<!--
CLAUDE_CONTEXT_BRIEFING (para futuras sesiones de Claude Code):
- Proyecto PERSONAL de finanzas de Matías. NO es SoftCerealCore. Vive en `plan-ahorro-app/`.
- Archivo vivo: `index.html` (~6300 líneas, HTML+JS vanilla + Supabase). `plan-ahorro.html` y `plan-app.html` son LEGACY pre-Supabase, NO tocar.
- Stack: HTML/JS vanilla + Supabase (Postgres/Auth/Edge Functions) + Vercel + PWA. Idioma español.
- Al terminar CUALQUIER cambio en index.html: bumpear `CACHE_NAME` en `service-worker.js` UNA vez por deploy (va por v60 al 2026-06-04).
- Verificación: `node -e` extrayendo el <script> inline y `new Function(...)` para chequear sintaxis. El E2E real lo hace Matías en el navegador (requiere su sesión Supabase autenticada; Claude no puede loguear).
- Tablas Supabase (8): external_positions, gastos, historico_ahorro, iol_balances, iol_credentials, iol_frasco_mapping, iol_positions, user_config. NO existe iol_operaciones.
- Memoria relacionada: project-plan-ahorro-app (en el store de memorias del usuario).
-->

# Plan Ahorro App — Estado y Roadmap

> App personal de finanzas: gastos, calculadora de ahorro por frascos, histórico de aportes,
> integración con brokers (IOL por API + Cocos por CSV), y métricas plan vs realidad.
> Última actualización: **2026-08-19**.

## Stack
- `index.html` — toda la app (HTML + JS vanilla). **App viva en producción.**
- ⚠️ Existe un segundo frontend en migración: `../plan-ahorro-vue/` (Vue 3 + Vite, desde 2026-06-08).
  Calculadora / Gastos / Sueldo / Histórico ya portados; faltan Brokers y Plan vs Real. **Todo fix
  en un tab ya portado hay que aplicarlo en los dos lados** hasta que la migración cierre.
- `service-worker.js` + `manifest.json` — PWA. **Bumpear `CACHE_NAME` una vez por deploy.**
- `supabase/functions/iol-proxy/index.ts` — Edge Function (Deno) que proxea IOL (read-only, AES-GCM).
- SQLs sueltos en la raíz (setup de tablas/migraciones manuales).
- Hosting Vercel. Supabase ref `qpqoampoiirmdylvtsss`.

## Convenciones de frascos
- `diario` (cash en pesos, NO se invierte), `colchon`, `casa`, `jubilacion`.
- Composición target en `const INSTRUMENTS` (index.html): Colchón 100% FCI MM USD · Casa 40/40/20 (MM/ONs/Bopreal) · Jubilación 65% SPYD / 35% QQQD.
- El MEP es global (`currentMep`), no por frasco.

---

## ✅ HECHO

### Fase 1 — Lectura de portafolio (IOL + Cocos)
- Edge Function `iol-proxy` con 5 acciones: `connect`, `test_connection`, `sync_portfolio`, `get_latest_portfolio`, `disconnect`. Read-only (sin `/operar/*`).
- Tab **Brokers**: dashboard de posiciones + saldos, variación diaria, mapeo símbolo→frasco (`iol_frasco_mapping`).
- **Auto-sync** en: abrir Brokers / clickear broker IOL (`syncAndRenderIol`) y al **iniciar sesión / reload** (`syncIolEnInicio` en `initApp`, background, solo si hay `iol_credentials`). Muestra el último snapshot al toque y dispara `sync_portfolio` en segundo plano. Throttle de 60s (`IOL_SYNC_THROTTLE`/`lastIolSyncAt`) compartido; el botón "Refrescar" es force. `loadAndRenderIol({showLoading})` permite re-render sin flash.
- **Cocos** por CSV (no estaba en el design doc original): import idempotente por `snapshot_date`, cash ARS/USD, histórico 90 días, gráfico de evolución/delta.

### Fase 2 — Plan vs Real (pestaña dedicada)
- 5ª pestaña `tab-planreal`. Mide "lo real" por **delta de snapshots** (NO operaciones): variación del valorizado por frasco entre fin de mes anterior y fin de mes, cruzando `iol_positions` + `external_positions` con `iol_frasco_mapping`. Sin tabla nueva ni cambios en Edge Function.
- Helper reusable `frascoUsdSums(iolPos, extPos, mapping, mep)` (extraído de `renderIolFrascoSummary`). `buildPlanVsReal(...)` arma tabla mes×frasco (Plan vs Δ Valor real vs Desvío) + gráfico ECharts (plan acumulado punteado vs valor real sólido).
- "Real" = variación de valor (incluye mercado), etiquetado así en la UI. Meses sin snapshot en algún borde → "Sin dato". Usa el MEP del mes para ambos bordes.

