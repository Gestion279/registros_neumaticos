-- =====================================================================
--  Diagnóstico: ¿por qué no aparecen los datos de la póliza?
--  Ejecutar en: Supabase > SQL Editor > New query > Run
--  Solo lee: no modifica nada (la función auxiliar es temporal y se
--  borra sola al cerrar la sesión).
-- =====================================================================

-- Cuenta las filas que devuelve la función, o muestra su error.
create or replace function pg_temp.filas_funcion_poliza() returns text
language plpgsql as $$
declare n text;
begin
  if to_regprocedure('public.vehiculos_poliza_con_cambios()') is null then return '—'; end if;
  execute 'select count(*)::text from public.vehiculos_poliza_con_cambios()' into n;
  return n;
exception when others then
  return 'ERROR: ' || sqlerrm;
end $$;

with
neu as (
  select distinct dominio from public.cambios_neumaticos
),
pol as (
  select distinct upper(regexp_replace(patente, '[^A-Za-z0-9]', '', 'g')) as pat
  from public.seg_periodo_vehiculos
),
fn as (
  select p.oid, r.rolname, r.rolsuper, r.rolbypassrls
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  join pg_roles r on r.oid = p.proowner
  where n.nspname = 'public' and p.proname = 'vehiculos_poliza_con_cambios'
)
select 1 as orden, 'Patentes con cambios de neumáticos' as control, count(*)::text as resultado from neu
union all
select 2, 'Patentes en la póliza (todos los períodos)', count(*)::text from pol
union all
select 3, 'Patentes que coinciden en las dos', count(*)::text from neu join pol on pol.pat = neu.dominio
union all
select 4, 'Función vehiculos_poliza_con_cambios creada',
  case when exists (select 1 from fn) then 'Sí' else 'NO: ejecutar supabase/vehiculos_poliza.sql' end
union all
select 5, 'Filas que devuelve la función (lo que ve la app)',
  pg_temp.filas_funcion_poliza()
union all
select 6, 'Dueño de la función puede leer la póliza (sin RLS)',
  coalesce((
    select case
      when f.rolsuper or f.rolbypassrls then 'Sí (' || f.rolname || ')'
      when exists (select 1 from pg_class c where c.oid = 'public.seg_periodo_vehiculos'::regclass and c.relowner = (select proowner from pg_proc where oid = f.oid) and not c.relforcerowsecurity)
        then 'Sí, es dueño de las tablas (' || f.rolname || ')'
      else 'NO (' || f.rolname || '): ejecutar supabase/vehiculos_poliza.sql de nuevo'
    end
    from fn f limit 1), '—')
union all
select 7, 'Ejemplos de neumáticos que NO están en la póliza',
  coalesce((select string_agg(dominio, ', ' order by dominio) from (select dominio from neu where dominio not in (select pat from pol) order by dominio limit 12) x), '—')
union all
select 8, 'Ejemplos de patentes de la póliza',
  coalesce((select string_agg(pat, ', ' order by pat) from (select pat from pol order by pat limit 12) x), '—')
order by orden;
