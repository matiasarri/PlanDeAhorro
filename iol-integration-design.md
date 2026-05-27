# Integración IOL en Plan Cloud — Diseño técnico

> Documento de diseño para integrar la API de InvertirOnline (IOL) en plan-cloud.
> **No incluye código aún.** El objetivo es validar arquitectura, schema y flujos
> antes de implementar. Implementación una vez aprobado.

---

## 0. Resumen ejecutivo

**Qué se busca:** que la app muestre tu portafolio IOL en vivo, lo sincronice con el plan de ahorro (frascos), y mejore las estadísticas cruzando lo planificado con lo realmente invertido.

**Arquitectura:** browser → **Supabase Edge Function** (proxy) → IOL API. Las credenciales viven encriptadas en Supabase, nunca en el browser.

**Tres fases:**
1. **Lectura de portafolio** (MVP) — ver posiciones y saldos
2. **Plan vs Realidad** — cruzar aportes planificados con compras reales en IOL
3. **Smart features** — MEP en vivo en la calculadora, rebalanceo, snapshots automáticos

---

## 1. Arquitectura general

```
┌──────────────────┐         ┌──────────────────────────┐         ┌────────────────────────┐
│  plan-cloud.html │  HTTPS  │ Supabase Edge Function   │  HTTPS  │ api.invertironline.com │
│  (browser/PWA)   │ ──────► │ /functions/v1/iol-proxy  │ ──────► │  /token, /api/v2/...   │
│                  │         │                          │         │                        │
│  JWT Supabase    │         │ - decrypt password       │         │  OAuth2 Resource Owner │
│  en Authorization│         │ - manage tokens          │         │                        │
└──────────────────┘         │ - single-flight refresh  │         └────────────────────────┘
                             │ - call IOL endpoints     │
                             │ - upsert snapshots       │
                             └─────────┬────────────────┘
                                       │
                                       ▼
                             ┌──────────────────────────┐
                             │  Supabase Postgres       │
                             │  - iol_credentials       │
                             │  - iol_positions         │
                             │  - iol_balances          │
                             │  - iol_operaciones       │
                             │  - iol_frasco_mapping    │
                             └──────────────────────────┘
```

**Reglas duras:**
- El navegador **nunca** llama a IOL directo. Siempre vía Edge Function.
- Las credenciales **nunca** salen del servidor. La función desencripta, llama IOL, descarta.
- Cada usuario ve solo sus datos (RLS en todas las tablas nuevas).

---

## 2. Schema de base de datos

SQL para correr en SQL Editor (después de aprobar):

