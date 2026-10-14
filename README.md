# Nortex Pay AI — conversational PayPal checkout & reconciliation for the Nicaraguan diaspora

**PayPal AI Hackathon 2026** · Deadline: Nov 12, 2026, 12:00 PM PT · License: MIT

Nortex is the business OS (invoicing, inventory, payroll) used by small
businesses in Nicaragua. PayPal does **not** operate in Nicaragua — so this
project is honest about the real use case: **the diaspora**. A Nicaraguan
living in the US pays a family business back home in USD; the business owner
in Nicaragua sees the invoice marked paid and booked in Nortex automatically.

> Sandbox only. No real money moves in this repo's demo, and nothing here is
> presented as a real payment. Ver `PLAN.md` para el plan del hackatón.

## What it does

1. **Conversational checkout** — the merchant says (WhatsApp, Nicaraguan
   Spanish): *"cobrale $50 a mi hijo por la factura A-000123"* → a PayPal
   order is created and a payment link goes to the buyer in the US.
2. **Capture + webhooks** — on approval the order is captured; PayPal
   webhooks (`PAYMENT.CAPTURE.COMPLETED / DENIED / REFUNDED`,
   `CHECKOUT.ORDER.APPROVED`) are **signature-verified** and reconciled.
3. **Automatic reconciliation into Nortex accounting** — one payment row +
   double-entry ledger entries (collection, and the PayPal fee booked
   **separately as a cost**) + invoice marked paid, in **one transaction**.
   The FX rate used (USD→NIO) is recorded on the payment.

### Money rules (non-negotiable)

- Amounts travel as **strings** (`"50.00"`) on the API and as exact
  `Decimal` (BigInt) inside Nortex. Never floats.
- **Idempotency keyed on PayPal's capture id**: a duplicated webhook (or a
  capture that also arrives by webhook) is a no-op — never a double charge
  or double entry. Proven by tests: the same event sent twice → one payment.
- **Fail closed**: an unverifiable webhook signature is logged and ignored;
  an unknown reconciliation reference never creates money; an amount
  mismatch is held for manual review, never auto-adjusted.
- **Multi-tenant by construction**: every payment resolves through
  `nortex-{tenantId}-{saleId}` and only ever touches that tenant's sale.

## Architecture

```
src/
  money/decimal.ts          Exact BigInt Decimal (no float money, ever)
  paypal/client.ts          Real PayPal client (Orders v2, capture, webhook signature verification)
  paypal/fake.ts            Deterministic fake gateway for demo/tests (same contracts)
  paypal/types.ts           Payload types + reference-id helpers
  nortex/reconciliation.ts  The reconciliation engine (idempotency, holds, refunds, audit)
  nortex/store.ts           In-memory store with atomic transactions (Prisma-shaped contract)
  nortex/types.ts           Sale / Payment / LedgerEntry / AuditEvent (all tenant-scoped)
  server/app.ts             HTTP API (node:http, zero deps)
  server/index.ts           Entrypoint (sandbox by default; demo mode without credentials)
  demo/run.ts               Scripted end-to-end diaspora demo (no credentials needed)
  demo/seed.ts              Synthetic demo data (no real customers)
  mcp/client.ts             Agent layer: consumes Nortex MCP tools over stdio (phase M2)
test/
  decimal.test.ts           Exact money arithmetic
  paypal.client.test.ts     Client contract against a stubbed fetch (payloads, errors, signatures)
  reconciliation.test.ts    Idempotency, holds, multi-tenancy, fee separation, refunds
  demo.e2e.test.ts          Full diaspora flow over real HTTP + defenses
  mcp.client.test.ts        M2: agent consumes the real MCP server (mock data)
```

HTTP surface:

| Route | What it does |
|---|---|
| `POST /api/integrations/paypal/orders` | Creates the PayPal order for a pending sale; sale stays **pending** |
| `POST /api/integrations/paypal/orders/:id/capture` | Captures after buyer approval and reconciles immediately |
| `POST /api/integrations/paypal/webhook` | Verifies signature, then reconciles (idempotent) |
| `GET /api/demo/sales/:tenantId/:saleId` | Read-only demo state (sale, payments, ledger, audit) |

## Phase M2 — the agent consumes Nortex MCP tools (done 2026-10-09)

