/**
 * Plantillas en voseo nica. Son TEXTO listo para enviar (WhatsApp Business API
 * queda fuera de F2-núcleo). Tono educado y sin presión indebida: es cobranza a
 * clientes de un negocio familiar. Los montos salen de strings Decimal.
 */
import { Decimal } from "../money/decimal.js";
import type { Sale } from "../nortex/types.js";

/** "1200.5" → "$1,200.50" (solo formato; la aritmética sigue siendo Decimal). */
export function formatUsd(amount: string): string {
  const fixed = Decimal.from(amount).toFixed(2);
  const neg = fixed.startsWith("-");
  const [int, frac] = (neg ? fixed.slice(1) : fixed).split(".");
  const grouped = int!.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${neg ? "-" : ""}$${grouped}.${frac}`;
}

/** Nombre para saludar: sin el paréntesis de aclaración ("Familia Pineda (EE. UU.)" → "Familia Pineda"). */
export function saludoNombre(customerName: string): string {
  return customerName.replace(/\s*\([^)]*\)\s*/g, " ").replace(/\s+/g, " ").trim();
}

export function mensajeLinkPago(sale: Sale, linkPago: string): string {
  return [
    `Hola ${saludoNombre(sale.customerName)}, ¿cómo estás? 👋`,
    `Te paso el link para pagar la factura ${sale.dgiNumber} por ${formatUsd(sale.amountUsd)} (USD):`,
    linkPago,
    "Podés pagar con tu cuenta PayPal o con tarjeta, cuando te quede cómodo.",
    "Cualquier duda, escribime. ¡Muchas gracias!",
  ].join("\n");
}

export function mensajeRecordatorio(sale: Sale, linkPago?: string): string {
  const lineas = [
    `Hola ${saludoNombre(sale.customerName)}, ¿cómo estás? 👋`,
    `Te escribo para recordarte, con mucho cariño, que la factura ${sale.dgiNumber} por ${formatUsd(sale.amountUsd)} (USD) sigue pendiente.`,
  ];
  if (linkPago) {
    lineas.push("Si te queda cómodo, la podés pagar acá:", linkPago);
  }
  lineas.push(
    "Si ya la pagaste, ignorá este mensaje y disculpá la molestia.",
    "Cualquier cosa, avisame. ¡Gracias por tu apoyo!",
  );
  return lineas.join("\n");
}

export const MSG_NO_ENTENDIDO =
  "No te entendí bien y con plata prefiero no adivinar. ¿Me lo decís de nuevo? " +
  "Por ejemplo: «cobrale $50 a Juan por la factura A-123», «recordale a María su factura» o «¿quién me debe?».";

export function msgNoEncontrada(cliente: string, factura?: string, yaPagada = false): string {
  if (yaPagada) {
    return `No hay nada por cobrarle a ${cliente}${factura ? ` en la factura ${factura}` : ""}: esa factura ya está pagada. 🎉`;
  }
  return `No encontré ninguna factura pendiente para ${cliente}${factura ? ` con el número ${factura}` : ""}. ¿Me confirmás el nombre o el número de factura?`;
}

export function msgAmbiguo(cliente: string, opciones: Sale[]): string {
  const lista = opciones
    .map((s, i) => `${i + 1}. ${s.dgiNumber} — ${s.customerName} — ${formatUsd(s.amountUsd)}`)
    .join("\n");
  return `Encontré más de una factura pendiente para ${cliente}:\n${lista}\n¿Cuál querés cobrar? Decime el número de factura (ejemplo: «cobrale a ${cliente} la factura ${opciones[0]!.dgiNumber}»).`;
}

export function msgMontoNoCalza(montoUsd: string, opciones: Sale[]): string {
  const lista = opciones.map((s) => `${s.dgiNumber}: ${formatUsd(s.amountUsd)}`).join("; ");
  return `Me pediste cobrar ${formatUsd(montoUsd)}, pero lo pendiente es ${lista}. No cobro un monto distinto al de la factura. ¿Cuál es el correcto?`;
}

export function msgResumenDeudas(pendientes: Sale[]): string {
  if (pendientes.length === 0) return "No tenés facturas pendientes de cobro. ¡Todo al día! 🎉";
  const total = pendientes.reduce((acc, s) => acc.add(Decimal.from(s.amountUsd)), Decimal.zero());
  const lista = pendientes
    .map((s) => `• ${s.customerName} — factura ${s.dgiNumber} — ${formatUsd(s.amountUsd)}`)
    .join("\n");
  return `Te deben ${formatUsd(total.toFixed(2))} en ${pendientes.length} factura${pendientes.length === 1 ? "" : "s"}:\n${lista}`;
}
