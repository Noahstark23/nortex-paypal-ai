/**
 * Agente de cobro y cobranza (F2, núcleo local). Ejecuta una intención ya
 * parseada contra el NortexStore + PaypalGateway, SIEMPRE acotado a un único
 * tenantId fijo del contexto: ningún dato de otro tenant es alcanzable.
 */
import { Decimal } from "../money/decimal.js";
import type { NortexStore, Sale } from "../nortex/types.js";
import type { PaypalGateway } from "../paypal/types.js";
import {
  MSG_NO_ENTENDIDO,
  formatUsd,
  mensajeLinkPago,
  mensajeRecordatorio,
  msgAmbiguo,
  msgMontoNoCalza,
  msgNoEncontrada,
  msgResumenDeudas,
} from "./messages.js";
import { invoiceKey, normalizeName, parseIntent, type Intent } from "./parser.js";

export interface AgentReply {
  tipo: Intent["tipo"];
  /** Respuesta para el comerciante (voseo). */
  texto: string;
  /** Link de aprobación PayPal (solo si hay orden). */
  linkPago?: string;
  /** Mensaje listo para mandarle al cliente. */
  mensajeWhatsApp?: string;
  saleId?: string;
  /** true solo si ESTA ejecución creó la orden PayPal. */
  ordenNueva?: boolean;
}

export interface AgentContext {
  store: NortexStore;
  gateway: PaypalGateway;
  tenantId: string;
}

type Resolution =
  | { kind: "one"; sale: Sale }
  | { kind: "reply"; reply: Omit<AgentReply, "tipo"> };

export class CobroAgent {
  /** Órdenes en vuelo por venta: dos comandos simultáneos no crean dos órdenes. */
  private readonly inflight = new Map<string, Promise<{ link: string; nueva: boolean } | undefined>>();

  constructor(private readonly ctx: AgentContext) {}

  async handle(text: string): Promise<AgentReply> {
    return this.execute(parseIntent(text));
  }

  async execute(intent: Intent): Promise<AgentReply> {
    switch (intent.tipo) {
      case "no_entendido":
        return { tipo: "no_entendido", texto: MSG_NO_ENTENDIDO };
      case "quien_debe": {
        const pend = this.pendientes().sort((a, b) => a.dgiNumber.localeCompare(b.dgiNumber));
        return { tipo: "quien_debe", texto: msgResumenDeudas(pend) };
      }
      case "cobrar": {
        const r = this.resolve(intent.cliente, intent.factura, intent.montoUsd);
        if (r.kind === "reply") return { tipo: "cobrar", ...r.reply };
        const orden = await this.ensureOrder(r.sale);
        if (!orden) return { tipo: "cobrar", saleId: r.sale.id, texto: msgSinLink(r.sale) };
        const mensajeWhatsApp = mensajeLinkPago(r.sale, orden.link);
        return {
          tipo: "cobrar",
          saleId: r.sale.id,
          linkPago: orden.link,
          mensajeWhatsApp,
          ordenNueva: orden.nueva,
          texto: `${orden.nueva ? "Listo, creé" : "Ya tenías"} el link de pago de ${formatUsd(r.sale.amountUsd)} para ${r.sale.customerName} (factura ${r.sale.dgiNumber}). Copiá este mensaje y mandáselo:\n\n${mensajeWhatsApp}`,
        };
      }
      case "recordatorio": {
        const r = this.resolve(intent.cliente, intent.factura);
        if (r.kind === "reply") return { tipo: "recordatorio", ...r.reply };
        const orden = await this.ensureOrder(r.sale);
        const mensajeWhatsApp = mensajeRecordatorio(r.sale, orden?.link);
        return {
          tipo: "recordatorio",
          saleId: r.sale.id,
          linkPago: orden?.link,
          mensajeWhatsApp,
          ordenNueva: orden?.nueva ?? false,
          texto: `Acá tenés el recordatorio para ${r.sale.customerName} (factura ${r.sale.dgiNumber}, ${formatUsd(r.sale.amountUsd)}):\n\n${mensajeWhatsApp}`,
        };
      }
    }
  }

