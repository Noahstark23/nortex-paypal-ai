/**
 * Demo de punta a punta SIN credenciales (gateway falso, datos sintéticos):
 *
 *   crear orden → el familiar en EE. UU. aprueba → capturar → concilia solo
 *   → webhook duplicado (no-op) → webhook con firma mala (rechazado).
 *
 * Es el mismo recorrido que graba el video del hackathon (ver README).
 * Uso: npm run demo   (sale con código != 0 si algo no cuadra)
 */
import type { AddressInfo } from "node:net";
import { FakePaypalGateway } from "../paypal/fake.js";
import { ReconciliationService } from "../nortex/reconciliation.js";
import { createApp } from "../server/app.js";
import { createDemoStore, DEMO_SALE_ID, DEMO_TENANT } from "./seed.js";

const log = (s: string) => console.log(s);
let failures = 0;
const check = (ok: boolean, label: string) => {
  log(`  ${ok ? "✓" : "✗ FALLO"} ${label}`);
  if (!ok) failures += 1;
};

async function main(): Promise<void> {
  const store = createDemoStore();
  const gateway = new FakePaypalGateway();
  const reconciliation = new ReconciliationService(store);
  const server = createApp({ gateway, store, reconciliation });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, json: (await res.json()) as Record<string, any> };
  };

  try {
    log("\n═══ NORTEX PAY AI — demo diáspora (sandbox, datos sintéticos) ═══\n");
    log("1) Doña Carmen (Estelí) cobra desde Nortex: «cobrale $50 a mi hijo por la factura A-000123».");
    const created = await call("POST", "/api/integrations/paypal/orders", {
      tenantId: DEMO_TENANT,
      saleId: DEMO_SALE_ID,
    });
    check(created.status === 201, `orden creada (${created.json.orderId})`);
    log(`   → link de pago para el familiar en EE. UU.: ${created.json.approveUrl}`);
    const pending = await call("GET", `/api/demo/sales/${DEMO_TENANT}/${DEMO_SALE_ID}`);
    check(pending.json.sale.status === "pending", "la venta sigue PENDIENTE tras crear la orden");

    log("\n2) El hijo aprueba el pago en PayPal (USD) y Nortex captura:");
    gateway.approve(created.json.orderId as string);
    const captured = await call(
      "POST",
      `/api/integrations/paypal/orders/${created.json.orderId}/capture`,
    );
    check(captured.status === 200, `captura ${captured.json.capture?.captureId} COMPLETED`);
    log(
      `   → bruto ${captured.json.capture?.grossUsd} USD, comisión PayPal ${captured.json.capture?.feeUsd} USD (costo aparte), neto ${captured.json.capture?.netUsd} USD`,
    );

    log("\n3) Conciliación automática en Nortex:");
    const state = await call("GET", `/api/demo/sales/${DEMO_TENANT}/${DEMO_SALE_ID}`);
    check(state.json.sale.status === "paid", "la factura quedó PAGADA");
    check(state.json.payments.length === 1, "exactamente UNA fila de pago");
    check(state.json.ledger.length === 2, "dos asientos: cobro + comisión por separado");
    const debits = state.json.ledger.flatMap((e: any) => e.lines).reduce(
      (acc: number, l: any) => acc + Math.round(Number(l.debitNio) * 100),
      0,
    );
    const credits = state.json.ledger.flatMap((e: any) => e.lines).reduce(
      (acc: number, l: any) => acc + Math.round(Number(l.creditNio) * 100),
      0,
    );
    check(debits === credits, `partida doble balanceada (débitos = créditos = C$${(debits / 100).toFixed(2)})`);
    log(`   → pago registrado con tasa FX ${state.json.payments[0].fxRateUsdNio} (C$${state.json.payments[0].grossNio} brutos)`);

    log("\n4) PayPal reenvía el MISMO webhook (pasa seguido): debe ser no-op.");
    const capture = captured.json.capture;
    const event = gateway.buildCaptureCompletedEvent(
      {
        orderId: capture.orderId,
        captureId: capture.captureId,
        status: "COMPLETED",
        grossUsd: capture.grossUsd,
        feeUsd: capture.feeUsd,
        netUsd: capture.netUsd,
        currency: "USD",
      },
      `nortex-${DEMO_TENANT}-${DEMO_SALE_ID}`,
    );
    const dup = await call("POST", "/api/integrations/paypal/webhook", event);
    check(dup.json.reconciliation?.status === "duplicate_ignored", "duplicado ignorado");
    const after = await call("GET", `/api/demo/sales/${DEMO_TENANT}/${DEMO_SALE_ID}`);
    check(after.json.payments.length === 1, "sigue habiendo UN solo pago (sin doble cobro)");

    log("\n5) Webhook con firma inválida: fail closed, no se aplica nada.");
    gateway.signatureValid = false;
    const bad = await call("POST", "/api/integrations/paypal/webhook", event);
    check(bad.status === 401, "rechazado con 401 y registrado en auditoría");

    log(failures === 0 ? "\n═══ DEMO OK: flujo completo conciliado ═══\n" : "\n═══ DEMO CON FALLOS ═══\n");
  } finally {
    server.close();
  }
  if (failures > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