```sql
-- ============================================================
-- Credenciales IOL (una fila por usuario)
-- ============================================================
CREATE TABLE iol_credentials (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  iol_username text NOT NULL,
  iol_password_encrypted text NOT NULL,  -- formato "iv_hex:ciphertext_hex" (AES-GCM)
  iol_refresh_token text,
  iol_refresh_expires_at timestamptz,
  iol_access_token text,
  iol_access_expires_at timestamptz,
  last_sync_at timestamptz,
  last_sync_error text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE iol_credentials ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own_iol_creds" ON iol_credentials FOR ALL
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- ============================================================
-- Snapshots de posiciones (cada sync = N filas con mismo snapshot_at)
-- ============================================================
CREATE TABLE iol_positions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  snapshot_at timestamptz NOT NULL DEFAULT now(),
  pais text NOT NULL,                    -- 'argentina' | 'estados_Unidos'
  simbolo text NOT NULL,
  descripcion text,
  mercado text,
  tipo text,                             -- cEDEARS, oBLIGACIONESNEGOCIABLES, etc.
  cantidad numeric,
  ppc numeric,                           -- precio promedio compra
  ultimo_precio numeric,
  variacion_diaria numeric,
  valorizado numeric,                    -- en moneda original
  ganancia_porcentaje numeric,
  ganancia_dinero numeric,
  moneda text,
  parking_disponible numeric             -- para MEP/CCL
);

CREATE INDEX iol_positions_user_snapshot ON iol_positions (user_id, snapshot_at DESC);
ALTER TABLE iol_positions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own_iol_positions" ON iol_positions FOR ALL
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- ============================================================
-- Snapshots de saldos por cuenta
-- ============================================================
CREATE TABLE iol_balances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  snapshot_at timestamptz NOT NULL DEFAULT now(),
  cuenta_numero text,
  cuenta_tipo text,                      -- inversion_Argentina_Pesos, etc.
  moneda text,
  estado text,                           -- operable | cerrada | bloqueada
  disponible numeric,
  comprometido numeric,
  saldo numeric,
  titulos_valorizados numeric,
  total numeric,
  margen_descubierto numeric,
  total_en_pesos numeric                 -- del EstadoCuentaModel raíz
);

CREATE INDEX iol_balances_user_snapshot ON iol_balances (user_id, snapshot_at DESC);
ALTER TABLE iol_balances ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own_iol_balances" ON iol_balances FOR ALL
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- ============================================================
-- Operaciones (compras/ventas/etc.) — para Fase 2
-- ============================================================
CREATE TABLE iol_operaciones (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  numero bigint NOT NULL,                -- ID de IOL
  tipo text,                             -- compra, venta, suscripcion, etc.
  simbolo text,
  cantidad numeric,
  precio numeric,
  monto numeric,
  cantidad_operada numeric,
  precio_operado numeric,
  monto_operado numeric,
  moneda text,
  estado text,
  fecha_orden timestamptz,
  fecha_operada timestamptz,
  raw jsonb,                             -- payload completo por si necesitamos más datos
  synced_at timestamptz DEFAULT now(),
  UNIQUE(user_id, numero)
);

CREATE INDEX iol_operaciones_user_fecha ON iol_operaciones (user_id, fecha_operada DESC);
ALTER TABLE iol_operaciones ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own_iol_operaciones" ON iol_operaciones FOR ALL
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- ============================================================
-- Mapping símbolo → frasco — para Fase 2
-- ============================================================
CREATE TABLE iol_frasco_mapping (
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  simbolo text NOT NULL,
  frasco text NOT NULL CHECK (frasco IN ('colchon', 'casa', 'jubilacion')),
  notas text,
  created_at timestamptz DEFAULT now(),
  PRIMARY KEY (user_id, simbolo)
);

ALTER TABLE iol_frasco_mapping ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own_iol_mapping" ON iol_frasco_mapping FOR ALL
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
```

**RLS:** todas las tablas con `auth.uid() = user_id`. Cero acceso cruzado.

**No incluye índices full-text ni materialized views** — la escala (1 usuario, ~50 posiciones, snapshots diarios) no lo justifica.

---

## 3. Edge Function: `iol-proxy`

Una sola función con dispatch por `action`. Esto evita tener que crear muchas funciones separadas.

### Endpoint

```
POST https://qpqoampoiirmdylvtsss.supabase.co/functions/v1/iol-proxy
Authorization: Bearer <supabase_user_jwt>
Content-Type: application/json

{ "action": "...", "params": {...} }
```

### Acciones implementadas

| Action | Params | Devuelve | Cuándo se usa |
|---|---|---|---|
| `connect` | `{ username, password }` | `{ ok, message }` | Setup inicial — primera vez que el user conecta IOL |
| `test_connection` | — | `{ ok, expires_at }` | Verificar que las creds siguen siendo válidas |
| `sync_portfolio` | — | `{ snapshot_at, positions_count, balances_count }` | Refrescar portafolio + saldos en BD |
| `sync_operaciones` | `{ fecha_desde?, fecha_hasta?, estado? }` | `{ count }` | Traer operaciones, para Fase 2 |
| `get_latest_portfolio` | — | `{ positions, balances, snapshot_at }` | Lectura desde BD (último snapshot) |
| `get_mep` | `{ simbolo? }` | `{ valor, fetched_at }` | Cotización MEP, Fase 3 |
| `disconnect` | — | `{ ok }` | Borrar creds + datos asociados |

