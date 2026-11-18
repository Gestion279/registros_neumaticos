-- =====================================================================
--  Datos del vehículo leídos del PDF del reporte
--  Ejecutar en: Supabase > SQL Editor > New query > Run
--  Se puede volver a ejecutar sin problemas. No borra ni cambia datos.
--
--  Se usan cuando la patente no figura en la póliza (o la póliza no
--  tiene ese dato): marca y modelo del vehículo y año.
-- =====================================================================

alter table public.cambios_neumaticos add column if not exists marca_vehiculo  text;
alter table public.cambios_neumaticos add column if not exists modelo_vehiculo text;
alter table public.cambios_neumaticos add column if not exists anio_vehiculo   text;

alter table public.cambios_neumaticos drop constraint if exists chk_vehiculo;
alter table public.cambios_neumaticos add constraint chk_vehiculo
  check (
        coalesce(length(marca_vehiculo), 0)  <= 100
    and coalesce(length(modelo_vehiculo), 0) <= 150
    and (anio_vehiculo is null or anio_vehiculo ~ '^\d{4}$')
  ) not valid;

-- Avisa a la API (PostgREST) que hay columnas nuevas.
notify pgrst, 'reload schema';
