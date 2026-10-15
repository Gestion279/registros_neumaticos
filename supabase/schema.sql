-- =====================================================================
--  Historial de cambios de neumáticos - Esquema de Supabase
--  ACCESO LIBRE: cualquiera con el link puede ver y cargar (sin login).
--  Ejecutar completo en: Supabase > SQL Editor > New query > Run
--  (Se puede volver a ejecutar sin problemas.)
-- =====================================================================

-- 1) Tabla principal: una fila por cambio (un PDF = un cambio)
create table if not exists public.cambios_neumaticos (
  id               bigint generated always as identity primary key,
  dominio          text   not null,
  fecha_cambio     date   not null,
  kilometraje      int,
  marca_neumatico  text,
  medida           text,
  cantidad         int,
  alineacion       boolean,
  rotacion         boolean,
  balanceo         boolean,
  valvulas         boolean,
  chofer           text,
  zona             text,
  asignacion       text,
  observaciones    text,
  pdf_path         text,            -- ruta del PDF dentro del bucket "pdfs"
  archivo_origen   text,            -- nombre original del archivo
  created_at       timestamptz not null default now(),
  unique (dominio, fecha_cambio)    -- evita duplicados al volver a subir un PDF
);

create index if not exists idx_cambios_dominio_fecha
  on public.cambios_neumaticos (dominio, fecha_cambio);

-- 2) Vista resumen para el listado de patentes
create or replace view public.patentes_resumen
with (security_invoker = true) as
select dominio,
       count(*)::int       as cambios,
       max(fecha_cambio)   as ultimo_cambio
from public.cambios_neumaticos
group by dominio;

-- 3) Acceso público: leer, agregar y reemplazar. NO se permite borrar.
alter table public.cambios_neumaticos enable row level security;

drop policy if exists "auth_select"   on public.cambios_neumaticos;
drop policy if exists "auth_insert"   on public.cambios_neumaticos;
drop policy if exists "auth_update"   on public.cambios_neumaticos;
drop policy if exists "auth_delete"   on public.cambios_neumaticos;
drop policy if exists "public_select" on public.cambios_neumaticos;
drop policy if exists "public_insert" on public.cambios_neumaticos;
drop policy if exists "public_update" on public.cambios_neumaticos;

create policy "public_select" on public.cambios_neumaticos
  for select to anon, authenticated using (true);
create policy "public_insert" on public.cambios_neumaticos
  for insert to anon, authenticated with check (true);
create policy "public_update" on public.cambios_neumaticos
  for update to anon, authenticated using (true) with check (true);

-- 4) Bucket de PDF: solo PDF, máximo 10 MB por archivo
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('pdfs', 'pdfs', false, 10485760, array['application/pdf'])
on conflict (id) do update
  set file_size_limit = 10485760,
      allowed_mime_types = array['application/pdf'];

drop policy if exists "pdfs_select"        on storage.objects;
drop policy if exists "pdfs_insert"        on storage.objects;
drop policy if exists "pdfs_update"        on storage.objects;
drop policy if exists "pdfs_delete"        on storage.objects;
drop policy if exists "pdfs_public_select" on storage.objects;
drop policy if exists "pdfs_public_insert" on storage.objects;
drop policy if exists "pdfs_public_update" on storage.objects;

create policy "pdfs_public_select" on storage.objects
  for select to anon, authenticated using (bucket_id = 'pdfs');
create policy "pdfs_public_insert" on storage.objects
  for insert to anon, authenticated with check (bucket_id = 'pdfs');
create policy "pdfs_public_update" on storage.objects
  for update to anon, authenticated using (bucket_id = 'pdfs') with check (bucket_id = 'pdfs');