### Flujo interno

Cada llamada al Edge Function ejecuta:

```
1. Validar JWT de Supabase → obtener user_id
2. Cargar iol_credentials del user (vía service_role para bypasear RLS internamente)
3. Si action != 'connect':
   - Verificar access_token vigente; si vencido, intentar refresh
   - Si refresh vencido, login con password desencriptada
   - Single-flight: lock con SELECT ... FOR UPDATE en iol_credentials
4. Ejecutar la acción correspondiente
5. Si la acción muta IOL data en BD, actualizar last_sync_at
6. Devolver resultado JSON con CORS headers permisivos
```

### Manejo de errores

| Caso | HTTP | Body |
|---|---|---|
| JWT inválido | 401 | `{ error: "unauthorized" }` |
| User sin creds IOL | 412 | `{ error: "no_credentials", message: "Conectá IOL primero" }` |
| IOL devuelve 401 (creds malas) | 401 | `{ error: "iol_auth_failed", message: "..." }` |
| IOL devuelve 429 | 429 | `{ error: "rate_limited", retry_after: 60 }` |
| IOL devuelve 5xx | 502 | `{ error: "iol_unavailable" }` |
| Action desconocida | 400 | `{ error: "unknown_action" }` |
| Excepción interna | 500 | `{ error: "internal", message: "..." }` |

---

## 4. Encriptación de password

**Algoritmo:** AES-GCM 256-bit, IV aleatorio de 12 bytes por encriptación.

**Master key:** 32 bytes hex, almacenada como variable de entorno del Edge Function:
```
IOL_ENCRYPTION_KEY=64-hex-chars-aleatorios
```

Se genera una vez con:
```bash
python -c "import secrets; print(secrets.token_hex(32))"
```

**Formato en BD:** `iv_hex:ciphertext_hex` (un string único).

**Pseudo:**
```typescript
async function encrypt(plaintext: string, hexKey: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey(
    'raw', hexToBytes(hexKey), 'AES-GCM', false, ['encrypt']
  );
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext)
  );
  return bytesToHex(iv) + ':' + bytesToHex(new Uint8Array(ct));
}

async function decrypt(encrypted: string, hexKey: string): Promise<string> {
  const [ivHex, ctHex] = encrypted.split(':');
  const key = await crypto.subtle.importKey(
    'raw', hexToBytes(hexKey), 'AES-GCM', false, ['decrypt']
  );
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: hexToBytes(ivHex) },
    key, hexToBytes(ctHex)
  );
  return new TextDecoder().decode(pt);
}
```

**Threat model:**
- Si te roban la BD: las passwords están cifradas, inútiles sin la key.
- Si te roban la key del Edge Function: ya tienen acceso al server, juego terminado igual.
- Lo importante: la key NO está en el frontend ni en la BD.

---

## 5. Estrategia de refresh de tokens IOL

El doc de IOL explicita: **refresh_token rota en cada uso**. Race conditions = invalidación accidental.

**Solución:** lock pesimista sobre la fila de `iol_credentials`:

```sql
BEGIN;
SELECT * FROM iol_credentials WHERE user_id = :user_id FOR UPDATE;
-- otras transacciones del mismo user esperan acá

-- decidir flujo:
IF access_token vigente → usar
ELIF refresh_token vigente → POST /token grant_type=refresh_token
ELSE → POST /token grant_type=password (con password desencriptada)

UPDATE iol_credentials SET
  iol_access_token = ...,
  iol_access_expires_at = ...,
  iol_refresh_token = ...,        -- rotó
  iol_refresh_expires_at = ...,
  updated_at = now()
WHERE user_id = :user_id;
COMMIT;
```

