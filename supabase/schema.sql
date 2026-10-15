-- =====================================================================
--  Historial de cambios de neumáticos - Esquema de Supabase
--  ACCESO LIBRE: cualquiera con el link puede ver y cargar (sin login).
--  Ejecutar completo en: Supabase > SQL Editor > New query > Run
--  Se puede volver a ejecutar sin problemas: aplica solo lo que falta.
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

-- Fecha de la última modificación (útil para saber si un registro fue reemplazado)
alter table public.cambios_neumaticos
  add column if not exists updated_at timestamptz;

-- El índice único de (dominio, fecha_cambio) ya cubre estas búsquedas:
-- este índice era un duplicado que solo ocupaba espacio y enlentecía las escrituras.
drop index if exists public.idx_cambios_dominio_fecha;

-- 2) Validaciones de datos
--    "not valid" = se exigen a partir de ahora sin revisar las filas viejas,
--    así el script no falla si ya hay algún dato fuera de rango.
alter table public.cambios_neumaticos drop constraint if exists chk_dominio;
alter table public.cambios_neumaticos add constraint chk_dominio
  check (dominio ~ '^[A-Z0-9]{5,8}$') not valid;

alter table public.cambios_neumaticos drop constraint if exists chk_kilometraje;
alter table public.cambios_neumaticos add constraint chk_kilometraje
  check (kilometraje is null or kilometraje between 0 and 3000000) not valid;

alter table public.cambios_neumaticos drop constraint if exists chk_cantidad;
alter table public.cambios_neumaticos add constraint chk_cantidad
  check (cantidad is null or cantidad between 0 and 20) not valid;

alter table public.cambios_neumaticos drop constraint if exists chk_largos;
alter table public.cambios_neumaticos add constraint chk_largos
  check (
        coalesce(length(marca_neumatico), 0) <= 100
    and coalesce(length(medida), 0)          <= 40
    and coalesce(length(chofer), 0)          <= 100
    and coalesce(length(zona), 0)            <= 100
    and coalesce(length(asignacion), 0)      <= 200
    and coalesce(length(observaciones), 0)   <= 3000
    and coalesce(length(archivo_origen), 0)  <= 255
  ) not valid;

alter table public.cambios_neumaticos drop constraint if exists chk_pdf_path;
alter table public.cambios_neumaticos add constraint chk_pdf_path
  check (pdf_path is null or pdf_path ~* '^[A-Z0-9 _-]{1,15}/\d{4}-\d{2}-\d{2}\.pdf$') not valid;

-- 3) Normalización automática antes de guardar
--    "ab 500 cm", "AB-500-CM" y "AB500CM" quedan todos como "AB500CM",
--    así no se crean patentes duplicadas por cómo se escribió.
create or replace function public.normalizar_cambio()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.dominio := upper(regexp_replace(coalesce(new.dominio, ''), '[^A-Za-z0-9]', '', 'g'));
  new.marca_neumatico := nullif(btrim(new.marca_neumatico), '');
  new.medida          := nullif(upper(btrim(new.medida)), '');
  new.chofer          := nullif(btrim(new.chofer), '');
  new.zona            := nullif(btrim(new.zona), '');
  new.asignacion      := nullif(btrim(new.asignacion), '');
  new.observaciones   := nullif(btrim(new.observaciones), '');

  if new.fecha_cambio > (now() at time zone 'America/Argentina/Buenos_Aires')::date + 1 then
    raise exception 'La fecha del cambio (%) es posterior a hoy.', new.fecha_cambio;
  end if;
  if new.fecha_cambio < date '2000-01-01' then
    raise exception 'La fecha del cambio (%) es demasiado antigua.', new.fecha_cambio;
  end if;

  if tg_op = 'UPDATE' then
    new.created_at := old.created_at;   -- no se puede reescribir la fecha de alta
    new.updated_at := now();
  end if;
  return new;
end;
$$;

drop trigger if exists trg_normalizar_cambio on public.cambios_neumaticos;
create trigger trg_normalizar_cambio
  before insert or update on public.cambios_neumaticos
  for each row execute function public.normalizar_cambio();

-- 4) Historial de reemplazos
--    Cada vez que alguien reemplaza un registro, la versión anterior se guarda acá.
--    Desde la app no se puede ver ni tocar: se consulta en el Table Editor de Supabase.
create table if not exists public.cambios_neumaticos_historial (
  id            bigint generated always as identity primary key,
  cambio_id     bigint not null,
  datos_previos jsonb  not null,
  reemplazado_en timestamptz not null default now()
);
create index if not exists idx_historial_cambio
  on public.cambios_neumaticos_historial (cambio_id, reemplazado_en desc);

alter table public.cambios_neumaticos_historial enable row level security;
-- Sin políticas a propósito: anon y authenticated no tienen acceso.
revoke all on public.cambios_neumaticos_historial from anon, authenticated;

create or replace function public.guardar_version_previa()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if to_jsonb(old) - 'updated_at' is distinct from to_jsonb(new) - 'updated_at' then
    insert into public.cambios_neumaticos_historial (cambio_id, datos_previos)
    values (old.id, to_jsonb(old));
  end if;
  return new;
end;
$$;
revoke execute on function public.guardar_version_previa() from public, anon, authenticated;

drop trigger if exists trg_guardar_version_previa on public.cambios_neumaticos;
create trigger trg_guardar_version_previa
  after update on public.cambios_neumaticos
  for each row execute function public.guardar_version_previa();

-- 5) Vista resumen para el listado de patentes
create or replace view public.patentes_resumen
with (security_invoker = true) as
select dominio,
       count(*)::int       as cambios,
       max(fecha_cambio)   as ultimo_cambio
from public.cambios_neumaticos
group by dominio;

-- 6) Acceso público: leer, agregar y reemplazar. NO se permite borrar.
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

-- Refuerzo: aunque alguien agregue por error una política de borrado,
-- los roles públicos no tienen el permiso DELETE ni TRUNCATE.
revoke delete, truncate on public.cambios_neumaticos from anon, authenticated;

-- 7) Bucket de PDF: solo PDF, máximo 10 MB por archivo
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('pdfs', 'pdfs', false, 10485760, array['application/pdf'])
on conflict (id) do update
  set public = false,
      file_size_limit = 10485760,
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

-- Solo se aceptan rutas con la forma PATENTE/aaaa-mm-dd.pdf
-- (evita carpetas raras, nombres arbitrarios o rutas con "..").
create policy "pdfs_public_insert" on storage.objects
  for insert to anon, authenticated
  with check (
    bucket_id = 'pdfs'
    and name ~* '^[A-Z0-9 _-]{1,15}/\d{4}-\d{2}-\d{2}\.pdf$'
  );
create policy "pdfs_public_update" on storage.objects
  for update to anon, authenticated
  using (bucket_id = 'pdfs')
  with check (
    bucket_id = 'pdfs'
    and name ~* '^[A-Z0-9 _-]{1,15}/\d{4}-\d{2}-\d{2}\.pdf$'
  );
