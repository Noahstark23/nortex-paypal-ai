/**
 * Conciliación PayPal → Nortex: el corazón del demo. Se prueban las reglas
 * duras de la skill §5: idempotencia, monto exacto, referencia desconocida,
 * multi-tenancy, comisión separada, FX registrada y reversos.
 */
import { describe, expect, it } from "vitest";
import { Decimal } from "../src/money/decimal.js";
import { FakePaypalGateway } from "../src/paypal/fake.js";
import { referenceIdFor, type PaypalWebhookEvent } from "../src/paypal/types.js";
import { InMemoryNortexStore } from "../src/nortex/store.js";
import { ReconciliationService } from "../src/nortex/reconciliation.js";
import type { Sale } from "../src/nortex/types.js";
import { DEMO_SALE, OTHER_TENANT_SALE } from "../src/demo/seed.js";

function setup() {
  const store = new InMemoryNortexStore();
  store.saveSale({ ...DEMO_SALE });
  store.saveSale({ ...OTHER_TENANT_SALE });
  const recon = new ReconciliationService(store);
  const fake = new FakePaypalGateway();
  return { store, recon, fake };
}

async function paySale(
  fake: FakePaypalGateway,
  recon: ReconciliationService,
  sale: Sale,
): Promise<PaypalWebhookEvent> {
  const order = await fake.createOrder({
    tenantId: sale.tenantId,
    saleId: sale.id,
    amountUsd: sale.amountUsd,
    description: `Factura ${sale.dgiNumber}`,
  });
  fake.approve(order.orderId);
  const capture = await fake.captureOrder(order.orderId);
  const event = fake.buildCaptureCompletedEvent(capture, order.referenceId);
  await recon.handleVerifiedWebhook(event);
  return event;
}

const totalDebits = (store: InMemoryNortexStore, tenantId: string) =>
  store
    .listLedgerEntries(tenantId)
    .flatMap((e) => e.lines)
    .reduce((acc, l) => acc.add(Decimal.from(l.debitNio)), Decimal.zero());
const totalCredits = (store: InMemoryNortexStore, tenantId: string) =>
  store
    .listLedgerEntries(tenantId)
    .flatMap((e) => e.lines)
    .reduce((acc, l) => acc.add(Decimal.from(l.creditNio)), Decimal.zero());

