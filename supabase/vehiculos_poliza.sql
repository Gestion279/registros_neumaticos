-- =====================================================================
--  Datos del vehículo para el historial de neumáticos
--  Ejecutar en: Supabase > SQL Editor > New query > Run
--  Se puede volver a ejecutar sin problemas.
--
--  Fuentes, en este orden:
--    1. Base de zonas de la app de pólizas (Excel ZONA / PATENTE /
--       ModeloCompleto): zona y descripción del vehículo.
--    2. Póliza (último período en que figura la patente): marca
--       completa y año, si la base de zonas no tiene el modelo.
--
--  Las tablas de pólizas (seg_*) solo se leen con usuario logueado.
--  Esta app entra sin login, así que se expone UNA función que devuelve
--  solo patente, modelo, marca, año y zona, y solo de las patentes con
--  al menos un cambio de neumáticos. Valores, premios y centros de costo
--  siguen sin ser accesibles desde la API pública.
-- =====================================================================

-- La columna modelo la agrega también la migración de la app de pólizas
-- (20261118120000_zonas_modelo.sql); acá se asegura que exista.
alter table public.seg_zonas add column if not exists modelo text;

-- Cambia lo que devuelve la función: hay que borrarla antes de crearla.
drop function if exists public.vehiculos_poliza_con_cambios();

create function public.vehiculos_poliza_con_cambios()
returns table (
  patente        text,
  modelo         text,     -- ModeloCompleto de la base de zonas
  marca          text,     -- marca completa de la póliza
  anio           text,
  zona           text,
  certificado    integer,
  periodo_id     text,
  vigencia_hasta date
)
language sql
stable
security definer
set search_path = ''
as $$
  with
  -- Patentes con al menos un cambio registrado (dominio ya está normalizado)
  con_cambios as (
    select distinct cn.dominio as pat
    from public.cambios_neumaticos cn
  ),
  -- Base de zonas (una fila por patente)
  zonas as (
    select distinct on (upper(regexp_replace(z.patente, '[^A-Za-z0-9]', '', 'g')))
           upper(regexp_replace(z.patente, '[^A-Za-z0-9]', '', 'g')) as pat,
           nullif(btrim(z.zona), '')   as zona,
           nullif(btrim(z.modelo), '') as modelo
    from public.seg_zonas z
    order by upper(regexp_replace(z.patente, '[^A-Za-z0-9]', '', 'g'))
  ),
  -- Último período de la póliza en el que aparece cada patente
  poliza as (
    select distinct on (upper(regexp_replace(v.patente, '[^A-Za-z0-9]', '', 'g')))
           upper(regexp_replace(v.patente, '[^A-Za-z0-9]', '', 'g')) as pat,
           v.certificado,
           nullif(btrim(v.marca), '') as marca,
           nullif(btrim(v.anio), '')  as anio,
           p.id                       as periodo_id,
           p.vigencia_hasta
    from public.seg_periodo_vehiculos v
    join public.seg_periodos p on p.id = v.periodo_id
    order by upper(regexp_replace(v.patente, '[^A-Za-z0-9]', '', 'g')),
             p.vigencia_desde desc nulls last,
             p.creado_en desc
  )
  select cc.pat, zo.modelo, po.marca, po.anio, zo.zona, po.certificado, po.periodo_id, po.vigencia_hasta
  from con_cambios cc
  left join zonas  zo on zo.pat = cc.pat
  left join poliza po on po.pat = cc.pat
  where zo.pat is not null or po.pat is not null
  order by cc.pat;
$$;

comment on function public.vehiculos_poliza_con_cambios() is
  'Historial de neumáticos: modelo y zona de la base de zonas, y marca y año de la póliza, solo para patentes con cambios registrados.';

revoke all on function public.vehiculos_poliza_con_cambios() from public;
grant execute on function public.vehiculos_poliza_con_cambios() to anon, authenticated;

-- Avisa a la API (PostgREST) que la función cambió, para que la app la vea enseguida.
notify pgrst, 'reload schema';