**Ventana de seguridad:** restamos 30s a `expires_at` para refrescar antes de que venza realmente.

**Si dos pestañas refrescan al mismo tiempo:** la segunda espera el lock, encuentra el token ya renovado por la primera, no necesita hacer nada.

---

## 6. Frontend — Cambios en plan-cloud.html

### Nueva pestaña: "Inversiones"

**Si no hay credenciales IOL conectadas:** mostrar form de setup:

```
┌─────────────────────────────────────────────────────┐
│  Conectá tu cuenta de IOL                           │
│                                                      │
│  Usuario IOL:    [___________________]              │
│  Password:       [___________________]              │
│                                                      │
│  [Conectar]                                          │
│                                                      │
│  Tus credenciales se guardan encriptadas en         │
│  Supabase. La password nunca sale del server.       │
└─────────────────────────────────────────────────────┘
```

**Si ya está conectado:** dashboard:

```
┌─────────────────────────────────────────────────────┐
│  Última sincronización: hace 5 min   [Refrescar]   │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐ │
│  │ Total USD   │  │ Total ARS   │  │ Ganancia    │ │
│  │ USD 10.152  │  │ $15.228.000 │  │ +13,5%      │ │
│  └─────────────┘  └─────────────┘  └─────────────┘ │
│                                                      │
│  Posiciones (Argentina + USA)                       │
│  ┌──────┬─────────────┬─────┬──────┬──────┬──────┐ │
│  │ Sym  │ Descripción │ Cant│ PPC  │ Hoy  │ Val. │ │
│  ├──────┼─────────────┼─────┼──────┼──────┼──────┤ │
│  │ AAPLD│ Apple CEDEAR│  50 │  4,1 │ 4,83 │ 241  │ │
│  │ AL35D│ Bono Arg    │ 100 │  6,8 │ 7,10 │ 710  │ │
│  │ ...  │             │     │      │      │      │ │
│  └──────┴─────────────┴─────┴──────┴──────┴──────┘ │
│                                                      │
│  Saldos por cuenta                                  │
│  • Inversión ARS:   $ 245.000  disponible           │
│  • Inversión USD:   USD 350    disponible           │
└─────────────────────────────────────────────────────┘
```

### Llamadas que hace el frontend

```typescript
// Cliente del Edge Function (simplificado)
async function callIolProxy(action: string, params: any = {}) {
  const { data: { session } } = await sb.auth.getSession();
  const res = await fetch(`${SUPABASE_URL}/functions/v1/iol-proxy`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${session.access_token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ action, params })
  });
  if (!res.ok) throw new Error((await res.json()).message || 'Error');
  return res.json();
}

// Uso:
await callIolProxy('connect', { username, password });
const { positions, balances } = await callIolProxy('get_latest_portfolio');
await callIolProxy('sync_portfolio');
```

---

## 7. Fase 1 — MVP (lectura de portafolio)

### Deliverables

1. **SQL:** crear `iol_credentials`, `iol_positions`, `iol_balances` (con RLS).
2. **Edge Function `iol-proxy`** con 4 acciones: `connect`, `test_connection`, `sync_portfolio`, `get_latest_portfolio`, `disconnect`.
3. **Variable de entorno** `IOL_ENCRYPTION_KEY` configurada en Supabase.
4. **Frontend:**
   - Nueva pestaña "Inversiones"
   - Form de setup
   - Dashboard con totales, tabla de posiciones, saldos por cuenta
   - Botón "Refrescar" + auto-sync al abrir el tab si > 10 min sin sync

### Endpoints IOL usados

- `POST /token` (auth)
- `GET /api/v2/estadocuenta` (saldos)
- `GET /api/v2/portafolio/argentina` (posiciones ARS)
- `GET /api/v2/portafolio/estados_Unidos` (posiciones USA, si tenés)

### Criterio de éxito Fase 1

