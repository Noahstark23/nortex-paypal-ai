/**
 * E2E por HTTP real (servidor en puerto efímero, gateway falso):
 * el flujo diáspora completo + las defensas (duplicado, firma mala,
 * tarjeta declinada) tal como lo vería un juez del hackathon.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { FakePaypalGateway } from "../src/paypal/fake.js";
import { InMemoryNortexStore } from "../src/nortex/store.js";
import { ReconciliationService } from "../src/nortex/reconciliation.js";
import { createApp } from "../src/server/app.js";
import { DEMO_SALE, DEMO_SALE_ID, DEMO_TENANT } from "../src/demo/seed.js";

let server: Server;
let base: string;
let gateway: FakePaypalGateway;
let store: InMemoryNortexStore;

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: (await res.json()) as Record<string, any> };
}

beforeAll(async () => {
  store = new InMemoryNortexStore();
  store.saveSale({ ...DEMO_SALE });
  gateway = new FakePaypalGateway();
  server = createApp({ gateway, store, reconciliation: new ReconciliationService(store) });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => server.close());

describe("E2E diáspora: crear orden → aprobar → capturar → conciliar", () => {
  let orderId: string;
  let captureId: string;

  it("crear la orden deja la venta PENDIENTE (jamás pagada al crear)", async () => {
    const created = await call("POST", "/api/integrations/paypal/orders", {
      tenantId: DEMO_TENANT,
      saleId: DEMO_SALE_ID,
    });
    expect(created.status).toBe(201);
    orderId = created.json.orderId;
    expect(created.json.approveUrl).toContain("sandbox.paypal.com");
    expect(created.json.mensaje).toContain(DEMO_SALE.dgiNumber);

    const state = await call("GET", `/api/demo/sales/${DEMO_TENANT}/${DEMO_SALE_ID}`);
    expect(state.json.sale.status).toBe("pending");
  });

  it("capturar tras la aprobación concilia: venta pagada, un pago, asientos", async () => {
    gateway.approve(orderId);
    const captured = await call("POST", `/api/integrations/paypal/orders/${orderId}/capture`);
    expect(captured.status).toBe(200);
    captureId = captured.json.capture.captureId;
    expect(captured.json.reconciliation.status).toBe("applied");

    const state = await call("GET", `/api/demo/sales/${DEMO_TENANT}/${DEMO_SALE_ID}`);
    expect(state.json.sale.status).toBe("paid");
    expect(state.json.payments).toHaveLength(1);
    expect(state.json.payments[0].paypalCaptureId).toBe(captureId);
    expect(state.json.ledger).toHaveLength(2);
  });

  it("el webhook COMPLETED que llega DESPUÉS es no-op (idempotencia cruzada)", async () => {
    const capture = { orderId, captureId, status: "COMPLETED", grossUsd: "50.00", feeUsd: "2.24", netUsd: "47.76", currency: "USD" };
    const event = gateway.buildCaptureCompletedEvent(capture, `nortex-${DEMO_TENANT}-${DEMO_SALE_ID}`);
    const res = await call("POST", "/api/integrations/paypal/webhook", event);
    expect(res.status).toBe(200);
    expect(res.json.reconciliation.status).toBe("duplicate_ignored");
    expect(store.listPayments(DEMO_TENANT)).toHaveLength(1);
    expect(store.listLedgerEntries(DEMO_TENANT)).toHaveLength(2);
  });

  it("webhook con firma inválida → 401 y no se aplica nada (fail closed)", async () => {
    gateway.signatureValid = false;
    const res = await call("POST", "/api/integrations/paypal/webhook", {
      id: "EV-MALA",
      event_type: "PAYMENT.CAPTURE.COMPLETED",
      resource: { id: "CAP-FALSA", custom_id: `nortex-${DEMO_TENANT}-${DEMO_SALE_ID}` },
    });
    expect(res.status).toBe(401);
    gateway.signatureValid = true;
    expect(store.findPaymentByCaptureId("CAP-FALSA")).toBeUndefined();
    expect(store.listAudit().some((a) => a.action === "webhook.signature_invalid")).toBe(true);
  });

  it("tarjeta declinada al capturar → 402 con mensaje claro, sin tocar la venta", async () => {
    const store2 = new InMemoryNortexStore();
    store2.saveSale({ ...DEMO_SALE, id: "venta-declinada" });
    const gw2 = new FakePaypalGateway();
    const server2 = createApp({ gateway: gw2, store: store2, reconciliation: new ReconciliationService(store2) });
    await new Promise<void>((resolve) => server2.listen(0, resolve));
    const base2 = `http://127.0.0.1:${(server2.address() as AddressInfo).port}`;
    try {
      const created = await fetch(`${base2}/api/integrations/paypal/orders`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tenantId: DEMO_TENANT, saleId: "venta-declinada" }),
      }).then((r) => r.json() as Promise<Record<string, any>>);
      gw2.approve(created.orderId);
      gw2.failNextCaptureWith = "INSTRUMENT_DECLINED";
      const res = await fetch(`${base2}/api/integrations/paypal/orders/${created.orderId}/capture`, { method: "POST" });
      const json = (await res.json()) as Record<string, any>;
      expect(res.status).toBe(402);
      expect(json.error).toMatch(/tarjeta fue rechazada/i);
      expect(store2.getSale(DEMO_TENANT, "venta-declinada")!.status).toBe("pending");
      expect(store2.listPayments(DEMO_TENANT)).toHaveLength(0);
    } finally {
      server2.close();
    }
  });
});
