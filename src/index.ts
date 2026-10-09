/**
 * nortex-paypal-ai — agente AI en voseo nica por WhatsApp (PayPal AI Hackathon 2026).
 *
 * Fase M2 (ADR-capa-comun): consume las tools de lectura del servidor MCP
 * nortex-mcp vía stdio, sin duplicarlas.
 */
export { McpNortexClient, MSG_NO_CONSULTA, parseToolText, textFromResult } from "./mcp/client.js";
export type { McpClientOptions } from "./mcp/client.js";
