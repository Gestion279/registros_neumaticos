// ---------------------------------------------------------------
//  Configuración de Supabase
//  Supabase > Project Settings > API
//  La "anon public key" es pública por diseño: la protección real
//  la dan las políticas RLS del archivo supabase/schema.sql.
//  NUNCA pegues acá la clave "service_role".
// ---------------------------------------------------------------
window.APP_CONFIG = {
  SUPABASE_URL: "https://TU-PROYECTO.supabase.co",
  SUPABASE_ANON_KEY: "TU_ANON_PUBLIC_KEY"
};
