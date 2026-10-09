# Nortex Pay AI — PayPal AI Hackathon 2026

## Estado
- **Decisión:** Noel aprobó entrar el 2026-10-05 ("Sí, arranquen con el proyecto").
- **Deadline:** 12 nov 2026, 12:00 PM PT (reglas oficiales — el video decía 2pm, mandan las reglas).
- **Submission:** https://paypalaihackathon.devpost.com/
- **Estrategia de repo:** repo público NUEVO `Noahstark23/nortex-paypal-ai` con licencia MIT — solo la integración construida durante el hackathon. NO se abre el código de Nortex.

## Concepto
Agente AI en español (voseo nica) para comerciantes Nortex, por WhatsApp:
1. **Checkout conversacional:** el comerciante dice "cobrale $50 a Juan por la factura 123" → se crea orden PayPal / link de pago → se envía al cliente por WhatsApp.
2. **Cobranza automática:** facturas vencidas → recordatorios personalizados y educados generados por AI.
3. **Conciliación:** webhooks de PayPal marcan facturas como pagadas en Nortex automáticamente.

## Ángulo de impacto (honesto)
PayPal NO opera en Nicaragua — el caso real es la **diáspora**: nicas en EE. UU. pagando a negocios de su familia, y comerciantes Nortex vendiendo a clientes en EE. UU. (Xoom/PayPal). No vender cobro doméstico nica con PayPal.

## Superficie de integración Nortex (verificada en main)
- `backend/routes/whatsappCommerce.ts` — comercio por WhatsApp existente
- `backend/routes/assistantCatalog.ts`, `assistant.ts`, `assistantActions.ts` — asistente
- `backend/routes/pedidos.ts`, `productCatalog.ts`, `productLookup.ts` — pedidos/catálogo
- Staging: https://staging.somosnortex.com (API sana)

## Criterios de jurado (pesos iguales)
1. Implementación tecnológica (PayPal + AI con profundidad real)
2. Diseño (producto completo, no POC)
3. Impacto potencial (problema real, audiencia real)
4. Innovación
5. Presentación (video <3 min mostrando el flujo end-to-end)

## Premios objetivo
- Best Use of Agentic Commerce: $5,000 (hecho a medida)
- Most Impactful: $5,000
- Grand prizes: $12k / $8k / $5k
- Sponsor (Render credits, etc.) como complemento

## Requisitos de submission (reglas oficiales)
- Repo público en GitHub con licencia open source visible + README con instrucciones de setup
- Demo funcional: URL hosteada O instrucciones para correrlo (jueces deben poder interactuar)
- Video <3 min en YouTube mostrando el proyecto funcionando
- Todo en inglés (o con traducción al inglés)
- Proyecto nuevo o "significativamente actualizado" durante 1 oct – 12 nov 2026
- Sin apoyo financiero de PayPal/Devpost (no aplica)

## Fases
1. **F0 — Setup (esta semana):** repo creado, Noel se registra en Devpost + crea cuenta PayPal Developer (gratis), starknortex entrega arquitectura/spec.
2. **F1 — Núcleo PayPal:** Orders API v2 + Invoices API + webhooks en sandbox; concilia contra staging Nortex.
3. **F2 — Agente AI:** checkout conversacional + cobranza por WhatsApp (voseo), usando catálogo/pedidos de Nortex.
4. **F3 — Demo y video:** demo hosteada estable, video <3 min, submission en Devpost.

## Roles
- Stark dirige. starknortex: arquitectura/spec/revisión. Claude Code + OpenCode: implementación (1 sesión = 1 ticket, PRs borrador al repo nuevo).
- Noel: registro Devpost + cuenta PayPal Developer (pasos de cuenta, los hace él).

## Bloqueadores actuales
- [ ] Noel: unirse al hackathon en Devpost
- [ ] Noel: crear cuenta en developer.paypal.com (gratis)
- [ ] starknortex: spec de arquitectura (directiva N-PAYPAL-20261005-01)
