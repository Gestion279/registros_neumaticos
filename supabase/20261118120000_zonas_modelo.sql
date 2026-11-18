-- =====================================================================
--  Base de zonas: guardar también el modelo completo del vehículo
--  (columna «ModeloCompleto» del Excel de zonas).
--  Lo usa la app de neumáticos para mostrar la descripción del vehículo.
--  Se puede ejecutar más de una vez. No borra datos.
-- =====================================================================

alter table public.seg_zonas add column if not exists modelo text;

-- Igual a la versión de 20261115120000_roles_usuarios.sql, más la columna modelo.
create or replace function public.seg_reemplazar_zonas(p_items jsonb, p_archivo text, p_conflictos jsonb default '[]'::jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare n integer; v_email text := public.seg_exigir('zonas');
begin
  delete from public.seg_zonas where true;
  insert into public.seg_zonas (patente, zona, modelo)
  select distinct on (x->>'patente') x->>'patente', x->>'zona', nullif(btrim(x->>'modelo'), '')
  from jsonb_array_elements(p_items) with ordinality as t(x, i)
  where coalesce(x->>'patente', '') <> '' and coalesce(x->>'zona', '') <> ''
  order by x->>'patente', i desc;
  get diagnostics n = row_count;
  insert into public.seg_bases (tipo, archivo, filas, detalle, cargado_en, cargado_por)
  values ('zonas', p_archivo, n, jsonb_build_object('conflictos', p_conflictos), now(), v_email)
  on conflict (tipo) do update set archivo = excluded.archivo, filas = excluded.filas, detalle = excluded.detalle, cargado_en = now(), cargado_por = excluded.cargado_por;
  perform public.seg_registrar(v_email, 'zonas', format('%s · %s patentes', coalesce(p_archivo, ''), n));
  return n;
end $$;
