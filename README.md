# Historial de cambios de neumáticos

App web estática (HTML + JS) para cargar los PDF de "Reporte cambio de neumáticos",
ver el historial por patente y consultar el PDF original de cada registro.
Se puede instalar en la computadora y en el celular (PWA).

- **Base de datos y archivos:** Supabase (Postgres + Storage)
- **Acceso:** libre, sin login. Cualquiera con el link puede ver y cargar PDF.
- **Código:** GitHub
- **Publicación:** Vercel (sitio estático, sin build)

## Estructura

```
index.html            Pantalla principal
css/styles.css        Estilos (PC, tablet y celular)
js/config.js          URL y anon key de Supabase  <-- editar
js/app.js             Lógica (lectura de PDF, historial, filtros, controles)
js/pwa.js             Instalación de la app
sw.js                 Service worker (permite instalar y abrir sin conexión)
manifest.webmanifest  Nombre, colores e íconos de la app instalada
icons/                Íconos
supabase/schema.sql   Tablas, vista, validaciones, políticas y bucket  <-- ejecutar
vercel.json           Configuración de Vercel
```

## Puesta en marcha

### 1. Supabase
1. Crear un proyecto en https://supabase.com
2. **SQL Editor > New query**, pegar el contenido de `supabase/schema.sql` y ejecutar.
3. **Project Settings > API**: copiar *Project URL* y *anon public key*.

### 2. Configurar la app
Editar `js/config.js` y pegar la URL y la anon key.

### 3. GitHub
```bash
git init
git add .
git commit -m "Historial de cambios de neumáticos"
git branch -M main
git remote add origin https://github.com/TU-USUARIO/TU-REPO.git
git push -u origin main
```

### 4. Vercel
1. https://vercel.com > **Add New > Project** > importar el repo.
2. *Framework Preset:* **Other**. Dejar vacíos Build Command y Output Directory.
3. **Deploy**. Cada `git push` a `main` publica automáticamente.

## Uso

1. **↑ Registros** (arriba a la derecha): elegir uno o varios PDF, o arrastrarlos a
   cualquier parte de la página. La app lee los datos, los muestra para revisarlos y,
   al confirmar, guarda el registro y el PDF.
2. Buscar la patente (completa o parcial) y, si hace falta, ordenar o filtrar por fecha,
   neumático, zona o chofer.
3. Elegir una patente: aparece su historial (el cambio más reciente primero) con el
   kilometraje y los km recorridos desde el cambio anterior. En PC se ve como tabla;
   en celular, como fichas con **Ver detalle**.
4. **Ver PDF** abre el original en una pestaña nueva; **Descargar** lo guarda.
   La dirección incluye la patente (`/#AB500CM`), así que se puede compartir o recargar
   sin perder la consulta.

### Controles de consistencia
La app nunca modifica los registros: solo los señala.
- **Revisar** (amarillo): km menor al cambio anterior, mismo km que otro cambio
  (posible duplicado), fecha posterior a hoy.
- **Error** (rojo): fecha inválida o PDF que no se pudo abrir.
- **Dato faltante** (gris): sin kilometraje o sin PDF.

Al cargar un PDF, el formulario de revisión también avisa si el kilometraje no encaja
con los cambios anterior y siguiente de esa patente.

## Notas

- Un mismo dominio + fecha de cambio es un único registro. Si se vuelve a cargar, la app
  pregunta si se reemplaza.
- La lectura de PDF depende de que el reporte tenga el mismo formato de plantilla.
  Siempre se puede corregir cualquier dato antes de guardar.
- Los PDF se guardan como `dominio/aaaa-mm-dd.pdf` en el bucket `pdfs` y se abren con
  enlaces temporales (10 minutos). Ojo: sin login, cualquiera con la anon key puede
  pedir esos enlaces, así que en la práctica los PDF son accesibles para quien tenga el link.
- Cada vez que se reemplaza un registro, la versión anterior queda guardada en la tabla
  `cambios_neumaticos_historial` (solo visible desde el panel de Supabase).

## Acceso libre: qué implica

- No hay login. La anon key queda en el código público y las políticas de `schema.sql`
  permiten a cualquiera **leer, agregar y reemplazar** registros y PDF.
- **No se puede borrar** desde la app ni desde la API pública. Para eliminar un registro
  o un PDF, hacerlo desde el panel de Supabase (Table Editor / Storage).
- Los PDF aceptados son solo `application/pdf` de hasta 10 MB.
- Quien tenga el link puede sobrescribir un registro existente (misma patente y fecha).
  Si más adelante hace falta control, se puede agregar login sin cambiar la base.
