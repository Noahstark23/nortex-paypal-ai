/**
 * Decimal: la plata es exacta o no es. Nada de 0.1 + 0.2 = 0.30000000000000004.
 */
import { describe, expect, it } from "vitest";
import { Decimal } from "../src/money/decimal.js";

describe("Decimal exacto (BigInt)", () => {
  it("suma sin error de float", () => {
    expect(Decimal.from("0.10").add(Decimal.from("0.20")).toFixed(2)).toBe("0.30");
    expect(Decimal.from("50.00").add(Decimal.from("0.01")).toFixed(2)).toBe("50.01");
  });

  it("resta y compara por valor, no por representación", () => {
    expect(Decimal.from("50.0").equals(Decimal.from("50.00"))).toBe(true);
    expect(Decimal.from("50.00").sub(Decimal.from("2.24")).toFixed(2)).toBe("47.76");
    expect(Decimal.from("49.99").cmp(Decimal.from("50.00"))).toBe(-1);
  });

  it("multiplica para FX y redondea half-up solo al pedirlo", () => {
    // 50 USD × 36.85 = 1842.50 NIO exactos
    expect(Decimal.from("50.00").mul(Decimal.from("36.85")).roundTo(2).toFixed(2)).toBe("1842.50");
    // half-up: 2.245 → 2.25 ; 2.244 → 2.24
    expect(Decimal.from("2.245").roundTo(2).toFixed(2)).toBe("2.25");
    expect(Decimal.from("2.244").roundTo(2).toFixed(2)).toBe("2.24");
  });

  it("comisión del fake: 50 × 3.49% + 0.49 = 2.24 (redondeo a centavos)", () => {
    const fee = Decimal.from("50.00").mul(Decimal.from("0.0349")).add(Decimal.from("0.49")).roundTo(2);
    expect(fee.toFixed(2)).toBe("2.24");
  });

  it("formatea siempre con 2 decimales para la API", () => {
    expect(Decimal.from("50").toFixed(2)).toBe("50.00");
    expect(Decimal.from("0.5").toFixed(2)).toBe("0.50");
  });

  it("rechaza numbers: el dinero jamás entra como float", () => {
    expect(() => Decimal.from(50 as unknown as string)).toThrow(/solo acepta string/);
    expect(() => Decimal.from("cincuenta")).toThrow(/inválido/);
  });
});
