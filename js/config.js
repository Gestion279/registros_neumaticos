// ---------------------------------------------------------------
//  Configuración de Supabase
//  Supabase > Project Settings > API
//  La "anon public key" es pública por diseño: la protección real
//  la dan las políticas RLS del archivo supabase/schema.sql.
//  NUNCA pegues acá la clave "service_role".
// ---------------------------------------------------------------
window.APP_CONFIG = {
  SUPABASE_URL: "https://oixzkvkybqexvrzwzwis.supabase.co",
  SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9peHprdmt5YnFleHZyend6d2lzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg4NTUxNzEsImV4cCI6MjEwNDQzMTE3MX0.BTghtY8mZkyrK2y-kZXMb1aIecptX3OHOpNFqUBMzP4"
};
