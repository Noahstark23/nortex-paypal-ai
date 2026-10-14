/**
 * Gateway FALSO de PayPal para el demo y los tests: mismos contratos que el
 * cliente real, cero red, cero credenciales. Jamás mueve plata real ni se
 * presenta como pago real (skill nortex-paypal §7/§9).
 *
 * Comisión simulada: 3.49% + $0.49 (tarifa comercial US de referencia),
 * calculada en Decimal y redondeada a centavos, como haría PayPal.
 */
import { Decimal } from "../money/decimal.js";
import {
  PaypalApiError,
  referenceIdFor,
  type CaptureResult,
  type CreateOrderInput,
  type CreatedOrder,
  type PaypalGateway,
  type PaypalWebhookEvent,
} from "./types.js";

interface FakeOrder {
  input: CreateOrderInput;
  approved: boolean;
  captured: boolean;
}

export class FakePaypalGateway implements PaypalGateway {
  private readonly orders = new Map<string, FakeOrder>();
  private seq = 0;
  /** Los tests/demo pueden forzar firma inválida poniendo esto en false. */
  signatureValid = true;
  /** Si se setea, la próxima captura falla con este issue (ej. INSTRUMENT_DECLINED). */
  failNextCaptureWith?: string;

  async createOrder(input: CreateOrderInput): Promise<CreatedOrder> {
    this.seq += 1;
    const orderId = `FAKE-ORDER-${this.seq}`;
    this.orders.set(orderId, { input, approved: false, captured: false });
    return {
      orderId,
      status: "CREATED",
      approveUrl: `https://www.sandbox.paypal.com/checkoutnow?token=${orderId}`,
      referenceId: referenceIdFor(input.tenantId, input.saleId),
    };
  }

  /** Simula que el comprador (el familiar en EE. UU.) aprobó en PayPal. */
  approve(orderId: string): void {
    const order = this.orders.get(orderId);
    if (!order) throw new PaypalApiError(`Orden desconocida: ${orderId}`, 404);
    order.approved = true;
  }

  async captureOrder(orderId: string): Promise<CaptureResult> {
    const order = this.orders.get(orderId);
    if (!order) throw new PaypalApiError(`Orden desconocida: ${orderId}`, 404);
    if (this.failNextCaptureWith) {
      const issue = this.failNextCaptureWith;
      this.failNextCaptureWith = undefined;
      throw new PaypalApiError(`Captura rechazada (${issue})`, 422, issue, "UNPROCESSABLE_ENTITY");
    }
    if (!order.approved) {
      throw new PaypalApiError(
        "La orden aún no fue aprobada por el comprador.",
        422,
        "ORDER_NOT_APPROVED",
        "UNPROCESSABLE_ENTITY",
      );
    }
    order.captured = true;
    const gross = Decimal.from(order.input.amountUsd);
    const fee = gross
      .mul(Decimal.from("0.0349"))
      .add(Decimal.from("0.49"))
      .roundTo(2);
    return {
      orderId,
      captureId: `FAKE-CAPTURE-${this.seq}`,
      status: "COMPLETED",
      grossUsd: gross.toFixed(2),
      feeUsd: fee.toFixed(2),
      netUsd: gross.sub(fee).toFixed(2),
      currency: "USD",
      payerEmail: "familia.en.usa@example.com",
    };
  }

  async getOrderReferenceId(orderId: string): Promise<string | undefined> {
    const order = this.orders.get(orderId);
    return order ? referenceIdFor(order.input.tenantId, order.input.saleId) : undefined;
  }

  async verifyWebhookSignature(): Promise<boolean> {
    return this.signatureValid;
  }

  /** Arma el evento PAYMENT.CAPTURE.COMPLETED equivalente al de PayPal real. */
  buildCaptureCompletedEvent(capture: CaptureResult, referenceId: string): PaypalWebhookEvent {
    return {
      id: `FAKE-EVENT-${capture.captureId}`,
      event_type: "PAYMENT.CAPTURE.COMPLETED",
      resource: {
        id: capture.captureId,
        custom_id: referenceId,
        amount: { value: capture.grossUsd, currency_code: "USD" },
        seller_receivable_breakdown: {
          gross_amount: { value: capture.grossUsd, currency_code: "USD" },
          paypal_fee: { value: capture.feeUsd, currency_code: "USD" },
          net_amount: { value: capture.netUsd, currency_code: "USD" },
        },
        supplementary_data: { related_ids: { order_id: capture.orderId } },
      },
    };
  }
}
