/**
 * Datos SINTÉTICOS del demo (ningún cliente real): el flujo diáspora.
 * Doña Carmen (Estelí, Nicaragua) le cobra a su hijo en EE. UU. la factura
 * de la pulpería; él paga en USD con PayPal; Nortex concilia solo.
 */
import { InMemoryNortexStore } from "../nortex/store.js";
import type { Sale } from "../nortex/types.js";

export const DEMO_TENANT = "pulperia-la-bendicion";
export const DEMO_SALE_ID = "venta-1001";
/** Tasa de referencia del demo; la real se registra por pago al conciliar. */
export const DEMO_FX_RATE = "36.85";

export const DEMO_SALE: Sale = {
  tenantId: DEMO_TENANT,
  id: DEMO_SALE_ID,
  dgiNumber: "A-000123",
  customerName: "Familia Pineda (EE. UU.)",
  description: "Pulpería La Bendición — mercadería del mes",
  amountUsd: "50.00",
  status: "pending",
  fxRateUsdNio: DEMO_FX_RATE,
};

/** Segundo tenant: prueba viva de que la conciliación es multi-tenant. */
export const OTHER_TENANT_SALE: Sale = {
  tenantId: "ferreteria-el-clavo",
  id: "venta-2001",
  dgiNumber: "A-000777",
  customerName: "Cliente de otro negocio",
  description: "Ferretería El Clavo — materiales",
  amountUsd: "80.00",
  status: "pending",
  fxRateUsdNio: DEMO_FX_RATE,
};

export function createDemoStore(): InMemoryNortexStore {
  const store = new InMemoryNortexStore();
  store.saveSale({ ...DEMO_SALE });
  store.saveSale({ ...OTHER_TENANT_SALE });
  return store;
}