describe("ReconciliationService", () => {
  it("aplica captura: pago + asientos balanceados + venta pagada + FX registrada", async () => {
    const { store, recon, fake } = setup();
    const result = await recon.handleVerifiedWebhook(
      fake.buildCaptureCompletedEvent(
        {
          orderId: "ORD-1",
          captureId: "CAP-1",
          status: "COMPLETED",
          grossUsd: "50.00",
          feeUsd: "2.24",
          netUsd: "47.76",
          currency: "USD",
        },
        referenceIdFor(DEMO_SALE.tenantId, DEMO_SALE.id),
      ),
    );
    expect(result.status).toBe("applied");

    const sale = store.getSale(DEMO_SALE.tenantId, DEMO_SALE.id)!;
    expect(sale.status).toBe("paid");

    const payments = store.listPayments(DEMO_SALE.tenantId);
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({
      paypalCaptureId: "CAP-1",
      grossUsd: "50.00",
      feeUsd: "2.24", // comisión como costo separado, no descuento
      netUsd: "47.76",
      fxRateUsdNio: "36.85", // la tasa usada quedó registrada
      grossNio: "1842.50",
      feeNio: "82.54",
    });

    const entries = store.listLedgerEntries(DEMO_SALE.tenantId);
    expect(entries.map((e) => e.kind)).toEqual(["cobro_paypal", "comision_paypal"]);
    expect(totalDebits(store, DEMO_SALE.tenantId).equals(totalCredits(store, DEMO_SALE.tenantId))).toBe(true);
    expect(store.listAudit(DEMO_SALE.tenantId).some((a) => a.action === "reconciliation.capture_applied")).toBe(true);
  });

  it("webhook DUPLICADO (mismo capture id) es no-op: un pago, dos asientos", async () => {
    const { store, recon, fake } = setup();
    const event = await paySale(fake, recon, DEMO_SALE);
    const again = await recon.handleVerifiedWebhook(event);
    expect(again.status).toBe("duplicate_ignored");
    expect(store.listPayments(DEMO_SALE.tenantId)).toHaveLength(1);
    expect(store.listLedgerEntries(DEMO_SALE.tenantId)).toHaveLength(2);
    expect(
      store.listAudit(DEMO_SALE.tenantId).some((a) => a.action === "reconciliation.duplicate_ignored"),
    ).toBe(true);
  });

  it("referencia desconocida: NO se crea plata, queda auditada", async () => {
    const { store, recon, fake } = setup();
    const event = fake.buildCaptureCompletedEvent(
      {
        orderId: "ORD-X",
        captureId: "CAP-X",
        status: "COMPLETED",
        grossUsd: "999.00",
        feeUsd: "0.00",
        netUsd: "999.00",
        currency: "USD",
      },
      "nortex-tenant-fantasma-venta-9999",
    );
    const result = await recon.handleVerifiedWebhook(event);
    expect(result.status).toBe("ignored_unknown_reference");
    expect(store.listPayments(DEMO_SALE.tenantId)).toHaveLength(0);
    expect(store.listLedgerEntries(DEMO_SALE.tenantId)).toHaveLength(0);
    expect(store.getSale(DEMO_SALE.tenantId, DEMO_SALE.id)!.status).toBe("pending");
  });

  it("monto distinto al pendiente: se retiene para revisión, jamás se ajusta solo", async () => {
    const { store, recon, fake } = setup();
    const event = fake.buildCaptureCompletedEvent(
      {
        orderId: "ORD-2",
        captureId: "CAP-2",
        status: "COMPLETED",
        grossUsd: "45.00", // la venta espera 50.00
        feeUsd: "2.06",
        netUsd: "42.94",
        currency: "USD",
      },
      referenceIdFor(DEMO_SALE.tenantId, DEMO_SALE.id),
    );
    const result = await recon.handleVerifiedWebhook(event);
    expect(result.status).toBe("held_amount_mismatch");
    expect(store.getSale(DEMO_SALE.tenantId, DEMO_SALE.id)!.status).toBe("pending");
    expect(store.listPayments(DEMO_SALE.tenantId)).toHaveLength(0);
  });

  it("multi-tenant: pagar la venta de un tenant jamás toca la del otro", async () => {
    const { store, recon, fake } = setup();
    await paySale(fake, recon, OTHER_TENANT_SALE);
    expect(store.getSale(OTHER_TENANT_SALE.tenantId, OTHER_TENANT_SALE.id)!.status).toBe("paid");
    expect(store.getSale(DEMO_SALE.tenantId, DEMO_SALE.id)!.status).toBe("pending");
    expect(store.listPayments(DEMO_SALE.tenantId)).toHaveLength(0);
    expect(store.listLedgerEntries(DEMO_SALE.tenantId)).toHaveLength(0);
  });

  it("captura denegada: la venta NO se marca pagada y queda el registro", async () => {
    const { store, recon } = setup();
    const result = await recon.handleVerifiedWebhook({
      id: "EV-DENIED",
      event_type: "PAYMENT.CAPTURE.DENIED",
      resource: { custom_id: referenceIdFor(DEMO_SALE.tenantId, DEMO_SALE.id) },
    });
    expect(result.status).toBe("denied_recorded");
    expect(store.getSale(DEMO_SALE.tenantId, DEMO_SALE.id)!.status).toBe("payment_failed");
    expect(store.listPayments(DEMO_SALE.tenantId)).toHaveLength(0);
  });

  it("reembolso: reversa los asientos, la venta vuelve a pendiente y es idempotente", async () => {
    const { store, recon, fake } = setup();
    await paySale(fake, recon, DEMO_SALE);
    const payment = store.listPayments(DEMO_SALE.tenantId)[0];

    const refundEvent: PaypalWebhookEvent = {
      id: "EV-REFUND",
      event_type: "PAYMENT.CAPTURE.REFUNDED",
      resource: { id: "REFUND-1", capture_id: payment.paypalCaptureId } as PaypalWebhookEvent["resource"],
    };
    const first = await recon.handleVerifiedWebhook(refundEvent);
    expect(first.status).toBe("refund_applied");
    expect(store.findPaymentByCaptureId(payment.paypalCaptureId)!.status).toBe("refunded");
    expect(store.getSale(DEMO_SALE.tenantId, DEMO_SALE.id)!.status).toBe("pending");
    // Con los reversos, la partida doble sigue balanceada en total.
    expect(totalDebits(store, DEMO_SALE.tenantId).equals(totalCredits(store, DEMO_SALE.tenantId))).toBe(true);
    expect(store.listLedgerEntries(DEMO_SALE.tenantId)).toHaveLength(4);

    const second = await recon.handleVerifiedWebhook(refundEvent);
    expect(second.status).toBe("refund_duplicate_ignored");
    expect(store.listLedgerEntries(DEMO_SALE.tenantId)).toHaveLength(4);
  });
});
