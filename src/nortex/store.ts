/**
 * Store en memoria para el demo y los tests. Cumple el mismo contrato que
 * cumpliría el adaptador Prisma contra el Nortex real (ver tipos.ts):
 * transacción atómica (snapshot + rollback) e idempotencia por capture id.
 */
import type {
  AuditEvent,
  LedgerEntry,
  NortexStore,
  Payment,
  Sale,
} from "./types.js";

interface State {
  sales: Map<string, Sale>;
  payments: Map<string, Payment>; // clave: paypalCaptureId
  ledger: LedgerEntry[];
  audit: AuditEvent[];
}

const saleKey = (tenantId: string, saleId: string) => `${tenantId}:${saleId}`;

export class InMemoryNortexStore implements NortexStore {
  private state: State = {
    sales: new Map(),
    payments: new Map(),
    ledger: [],
    audit: [],
  };

  getSale(tenantId: string, saleId: string): Sale | undefined {
    const sale = this.state.sales.get(saleKey(tenantId, saleId));
    return sale ? { ...sale } : undefined;
  }

  findSaleByPaypalOrderId(orderId: string): Sale | undefined {
    for (const sale of this.state.sales.values()) {
      if (sale.paypalOrderId === orderId) return { ...sale };
    }
    return undefined;
  }

  saveSale(sale: Sale): void {
    this.state.sales.set(saleKey(sale.tenantId, sale.id), { ...sale });
  }

  listSales(tenantId: string): Sale[] {
    return [...this.state.sales.values()]
      .filter((s) => s.tenantId === tenantId)
      .map((s) => ({ ...s }));
  }

  findPaymentByCaptureId(captureId: string): Payment | undefined {
    const payment = this.state.payments.get(captureId);
    return payment ? { ...payment } : undefined;
  }

  savePayment(payment: Payment): void {
    this.state.payments.set(payment.paypalCaptureId, { ...payment });
  }

  addLedgerEntry(entry: LedgerEntry): void {
    this.state.ledger.push({ ...entry, lines: entry.lines.map((l) => ({ ...l })) });
  }

  addAudit(event: AuditEvent): void {
    this.state.audit.push({ ...event });
  }

  listPayments(tenantId: string): Payment[] {
    return [...this.state.payments.values()]
      .filter((p) => p.tenantId === tenantId)
      .map((p) => ({ ...p }));
  }

  listLedgerEntries(tenantId: string): LedgerEntry[] {
    return this.state.ledger
      .filter((e) => e.tenantId === tenantId)
      .map((e) => ({ ...e, lines: e.lines.map((l) => ({ ...l })) }));
  }

  listAudit(tenantId?: string): AuditEvent[] {
    return this.state.audit
      .filter((a) => tenantId === undefined || a.tenantId === tenantId)
      .map((a) => ({ ...a }));
  }

  transaction<T>(fn: () => T): T {
    const snapshot: State = {
      sales: new Map([...this.state.sales].map(([k, v]) => [k, { ...v }])),
      payments: new Map([...this.state.payments].map(([k, v]) => [k, { ...v }])),
      ledger: [...this.state.ledger],
      audit: [...this.state.audit],
    };
    try {
      return fn();
    } catch (err) {
      this.state = snapshot;
      throw err;
    }
  }
}