### Fase 3 (parcial) — MEP en vivo global
- MEP global `currentMep`, fuente **ArgentinaDatos**: `GET https://api.argentinadatos.com/v1/cotizaciones/dolares/bolsa` → array histórico `{casa:"bolsa", compra, venta, fecha}`; se toma el último elemento y su `venta`. (MEP = casa **"bolsa"**, NO "blue".) CORS abierto → fetch directo del browser, sin Edge Function.
- Chip `#mep-pill` en el header (visible en toda la app, clickeable para forzar refresh). **Auto-update** al loguear + cada 10 min + al volver el foco; cache 5 min en localStorage (`mep_cache`); timeout 5s.
- `actualizarMepVivo()` propaga a todo: `currentMep` + `iolState.mepRate` + persiste `default_mep` + `calcular()`. La calculadora ya **no** tiene input de MEP.
- **Indicadores del header**: se quitó el pill "Sincronizado". Punto de color (`.status-dot`: gris=neutro/init, verde=ok, ámbar pulsante=guardando/cargando, rojo=error; con tooltip) en el pill del **usuario** (`setStatus`, refleja saves/loads de gastos+histórico) y en el del **MEP** (`setMepDot`, refleja el sync del MEP).
- Helper `ARG_DATOS` dejado preparado para sumar inflación.

### Sueldo como entidad propia + tab "Sueldo" + vs inflación
- **Tabla `sueldos`** (user_id, year, mes, sueldo_ars) = fuente de verdad del ingreso, separada de `historico_ahorro`. SQL en `sueldos.sql` (incluye seed desde historico_ahorro). RLS por user_id.
- **Tab "Sueldo"** (6º tab, `data-tab="sueldo"`, **visible también para `gastos_only`** — NO está en `restricted`): tabla editable mes→sueldo del año + **MEP promedio del mes** (`mepPromedioMes` sobre la serie diaria `bolsa`, `fetchMepSerie` cache 12h) + **sueldo USD**. Selector de año.
- **Sueldo vs inflación** (movido acá desde Histórico): `buildSueldoVsInflacion(rows, serie)` acumula inflación mensual desde el 1er mes con sueldo (S0) → "sueldo ajustado" = S0 inflado; meses sin inflación publicada → `ajustado:null` (gap). `renderSueldoVsInflacion` dibuja nominal vs ajustado + resumen.
- **IPC por región**: inflación desde **datos.gob.ar** (Series de Tiempo, INDEC, gratis, sin API key, CORS) — `IPC_REGION_IDS` (familia `145.3_ING<REG>UAL_DICI_M_*`), `fetchInflacionRegional` trae las 7 regiones en 1 request (cache 12h, fracción→×100). **Región config vs vista**: engranaje "Mi región" (config, persiste `user_config.region`, define el IPC grabado) + combo "Ver región" (solo vista, no toca config). Columna **`sueldos.ipc`** = snapshot del IPC mensual de la región config, grabado al abrir el tab (`persistIpcConfigRegion`). SQLs: `add-region-config.sql` + `add-ipc-sueldos.sql`. ArgenStats descartado (API key + Edge Function + plan).
- **Calc = fuente única**: `loadCalcMonth` precarga `ingreso` desde `sueldos` (no historico); editar el ingreso upserta en `sueldos` (`scheduleSueldoUpsert`, solo en edición del usuario). `registrar-historico-btn` sigue snapshoteando ingreso en `historico_ahorro.ingreso_ars`.
- Frontend puro salvo la tabla `sueldos`. `buildSueldoVsInflacion` acepta `sueldo_ars` o `ingreso_ars` (helper `salaryOf`).

### Rebalanceo (tab Plan vs Real)
- Sección "Rebalanceo": composición real (último snapshot) vs target por frasco + reparto sugerido del **próximo aporte** (de la calc, global `aporteCalc` expuesto en `calcular()`). NO vende/mueve lo existente, solo dirige el aporte nuevo (cash-flow rebalancing: `repartirAporte` prioriza lo sub-ponderado).
- `holdingsPorFrascoSimbolo` (último snapshot IOL+Cocos, reusa `pickIolBefore`/`pickCocosBefore` con corte "ahora"); `buildRebalanceo` agrupa por **instrumento del plan**; `renderRebalanceo`. Frontend puro.
- **Matcheo símbolo→instrumento del plan** (`add-instrumento-mapping.sql` → col `iol_frasco_mapping.instrumento`): `planItemDe` (manual o auto SPYD/QQQD/Colchón). Engranaje en la sección Rebalanceo (`#rebalanceo-config` inline) con tabla símbolo|frasco|select; `setIolInstrumento`/`fetchIolInstrumentos` (`iolState.instrumentos`). Casa rebalancea por instrumento real (varios bonos→ONs); sin matchear → fila "Sin matchear".

### Fixes 2026-08-19 (aplicados en index.html **y** en plan-ahorro-vue)
- **Gastos — se eliminó la propagación del importe a los meses siguientes.** El handler colgaba de
  `input` (una vez por tecla) y la guarda `futVal === 0` solo escribía meses vacíos: al tipear
  `100000` en marzo, la primera tecla llenaba abril–diciembre con **1** y las teclas siguientes ya
  no los corregían (dejaban de estar vacíos). Además proyectaba hasta diciembre, inflando stats y
  gráfico. Decisión: **cada mes se carga a mano**, sin réplica, tampoco en gastos fijos. Se borró
  también el array `monthInputs` (solo existía para propagar) y `fieldsToSave`.
  Archivos: `index.html` (`renderGastoRow`) · `src/components/TabGastos.vue` (`onMonthInput`).
