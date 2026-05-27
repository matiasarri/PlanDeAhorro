-- =========================================================
-- IMPORTACION INICIAL desde GastosImpuestosServicios.xlsx
-- =========================================================
-- INSTRUCCIONES:
-- 1. Registrate primero en la app (plan-cloud.html) con tu email.
-- 2. Reemplaza 'CAMBIAR_POR_TU_EMAIL' por el email con que te registraste.
-- 3. Copia todo el bloque y pegalo en Supabase -> SQL Editor.
-- 4. Apreta Run.
-- =========================================================

DO $$
DECLARE
  v_user_id uuid;
BEGIN
  SELECT id INTO v_user_id FROM auth.users WHERE email = 'CAMBIAR_POR_TU_EMAIL';

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Email no encontrado en auth.users. Registrate primero en la app.';
  END IF;

  DELETE FROM gastos WHERE user_id = v_user_id;

  INSERT INTO gastos (user_id, year, concepto, codigo,
    enero, febrero, marzo, abril, mayo, junio,
    julio, agosto, septiembre, octubre, noviembre, diciembre, orden) VALUES
    (v_user_id, 2025, 'API Inmoviliaria', '15110021232628134', 0, 0, 0, 0, 0, 0, 0, 0, 0, 3380, 0, 3380, 1),
    (v_user_id, 2025, 'COPROL', '205061', 0, 0, 0, 0, 0, 0, 0, 0, 14575.61, 12274.20, 13500.42, 12656.64, 2),
    (v_user_id, 2025, 'EPE', '285701812968', 0, 0, 0, 0, 0, 0, 0, 0, 18903.86, 18903.86, 20030.44, 20030.43, 3),
    (v_user_id, 2025, 'Litoral Gas', '98715749998', 0, 0, 0, 0, 0, 0, 0, 0, 38692.08, 38982.99, 0, 1032.62, 4),
    (v_user_id, 2025, 'Roldan', '1291427', 0, 0, 0, 0, 0, 0, 0, 0, 25585.47, 25585.47, 25585.47, 25585.47, 5),
    (v_user_id, 2025, 'Patente OTL377', '756635337705000', 0, 0, 0, 0, 0, 0, 0, 0, 0, 17795.20, 16771, 16771, 6),
    (v_user_id, 2025, 'Patente AG662JW', '00241476625166060', 0, 0, 0, 0, 0, 0, 0, 0, 0, 111719.16, 105485, 105485, 7),
    (v_user_id, 2025, 'Convenio AG662JW', '728187326', 0, 0, 0, 0, 0, 0, 0, 0, 0, 45106.65, 46157.63, 47736.36, 8),
    (v_user_id, 2026, 'API Inmoviliaria', '15110021232628134', 11440, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1),
    (v_user_id, 2026, 'COPROL', '205061', 16940.68, 20705.29, 19764.13, 17881.82, 21044.08, 0, 0, 0, 0, 0, 0, 0, 2),
    (v_user_id, 2026, 'EPE', '285701812968', 22590.82, 22590.82, 39631.52, 39900.07, 48994.70, 0, 0, 0, 0, 0, 0, 0, 3),
    (v_user_id, 2026, 'Litoral Gas', '98715749998', 48026.11, 47806.22, 0, 0, 16653.25, 0, 0, 0, 0, 0, 0, 0, 4),
    (v_user_id, 2026, 'Roldan', '1291427', 25585.47, 28016.06, 28016.06, 28016.06, 3924.29, 0, 0, 0, 0, 0, 0, 0, 5),
    (v_user_id, 2026, 'Cuota Polo Track', '', 1052879.75, 1061897.91, 1060462.85, 1054910.27, 1049244.83, 0, 0, 0, 0, 0, 0, 0, 6),
    (v_user_id, 2026, 'Patente OTL377', '756635337705000', 76526.50, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 7),
    (v_user_id, 2026, 'Patente AG662JW', '00241476625166060', 504980.50, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 8),
    (v_user_id, 2026, 'Convenio AG662JW', '728187326', 49315, 50893.83, 52472.56, 54051.29, 55630.03, 0, 0, 0, 0, 0, 0, 0, 9);

  RAISE NOTICE 'Importados 17 conceptos.';
END $$;