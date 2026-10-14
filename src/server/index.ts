/**
 * Entrypoint del servidor de integración (sandbox por defecto).
 *
 * Requiere las credenciales que crea Noel en developer.paypal.com
 * (PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET / PAYPAL_WEBHOOK_ID — ver
 * .env.example). Sin credenciales, arranca SOLO si NORTEX_DEMO_MODE=1,
 * usando el gateway falso y datos sintéticos (para jueces y desarrollo).
 */
import { PaypalClient, PAYPAL_LIVE_BASE, PAYPAL_SANDBOX_BASE } from "../paypal/client.js";
import { FakePaypalGateway } from "../paypal/fake.js";
import type { PaypalGateway } from "../paypal/types.js";
import { InMemoryNortexStore } from "../nortex/store.js";
import { ReconciliationService } from "../nortex/reconciliation.js";
import { createDemoStore, DEMO_SALE, OTHER_TENANT_SALE } from "../demo/seed.js";
import { createApp } from "./app.js";

const port = Number(process.env.PORT ?? 8080);
const demoMode = process.env.NORTEX_DEMO_MODE === "1";

let gateway: PaypalGateway;
let store: InMemoryNortexStore;

if (demoMode) {
  console.warn("⚠ MODO DEMO: gateway falso de PayPal y datos sintéticos. Ningún pago es real.");
  gateway = new FakePaypalGateway();
  store = createDemoStore();
} else {
  const clientId = process.env.PAYPAL_CLIENT_ID;
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET;
  const webhookId = process.env.PAYPAL_WEBHOOK_ID;
  if (!clientId || !clientSecret || !webhookId) {
    console.error(
      "Faltan PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET / PAYPAL_WEBHOOK_ID.\n" +
        "Las credenciales las crea Noel en https://developer.paypal.com/dashboard/ (app sandbox).\n" +
        "Para probar sin credenciales: NORTEX_DEMO_MODE=1 npm start",
    );
    process.exit(1);
  }
  const env = process.env.PAYPAL_ENV ?? "sandbox";
  gateway = new PaypalClient({
    clientId,
    clientSecret,
    webhookId,
    baseUrl: env === "live" ? PAYPAL_LIVE_BASE : PAYPAL_SANDBOX_BASE,
  });
  store = new InMemoryNortexStore();
  if (process.env.NORTEX_DEMO_SEED === "1") {
    store.saveSale({ ...DEMO_SALE });
    store.saveSale({ ...OTHER_TENANT_SALE });
  }
}

const reconciliation = new ReconciliationService(store);
const server = createApp({ gateway, store, reconciliation });
server.listen(port, () => {
  console.log(`nortex-paypal-ai escuchando en http://localhost:${port} (${demoMode ? "demo" : (process.env.PAYPAL_ENV ?? "sandbox")})`);
});
