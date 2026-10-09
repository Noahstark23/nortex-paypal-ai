/**
 * Cliente MCP de nortex-paypal-ai — fase M2 del ADR `ADR-capa-comun.md`
 * ("un solo cerebro, dos bocas").
 *
 * Este módulo NO reimplementa ninguna tool del servidor MCP nortex-mcp: spawnea
 * el servidor por stdio y le hace `tools/call`, exponiendo wrappers tipados
 * para el agente de WhatsApp. La lógica de negocio (queries, agregados,
 * formateo en voseo, rate limit, auditoría) vive 100% en el servidor.
 *
 * Fail closed: si el servidor no responde, responde malformado, o el tenant no
 * está autorizado, cada wrapper devuelve un string en voseo — NUNCA inventa
 * datos ni propaga stack traces al comerciante. (En 401/403 el propio servidor
 * ya responde su mensaje fail-closed, que pasa la validación y fluye tal cual.)
 *
 * Secretos: `NORTEX_SERVICE_TOKEN` (y el resto del entorno) se hereda al proceso
 * hijo vía `env`. El token jamás se loguea, jamás va al repo (ver .gitignore y
 * el grep de secretos en el README).
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { TextContent } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

/** Build local del servidor MCP (commit 5b58c08, F2). Override con env. */
export const MCP_SERVER_DEFAULT_PATH = "/home/hatch/workspace/nortex-mcp/dist/index.js";

/**
 * Mensaje fail-closed del cliente. El agente de WhatsApp lo reenvía tal cual:
 * corto, en voseo, sin prometer datos que no tenemos.
 */
export const MSG_NO_CONSULTA = "No pude consultar eso ahora. Probá de nuevo en un rato.";

/** Timeout default por tool call (el servidor mock responde en ms; http puede tardar). */
export const DEFAULT_TIMEOUT_MS = 20_000;

// ---------------------------------------------------------------------------
// Validación de salida (2 capas, como pide M2)
// ---------------------------------------------------------------------------

/** Capa 1: schema permisivo — el servidor promete strings en voseo, nunca JSON crudo. */
const ToolTextSchema = z.string().min(1);

/**
 * Capa 2: safeParse → string validado o null.
 * El wrapper convierte el null en el mensaje fail-closed en voseo.
 */
export function parseToolText(raw: unknown): string | null {
  const parsed = ToolTextSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

function isTextBlock(b: unknown): b is TextContent {
  return (
    typeof b === "object" &&
    b !== null &&
    (b as { type?: unknown }).type === "text" &&
    typeof (b as { text?: unknown }).text === "string"
  );
}

/** Extrae el texto de un CallToolResult; null si viene malformado o con isError. */
export function textFromResult(result: unknown): string | null {
  if (typeof result !== "object" || result === null) return null;
  const r = result as { isError?: unknown; content?: unknown };
  if (r.isError === true) return null;
  if (!Array.isArray(r.content)) return null;
  const texts = r.content.filter(isTextBlock).map((b) => b.text);
  if (texts.length === 0) return null;
  return parseToolText(texts.join("\n"));
}

// ---------------------------------------------------------------------------
// Cliente
// ---------------------------------------------------------------------------

export interface McpClientOptions {
  /** Ruta al entry del servidor MCP. Default: env NORTEX_MCP_SERVER_PATH o el build local. */
  serverPath?: string;
  /** Timeout por tool call en ms. Default: 20_000. */
  timeoutMs?: number;
}

export class McpNortexClient {
  private readonly client: Client;
  private readonly transport: StdioClientTransport;
  private readonly timeoutMs: number;
  private closed = false;

  private constructor(client: Client, transport: StdioClientTransport, timeoutMs: number) {
    this.client = client;
    this.transport = transport;
    this.timeoutMs = timeoutMs;
  }

  /**
   * Conecta al servidor MCP por stdio. LANZA si el servidor no arranca
   * (comando inexistente, crash en init): eso es un error de construcción,
   * no de consulta — los wrappers son los que hacen fail closed.
   */
  static async create(opts: McpClientOptions = {}): Promise<McpNortexClient> {
    const serverPath =
      opts.serverPath ?? process.env.NORTEX_MCP_SERVER_PATH ?? MCP_SERVER_DEFAULT_PATH;
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    // Heredamos el entorno al hijo (incluye NORTEX_SERVICE_TOKEN y
    // NORTEX_TENANT_ID si están seteados). El SDK solo hereda PATH por
    // default, así que hay que pasarlo explícito; el tipo del SDK exige
    // Record<string,string>, por eso se filtran los undefined. Nunca se loguea.
    const childEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined) childEnv[k] = v;
    }
    const transport = new StdioClientTransport({
      command: "node",
      args: [serverPath],
      env: childEnv,
    });
    const client = new Client(
      { name: "nortex-paypal-ai", version: "0.1.0" },
      { capabilities: {} },
    );
    await client.connect(transport);
    return new McpNortexClient(client, transport, timeoutMs);
  }

  /**
   * ÚNICO punto de contacto con el servidor. No hay lógica de negocio acá:
   * manda el nombre de la tool + args, valida la salida con zod, y ante
   * cualquier fallo (timeout, proceso muerto, protocolo roto, salida
   * malformada) devuelve el mensaje fail-closed en voseo.
   */
  private async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    if (this.closed) return MSG_NO_CONSULTA;
    try {
      const result = await this.client.callTool(
        { name, arguments: args },
        undefined,
        { timeout: this.timeoutMs },
      );
      return textFromResult(result) ?? MSG_NO_CONSULTA;
    } catch {
      // Fail closed: red caída, servidor muerto, timeout, handshake roto.
      // Sin stack traces al comerciante, sin datos inventados.
      return MSG_NO_CONSULTA;
    }
  }

  // ---- Wrappers tipados (las 4 tools que el agente WhatsApp necesita) ----
  // Ninguno toca dinero ni reimplementa nada: delegan 100% al servidor.

  /** ventas_hoy: cuánto vendió el negocio hoy (día comercial America/Managua). */
  async ventasHoy(): Promise<string> {
    return this.callTool("ventas_hoy", {});
  }

  /** buscar_producto: precio + stock por bodega de cada coincidencia. */
  async buscarProducto(q: string, limit = 10): Promise<string> {
    return this.callTool("buscar_producto", { q, limit });
  }

  /** stock_producto: stock total + por bodega de la primera coincidencia. */
  async stockProducto(producto: string): Promise<string> {
    return this.callTool("stock_producto", { producto });
  }

  /** precio_producto: precio base (NIO) de un producto. */
  async precioProducto(producto: string): Promise<string> {
    return this.callTool("precio_producto", { producto });
  }

  /** Cierra el transporte stdio y el proceso del servidor. */
  async close(): Promise<void> {
    this.closed = true;
    try {
      await this.client.close();
    } catch {
      // Cerrar es best-effort; el flag `closed` ya garantiza fail closed.
    }
  }
}
