import { beforeEach, describe, expect, it } from "vitest";
import { CobroAgent } from "../src/agent/agent.js";
import { formatUsd, mensajeLinkPago, mensajeRecordatorio } from "../src/agent/messages.js";
import { createAgentDemoStore, DEMO_TENANT, OTHER_TENANT_SALE } from "../src/demo/seed.js";
import { InMemoryNortexStore } from "../src/nortex/store.js";
import { FakePaypalGateway } from "../src/paypal/fake.js";

let store: InMemoryNortexStore;
let gateway: FakePaypalGateway;
let agent: CobroAgent;
let created: number;

beforeEach(() => {
  store = createAgentDemoStore();
  store.saveSale({ ...OTHER_TENANT_SALE, customerName: "Rosa Calderón" });
  gateway = new FakePaypalGateway();
  created = 0;
  const orig = gateway.createOrder.bind(gateway);
  gateway.createOrder = async (i) => { created += 1; return orig(i); };
  agent = new CobroAgent({ store, gateway, tenantId: DEMO_TENANT });
});

describe("agente: cobrar", () => {
  it("caso feliz: UNA orden, paypalOrderId guardado, link + mensaje", async () => {
    const r = await agent.handle("cobrale $75 a Juan por la factura A-124");
    expect(created).toBe(1);
    expect(r.ordenNueva).toBe(true);
    expect(r.linkPago).toMatch(/^https:\/\/www\.sandbox\.paypal\.com\//);
    expect(r.mensajeWhatsApp).toContain(r.linkPago!);
    const sale = store.getSale(DEMO_TENANT, "venta-1002")!;
    expect(sale.paypalOrderId).toBe("FAKE-ORDER-1");
    expect(sale.status).toBe("pending");
  });

  it("repetir el comando NO crea otra orden", async () => {
    const a = await agent.handle("cobrale a Juan la factura A-124");
    const b = await agent.handle("cobrale a Juan la factura A-124");
    expect(created).toBe(1);
    expect(b.ordenNueva).toBe(false);
    expect(b.linkPago).toBe(a.linkPago);
  });

  it("dos comandos simultáneos tampoco duplican", async () => {
    await Promise.all([agent.handle("cobrale a Juan"), agent.handle("cobrale a Juan")]);
    expect(created).toBe(1);
  });

  it("ambigüedad: lista opciones (número + monto) y no crea orden", async () => {
    const r = await agent.handle("cobrale a María");
    expect(created).toBe(0);
    expect(r.linkPago).toBeUndefined();
    expect(r.texto).toContain("A-000125");
    expect(r.texto).toContain("$1,200.50");
    expect(r.texto).toContain("A-000126");
    expect(r.texto).toContain("$35.25");
  });

  it("la factura desambigua; factura 'A-125' ≡ 'A-000125'", async () => {
    const r = await agent.handle("cobrale a María la factura A-125");
    expect(r.saleId).toBe("venta-1003");
    expect(created).toBe(1);
  });

  it("un monto que no calza con la factura NO se cobra", async () => {
    const r = await agent.handle("cobrale $99 a Juan por la factura A-124");
    expect(created).toBe(0);
    expect(r.texto).toContain("$99.00");
    expect(r.texto).toContain("$75.00");
  });

  it("venta pagada no cobra", async () => {
    const r = await agent.handle("cobrale a Pedro");
    expect(created).toBe(0);
    expect(r.texto).toMatch(/ya está pagada/);
  });

  it("tenant ajeno jamás aparece", async () => {
    const r = await agent.handle("cobrale a Rosa Calderón");
    expect(created).toBe(0);
    expect(r.texto).toMatch(/No encontré/);
    const debe = await agent.handle("¿quién me debe?");
    expect(debe.texto).not.toContain("Rosa");
    expect(debe.texto).not.toContain("A-000777");
    expect(store.getSale("ferreteria-el-clavo", "venta-2001")!.paypalOrderId).toBeUndefined();
  });

  it("nombres: sin acentos/mayúsculas; 'juan' no calza 'juanita'", async () => {
    store.saveSale({ tenantId: DEMO_TENANT, id: "v-j", dgiNumber: "B-1", customerName: "Juanita Ruiz", description: "x", amountUsd: "10.00", status: "pending", fxRateUsdNio: "36.85" });
    expect((await agent.handle("cobrale a MARIA lopez la A-126")).saleId).toBe("venta-1004");
    expect((await agent.handle("cobrale a juan")).saleId).toBe("venta-1002");
  });

  it("no_entendido responde en voseo pidiendo aclaración, sin orden", async () => {
    const r = await agent.handle("cobrale 1,5 a Juan");
    expect(r.tipo).toBe("no_entendido");
    expect(r.texto).toMatch(/¿Me lo decís de nuevo\?/);
    expect(created).toBe(0);
  });
});

describe("agente: cobranza", () => {
  it("quién me debe: solo pendientes del tenant, con total Decimal", async () => {
    const r = await agent.handle("¿quién me debe?");
    expect(r.texto).toContain("$1,360.75 en 4 facturas");
    expect(r.texto).not.toContain("Pedro");
  });

  it("recordatorio sin orden previa crea una y no la duplica al repetir", async () => {
    const a = await agent.handle("recordale a Juan su factura");
    expect(created).toBe(1);
    expect(a.mensajeWhatsApp).toContain(a.linkPago!);
    await agent.handle("mandale un recordatorio a Juan por la A-124");
    expect(created).toBe(1);
  });

  it("recordatorio reusa la orden creada por un cobro previo", async () => {
    const c = await agent.handle("cobrale a Juan");
    const r = await agent.handle("recordale a Juan su factura");
    expect(created).toBe(1);
    expect(r.linkPago).toBe(c.linkPago);
    expect(r.ordenNueva).toBe(false);
  });

  it("orden existente sin link guardado: no crea otra (riesgo de doble cobro)", async () => {
    const s = store.getSale(DEMO_TENANT, "venta-1002")!;
    store.saveSale({ ...s, paypalOrderId: "LEGACY-1" });
    const r = await agent.handle("cobrale a Juan");
    expect(created).toBe(0);
    expect(r.linkPago).toBeUndefined();
    expect(r.texto).toMatch(/no quiero crear otra/);
  });
});

describe("mensajes", () => {
  const sale = store0();
  function store0() { return createAgentDemoStore().getSale(DEMO_TENANT, "venta-1003")!; }

  it("formatUsd", () => {
    expect(formatUsd("50")).toBe("$50.00");
    expect(formatUsd("1200.5")).toBe("$1,200.50");
  });
  it("link de pago: monto, factura, nombre, voseo", () => {
    const m = mensajeLinkPago(sale, "https://pay/x");
    expect(m).toContain("$1,200.50");
    expect(m).toContain("A-000125");
    expect(m).toContain("María López");
    expect(m).not.toContain("(Houston)");
    expect(m).toMatch(/Podés|escribime/);
    expect(m).toContain("https://pay/x");
  });
  it("recordatorio: educado, voseo, sin presión; link opcional", () => {
    const m = mensajeRecordatorio(sale, "https://pay/x");
    expect(m).toContain("$1,200.50");
    expect(m).toContain("A-000125");
    expect(m).toMatch(/ignorá este mensaje/);
    expect(m).toContain("https://pay/x");
    expect(mensajeRecordatorio(sale)).not.toContain("http");
  });
});