Per ADR *capa común* ("one brain, two mouths"), this repo does **not**
reimplement Nortex's read tools — it calls them over MCP (stdio) via the
`nortex-mcp` server. `src/mcp/client.ts` (`McpNortexClient`) exposes typed
wrappers for 4 tools (`ventas_hoy`, `buscar_producto`, `stock_producto`,
`precio_producto`), validates output with zod, and fails closed in
Nicaraguan Spanish — it never invents data. `NORTEX_SERVICE_TOKEN` travels
only via environment to the child process and is never logged.

## Setup

### Prerequisites — accounts (done by the project owner, free)

1. Join the hackathon on Devpost: https://paypalaihackathon.devpost.com/
2. Create a PayPal Developer account: https://developer.paypal.com/dashboard/
3. Create a **sandbox** REST app → copy **Client ID** and **Secret**.
4. Register the webhook URL `https://<your-host>/api/integrations/paypal/webhook`
   subscribed to the four events above → copy the **Webhook ID**.

### Run it

```bash
npm install
cp .env.example .env   # fill PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET / PAYPAL_WEBHOOK_ID

npm test               # full suite (Decimal, client contract, reconciliation, e2e, MCP)
npm run typecheck
npm run demo           # end-to-end diaspora demo with the fake gateway — no credentials
npm start              # real server against PayPal sandbox (PORT=8080)
NORTEX_DEMO_MODE=1 npm start   # judges' mode: fake gateway + synthetic data, no credentials
```

The MCP tests additionally require the MCP server build:
`cd ~/workspace/nortex-mcp && npm run build` (path overridable via
`NORTEX_MCP_SERVER_PATH`).

## Demo script (for the <3 min video)

The flow below is exactly what `npm run demo` executes and asserts.

**The story.** Doña Carmen runs *Pulpería La Bendición* in Estelí, Nicaragua,
on Nortex. Her son lives in the US and covers the store's monthly invoice —
today that means screenshots, phone calls, and manual bookkeeping.

| Time | On screen | Narration / dialogue |
|---|---|---|
| 0:00–0:20 | Nortex invoice A-000123, pending, US$50.00 | "Every month, thousands of Nicaraguan families in the US pay businesses back home. The money arrives — the paperwork doesn't." |
| 0:20–0:45 | WhatsApp chat with the Nortex agent | Carmen: **«Cobrale $50 a mi hijo por la factura A-000123.»** The agent creates the PayPal order and replies with the payment link: **«Listo, le mandé el link de pago por la factura A-000123.»** The invoice stays *pending* — creating an order is not a payment. |
| 0:45–1:15 | Son's phone in the US: PayPal sandbox approval in USD | "Her son approves in dollars, on the rail he already has. PayPal doesn't operate in Nicaragua — the diaspora is the honest use case." |
| 1:15–1:50 | Capture + Nortex back office | The webhook arrives, signature verified. The invoice flips to **paid**. The ledger shows the collection entry **and** the PayPal fee as its own cost entry; the FX rate (USD→C$36.85) is recorded on the payment. |
| 1:50–2:20 | The same webhook is delivered **again** (PayPal really does retry) | "PayPal delivers the same webhook twice. Capture-id idempotency: one payment, one set of entries, zero double-charging." Then a forged webhook → **401, nothing applied**. |
| 2:20–2:50 | Carmen's WhatsApp | Agent: **«Ya cayó el pago de la factura A-000123: $50.00, ya quedó registrada y pagada.»** No screenshots, no phone calls, books balanced (debits = credits). |
| 2:50–3:00 | Close | "Nortex Pay AI: the diaspora pays, Nortex reconciles. Built for the PayPal AI Hackathon 2026." |

## Status

- ✅ **M2** — agent consumes Nortex MCP tools over stdio (tests against the real MCP server, **mock data, not verified against staging**).
- ✅ **F1** — PayPal Orders v2 + capture + verified webhooks + reconciliation
  (payment, separate fee entry, FX record, audit trail, refunds) with the
  scripted end-to-end demo above. Local repo only; pushing to the public
  `Noahstark23/nortex-paypal-ai` repo is the owner's call.
- ⏳ **F2** — wire the conversational agent (WhatsApp) to the orders endpoint end-to-end.
- ⏳ **F3** — hosted demo + <3 min video + Devpost submission.
- 🔒 Going live (real money) requires the owner's explicit approval and a watched $1
  test — this repo never flips that switch by itself.

## Honesty notes

- PayPal is the **US-side rail**; Nicaraguan walk-in customers keep paying by
  bank transfer, exactly as they do today. We don't promise local PayPal payouts.
- Demo data is fully synthetic. A sandbox capture is never presented as a real payment.
- No real secret values live in this repo — credentials travel only via environment
  (see `.env.example`); `.env` is git-ignored.