- Te conectás una vez con tu user IOL + password
- Ves tus posiciones reales en la app, en USD y ARS
- Si abrís desde el celu, mismas posiciones (Edge Function es server-side)
- Si esperás un día, podés refrescar y ver valores actualizados

---

## 8. Fase 2 — Plan vs Realidad

### Concepto

Cruzar `historico_ahorro` (planificado, lo que la calculadora dice que ibas a aportar) con `iol_operaciones` (compras reales en IOL) para ver si seguís el plan.

### Mapping símbolo → frasco

Tabla `iol_frasco_mapping`. UI para definirla:

```
┌──────────────────────────────────────────────────┐
│  ¿Qué frasco corresponde a cada instrumento?     │
│                                                   │
│  SPY  → [Frasco Jubilación ▼]                    │
│  QQQ  → [Frasco Jubilación ▼]                    │
│  AL30 → [Frasco Casa       ▼]                    │
│  MM USD → [Colchón         ▼]                    │
│  AAPLD → [ Ignorar          ▼]  (no es del plan) │
│                                                   │
│  [Guardar]                                        │
└──────────────────────────────────────────────────┘
```

### Vista "Plan vs Real" (en tab Histórico o tab nuevo)

Para cada mes registrado en histórico:

```
Mes        Frasco        Plan USD  Real USD  Δ      Estado
─────────────────────────────────────────────────────────────
2026-05    Colchón        325        300      -25    OK
2026-05    Casa           650        0        -650   Sin aporte
2026-05    Jubilación     325        330      +5     OK
2026-04    Colchón        325        330      +5     OK
...
```

Donde "Real USD" = suma de compras de IOL del mes correspondientes a símbolos del frasco, valuadas a MEP del momento.

### Gráfico de evolución

- Eje X: tiempo (mes)
- Eje Y: USD acumulado
- Líneas: 3 líneas (plan colchón, plan casa, plan jubilación) + 3 líneas (real colchón, real casa, real jubilación)
- Permite ver desvíos visuales

### Endpoints IOL nuevos para Fase 2

- `GET /api/v2/operaciones?filtro.fechaDesde=...&filtro.fechaHasta=...&filtro.estado=terminadas`

### Criterio de éxito Fase 2

- Configurás el mapping de símbolos
- Ves tabla mes-a-mes de plan vs real
- Detectás meses donde no aportaste lo planificado

---

## 9. Fase 3 — Smart features

### 9.1 MEP en vivo en la calculadora

Hoy tipeás el MEP a mano. Reemplazarlo por:

```
Cotización dólar MEP:  [1.523,40] $/USD   [↻ actualizar]
                       última: hace 2 min
```

- Botón "actualizar" llama `iol-proxy` con action `get_mep` (símbolo AL30 default).
- Caché 5 min para no machacar.
- Al loguearse, actualiza automático.

### 9.2 Análisis de rebalanceo

Comparar composición real del Frasco Jubilación con target 70/30 SPY/QQQ:

```
Composición actual del Frasco Jubilación:
  SPY: USD 8.500 (74,5%)  Target: 70%  → +4,5% por encima
  QQQ: USD 2.900 (25,5%)  Target: 30%  → -4,5% por debajo

Sugerencia: en tu próximo aporte, asigná más a QQQ para volver al target.
  Si aportás USD 500: 100% a QQQ → composición proyectada 71,4% / 28,6%.
```

### 9.3 Snapshots automáticos

Cron diario (vía pg_cron + un secret) que llama al Edge Function para hacer sync de cada usuario con creds activas.

Útil para no perder datos si no usás la app por días.

### Criterio de éxito Fase 3

- La calculadora siempre tiene MEP fresco sin que tipees
- La pestaña Inversiones te sugiere rebalanceos
- El histórico tiene snapshots aunque no entres a la app

---

## 10. Decisiones pendientes / open questions

Cosas que me gustaría definir con vos antes de codear:

1. **Cuentas IOL múltiples:** ¿operás con una sola cuenta IOL o tenés más de una? La API soporta múltiples, pero la UI se simplifica mucho si es una sola.

2. **Histórico de posiciones:** ¿guardamos un snapshot por día? ¿o solo el último? Snapshots diarios permiten gráficos históricos lindos pero son ~50 filas/día.

3. **Operaciones — cuánto histórico bajar la primera vez:** ¿1 año? ¿todo? IOL no pagina, así que bajar todo de una puede ser pesado si tenés mucha actividad.

4. **Símbolos a trackear inicialmente:** te leo qué tickers tenés y armamos el mapping a frascos. De tu screenshot de IOL veo: AAPLD, AL35D, AMZND, MELID, PAMPD, QQQD, SPYD, TRAND, más posibles otros.

5. **Fallback si IOL está caído:** si la API de IOL no responde, ¿mostramos último snapshot guardado? ¿error puro?

6. **Sync MEP — frecuencia:** ¿cuánto cache? 5 min es razonable, pero podemos hacer cache 1 hora si querés ser más conservador con las llamadas a IOL.

7. **Quién corre el setup inicial:** vos sabés tu password de IOL. ¿La querés tipear en el form de la app y que la app se encargue del primer login, o preferís hacer un flujo más manual?

---

## 11. Plan de implementación

Una vez aprobado el diseño:

### Sprint 1 (Fase 1)
1. Generar `IOL_ENCRYPTION_KEY` y configurarla en Supabase
2. Correr el SQL del Schema (sección 2, tablas Fase 1)
3. Escribir Edge Function `iol-proxy` con acciones core
4. Configurar la función en Supabase (deploy via CLI o dashboard)
5. Probar con curl: connect → sync → get
6. Sumar pestaña Inversiones al HTML
7. Probar end-to-end con tu cuenta real
8. Deploy a Vercel

### Sprint 2 (Fase 2)
1. Tabla `iol_operaciones` y `iol_frasco_mapping`
2. Acciones `sync_operaciones`, `get_plan_vs_real` en Edge Function
3. UI para mapping de símbolos → frascos
4. Vista "Plan vs Real" con tabla y gráfico

### Sprint 3 (Fase 3)
1. Action `get_mep`
2. Integración en calculadora
3. Análisis de rebalanceo
4. Cron de snapshots automáticos

---

## 12. Riesgos y mitigaciones

| Riesgo | Probabilidad | Impacto | Mitigación |
|---|---|---|---|
| IOL cambia la API | Bajo | Alto | El doc IOL es estable. Si rompen, ajustamos el Edge Function (un solo punto). |
| Rate limiting de IOL | Medio | Medio | Cache aggressive de cotizaciones, sync manual + cache. |
| Master key comprometida | Bajo | Alto | Rotar la key, re-encriptar todas las passwords. |
| Edge Function timeout (10s en free tier) | Bajo | Medio | Operaciones lentas async; portfolio chico < 1s normalmente. |
| Supabase free tier overrun | Bajo | Bajo | 500k invocations/mes, uso real << 1k. |
| IOL refresh_token expira mientras estás dormido | Alto | Bajo | Auto-relogin con password desencriptada. |

---

## 13. Costos

**Cero pesos.** Todo en free tiers:
- Supabase: 500 MB DB + 500k Edge Function invocations + auth ilimitado
- IOL: gratis (es feature del broker)
- Vercel: hosting estático ilimitado

---

## Próximos pasos

Revisá el doc. Cuando aprobes (o pidas cambios) en estos puntos, arrancamos a codear:

1. ✅ / ❌ Arquitectura general (Edge Function como proxy)
2. ✅ / ❌ Schema de tablas (sección 2)
3. ✅ / ❌ Diseño del API del Edge Function (sección 3)
4. ✅ / ❌ Estrategia de encriptación (sección 4)
5. Respuestas a las decisiones pendientes (sección 10)

Una vez resuelto, codeamos Fase 1.
