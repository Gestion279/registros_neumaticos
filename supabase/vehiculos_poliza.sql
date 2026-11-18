-- =====================================================================
--  Datos de la póliza para el historial de neumáticos
--  Ejecutar en: Supabase > SQL Editor > New query > Run
--  Se puede volver a ejecutar sin problemas.
--
--  Las tablas de la app de pólizas (seg_*) solo se leen con usuario
--  logueado. Esta app entra sin login, así que en lugar de abrir esas
--  tablas se expone UNA función que devuelve solo:
--    patente, certificado, marca, año y zona
--  y solo de las patentes que tienen al menos un cambio de neumáticos.
--  Valores, premios, centros de costo y el resto de la póliza siguen
--  sin ser accesibles desde la API pública.
-- =====================================================================

create or replace function public.vehiculos_poliza_con_cambios()
returns table (
  patente        text,
  certificado    integer,
  marca          text,
  anio           text,
  zona           text,
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
    select distinct cn.dominio
    from public.cambios_neumaticos cn
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
  ),
  zonas as (
    select distinct on (upper(regexp_replace(z.patente, '[^A-Za-z0-9]', '', 'g')))
           upper(regexp_replace(z.patente, '[^A-Za-z0-9]', '', 'g')) as pat,
           nullif(btrim(z.zona), '') as zona
    from public.seg_zonas z
    order by upper(regexp_replace(z.patente, '[^A-Za-z0-9]', '', 'g'))
  )
  select po.pat, po.certificado, po.marca, po.anio, zo.zona, po.periodo_id, po.vigencia_hasta
  from poliza po
  join con_cambios cc on cc.dominio = po.pat
  left join zonas zo on zo.pat = po.pat
  order by po.certificado nulls last, po.pat;
$$;

comment on function public.vehiculos_poliza_con_cambios() is
  'Historial de neumáticos: marca, año, certificado y zona de la póliza, solo para patentes con cambios registrados.';

revoke all on function public.vehiculos_poliza_con_cambios() from public;
grant execute on function public.vehiculos_poliza_con_cambios() to anon, authenticated;

-- Avisa a la API (PostgREST) que hay una función nueva, para que la app la vea enseguida.
notify pgrst, 'reload schema';