- **Sueldo vs inflación — el IPC acumula cruzando años.** `fetchSueldos(year)` filtraba por año, así
  que `buildSueldoVsInflacion` tomaba como S0 el primer sueldo de **ese** año: el ajuste por
  inflación se reiniciaba cada 1° de enero y se perdía todo el acumulado previo. Ahora
  `fetchSueldos()` sin argumento trae **todo el histórico** (sort por `year` + mes); la tabla filtra
  el año elegido en memoria (`sueldosTabRows` / `sueldosDelAnio`) y el gráfico + `persistIpcConfigRegion`
  usan el histórico completo (`sueldosTabHist`). El eje X del gráfico ya venía preparado para
  multi-año (`MESES_CORTOS[m.monthIdx] + año`), así que ahora muestra la serie entera.
  Archivos: `index.html` (`fetchSueldos`, `loadAndRenderSueldos`, handler "Mi región") ·
  `src/lib/api.js` + `src/components/TabSueldo.vue`.
- **IPC/MEP congelados: el service worker era cache-first para TODO lo no-Supabase.** La URL de las
  series (datos.gob.ar y ArgentinaDatos) es siempre idéntica, así que `caches.match` daba hit y el SW
  devolvía **para siempre** la primera respuesta: los meses nuevos de IPC y MEP no aparecían nunca
  (solo al bumpear `CACHE_NAME`, que es lo único que limpiaba el cache). El TTL de 12h del
  localStorage era irrelevante, la red nunca se consultaba. Fix: rama **network-first con fallback a
  cache** para `datos.gob.ar` / `argentinadatos` en `service-worker.js` — la misma estrategia que ya
  tenía la versión Vue en `vite.config.js` (`runtimeCaching` NetworkFirst), donde el bug no existía.
- **Botón de refresh manual de indicadores** en el header del tab Sueldo (`#sueldo-refresh-btn`,
  ícono que gira mientras consulta): `refrescarIndicadoresSueldo(true)` pide IPC + MEP salteando los
  caches de 12h, regraba `sueldos.ipc` y re-renderiza tabla y gráfico.
- **Refresh automático al cargar un sueldo**: el handler `change` del input de sueldo llama a
  `refrescarIndicadoresSueldo(true)` después del upsert — al cargar el sueldo del mes, el IPC del mes
  anterior ya suele estar publicado.
- **Fallback a cache stale** en `fetchInflacionRegional` / `fetchMepSerie`: si la red falla devuelven
  el último dato conocido de localStorage en vez de tirar excepción (antes el cache-first del SW
  tapaba esto; sacándolo, sin fallback la tabla quedaría vacía offline). Aplicado en los dos
  frontends (`index.html` y `src/lib/indicadores.js`).
- SW bumpeado a `plan-cloud-v69`.

---

## ⏳ PENDIENTE

### Verificación E2E de Fase 2 + Fase 3 (Matías, en el navegador)
- Plan vs Real: meses con snapshot muestran Δ; previos a la integración IOL (fines de mayo) → "Sin dato".
- MEP: chip se llena solo, puntos de color con tooltip, se refleja en Brokers/Plan vs Real.

### Diferido — Capital inicial
- Poder establecer el **capital inicial** (lo que ya tenías al arrancar) antes de la calc/frascos. Decisión tomada: sería **base de partida + EXCLUIDO del rebalanceo**. Quedó pospuesto (se priorizó el rebalanceo); definir granularidad (total / por frasco / por instrumento) al retomar.

### Fase 3 — resto
1. **Snapshots automáticos (pg_cron)** — la más pesada:
   - Necesita extensiones `pg_cron` + `pg_net` en Supabase.
   - El Edge Function hoy autentica por **JWT de usuario**; un cron no lo tiene → hace falta una variante con **service-role** (o un secret) que itere usuarios con creds activas y sincronice IOL.
   - Requiere pasos manuales de Matías en el dashboard de Supabase.


---

## Notas técnicas para retomar
- **Datasource único de MEP**: `currentMep` (global). Brokers/Plan vs Real lo prefieren sobre `cfg.default_mep`. No reintroducir un input de MEP en la calc.
- **Tabla de mapeo** se llama `iol_frasco_mapping` (en el design doc figura como `iol_frasco_mapping`; el código real lo confirma). El frasco se resuelve por **símbolo**, compartido entre IOL y Cocos.
- **Gotcha encoding**: cuidar acentos al editar (á/é/í/ó/ú/ñ).
- **Tabs**: alta de pestaña = botón en `.tab-nav` + `<section id="tab-X">` + caso en `showTab()` + agregar a `restricted` en `applyRolePermissions` si debe ocultarse para `gastos_only`.
- **Charts**: `getChart(id)` / `disposeChart(id)`; el resize lo dispara `showTab` vía `resizeAllCharts`.
- El design doc original (`iol-integration-design.md`) proponía Fase 2 por `iol_operaciones`; se **descartó** a favor del delta de snapshots.
