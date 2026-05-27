-- =============================================================================
-- IOL Integration — Schema Fase 1
-- =============================================================================
-- Correr este SQL en Supabase SQL Editor (New query → Run).
-- Crea 4 tablas con RLS para integrar IOL.
-- =============================================================================

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
CREATE POLICY "own_iol_creds_all" ON iol_credentials FOR ALL
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- ============================================================
-- Snapshots de posiciones — snapshot diario
-- (cada sync del día sobreescribe el snapshot del día)
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
CREATE INDEX iol_positions_user_simbolo ON iol_positions (user_id, simbolo);

ALTER TABLE iol_positions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own_iol_positions_all" ON iol_positions FOR ALL
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- ============================================================
-- Snapshots de saldos por cuenta — snapshot diario
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
CREATE POLICY "own_iol_balances_all" ON iol_balances FOR ALL
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- ============================================================
-- Mapping símbolo → frasco
-- ============================================================
CREATE TABLE iol_frasco_mapping (
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  simbolo text NOT NULL,
  frasco text NOT NULL CHECK (frasco IN ('colchon', 'casa', 'jubilacion')),
  notas text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  PRIMARY KEY (user_id, simbolo)
);

ALTER TABLE iol_frasco_mapping ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own_iol_mapping_all" ON iol_frasco_mapping FOR ALL
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- ============================================================
-- Trigger para updated_at en mapping
-- ============================================================
CREATE TRIGGER iol_mapping_updated_at
  BEFORE UPDATE ON iol_frasco_mapping
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER iol_credentials_updated_at
  BEFORE UPDATE ON iol_credentials
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================================
-- Verificación
-- ============================================================
-- Esto debería mostrar las 4 tablas creadas:
-- SELECT table_name FROM information_schema.tables
-- WHERE table_schema = 'public' AND table_name LIKE 'iol_%';
