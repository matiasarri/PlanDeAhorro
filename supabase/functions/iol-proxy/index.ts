// =============================================================================
// IOL Proxy — Supabase Edge Function (Deno)
// =============================================================================
// Proxy server-side entre el frontend de plan-cloud y la API de IOL.
//
// - Auth: JWT de Supabase en Authorization header (RLS aplica naturalmente).
// - Encriptación: AES-GCM 256, master key en env var IOL_ENCRYPTION_KEY.
// - Scope: READ-ONLY (no llama endpoints /operar/* de IOL, por diseño).
// - Snapshots diarios: cada sync del día sobreescribe el snapshot del día.
// =============================================================================

import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0'

const IOL_BASE = 'https://api.invertironline.com'
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!
const MASTER_KEY_HEX = Deno.env.get('IOL_ENCRYPTION_KEY')!

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

// =============================================================================
// Encryption helpers (AES-GCM 256)
// =============================================================================
function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < hex.length; i += 2) bytes[i / 2] = parseInt(hex.substr(i, 2), 16)
  return bytes
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('')
}

async function getCryptoKey(usage: 'encrypt' | 'decrypt'): Promise<CryptoKey> {
  if (!MASTER_KEY_HEX || MASTER_KEY_HEX.length !== 64) {
    throw new Error('IOL_ENCRYPTION_KEY no configurada o longitud inválida (debe ser 64 chars hex)')
  }
  return await crypto.subtle.importKey(
    'raw',
    hexToBytes(MASTER_KEY_HEX),
    'AES-GCM',
    false,
    [usage],
  )
}

async function encryptPassword(plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const key = await getCryptoKey('encrypt')
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(plaintext),
  )
  return bytesToHex(iv) + ':' + bytesToHex(new Uint8Array(ct))
}

async function decryptPassword(encrypted: string): Promise<string> {
  const [ivHex, ctHex] = encrypted.split(':')
  if (!ivHex || !ctHex) throw new Error('Formato de password encriptada inválido')
  const key = await getCryptoKey('decrypt')
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: hexToBytes(ivHex) },
    key,
    hexToBytes(ctHex),
  )
  return new TextDecoder().decode(pt)
}

// =============================================================================
// IOL Auth
// =============================================================================
interface IolTokenResponse {
  access_token: string
  refresh_token: string
  expires_in: number
  token_type: string
}

async function iolLogin(username: string, password: string): Promise<IolTokenResponse> {
  const body = new URLSearchParams({
    username,
    password,
    grant_type: 'password',
  })
  const res = await fetch(`${IOL_BASE}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })
  if (!res.ok) {
    const errText = await res.text()
    throw new Error(`IOL login failed (${res.status}): ${errText}`)
  }
  return await res.json()
}

async function iolRefresh(refreshToken: string): Promise<IolTokenResponse> {
  const body = new URLSearchParams({
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  })
  const res = await fetch(`${IOL_BASE}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })
  if (!res.ok) throw new Error(`IOL refresh failed (${res.status})`)
  return await res.json()
}

