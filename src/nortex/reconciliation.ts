/**
 * Conciliación PayPal → Nortex (skill nortex-paypal §5). Reglas duras:
 *
 * 1. Idempotencia por capture id: un webhook duplicado es un no-op, jamás
 *    un doble pago ni un doble asiento.
 * 2. Referencia desconocida → se registra y se alerta; NO se crea plata.
 * 3. Monto distinto al pendiente → queda en revisión manual, jamás se ajusta solo.
 * 4. Aplicación atómica: fila de pago + asientos contables + venta pagada,
 *    todo en UNA transacción.
 * 5. La comisión de PayPal se contabiliza como costo separado.
 * 6. La tasa FX usada queda registrada en el pago.
 */
import { Decimal } from "../money/decimal.js";
import type { PaypalWebhookEvent } from "../paypal/types.js";
import type {
  LedgerEntry,
  LedgerLine,
  NortexStore,
  Payment,
  Sale,
} from "./types.js";

export type ReconStatus =
  | "applied"
  | "duplicate_ignored"
  | "ignored_unknown_reference"
  | "held_amount_mismatch"
  | "held_sale_already_paid"
  | "denied_recorded"
  | "refund_applied"
  | "refund_duplicate_ignored"
  | "ignored_event";

export interface ReconResult {
  status: ReconStatus;
  detail: string;
  paymentId?: string;
}

export interface CaptureData {
  captureId: string;
  orderId: string;
  grossUsd: string;
  feeUsd: string;
  netUsd: string;
  referenceId?: string;
  source: "webhook" | "capture_endpoint";
}

const ACCOUNTS = {
  paypalClearing: "PayPal por conciliar",
  receivable: "Cuentas por cobrar clientes",
  feeExpense: "Comisiones PayPal",
} as const;

let seq = 0;
const nextId = (prefix: string) => `${prefix}-${++seq}-${Date.now().toString(36)}`;
const nowIso = () => new Date().toISOString();

export class ReconciliationService {
  constructor(private readonly store: NortexStore) {}

  audit(tenantId: string | undefined, action: string, detail: string): void {
    this.store.addAudit({ id: nextId("aud"), tenantId, action, detail, at: nowIso() });
  }

  /** Punto de entrada de webhooks ya verificados (firma OK). */
  async handleVerifiedWebhook(event: PaypalWebhookEvent): Promise<ReconResult> {
    switch (event.event_type) {
      case "PAYMENT.CAPTURE.COMPLETED":
        return this.applyCapture(this.captureDataFromEvent(event));
      case "PAYMENT.CAPTURE.DENIED":
        return this.applyDenied(event);
      case "PAYMENT.CAPTURE.REFUNDED":
        return this.applyRefund(event);
      case "CHECKOUT.ORDER.APPROVED":
        this.audit(
          undefined,
          "webhook.order_approved",
          `Orden aprobada (sin movimiento de plata): ${event.resource.id ?? "?"}`,
        );
        return { status: "ignored_event", detail: "Aprobación registrada; la plata entra al capturar." };
      default:
        this.audit(undefined, "webhook.ignored", `Evento no suscrito: ${event.event_type}`);
        return { status: "ignored_event", detail: `Evento ${event.event_type} sin acción.` };
    }
  }

  /**
   * Resuelve la referencia contra el store probando cada corte posible:
   * tenant y venta pueden contener guiones ("pulperia-la-bendicion" /
   * "venta-1001"), así que el formato nortex-{tenant}-{venta} no se puede
   * partir a ciegas — manda la venta que EXISTE para ese tenant.
   */
  private resolveSale(referenceId?: string): Sale | undefined {
    if (!referenceId?.startsWith("nortex-")) return undefined;
    const rest = referenceId.slice("nortex-".length);
    for (let i = rest.indexOf("-"); i > 0; i = rest.indexOf("-", i + 1)) {
      const sale = this.store.getSale(rest.slice(0, i), rest.slice(i + 1));
      if (sale) return sale;
    }
    return undefined;
  }

