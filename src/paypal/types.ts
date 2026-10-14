/**
 * Tipos de la superficie PayPal que usa Nortex (Orders v2 + Webhooks v1).
 * Referencia oficial: https://developer.paypal.com/docs/api/orders/v2/
 */

export interface CreateOrderInput {
  tenantId: string;
  saleId: string;
  /** Monto bruto USD como string Decimal ("50.00"). Jamás number. */
  amountUsd: string;
  description: string;
  returnUrl?: string;
  cancelUrl?: string;
}

export interface CreatedOrder {
  orderId: string;
  status: string;
  approveUrl: string;
  /** Nuestra llave de conciliación: nortex-{tenantId}-{saleId}. */
  referenceId: string;
}

export interface CaptureResult {
  orderId: string;
  captureId: string;
  status: string; // COMPLETED | DECLINED | ...
  grossUsd: string;
  feeUsd: string;
  netUsd: string;
  currency: string;
  payerEmail?: string;
}

/** Evento de webhook ya parseado (el cuerpo JSON tal cual lo envía PayPal). */
export interface PaypalWebhookEvent {
  id: string;
  event_type: string;
  resource: Record<string, unknown> & {
    id?: string;
    custom_id?: string;
    amount?: { value?: string; currency_code?: string };
    seller_receivable_breakdown?: {
      gross_amount?: { value?: string; currency_code?: string };
      paypal_fee?: { value?: string; currency_code?: string };
      net_amount?: { value?: string; currency_code?: string };
    };
    supplementary_data?: { related_ids?: { order_id?: string } };
    links?: Array<{ href?: string; rel?: string }>;
  };
}

/** Puerto hacia PayPal: el cliente real (fetch) y el fake (demo/tests) lo cumplen. */
export interface PaypalGateway {
  createOrder(input: CreateOrderInput): Promise<CreatedOrder>;
  captureOrder(orderId: string): Promise<CaptureResult>;
  getOrderReferenceId(orderId: string): Promise<string | undefined>;
  verifyWebhookSignature(
    headers: Record<string, string | undefined>,
    event: PaypalWebhookEvent,
  ): Promise<boolean>;
}

/** Error de la API de PayPal con el `issue` crudo (ej. INSTRUMENT_DECLINED). */
export class PaypalApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly issue?: string,
    readonly paypalName?: string,
  ) {
    super(message);
    this.name = "PaypalApiError";
  }
}

/** Llave de conciliación que viaja en reference_id Y custom_id de la unidad de compra. */
export function referenceIdFor(tenantId: string, saleId: string): string {
  return `nortex-${tenantId}-${saleId}`;
}

/**
 * Inversa aproximada de referenceIdFor (último segmento = venta).
 * OJO: si tenant y venta contienen guiones, el corte es ambiguo; la
 * conciliación NO usa esta función — resuelve la referencia contra el
 * store probando los cortes hasta hallar la venta existente.
 */
export function parseReferenceId(
  referenceId: string,
): { tenantId: string; saleId: string } | undefined {
  if (!referenceId.startsWith("nortex-")) return undefined;
  const rest = referenceId.slice("nortex-".length);
  const cut = rest.lastIndexOf("-");
  if (cut <= 0 || cut === rest.length - 1) return undefined;
  return { tenantId: rest.slice(0, cut), saleId: rest.slice(cut + 1) };
}