  private pendientes(): Sale[] {
    return this.ctx.store.listSales(this.ctx.tenantId).filter((s) => s.status === "pending");
  }

  private resolve(cliente: string, factura?: string, montoUsd?: string): Resolution {
    const all = this.ctx.store.listSales(this.ctx.tenantId);
    const matches = (s: Sale) => {
      if (!coincideNombre(cliente, s.customerName)) return false;
      return factura === undefined || invoiceKey(factura) === invoiceKey(s.dgiNumber);
    };
    const candidatas = all.filter((s) => s.status === "pending" && matches(s));

    if (candidatas.length === 0) {
      const yaPagada = all.some((s) => s.status === "paid" && matches(s));
      return { kind: "reply", reply: { texto: msgNoEncontrada(cliente, factura, yaPagada) } };
    }

    let elegibles = candidatas;
    if (montoUsd !== undefined) {
      // Comparación Decimal-exacta contra el monto de la venta (nunca se cobra otro).
      const iguales = candidatas.filter((s) => Decimal.from(s.amountUsd).equals(Decimal.from(montoUsd)));
      if (iguales.length === 0) {
        return { kind: "reply", reply: { texto: msgMontoNoCalza(montoUsd, candidatas) } };
      }
      elegibles = iguales;
    }
    if (elegibles.length > 1) {
      return { kind: "reply", reply: { texto: msgAmbiguo(cliente, elegibles) } };
    }
    return { kind: "one", sale: elegibles[0]! };
  }

  /** Reusa la orden de la venta si existe; si no, crea UNA. undefined = hay orden pero sin link guardado. */
  private ensureOrder(sale: Sale): Promise<{ link: string; nueva: boolean } | undefined> {
    const key = `${sale.tenantId}:${sale.id}`;
    const running = this.inflight.get(key);
    if (running) return running.then((r) => (r ? { ...r, nueva: false } : r));
    const p = this.createOrReuse(sale.tenantId, sale.id).finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  private async createOrReuse(
    tenantId: string,
    saleId: string,
  ): Promise<{ link: string; nueva: boolean } | undefined> {
    const { store, gateway } = this.ctx;
    const sale = store.getSale(tenantId, saleId);
    if (!sale || sale.status !== "pending") return undefined;
    if (sale.paypalOrderId) {
      // Si no guardamos el link NO creamos otra orden: dos órdenes abiertas = riesgo de doble cobro.
      return sale.paypalApproveUrl ? { link: sale.paypalApproveUrl, nueva: false } : undefined;
    }
    const order = await gateway.createOrder({
      tenantId: sale.tenantId,
      saleId: sale.id,
      amountUsd: sale.amountUsd,
      description: `Factura ${sale.dgiNumber} — ${sale.description}`,
    });
    store.saveSale({
      ...sale,
      paypalOrderId: order.orderId,
      paypalApproveUrl: order.approveUrl,
      status: "pending",
    });
    store.addAudit({
      id: `aud-agent-${order.orderId}`,
      tenantId,
      action: "agent_order_created",
      detail: `Agente F2 creó la orden ${order.orderId} para ${sale.dgiNumber}`,
      at: new Date().toISOString(),
    });
    return { link: order.approveUrl, nueva: true };
  }
}

function msgSinLink(sale: Sale): string {
  return `La factura ${sale.dgiNumber} ya tiene una orden PayPal abierta, pero no tengo guardado su link y no quiero crear otra (podrían cobrarle dos veces). Revisala en PayPal o pedile a soporte que la regenere.`;
}

/** Todos los tokens del nombre buscado deben estar completos en el del cliente ("juan" no calza "juanita"). */
function coincideNombre(buscado: string, nombreCliente: string): boolean {
  const tokens = new Set(normalizeName(nombreCliente).split(" "));
  const q = normalizeName(buscado).split(" ").filter(Boolean);
  return q.length > 0 && q.every((t) => tokens.has(t));
}