  private captureDataFromEvent(event: PaypalWebhookEvent): CaptureData {
    const r = event.resource;
    const breakdown = r.seller_receivable_breakdown;
    return {
      captureId: r.id ?? "",
      orderId: r.supplementary_data?.related_ids?.order_id ?? "",
      grossUsd: breakdown?.gross_amount?.value ?? r.amount?.value ?? "0",
      feeUsd: breakdown?.paypal_fee?.value ?? "0",
      netUsd: breakdown?.net_amount?.value ?? r.amount?.value ?? "0",
      referenceId: r.custom_id,
      source: "webhook",
    };
  }

  applyCapture(data: CaptureData): ReconResult {
    // (1) Idempotencia ANTES de cualquier escritura.
    const existing = this.store.findPaymentByCaptureId(data.captureId);
    if (existing) {
      this.audit(
        existing.tenantId,
        "reconciliation.duplicate_ignored",
        `Captura ${data.captureId} ya conciliada (pago ${existing.id}); entrega duplicada ignorada.`,
      );
      return {
        status: "duplicate_ignored",
        detail: "La captura ya estaba conciliada; no se duplicó nada.",
        paymentId: existing.id,
      };
    }

    // (2) Resolver referencia → tenant + venta (multi-tenant estricto).
    const sale = this.resolveSale(data.referenceId);
    if (!sale) {
      this.audit(
        undefined,
        "reconciliation.unknown_reference",
        `Captura ${data.captureId} con referencia "${data.referenceId ?? "?"}" sin venta en Nortex. NO se creó plata; revisar a mano.`,
      );
      return {
        status: "ignored_unknown_reference",
        detail: "Referencia sin venta en Nortex; quedó registrado para revisión manual.",
      };
    }

    if (sale.status === "paid") {
      this.audit(
        sale.tenantId,
        "reconciliation.sale_already_paid",
        `Captura ${data.captureId} para la venta ${sale.id} que ya estaba pagada con otra captura.`,
      );
      return { status: "held_sale_already_paid", detail: "La venta ya estaba pagada; captura en revisión." };
    }

    // (3) El monto debe ser EXACTO al pendiente (comparación Decimal, no float).
    const gross = Decimal.from(data.grossUsd);
    if (!gross.equals(Decimal.from(sale.amountUsd))) {
      this.audit(
        sale.tenantId,
        "reconciliation.amount_mismatch",
        `Captura ${data.captureId}: llegaron ${gross.toFixed(2)} USD pero la venta ${sale.id} espera ${Decimal.from(sale.amountUsd).toFixed(2)} USD. En revisión manual; NO se ajustó solo.`,
      );
      return {
        status: "held_amount_mismatch",
        detail: "El monto no coincide con el pendiente; quedó en revisión manual.",
      };
    }

    // (4) Aplicar TODO en una transacción: pago + asientos + venta pagada.
    const fee = Decimal.from(data.feeUsd);
    const rate = Decimal.from(sale.fxRateUsdNio);
    const grossNio = gross.mul(rate).roundTo(2);
    const feeNio = fee.mul(rate).roundTo(2);
    const payment: Payment = {
      id: nextId("pay"),
      paypalCaptureId: data.captureId,
      paypalOrderId: data.orderId,
      tenantId: sale.tenantId,
      saleId: sale.id,
      grossUsd: gross.toFixed(2),
      feeUsd: fee.toFixed(2),
      netUsd: Decimal.from(data.netUsd).toFixed(2),
      currency: "USD",
      fxRateUsdNio: rate.toString(),
      grossNio: grossNio.toFixed(2),
      feeNio: feeNio.toFixed(2),
      status: "completed",
      source: data.source,
      createdAt: nowIso(),
    };

    this.store.transaction(() => {
      this.store.savePayment(payment);
      this.store.addLedgerEntry(
        this.entry(sale.tenantId, sale.id, "cobro_paypal", payment.id, [
          { account: ACCOUNTS.paypalClearing, debitNio: grossNio.toFixed(2), creditNio: "0.00" },
          { account: ACCOUNTS.receivable, debitNio: "0.00", creditNio: grossNio.toFixed(2) },
        ]),
      );
      if (!fee.isZero()) {
        this.store.addLedgerEntry(
          this.entry(sale.tenantId, sale.id, "comision_paypal", payment.id, [
            { account: ACCOUNTS.feeExpense, debitNio: feeNio.toFixed(2), creditNio: "0.00" },
            { account: ACCOUNTS.paypalClearing, debitNio: "0.00", creditNio: feeNio.toFixed(2) },
          ]),
        );
      }
      this.store.saveSale({ ...sale, status: "paid", paypalOrderId: data.orderId || sale.paypalOrderId });
    });

    this.audit(
      sale.tenantId,
      "reconciliation.capture_applied",
      `Venta ${sale.id} (factura ${sale.dgiNumber}) pagada: ${payment.grossUsd} USD brutos, comisión ${payment.feeUsd} USD, tasa FX ${payment.fxRateUsdNio} registrada. Captura ${data.captureId} vía ${data.source}.`,
    );
    return { status: "applied", detail: "Pago y asientos aplicados; venta pagada.", paymentId: payment.id };
  }

