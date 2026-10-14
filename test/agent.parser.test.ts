import { describe, expect, it } from "vitest";
import { parseAmount, parseIntent } from "../src/agent/parser.js";

describe("parser: cobro", () => {
  it("monto con $, cliente y factura", () => {
    expect(parseIntent("cobrale $50 a Juan por la factura A-123")).toEqual({
      tipo: "cobrar", cliente: "Juan", factura: "A-123", montoUsd: "50.00",
    });
  });
  it("monto en palabras (dólares) con acento en el verbo, sin factura", () => {
    expect(parseIntent("cobrále 50 dólares a María")).toEqual({ tipo: "cobrar", cliente: "María", montoUsd: "50.00" });
  });
  it("sin monto: se toma de la venta", () => {
    expect(parseIntent("cobrale a Juan la factura A-123")).toEqual({ tipo: "cobrar", cliente: "Juan", factura: "A-123" });
  });
  it("«pasale el link de pago»", () => {
    expect(parseIntent("pasale el link de pago a Juan por la A-123")).toEqual({ tipo: "cobrar", cliente: "Juan", factura: "A-123" });
  });
  it("miles y decimales, nombre compuesto, factura numérica", () => {
    expect(parseIntent("cobrale $1,200.50 a Juan Pérez por la factura 77")).toEqual({
      tipo: "cobrar", cliente: "Juan Pérez", factura: "77", montoUsd: "1200.50",
    });
    expect(parseIntent("cobrale 50.25 a Ana María López")).toMatchObject({ cliente: "Ana María López", montoUsd: "50.25" });
  });
});

describe("parser: cobranza", () => {
  it("quién me debe", () => {
    expect(parseIntent("¿quién me debe?")).toEqual({ tipo: "quien_debe" });
    expect(parseIntent("quienes me deben")).toEqual({ tipo: "quien_debe" });
  });
  it("recordatorios", () => {
    expect(parseIntent("recordale a Juan su factura")).toEqual({ tipo: "recordatorio", cliente: "Juan" });
    expect(parseIntent("mandale un recordatorio a María por la A-123")).toEqual({
      tipo: "recordatorio", cliente: "María", factura: "A-123",
    });
  });
});

describe("parser: lo que no entiende (nunca adivina con dinero)", () => {
  it.each([
    "hola qué tal",
    "cobrale $50",
    "cobrale 1,5 a Juan",
    "cobrale 1.200,50 a Juan",
    "cobrale $50 a Juan por la factura A-123 y $60",
    "recordale",
    "",
  ])("«%s» → no_entendido", (t) => {
    expect(parseIntent(t)).toEqual({ tipo: "no_entendido" });
  });
});

describe("parseAmount: Decimal, no float", () => {
  it("normaliza a 2 decimales", () => {
    expect(parseAmount("$50")).toBe("50.00");
    expect(parseAmount("50")).toBe("50.00");
    expect(parseAmount("50.5")).toBe("50.50");
    expect(parseAmount("1,200.50")).toBe("1200.50");
    expect(parseAmount("0.1")).toBe("0.10");
  });
  it("rechaza ambiguos, ceros y 3 decimales", () => {
    for (const bad of ["1,5", "1.200,50", "0", "50.123", "abc", "12,34"]) expect(parseAmount(bad)).toBeUndefined();
  });
});
