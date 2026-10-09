/**
 * Tests M2: nortex-paypal-ai consume ≥3 tools MCP sin duplicar.
 *
 * Ejercitan los wrappers contra el SERVIDOR MCP REAL construido localmente
 * (~/workspace/nortex-mcp/dist/index.js, commit 5b58c08, modo mock con datos
 * SINTÉTICOS — SIN VERIFICAR CONTRA STAGING).
 *
 * Qué se verifica:
 *  1. ≥3 tools responden de punta a punta (stdio real, no stubs).
 *  2. La salida parsea con zod (parseToolText: schema permisivo + safeParse).
 *  3. Fail closed: servidor muerto → string exacto en voseo, nunca datos
 *     inventados ni excepciones hacia el agente.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  MCP_SERVER_DEFAULT_PATH,
  McpNortexClient,
  MSG_NO_CONSULTA,
  parseToolText,
} from "../src/mcp/client.js";

const SERVER_PATH = process.env.NORTEX_MCP_SERVER_PATH ?? MCP_SERVER_DEFAULT_PATH;

describe("M2: el agente consume tools MCP vía stdio (servidor real, mocks)", () => {
  let client: McpNortexClient;

  beforeAll(async () => {
    client = await McpNortexClient.create({ serverPath: SERVER_PATH });
  }, 30_000);

  afterAll(async () => {
    await client.close();
  });

  it("ventas_hoy responde en voseo (mock ancla la serie al día real)", async () => {
    const text = await client.ventasHoy();
    expect(text).not.toBe(MSG_NO_CONSULTA);
    expect(text).toContain("vendiste");
  });

  it("buscar_producto responde precio + stock por bodega", async () => {
    const text = await client.buscarProducto("queso");
    expect(text).not.toBe(MSG_NO_CONSULTA);
    expect(text).toContain("Queso frito");
    expect(text).toContain("C$");
  });

  it("stock_producto responde total + por bodega", async () => {
    const text = await client.stockProducto("queso frito");
    expect(text).not.toBe(MSG_NO_CONSULTA);
    expect(text).toContain("te quedan");
  });

  it("precio_producto responde precio base NIO", async () => {
    const text = await client.precioProducto("queso frito");
    expect(text).not.toBe(MSG_NO_CONSULTA);
    expect(text).toContain("vale");
    expect(text).toContain("C$120.00");
  });

  it("el input inválido fluye como mensaje en voseo del servidor (no excepción)", async () => {
    // El servidor valida y responde en voseo; el cliente no reimplementa la regla.
    const text = await client.buscarProducto("x");
    expect(text).not.toBe(MSG_NO_CONSULTA);
    expect(text).toContain("mínimo 2 letras");
  });
});

describe("validación de salida: 2 capas (schema permisivo + safeParse)", () => {
  it("string no vacío pasa", () => {
    expect(parseToolText("Hoy vendiste C$12,450.00.")).toBe("Hoy vendiste C$12,450.00.");
  });

  it("vacío / no-string → null (el wrapper lo vuelve voseo fail-closed)", () => {
    expect(parseToolText("")).toBeNull();
    expect(parseToolText(42)).toBeNull();
    expect(parseToolText(null)).toBeNull();
    expect(parseToolText(undefined)).toBeNull();
    expect(parseToolText({ text: "x" })).toBeNull();
  });
});

describe("fail closed: el wrapper nunca inventa datos", () => {
  it("servidor muerto (cerrado) → string exacto en voseo en las 4 tools", async () => {
    const dead = await McpNortexClient.create({ serverPath: SERVER_PATH });
    await dead.close(); // simula el servidor caído
    await expect(dead.ventasHoy()).resolves.toBe(MSG_NO_CONSULTA);
    await expect(dead.buscarProducto("queso")).resolves.toBe(MSG_NO_CONSULTA);
    await expect(dead.stockProducto("queso")).resolves.toBe(MSG_NO_CONSULTA);
    await expect(dead.precioProducto("queso")).resolves.toBe(MSG_NO_CONSULTA);
  });

  it("la factoría LANZA si el servidor no existe (error de construcción, no de consulta)", async () => {
    await expect(
      McpNortexClient.create({ serverPath: "/no/existe/index.js", timeoutMs: 5_000 }),
    ).rejects.toThrow();
  });
});
