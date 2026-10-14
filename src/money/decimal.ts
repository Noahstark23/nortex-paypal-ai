/**
 * Decimal exacto para dinero (regla nortex-senior: NUNCA float con plata).
 *
 * Implementación mínima sobre BigInt: coeficiente entero + escala.
 * - La API de PayPal recibe montos como string ("50.00").
 * - Nortex contabiliza en Decimal; la tasa FX usada queda registrada en el pago.
 * - El redondeo es half-up (comercial) y SOLO ocurre donde se pide explícito
 *   (roundTo), nunca escondido en una operación.
 */
export class Decimal {
  private constructor(
    private readonly coef: bigint,
    private readonly scale: number,
  ) {}

  static from(value: string | Decimal): Decimal {
    if (value instanceof Decimal) return value;
    if (typeof value !== "string") {
      throw new Error(
        `Decimal.from solo acepta string (recibido: ${typeof value}). ` +
          "El dinero jamás entra como number/float.",
      );
    }
    const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value.trim());
    if (!m) throw new Error(`Decimal inválido: "${value}"`);
    const [, sign, intPart, fracPart = ""] = m;
    const coef = BigInt(intPart + fracPart) * (sign === "-" ? -1n : 1n);
    return new Decimal(coef, fracPart.length);
  }

  static zero(): Decimal {
    return new Decimal(0n, 0);
  }

  /** Alinea dos decimales a la misma escala devolviendo coeficientes comparables. */
  private align(other: Decimal): [bigint, bigint, number] {
    const scale = Math.max(this.scale, other.scale);
    const a = this.coef * 10n ** BigInt(scale - this.scale);
    const b = other.coef * 10n ** BigInt(scale - other.scale);
    return [a, b, scale];
  }

  add(other: Decimal): Decimal {
    const [a, b, scale] = this.align(other);
    return new Decimal(a + b, scale);
  }

  sub(other: Decimal): Decimal {
    const [a, b, scale] = this.align(other);
    return new Decimal(a - b, scale);
  }

  mul(other: Decimal): Decimal {
    return new Decimal(this.coef * other.coef, this.scale + other.scale);
  }

  cmp(other: Decimal): number {
    const [a, b] = this.align(other);
    return a < b ? -1 : a > b ? 1 : 0;
  }

  equals(other: Decimal): boolean {
    return this.cmp(other) === 0;
  }

  isZero(): boolean {
    return this.coef === 0n;
  }

  isNegative(): boolean {
    return this.coef < 0n;
  }

  /** Redondeo half-up a la escala pedida (ej. 2 para centavos). */
  roundTo(scale: number): Decimal {
    if (scale >= this.scale) {
      return new Decimal(this.coef * 10n ** BigInt(scale - this.scale), scale);
    }
    const divisor = 10n ** BigInt(this.scale - scale);
    const negative = this.coef < 0n;
    const abs = negative ? -this.coef : this.coef;
    const quotient = abs / divisor;
    const remainder = abs % divisor;
    const rounded = remainder * 2n >= divisor ? quotient + 1n : quotient;
    return new Decimal(negative ? -rounded : rounded, scale);
  }

  /** String con exactamente `scale` decimales (default 2): formato API/contable. */
  toFixed(scale = 2): string {
    const r = this.roundTo(scale);
    const negative = r.coef < 0n;
    const digits = (negative ? -r.coef : r.coef).toString().padStart(scale + 1, "0");
    const intPart = scale === 0 ? digits : digits.slice(0, -scale);
    const fracPart = scale === 0 ? "" : `.${digits.slice(-scale)}`;
    return `${negative ? "-" : ""}${intPart}${fracPart}`;
  }

  toString(): string {
    return this.toFixed(this.scale);
  }
}
