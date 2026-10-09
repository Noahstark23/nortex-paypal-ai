# nortex-paypal-ai — agente WhatsApp para comerciantes Nortex (PayPal AI Hackathon 2026)

Agente AI en español (voseo nicaragüense) por WhatsApp: checkout conversacional
("cobrale $50 a Juan"), cobranza y conciliación vía PayPal. Ángulo honesto:
PayPal no opera en Nicaragua — el caso real es la **diáspora** (nicas en EE. UU.
pagando a negocios de su familia) y ventas a clientes en EE. UU.

Ver `PLAN.md` para el plan del hackatón (fases, deadlines, bloqueadores).

## Fase M2 — consumo de tools MCP (completada 2026-10-09)

ADR: `~/workspace/equipo-ias/tracks/musenortex/ADR-capa-comun.md`
("un solo cerebro, dos bocas"). Este repo **no reimplementa** las tools de
lectura: las **llama** vía MCP al servidor `nortex-mcp` (stdio).

`src/mcp/client.ts` — `McpNortexClient`:
- Spawnea `~/workspace/nortex-mcp/dist/index.js` (F2, commit `5b58c08`) por stdio
  con el SDK `@modelcontextprotocol/sdk` y expone wrappers tipados para **4 tools**:
  `ventas_hoy`, `buscar_producto`, `stock_producto`, `precio_producto`.
- El único punto de contacto es `tools/call`; la lógica vive 100% en el servidor.
- Validación de salida en 2 capas: schema zod permisivo (`string` no vacío) +
  `safeParse`. Si falla → mensaje en voseo.
- **Fail closed:** timeout, servidor muerto, salida malformada o `isError` →
  `"No pude consultar eso ahora. Probá de nuevo en un rato."` Nunca inventa
  datos ni propaga stack traces. (En 401/403 el propio servidor responde su
  mensaje fail-closed, que fluye tal cual.)
- `NORTEX_SERVICE_TOKEN` solo viaja por entorno al proceso hijo; jamás se loguea.

## Estado

- **Repo local, sin remoto.** El push al repo público `Noahstark23/nortex-paypal-ai`
  lo decide Noel (el repo público aún no existe).
- **Mocks sin verificar contra staging.** Los tests corren contra el servidor MCP
  real en modo mock (datos sintéticos del borrador F0, **SIN VERIFICAR CONTRA
  STAGING**). No se declara paridad con producción ni demo funcional contra ella.
- **$0, read-only.** Este módulo no escribe nada, no gasta nada.

## Cómo correr los tests

```bash
npm install
npm test        # vitest: 9 tests contra el servidor MCP real (mocks)
npm run typecheck
```

Requiere el build del servidor: `cd ~/workspace/nortex-mcp && npm run build`
(la ruta se puede cambiar con `NORTEX_MCP_SERVER_PATH`).

## Secretos

Verificado sin valores reales en el repo:

```bash
grep -rniE "token|secret|bearer|password|api[_-]?key" src/ test/ .env.example
# -> solo plomería: nombre de NORTEX_SERVICE_TOKEN en comentarios y placeholder
#    en .env.example. El .env real está en .gitignore.
```

## Estructura

```
src/
  index.ts        # re-exports
  mcp/client.ts   # McpNortexClient: stdio + 4 wrappers + fail closed + zod
test/
  mcp.client.test.ts  # 9 tests: ≥3 tools e2e, zod 2 capas, fail closed
PLAN.md           # plan del hackatón
```
