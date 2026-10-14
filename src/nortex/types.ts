/**
 * Entidades Nortex del flujo PayPal. Todos los montos son strings Decimal
 * (jamás number) y TODA entidad cuelga de un tenantId: la conciliación es
 * multi-tenant por construcción — una referencia de un tenant jamás toca
 * la venta de otro.
 */

export type SaleStatus = "pending" | "paid" | "payment_failed";

export interface Sale {
  tenantId: string;
  id: string;
  /** Número de factura DGI (Serie A/B) tal como sale en el comprobante. */
  dgiNumber: string;
  customerName: string;
  description: string;
  /** Monto pendiente en USD (la diáspora paga en USD vía PayPal). */
  amountUsd: string;
  status: SaleStatus;
  /** Tasa FX USD→NIO vigente al emitir; si el pago la usa, queda registrada en el pago. */
  fxRateUsdNio: string;
  paypalOrderId?: string;
  /** Link de aprobación de la orden (F2): permite reusar la orden sin pedirle otra a PayPal. */
  paypalApproveUrl?: string;
}

export type PaymentStatus = "completed" | "refunded";

export interface Payment {
  id: string;
  /** LLAVE DE IDEMPOTENCIA: id de captura de PayPal. Único global. */
  paypalCaptureId: string;
  paypalOrderId: string;
  tenantId: string;
  saleId: string;
  grossUsd: string;
  /** Comisión de PayPal: costo separado, NUNCA un descuento (skill §4). */
  feeUsd: string;
  netUsd: string;
  currency: "USD";
  /** Tasa FX efectivamente usada en la conversión a NIO de los asientos. */
  fxRateUsdNio: string;
  grossNio: string;
  feeNio: string;
  status: PaymentStatus;
  source: "webhook" | "capture_endpoint";
  createdAt: string;
}

export type LedgerEntryKind =
  | "cobro_paypal"
  | "comision_paypal"
  | "reverso_cobro_paypal"
  | "reverso_comision_paypal";

export interface LedgerLine {
  account: string;
  /** Strings NIO con 2 decimales; uno de los dos es "0.00" por línea. */
  debitNio: string;
  creditNio: string;
}

export interface LedgerEntry {
  id: string;
  tenantId: string;
  saleId: string;
  kind: LedgerEntryKind;
  /** En un asiento sano, Σdébitos == Σcréditos (partida doble). */
  lines: LedgerLine[];
  paymentId: string;
  createdAt: string;
}

export interface AuditEvent {
  id: string;
  tenantId?: string;
  action: string;
  detail: string;
  at: string;
}

export interface NortexStore {
  getSale(tenantId: string, saleId: string): Sale | undefined;
  findSaleByPaypalOrderId(orderId: string): Sale | undefined;
  saveSale(sale: Sale): void;
  /** Ventas de UN tenant (F2: el agente nunca ve otro tenant). */
  listSales(tenantId: string): Sale[];
  findPaymentByCaptureId(captureId: string): Payment | undefined;
  savePayment(payment: Payment): void;
  addLedgerEntry(entry: LedgerEntry): void;
  addAudit(event: AuditEvent): void;
  listPayments(tenantId: string): Payment[];
  listLedgerEntries(tenantId: string): LedgerEntry[];
  listAudit(tenantId?: string): AuditEvent[];
  /**
   * Equivalente al $transaction de Prisma en el Nortex real: pago + asientos
   * + estado de la venta se aplican juntos o no se aplica nada.
   */
  transaction<T>(fn: () => T): T;
}
