/**
 * Superficie HTTP de la integración (sin dependencias: node:http).
 *
 * Rutas:
 *  POST /api/integrations/paypal/orders            → crea la orden (checkout)
 *  POST /api/integrations/paypal/orders/:id/capture → captura y concilia al instante
 *  POST /api/integrations/paypal/webhook            → verifica firma y concilia (idempotente)
 *  GET  /api/demo/sales/:tenantId/:saleId           → estado visible para el demo/jueces
 *
 * La captura por endpoint y el webhook convergen en el MISMO applyCapture:
 * si ambos llegan, la idempotencia por capture id hace que el segundo sea no-op.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { PaypalGateway, PaypalWebhookEvent } from "../paypal/types.js";
import { PaypalApiError } from "../paypal/types.js";
import type { NortexStore } from "../nortex/types.js";
import { ReconciliationService } from "../nortex/reconciliation.js";

export interface AppDeps {
  gateway: PaypalGateway;
  store: NortexStore;
  reconciliation: ReconciliationService;
}

const MAX_BODY = 1_000_000;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(text);
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new Error("Cuerpo demasiado grande.");
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return (raw ? JSON.parse(raw) : {}) as T;
}

function headerMap(req: IncomingMessage): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    out[k.toLowerCase()] = Array.isArray(v) ? v[0] : v;
  }
  return out;
}

export function createApp(deps: AppDeps): Server {
  const { gateway, store, reconciliation } = deps;

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    try {
      // ── Crear orden: el comerciante cobra ("cobrale $50 a Juan") ──────────
      if (req.method === "POST" && path === "/api/integrations/paypal/orders") {
        const body = await readJson<{ tenantId?: string; saleId?: string }>(req);
        if (!body.tenantId || !body.saleId) {
          return sendJson(res, 400, { error: "Faltan tenantId y saleId." });
        }
        const sale = store.getSale(body.tenantId, body.saleId);
        if (!sale) return sendJson(res, 404, { error: "Venta no encontrada para ese tenant." });
        if (sale.status === "paid") {
          return sendJson(res, 409, { error: "Esa factura ya está pagada." });
        }
        const order = await gateway.createOrder({
          tenantId: sale.tenantId,
          saleId: sale.id,
          amountUsd: sale.amountUsd,
          description: `Factura ${sale.dgiNumber} — ${sale.description}`,
        });
        store.saveSale({ ...sale, paypalOrderId: order.orderId, status: "pending" });
        // La venta sigue PENDIENTE: pagada recién al capturar (skill §3).
        return sendJson(res, 201, {
          orderId: order.orderId,
          approveUrl: order.approveUrl,
          status: order.status,
          mensaje: `Pasale este link a tu cliente para que pague la factura ${sale.dgiNumber}: ${order.approveUrl}`,
        });
      }

      // ── Capturar: el comprador ya aprobó en PayPal ────────────────────────
      const captureMatch = /^\/api\/integrations\/paypal\/orders\/([^/]+)\/capture$/.exec(path);
      if (req.method === "POST" && captureMatch) {
        const orderId = decodeURIComponent(captureMatch[1]);
        const sale = store.findSaleByPaypalOrderId(orderId);
        if (!sale) return sendJson(res, 404, { error: "Orden sin venta asociada en Nortex." });
        let capture;
        try {
          capture = await gateway.captureOrder(orderId);
        } catch (err) {
          if (err instanceof PaypalApiError && err.issue === "INSTRUMENT_DECLINED") {
            // Skill §4: se reinicia la aprobación; mensaje claro al comprador.
            return sendJson(res, 402, {
              error: "Tu tarjeta fue rechazada. Probá con otro medio de pago, por favor.",
              issue: err.issue,
            });
          }
          if (err instanceof PaypalApiError && err.issue === "PAYER_CANNOT_PAY") {
            return sendJson(res, 402, {
              error: "No pudimos procesar tu pago con esa cuenta. Probá con otra, por favor.",
              issue: err.issue,
            });
          }
          throw err;
        }
        if (capture.status !== "COMPLETED") {
          return sendJson(res, 422, { error: `La captura quedó en estado ${capture.status}.` });
        }
        const result = reconciliation.applyCapture({
          captureId: capture.captureId,
          orderId: capture.orderId,
          grossUsd: capture.grossUsd,
          feeUsd: capture.feeUsd,
          netUsd: capture.netUsd,
          referenceId: `nortex-${sale.tenantId}-${sale.id}`,
          source: "capture_endpoint",
        });
        return sendJson(res, 200, { capture, reconciliation: result });
      }

      // ── Webhook: verificar firma SIEMPRE; fail closed ─────────────────────
      if (req.method === "POST" && path === "/api/integrations/paypal/webhook") {
        const event = await readJson<PaypalWebhookEvent>(req);
        const valid = await gateway.verifyWebhookSignature(headerMap(req), event);
        if (!valid) {
          reconciliation.audit(
            undefined,
            "webhook.signature_invalid",
            `Webhook ${event.id ?? "?"} (${event.event_type ?? "?"}) con firma NO verificable: ignorado, no se aplicó nada.`,
          );
          return sendJson(res, 401, { error: "Firma no verificable." });
        }
        // COMPLETED sin custom_id: resolver la referencia consultando la orden.
        if (
          event.event_type === "PAYMENT.CAPTURE.COMPLETED" &&
          !event.resource.custom_id &&
          event.resource.supplementary_data?.related_ids?.order_id
        ) {
          const ref = await gateway.getOrderReferenceId(
            event.resource.supplementary_data.related_ids.order_id,
          );
          if (ref) event.resource.custom_id = ref;
        }
        const result = await reconciliation.handleVerifiedWebhook(event);
        return sendJson(res, 200, { received: true, reconciliation: result });
      }

      // ── Estado del demo (solo lectura; en producción iría tras auth) ─────
      const demoMatch = /^\/api\/demo\/sales\/([^/]+)\/([^/]+)$/.exec(path);
      if (req.method === "GET" && demoMatch) {
        const tenantId = decodeURIComponent(demoMatch[1]);
        const saleId = decodeURIComponent(demoMatch[2]);
        const sale = store.getSale(tenantId, saleId);
        if (!sale) return sendJson(res, 404, { error: "Venta no encontrada." });
        return sendJson(res, 200, {
          sale,
          payments: store.listPayments(tenantId).filter((p) => p.saleId === saleId),
          ledger: store.listLedgerEntries(tenantId).filter((e) => e.saleId === saleId),
          audit: store.listAudit(tenantId),
        });
      }

      return sendJson(res, 404, { error: "Ruta no encontrada." });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Error interno.";
      return sendJson(res, 500, { error: message });
    }
  });
}
