/**
 * Cliente real de PayPal (Orders v2 + verificación de webhooks), SOLO servidor.
 *
 * - Base URL según entorno: sandbox (default) o live. Live exige aprobación
 *   explícita de Noel (ver skill nortex-paypal §7); este cliente no decide eso,
 *   solo obedece la configuración.
 * - Montos SIEMPRE como string con 2 decimales (Decimal), jamás float.
 * - `fetchFn` inyectable: los tests ejercitan este mismo código con stubs.
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

export const PAYPAL_SANDBOX_BASE = "https://api-m.sandbox.paypal.com";
export const PAYPAL_LIVE_BASE = "https://api-m.paypal.com";

export interface PaypalClientOptions {
  clientId: string;
  clientSecret: string;
  /** ID del webhook registrado en el dashboard (para verificar firmas). */
  webhookId: string;
  baseUrl?: string;
  fetchFn?: typeof fetch;
}

interface TokenCache {
  token: string;
  expiresAtMs: number;
}

export class PaypalClient implements PaypalGateway {
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private tokenCache?: TokenCache;

  constructor(private readonly opts: PaypalClientOptions) {
    if (!opts.clientId || !opts.clientSecret) {
      throw new Error(
        "PaypalClient: faltan PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET. " +
          "Las credenciales las crea Noel en developer.paypal.com (ver .env.example).",
      );
    }
    this.baseUrl = opts.baseUrl ?? PAYPAL_SANDBOX_BASE;
    this.fetchFn = opts.fetchFn ?? fetch;
  }

  private async accessToken(): Promise<string> {
    const now = Date.now();
    if (this.tokenCache && this.tokenCache.expiresAtMs > now + 30_000) {
      return this.tokenCache.token;
    }
    const auth = Buffer.from(`${this.opts.clientId}:${this.opts.clientSecret}`).toString("base64");
    const res = await this.fetchFn(`${this.baseUrl}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    });
    if (!res.ok) {
      throw new PaypalApiError(
        `PayPal OAuth falló (${res.status}). Causa típica: credenciales de otro entorno (sandbox vs live).`,
        res.status,
      );
    }
    const body = (await res.json()) as { access_token: string; expires_in: number };
    this.tokenCache = {
      token: body.access_token,
      expiresAtMs: now + body.expires_in * 1000,
    };
    return body.access_token;
  }

  private async api<T>(path: string, init: RequestInit): Promise<T> {
    const token = await this.accessToken();
    const res = await this.fetchFn(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    });
    if (!res.ok) {
      let issue: string | undefined;
      let name: string | undefined;
      try {
        const err = (await res.json()) as {
          name?: string;
          details?: Array<{ issue?: string; description?: string }>;
        };
        name = err.name;
        issue = err.details?.[0]?.issue;
      } catch {
        // cuerpo no-JSON: el status basta para diagnosticar
      }
      throw new PaypalApiError(
        `PayPal ${path} → ${res.status}${name ? ` ${name}` : ""}${issue ? ` (${issue})` : ""}`,
        res.status,
        issue,
        name,
      );
    }
    return (await res.json()) as T;
  }

  async createOrder(input: CreateOrderInput): Promise<CreatedOrder> {
    const referenceId = referenceIdFor(input.tenantId, input.saleId);
    const value = Decimal.from(input.amountUsd).toFixed(2);
    const order = await this.api<{
      id: string;
      status: string;
      links?: Array<{ rel: string; href: string }>;
    }>("/v2/checkout/orders", {
      method: "POST",
      body: JSON.stringify({
        intent: "CAPTURE",
        purchase_units: [
          {
            reference_id: referenceId,
            // custom_id se repite a propósito: es el campo que PayPal devuelve
            // dentro del recurso de captura en los webhooks → conciliación directa.
            custom_id: referenceId,
            description: input.description,
            amount: { currency_code: "USD", value },
          },
        ],
        application_context: {
          shipping_preference: "NO_SHIPPING",
          user_action: "PAY_NOW",
          ...(input.returnUrl ? { return_url: input.returnUrl } : {}),
          ...(input.cancelUrl ? { cancel_url: input.cancelUrl } : {}),
        },
      }),
    });
    const approveUrl = order.links?.find((l) => l.rel === "approve")?.href;
    if (!approveUrl) {
      throw new PaypalApiError(`La orden ${order.id} no trajo link de aprobación.`, 502);
    }
    // La venta queda PENDIENTE en Nortex: jamás se marca pagada al crear la orden.
    return { orderId: order.id, status: order.status, approveUrl, referenceId };
  }

  async captureOrder(orderId: string): Promise<CaptureResult> {
    const data = await this.api<{
      id: string;
      status: string;
      payer?: { email_address?: string };
      purchase_units?: Array<{
        payments?: {
          captures?: Array<{
            id: string;
            status: string;
            amount: { value: string; currency_code: string };
            seller_receivable_breakdown?: {
              gross_amount: { value: string };
              paypal_fee: { value: string };
              net_amount: { value: string };
            };
          }>;
        };
      }>;
    }>(`/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {
      method: "POST",
      body: "{}",
    });
    const capture = data.purchase_units?.[0]?.payments?.captures?.[0];
    if (!capture) {
      throw new PaypalApiError(`La captura de ${orderId} no devolvió captures.`, 502);
    }
    const breakdown = capture.seller_receivable_breakdown;
    return {
      orderId: data.id,
      captureId: capture.id,
      status: capture.status,
      grossUsd: Decimal.from(capture.amount.value).toFixed(2),
      feeUsd: breakdown ? Decimal.from(breakdown.paypal_fee.value).toFixed(2) : "0.00",
      netUsd: breakdown
        ? Decimal.from(breakdown.net_amount.value).toFixed(2)
        : Decimal.from(capture.amount.value).toFixed(2),
      currency: capture.amount.currency_code,
      payerEmail: data.payer?.email_address,
    };
  }

  async getOrderReferenceId(orderId: string): Promise<string | undefined> {
    const data = await this.api<{
      purchase_units?: Array<{ reference_id?: string; custom_id?: string }>;
    }>(`/v2/checkout/orders/${encodeURIComponent(orderId)}`, { method: "GET" });
    const unit = data.purchase_units?.[0];
    return unit?.reference_id ?? unit?.custom_id;
  }

  /**
   * Verificación de firma vía el endpoint oficial de PayPal. Fail closed:
   * cualquier error (red, status, respuesta rara) devuelve false y el
   * webhook se ignora — jamás se aplica plata sin firma válida.
   */
  async verifyWebhookSignature(
    headers: Record<string, string | undefined>,
    event: PaypalWebhookEvent,
  ): Promise<boolean> {
    try {
      const result = await this.api<{ verification_status?: string }>(
        "/v1/notifications/verify-webhook-signature",
        {
          method: "POST",
          body: JSON.stringify({
            auth_algo: headers["paypal-auth-algo"],
            cert_url: headers["paypal-cert-url"],
            transmission_id: headers["paypal-transmission-id"],
            transmission_sig: headers["paypal-transmission-sig"],
            transmission_time: headers["paypal-transmission-time"],
            webhook_id: this.opts.webhookId,
            webhook_event: event,
          }),
        },
      );
      return result.verification_status === "SUCCESS";
    } catch {
      return false;
    }
  }
}