async function ensureAccessToken(supabase: SupabaseClient, userId: string): Promise<string> {
  const { data: creds, error } = await supabase
    .from('iol_credentials')
    .select('*')
    .eq('user_id', userId)
    .single()

  if (error || !creds) throw new Error('no_credentials')

  const now = new Date()
  const accessExpires = creds.iol_access_expires_at ? new Date(creds.iol_access_expires_at) : null
  const refreshExpires = creds.iol_refresh_expires_at ? new Date(creds.iol_refresh_expires_at) : null

  // Access token vigente con margen de 30s
  if (creds.iol_access_token && accessExpires && accessExpires.getTime() - now.getTime() > 30000) {
    return creds.iol_access_token
  }

  // Intentar refresh
  let tokenResponse: IolTokenResponse | null = null
  if (creds.iol_refresh_token && refreshExpires && refreshExpires.getTime() > now.getTime()) {
    try {
      tokenResponse = await iolRefresh(creds.iol_refresh_token)
    } catch (e) {
      console.warn('Refresh failed, fallback to login:', e)
    }
  }

  // Fallback a login con password desencriptada
  if (!tokenResponse) {
    const password = await decryptPassword(creds.iol_password_encrypted)
    tokenResponse = await iolLogin(creds.iol_username, password)
  }

  // Persistir nuevos tokens
  const newAccessExpires = new Date(now.getTime() + tokenResponse.expires_in * 1000)
  const newRefreshExpires = new Date(now.getTime() + 3600 * 1000) // 1 hora aprox

  await supabase
    .from('iol_credentials')
    .update({
      iol_access_token: tokenResponse.access_token,
      iol_access_expires_at: newAccessExpires.toISOString(),
      iol_refresh_token: tokenResponse.refresh_token,
      iol_refresh_expires_at: newRefreshExpires.toISOString(),
      updated_at: now.toISOString(),
    })
    .eq('user_id', userId)

  return tokenResponse.access_token
}

