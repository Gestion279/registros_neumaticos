# Historial de cambios de neumáticos

App web estática (HTML + JS) para cargar los PDF de "Reporte cambio de neumáticos",
ver el historial por patente y consultar el PDF original de cada registro.

- **Base de datos y archivos:** Supabase (Postgres + Storage)
- **Acceso:** libre, sin login. Cualquiera con el link puede ver y cargar PDF.
- **Código:** GitHub
- **Publicación:** Vercel (sitio estático, sin build)

## Estructura

```
index.html            Pantalla principal
css/styles.css        Estilos
js/config.js          URL y anon key de Supabase  <-- editar
js/app.js             Lógica (lectura de PDF, tabla, visor)
supabase/schema.sql   Tablas, vista, políticas y bucket  <-- ejecutar una vez
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

1. **Cargar PDF**: elegir o arrastrar uno o varios archivos. La app lee los datos,
   los muestra para revisarlos y, al confirmar, guarda el registro y el PDF.
2. Elegir una patente: aparece su historial ordenado por fecha (creciente por defecto)
   con el kilometraje de cada cambio.
3. **Ver PDF** al costado de cada registro abre el original para consultas.

### Alertas automáticas
- **Km menor al cambio anterior:** el kilometraje de un cambio es menor al del cambio previo
  de la misma patente (posible error de carga o del odómetro).
- **Sin PDF:** el registro no tiene archivo asociado.

## Notas

- Un mismo dominio + fecha de cambio es un único registro. Si se vuelve a cargar, la app
  pregunta si se reemplaza.
- La lectura de PDF depende de que el reporte tenga el mismo formato de plantilla.
  Siempre se puede corregir cualquier dato antes de guardar.
- Los PDF se guardan como `dominio/aaaa-mm-dd.pdf` en el bucket privado `pdfs`
  y se muestran con la sesión del usuario (no hay links públicos).

## Acceso libre: qué implica

- No hay login. La anon key queda en el código público y las políticas de `schema.sql`
  permiten a cualquiera **leer, agregar y reemplazar** registros y PDF.
- **No se puede borrar** desde la app ni desde la API pública. Para eliminar un registro
  o un PDF, hacerlo desde el panel de Supabase (Table Editor / Storage).
- Los PDF aceptados son solo `application/pdf` de hasta 10 MB.
- Quien tenga el link puede sobrescribir un registro existente (misma patente y fecha).
  Si más adelante hace falta control, se puede agregar login sin cambiar la base.
