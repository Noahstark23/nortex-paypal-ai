/**
 * nortex-paypal-ai — agente AI en voseo nica por WhatsApp (PayPal AI Hackathon 2026).
 *
 * Fase M2 (ADR-capa-comun): consume las tools de lectura del servidor MCP
 * nortex-mcp vía stdio, sin duplicarlas.
 */
export { McpNortexClient, MSG_NO_CONSULTA, parseToolText, textFromResult } from "./mcp/client.js";
export type { McpClientOptions } from "./mcp/client.js";

// F1 — Núcleo PayPal: órdenes, captura, webhooks y conciliación en Nortex.
export { Decimal } from "./money/decimal.js";
export { PaypalClient, PAYPAL_LIVE_BASE, PAYPAL_SANDBOX_BASE } from "./paypal/client.js";
export type { PaypalClientOptions } from "./paypal/client.js";
export { FakePaypalGateway } from "./paypal/fake.js";
export {
  PaypalApiError,
  parseReferenceId,
  referenceIdFor,
} from "./paypal/types.js";
export type {
  CaptureResult,
  CreatedOrder,
  CreateOrderInput,
  PaypalGateway,
  PaypalWebhookEvent,
} from "./paypal/types.js";
export { InMemoryNortexStore } from "./nortex/store.js";
export { ReconciliationService } from "./nortex/reconciliation.js";
export type { CaptureData, ReconResult, ReconStatus } from "./nortex/reconciliation.js";
export type {
  AuditEvent,
  LedgerEntry,
  LedgerLine,
  NortexStore,
  Payment,
  Sale,
} from "./nortex/types.js";
export { createApp } from "./server/app.js";