// =============================================================================
// IOL API calls (solo GET — read-only)
// =============================================================================
async function iolGet(token: string, path: string): Promise<unknown> {
  const res = await fetch(`${IOL_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
  })
  if (res.status === 401) throw new Error('iol_token_expired')
  if (!res.ok) {
    const errText = await res.text()
    throw new Error(`IOL ${path} failed (${res.status}): ${errText}`)
  }
  return await res.json()
}

// =============================================================================
// Acciones
// =============================================================================

async function actionConnect(
  supabase: SupabaseClient,
  userId: string,
  params: { username?: string; password?: string },
): Promise<Response> {
  const { username, password } = params
  if (!username || !password) {
    return jsonResponse({ error: 'missing_credentials', message: 'Falta usuario o password' }, 400)
  }

  // Probar login con IOL antes de guardar nada
  let tokenResponse: IolTokenResponse
  try {
    tokenResponse = await iolLogin(username, password)
  } catch (e) {
    const msg = (e as Error).message
    if (msg.includes('invalid_grant')) {
      return jsonResponse({
        error: 'iol_auth_failed',
        message: 'Usuario o password incorrectos en IOL. Verificá también que tengas APIs habilitadas en Mi Cuenta → Personalización.',
      }, 401)
    }
    return jsonResponse({ error: 'iol_auth_failed', message: msg }, 401)
  }

  // Encriptar password
  const encrypted = await encryptPassword(password)
  const now = new Date()
  const accessExpires = new Date(now.getTime() + tokenResponse.expires_in * 1000)
  const refreshExpires = new Date(now.getTime() + 3600 * 1000)

  const { error } = await supabase.from('iol_credentials').upsert({
    user_id: userId,
    iol_username: username,
    iol_password_encrypted: encrypted,
    iol_access_token: tokenResponse.access_token,
    iol_access_expires_at: accessExpires.toISOString(),
    iol_refresh_token: tokenResponse.refresh_token,
    iol_refresh_expires_at: refreshExpires.toISOString(),
    last_sync_at: null,
    last_sync_error: null,
    updated_at: now.toISOString(),
  })

  if (error) return jsonResponse({ error: 'db_error', message: error.message }, 500)

  return jsonResponse({ ok: true, message: 'Conectado a IOL', username })
}

async function actionTestConnection(supabase: SupabaseClient, userId: string): Promise<Response> {
  try {
    await ensureAccessToken(supabase, userId)
    return jsonResponse({ ok: true })
  } catch (e) {
    return jsonResponse({ ok: false, error: (e as Error).message })
  }
}

async function actionSyncPortfolio(supabase: SupabaseClient, userId: string): Promise<Response> {
  let token: string
  try {
    token = await ensureAccessToken(supabase, userId)
  } catch (e) {
    const msg = (e as Error).message
    await supabase.from('iol_credentials')
      .update({ last_sync_error: msg, updated_at: new Date().toISOString() })
      .eq('user_id', userId)
    if (msg === 'no_credentials') {
      return jsonResponse({ error: 'no_credentials' }, 412)
    }
    return jsonResponse({ error: 'auth_failed', message: msg }, 401)
  }

  // Fetch IOL data (paralelo para velocidad)
  let estadoCuenta: any, portAR: any, portUSA: any
  try {
    [estadoCuenta, portAR, portUSA] = await Promise.all([
      iolGet(token, '/api/v2/estadocuenta'),
      iolGet(token, '/api/v2/portafolio/argentina'),
      iolGet(token, '/api/v2/portafolio/estados_Unidos').catch(() => ({
        activos: [],
        pais: 'estados_Unidos',
      })),
    ])
  } catch (e) {
    const msg = (e as Error).message
    await supabase.from('iol_credentials')
      .update({ last_sync_error: msg, updated_at: new Date().toISOString() })
      .eq('user_id', userId)
    return jsonResponse({ error: 'iol_fetch_failed', message: msg }, 502)
  }

  const now = new Date()
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString()
  const tomorrowStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString()

  // Borrar snapshot del día (si ya hubo sync hoy)
  await supabase.from('iol_balances')
    .delete()
    .eq('user_id', userId)
    .gte('snapshot_at', todayStart)
    .lt('snapshot_at', tomorrowStart)

  await supabase.from('iol_positions')
    .delete()
    .eq('user_id', userId)
    .gte('snapshot_at', todayStart)
    .lt('snapshot_at', tomorrowStart)

  // Preparar inserts de balances
  const balancesToInsert = []
  for (const cuenta of estadoCuenta.cuentas || []) {
    balancesToInsert.push({
      user_id: userId,
      snapshot_at: now.toISOString(),
      cuenta_numero: cuenta.numero,
      cuenta_tipo: cuenta.tipo,
      moneda: cuenta.moneda,
      estado: cuenta.estado,
      disponible: cuenta.disponible,
      comprometido: cuenta.comprometido,
      saldo: cuenta.saldo,
      titulos_valorizados: cuenta.titulosValorizados,
      total: cuenta.total,
      margen_descubierto: cuenta.margenDescubierto,
      total_en_pesos: estadoCuenta.totalEnPesos,
    })
  }
  if (balancesToInsert.length) {
    const { error } = await supabase.from('iol_balances').insert(balancesToInsert)
    if (error) return jsonResponse({ error: 'db_error', message: error.message }, 500)
  }

  // Preparar inserts de posiciones
  const positionsToInsert = []
  for (const portfolio of [portAR, portUSA]) {
    if (!portfolio?.activos) continue
    for (const activo of portfolio.activos) {
      positionsToInsert.push({
        user_id: userId,
        snapshot_at: now.toISOString(),
        pais: portfolio.pais,
        simbolo: activo.titulo?.simbolo,
        descripcion: activo.titulo?.descripcion,
        mercado: activo.titulo?.mercado,
        tipo: activo.titulo?.tipo,
        cantidad: activo.cantidad,
        ppc: activo.ppc,
        ultimo_precio: activo.ultimoPrecio,
        variacion_diaria: activo.variacionDiaria,
        valorizado: activo.valorizado,
        ganancia_porcentaje: activo.gananciaPorcentaje,
        ganancia_dinero: activo.gananciaDinero,
        moneda: activo.titulo?.moneda,
        parking_disponible: activo.parking?.disponibleInmediato || null,
      })
    }
  }
  if (positionsToInsert.length) {
    const { error } = await supabase.from('iol_positions').insert(positionsToInsert)
    if (error) return jsonResponse({ error: 'db_error', message: error.message }, 500)
  }

  // Update last_sync_at
  await supabase.from('iol_credentials')
    .update({
      last_sync_at: now.toISOString(),
      last_sync_error: null,
      updated_at: now.toISOString(),
    })
    .eq('user_id', userId)

  return jsonResponse({
    snapshot_at: now.toISOString(),
    positions_count: positionsToInsert.length,
    balances_count: balancesToInsert.length,
  })
}

async function actionGetLatestPortfolio(
  supabase: SupabaseClient,
  userId: string,
): Promise<Response> {
  const { data: creds } = await supabase
    .from('iol_credentials')
    .select('last_sync_at, last_sync_error, iol_username')
    .eq('user_id', userId)
    .maybeSingle()

  if (!creds) {
    return jsonResponse({
      connected: false,
      positions: [],
      balances: [],
      snapshot_at: null,
      last_sync_at: null,
      last_sync_error: null,
    })
  }

  // Buscar el último snapshot (más reciente)
  const { data: latestPos } = await supabase
    .from('iol_positions')
    .select('snapshot_at')
    .eq('user_id', userId)
    .order('snapshot_at', { ascending: false })
    .limit(1)

  const latestSnapshot = latestPos?.[0]?.snapshot_at

  if (!latestSnapshot) {
    return jsonResponse({
      connected: true,
      username: creds.iol_username,
      positions: [],
      balances: [],
      snapshot_at: null,
      last_sync_at: creds.last_sync_at,
      last_sync_error: creds.last_sync_error,
    })
  }

  const { data: positions } = await supabase
    .from('iol_positions')
    .select('*')
    .eq('user_id', userId)
    .eq('snapshot_at', latestSnapshot)

  const { data: balances } = await supabase
    .from('iol_balances')
    .select('*')
    .eq('user_id', userId)
    .eq('snapshot_at', latestSnapshot)

  return jsonResponse({
    connected: true,
    username: creds.iol_username,
    positions: positions || [],
    balances: balances || [],
    snapshot_at: latestSnapshot,
    last_sync_at: creds.last_sync_at,
    last_sync_error: creds.last_sync_error,
  })
}

async function actionDisconnect(supabase: SupabaseClient, userId: string): Promise<Response> {
  // RLS asegura que solo borre las del user actual
  await supabase.from('iol_positions').delete().eq('user_id', userId)
  await supabase.from('iol_balances').delete().eq('user_id', userId)
  await supabase.from('iol_credentials').delete().eq('user_id', userId)
  return jsonResponse({ ok: true })
}

// =============================================================================
// Handler principal
// =============================================================================
Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  if (req.method !== 'POST') {
    return jsonResponse({ error: 'method_not_allowed' }, 405)
  }

  try {
    // Validar JWT de Supabase
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) {
      return jsonResponse({ error: 'unauthorized', message: 'Falta Authorization header' }, 401)
    }
    const token = authHeader.replace(/^Bearer\s+/i, '')

    // Cliente Supabase que actúa como el user (RLS aplica)
    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    })

    // Validar JWT explícitamente con el token
    const { data: { user }, error: authError } = await supabase.auth.getUser(token)
    if (authError || !user) {
      console.error('Auth error:', authError)
      return jsonResponse({
        error: 'unauthorized',
        message: 'JWT inválido',
        details: authError?.message,
      }, 401)
    }

    const body = await req.json().catch(() => ({}))
    const action = body.action
    const params = body.params || {}

    switch (action) {
      case 'connect':
        return await actionConnect(supabase, user.id, params)
      case 'test_connection':
        return await actionTestConnection(supabase, user.id)
      case 'sync_portfolio':
        return await actionSyncPortfolio(supabase, user.id)
      case 'get_latest_portfolio':
        return await actionGetLatestPortfolio(supabase, user.id)
      case 'disconnect':
        return await actionDisconnect(supabase, user.id)
      default:
        return jsonResponse({ error: 'unknown_action', message: `Action no reconocida: ${action}` }, 400)
    }
  } catch (err) {
    console.error('Unhandled error:', err)
    return jsonResponse({
      error: 'internal',
      message: (err as Error).message,
    }, 500)
  }
})