  private applyDenied(event: PaypalWebhookEvent): ReconResult {
    const referenceId = event.resource.custom_id;
    const sale = this.resolveSale(referenceId);
    if (sale && sale.status === "pending") {
      this.store.saveSale({ ...sale, status: "payment_failed" });
    }
    this.audit(
      sale?.tenantId,
      "reconciliation.capture_denied",
      `Captura denegada para la referencia "${referenceId ?? "?"}". El comprador debe reintentar con otro medio de pago.`,
    );
    return { status: "denied_recorded", detail: "Denegación registrada; la venta no se marcó pagada." };
  }

  private applyRefund(event: PaypalWebhookEvent): ReconResult {
    // En PayPal real el recurso de reembolso enlaza a la captura vía links[rel=up];
    // nuestro fake y el simulador de sandbox mandan custom_id/capture_id directos.
    const r = event.resource;
    const upHref = r.links?.find((l) => l.rel === "up")?.href ?? "";
    const captureId =
      (r as Record<string, unknown>)["capture_id"]?.toString() ??
      upHref.split("/captures/")[1]?.split(/[/?#]/)[0];
    const payment = captureId ? this.store.findPaymentByCaptureId(captureId) : undefined;
    if (!payment) {
      this.audit(
        undefined,
        "reconciliation.refund_unknown",
        `Reembolso sin pago conciliado (captura "${captureId ?? "?"}"). Revisar a mano.`,
      );
      return { status: "ignored_unknown_reference", detail: "Reembolso sin pago conocido; registrado." };
    }
    if (payment.status === "refunded") {
      return { status: "refund_duplicate_ignored", detail: "El reembolso ya estaba aplicado." };
    }
    const sale = this.store.getSale(payment.tenantId, payment.saleId);
    const grossNio = Decimal.from(payment.grossNio);
    const feeNio = Decimal.from(payment.feeNio);
    this.store.transaction(() => {
      this.store.savePayment({ ...payment, status: "refunded" });
      this.store.addLedgerEntry(
        this.entry(payment.tenantId, payment.saleId, "reverso_cobro_paypal", payment.id, [
          { account: ACCOUNTS.receivable, debitNio: grossNio.toFixed(2), creditNio: "0.00" },
          { account: ACCOUNTS.paypalClearing, debitNio: "0.00", creditNio: grossNio.toFixed(2) },
        ]),
      );
      if (!feeNio.isZero()) {
        this.store.addLedgerEntry(
          this.entry(payment.tenantId, payment.saleId, "reverso_comision_paypal", payment.id, [
            { account: ACCOUNTS.paypalClearing, debitNio: feeNio.toFixed(2), creditNio: "0.00" },
            { account: ACCOUNTS.feeExpense, debitNio: "0.00", creditNio: feeNio.toFixed(2) },
          ]),
        );
      }
      if (sale) this.store.saveSale({ ...sale, status: "pending" });
    });
    this.audit(
      payment.tenantId,
      "reconciliation.refund_applied",
      `Reembolso de la captura ${payment.paypalCaptureId}: asientos reversados y venta ${payment.saleId} de vuelta a pendiente.`,
    );
    return { status: "refund_applied", detail: "Reembolso aplicado con asientos de reverso.", paymentId: payment.id };
  }

  private entry(
    tenantId: string,
    saleId: string,
    kind: LedgerEntry["kind"],
    paymentId: string,
    lines: LedgerLine[],
  ): LedgerEntry {
    return { id: nextId("led"), tenantId, saleId, kind, lines, paymentId, createdAt: nowIso() };
  }
}
