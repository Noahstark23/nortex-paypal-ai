/**
 * Parser DETERMINISTA de intenciones del comerciante (sin LLM).
 *
 * Regla de oro: con dinero jamás se adivina. Si el texto trae un monto que no
 * se puede leer sin ambigüedad (o dos montos), la intención es `no_entendido`
 * y el agente pide aclaración. Los montos se normalizan a string Decimal con
 * 2 decimales vía `src/money` — nunca pasan por number/float.
 */
import { Decimal } from "../money/decimal.js";

export type Intent =
  | { tipo: "cobrar"; cliente: string; factura?: string; montoUsd?: string }
  | { tipo: "recordatorio"; cliente: string; factura?: string }
  | { tipo: "quien_debe" }
  | { tipo: "no_entendido" };

/** Minúsculas sin acentos/diacríticos, preservando el largo (para mapear índices al original). */
export function fold(s: string): string {
  return Array.from(s.normalize("NFC"))
    .map((c) => {
      const f = c.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
      return f.length === c.length ? f : c;
    })
    .join("");
}

/** Normalización para comparar nombres: sin acentos, sin mayúsculas, solo alfanumérico y espacios. */
export function normalizeName(s: string): string {
  return fold(s).replace(/[^a-z0-9ñ]+/g, " ").trim();
}

/** Clave canónica de factura: letras + número sin ceros a la izquierda ("A-000123" ≡ "a123"). */
export function invoiceKey(raw: string): string {
  const m = /^([a-z]*)[\s-]*0*(\d+)$/.exec(fold(raw).trim());
  return m ? `${m[1]}${m[2]}` : fold(raw).replace(/[^a-z0-9]/g, "");
}

/**
 * Lee un monto escrito ("50", "50.25", "1,200.50", "$1,200") a string Decimal de
 * 2 decimales. Devuelve undefined si es ambiguo o inválido (ej. "1,5", "1.200,50").
 */
export function parseAmount(raw: string): string | undefined {
  const t = raw.replace(/^\$\s*/, "").trim();
  const grouped = /^\d{1,3}(,\d{3})+(\.\d{1,2})?$/.test(t);
  const plain = /^\d+(\.\d{1,2})?$/.test(t);
  if (!grouped && !plain) return undefined;
  const d = Decimal.from(t.replace(/,/g, ""));
  if (d.isZero()) return undefined;
  return d.toFixed(2);
}

const NUM = String.raw`\d[\d.,]*`;
const RE_INVOICE = new RegExp(
  String.raw`(?:\b(?:por|de|con)\s+)?(?:\b(?:la|su|esa|esta|el)\s+)?(?:\bfactura\b|\bfact\b\.?)\s*(?:(?:numero|nro|num|no|n°|nº|#)\.?\s*)?([a-z]{0,3}[\s-]?\d+)` +
    String.raw`|(?:\b(?:por|de|con)\s+)?\b(?:la|su)\s+([a-z]-?\d+)\b` +
    String.raw`|\b(?:por|de|con)\s+(?:la\s+)?([a-z]-\d+)\b` +
    String.raw`|(?:\b(?:por|de|con)\s+)?(?:\b(?:la|su|esa|esta|el)\s+)?\bfactura\b`,
  "g",
);
const RE_MONEY = new RegExp(
  String.raw`\$\s*(${NUM})|(${NUM})\s*(?:dolares|dolar|usd|us\$|\$)|\b(${NUM})\b`,
  "g",
);

function blank(s: string, start: number, end: number): string {
  return s.slice(0, start) + " ".repeat(end - start) + s.slice(end);
}

export function parseIntent(text: string): Intent {
  const original = text.normalize("NFC");
  let f = fold(original);

  const quienDebe =
    /\b(quien(es)?\s+(me\s+)?deben?|a\s+quien\s+le\s+(cobro|tengo\s+que\s+cobrar)|cuanto\s+me\s+deben|me\s+deben|facturas?\s+pendientes?|cuentas?\s+por\s+cobrar)\b/;
  const recordar = /\b(record[a]le|recordar(le)?|recordatorio)\b/;
  const cobrar =
    /\b(cobr[a]le|cobr[ae]rle|cobrar|cobrar?le|pas[a]le\s+(el\s+)?(link|enlace)|mand[a]le\s+(el\s+)?(link|enlace)|envi[a]le\s+(el\s+)?(link|enlace))\b/;

  let tipo: "cobrar" | "recordatorio" | "quien_debe";
  if (quienDebe.test(f) && !recordar.test(f) && !cobrar.test(f)) tipo = "quien_debe";
  else if (recordar.test(f)) tipo = "recordatorio";
  else if (cobrar.test(f)) tipo = "cobrar";
  else return { tipo: "no_entendido" };
  if (tipo === "quien_debe") return { tipo };

  // 1) Factura (se extrae primero para que su número no se confunda con un monto).
  let factura: string | undefined;
  for (const m of [...f.matchAll(RE_INVOICE)]) {
    const code = m[1] ?? m[2] ?? m[3];
    if (code && factura === undefined) factura = original.slice(m.index! + m[0].length - code.length, m.index! + m[0].length).trim();
    f = blank(f, m.index!, m.index! + m[0].length);
  }
  if (factura !== undefined) factura = factura.toUpperCase().replace(/\s+/g, "");

  // 2) Monto: exactamente uno o ninguno; cualquier cosa rara = no se adivina.
  const amounts: string[] = [];
  for (const m of [...f.matchAll(RE_MONEY)]) {
    const raw = (m[1] ?? m[2] ?? m[3])!;
    const parsed = parseAmount(raw);
    if (parsed === undefined) return { tipo: "no_entendido" };
    amounts.push(parsed);
    f = blank(f, m.index!, m.index! + m[0].length);
  }
  if (amounts.length > 1) return { tipo: "no_entendido" };
  const montoUsd = amounts[0];

  // 3) Cliente: lo que sigue a la primera " a " después del verbo.
  const verb = (recordar.exec(f) ?? cobrar.exec(f))!;
  const afterVerb = f.slice(verb.index + verb[0].length);
  const base = verb.index + verb[0].length;
  const am = /(?:^|\s)a\s+(\S.*)$/.exec(afterVerb);
  if (!am) return { tipo: "no_entendido" };
  const startIdx = base + am.index + am[0].length - am[1]!.length;
  let name = original.slice(startIdx, startIdx + am[1]!.length);
  // En la versión plegada quedan recortes (espacios del blanking): limpiar conectores sueltos.
  name = name
    .replace(/\s+/g, " ")
    .replace(/\s+(por|de|con|su|la|el|esa|esta|dolares|usd|y)\s*$/i, "")
    .replace(/[¿?¡!.,;:]+$/g, "")
    .trim();
  // Los trozos blanqueados dejaron huecos con texto original: recortar al primer hueco.
  const gap = f.slice(startIdx, startIdx + am[1]!.length).search(/\s{2,}/);
  if (gap >= 0) {
    name = original
      .slice(startIdx, startIdx + gap)
      .replace(/\s+/g, " ")
      .replace(/\s+(por|de|con|su|la|el|esa|esta|y)\s*$/i, "")
      .replace(/[¿?¡!.,;:]+$/g, "")
      .trim();
  }
  if (!name || !/[a-zñ]/i.test(fold(name))) return { tipo: "no_entendido" };

  if (tipo === "recordatorio") {
    return { tipo, cliente: name, ...(factura ? { factura } : {}) };
  }
  return {
    tipo,
    cliente: name,
    ...(factura ? { factura } : {}),
    ...(montoUsd ? { montoUsd } : {}),
  };
}
