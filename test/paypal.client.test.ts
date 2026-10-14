/**
 * Cliente PayPal real contra un fetch STUB (cero red, cero credenciales):
 * se verifica el contrato saliente (payloads) y el entrante (parseo/errores)
 * exactamente como lo exige la API de PayPal sandbox.
 */
import { describe, expect, it } from "vitest";
import { PaypalClient } from "../src/paypal/client.js";
import { PaypalApiError } from "../src/paypal/types.js";

interface RecordedCall {
  url: string;
  method?: string;
  body?: string;
}

function stubFetch(handler: (call: RecordedCall) => { status: number; json: unknown }) {
  const calls: RecordedCall[] = [];
  const fetchFn = (async (url: string | URL, init?: RequestInit) => {
    const call: RecordedCall = {
      url: String(url),
      method: init?.method,
      body: typeof init?.body === "string" ? init.body : undefined,
    };
    calls.push(call);
    const { status, json } = handler(call);
    return new Response(JSON.stringify(json), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { fetchFn, calls };
}

const okHandler = (call: RecordedCall) => {
  if (call.url.endsWith("/v1/oauth2/token")) {
    return { status: 200, json: { access_token: "tok-stub", expires_in: 3600 } };
  }
  if (call.url.endsWith("/v2/checkout/orders") && call.method === "POST") {
    return {
      status: 201,
      json: {
        id: "ORD-STUB-1",
        status: "CREATED",
        links: [
          { rel: "self", href: "https://api-m.sandbox.paypal.com/v2/checkout/orders/ORD-STUB-1" },
          { rel: "approve", href: "https://www.sandbox.paypal.com/checkoutnow?token=ORD-STUB-1" },
        ],
      },
    };
  }
  if (call.url.endsWith("/v2/checkout/orders/ORD-STUB-1/capture")) {
    return {
      status: 201,
      json: {
        id: "ORD-STUB-1",
        status: "COMPLETED",
        payer: { email_address: "hijo.en.usa@example.com" },
        purchase_units: [
          {
            reference_id: "nortex-tenant-a-venta-1",
            payments: {
              captures: [
                {
                  id: "CAP-STUB-1",
                  status: "COMPLETED",
                  amount: { value: "50.00", currency_code: "USD" },
                  seller_receivable_breakdown: {
                    gross_amount: { value: "50.00", currency_code: "USD" },
                    paypal_fee: { value: "2.24", currency_code: "USD" },
                    net_amount: { value: "47.76", currency_code: "USD" },
                  },
                },
              ],
            },
          },
        ],
      },
    };
  }
  if (call.url.endsWith("/v1/notifications/verify-webhook-signature")) {
    return { status: 200, json: { verification_status: "SUCCESS" } };
  }
  return { status: 404, json: { name: "RESOURCE_NOT_FOUND" } };
};

const makeClient = (fetchFn: typeof fetch) =>
  new PaypalClient({
    clientId: "stub-id",
    clientSecret: "stub-secret",
    webhookId: "WH-STUB",
    fetchFn,
  });

describe("PaypalClient (fetch stub, sandbox)", () => {
  it("crea la orden con monto string, reference_id y custom_id de conciliación", async () => {
    const { fetchFn, calls } = stubFetch(okHandler);
    const client = makeClient(fetchFn);
    const order = await client.createOrder({
      tenantId: "tenant-a",
      saleId: "venta-1",
      amountUsd: "50",
      description: "Factura A-000123",
    });
    expect(order.orderId).toBe("ORD-STUB-1");
    expect(order.approveUrl).toContain("sandbox.paypal.com");
    expect(order.referenceId).toBe("nortex-tenant-a-venta-1");

    const createCall = calls.find((c) => c.url.endsWith("/v2/checkout/orders"))!;
    const payload = JSON.parse(createCall.body!) as {
      intent: string;
      purchase_units: Array<{
        reference_id: string;
        custom_id: string;
        amount: { currency_code: string; value: unknown };
      }>;
    };
    expect(payload.intent).toBe("CAPTURE");
    expect(payload.purchase_units[0].reference_id).toBe("nortex-tenant-a-venta-1");
    expect(payload.purchase_units[0].custom_id).toBe("nortex-tenant-a-venta-1");
    // Regla de la skill: el monto viaja como STRING "50.00", jamás number.
    expect(payload.purchase_units[0].amount.value).toBe("50.00");
    expect(typeof payload.purchase_units[0].amount.value).toBe("string");
  });

  it("captura y parsea bruto/comisión/neto por separado", async () => {
    const { fetchFn } = stubFetch(okHandler);
    const client = makeClient(fetchFn);
    const capture = await client.captureOrder("ORD-STUB-1");
    expect(capture).toMatchObject({
      captureId: "CAP-STUB-1",
      status: "COMPLETED",
      grossUsd: "50.00",
      feeUsd: "2.24",
      netUsd: "47.76",
      currency: "USD",
    });
  });

  it("INSTRUMENT_DECLINED llega como PaypalApiError con el issue crudo", async () => {
    const { fetchFn } = stubFetch((call) => {
      if (call.url.includes("/capture")) {
        return {
          status: 422,
          json: {
            name: "UNPROCESSABLE_ENTITY",
            details: [{ issue: "INSTRUMENT_DECLINED", description: "The instrument presented was declined." }],
          },
        };
      }
      return okHandler(call);
    });
    const client = makeClient(fetchFn);
    await expect(client.captureOrder("ORD-STUB-1")).rejects.toMatchObject({
      name: "PaypalApiError",
      issue: "INSTRUMENT_DECLINED",
    } satisfies Partial<PaypalApiError>);
  });

  it("verificación de firma: SUCCESS → true; FAILURE o error de red → false (fail closed)", async () => {
    const headers = { "paypal-transmission-id": "t-1" };
    const event = { id: "EV-1", event_type: "PAYMENT.CAPTURE.COMPLETED", resource: {} };

    const ok = stubFetch(okHandler);
    await expect(makeClient(ok.fetchFn).verifyWebhookSignature(headers, event)).resolves.toBe(true);

    const fail = stubFetch((call) =>
      call.url.includes("verify-webhook")
        ? { status: 200, json: { verification_status: "FAILURE" } }
        : okHandler(call),
    );
    await expect(makeClient(fail.fetchFn).verifyWebhookSignature(headers, event)).resolves.toBe(false);

    const down = stubFetch(() => {
      throw new Error("red caída");
    });
    await expect(makeClient(down.fetchFn).verifyWebhookSignature(headers, event)).resolves.toBe(false);
  });

  it("sin credenciales, el constructor falla cerrado con instrucciones", () => {
    expect(
      () => new PaypalClient({ clientId: "", clientSecret: "", webhookId: "x" }),
    ).toThrow(/developer\.paypal\.com/);
  });
});
