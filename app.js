/* =====================================================================
   Historial de cambios de neumáticos
   - Acceso libre: cualquiera con el link puede ver y cargar
   - Lectura de PDF en el navegador (pdf.js)
   - Historial por patente (fecha creciente por defecto)
   - Visor del PDF original al costado de cada registro
   ===================================================================== */
(() => {
  "use strict";

  const { SUPABASE_URL, SUPABASE_ANON_KEY } = window.APP_CONFIG || {};
  const BUCKET = "pdfs";
  const TABLA = "cambios_neumaticos";

  pdfjsLib.GlobalWorkerOptions.workerSrc =
    "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

  const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  const $ = (id) => document.getElementById(id);
  const state = { patentes: [], filtro: "", sel: null, cambios: [], asc: true };

  /* ---------------------------------------------------------------
     Utilidades
     --------------------------------------------------------------- */
  const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const fmtFecha = (iso) => {
    if (!iso) return "";
    const [y, m, d] = iso.split("-");
    return `${d}/${m}/${y}`;
  };
  const fmtNum = (n) => (n == null ? "" : Number(n).toLocaleString("es-AR"));
  const limpiarDominio = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");

  function toast(msg, esError = false) {
    const el = document.createElement("div");
    el.className = "toast" + (esError ? " err" : "");
    el.textContent = msg;
    $("toasts").appendChild(el);
    setTimeout(() => el.remove(), esError ? 7000 : 4000);
  }

  const mensajeError = (e) => (e && (e.message || e.error_description)) || String(e);

  /* ---------------------------------------------------------------
     Arranque
     --------------------------------------------------------------- */
  function iniciar() {
    if (!SUPABASE_URL || SUPABASE_URL.includes("TU-PROYECTO")) {
      $("patentes").innerHTML =
        '<p class="vacio">Falta configurar js/config.js con la URL y la anon key de Supabase.</p>';
      return;
    }
    cargarPatentes();
  }

  /* ---------------------------------------------------------------
     Patentes
     --------------------------------------------------------------- */
  async function cargarPatentes() {
    const { data, error } = await sb.from("patentes_resumen").select("*").order("dominio");
    if (error) return toast("No se pudieron cargar las patentes: " + mensajeError(error), true);
    state.patentes = data || [];
    renderPatentes();
  }

  function renderPatentes() {
    const cont = $("patentes");
    const q = limpiarDominio(state.filtro);
    const lista = state.patentes.filter((p) => p.dominio.includes(q));

    if (!state.patentes.length) {
      cont.innerHTML = '<p class="vacio">Todavía no hay registros. Cargá el primer PDF para empezar.</p>';
      return;
    }
    if (!lista.length) {
      cont.innerHTML = '<p class="vacio">Ninguna patente coincide con la búsqueda.</p>';
      return;
    }
    cont.innerHTML = lista
      .map(
        (p) => `
        <button class="plate-btn" data-dominio="${esc(p.dominio)}" aria-pressed="${p.dominio === state.sel}">
          <span class="plate">${esc(p.dominio)}</span>
          <small>${p.cambios} ${p.cambios === 1 ? "cambio" : "cambios"} · ${fmtFecha(p.ultimo_cambio)}</small>
        </button>`
      )
      .join("");
  }

  $("buscar").addEventListener("input", (e) => {
    state.filtro = e.target.value;
    renderPatentes();
  });

  $("patentes").addEventListener("click", (e) => {
    const b = e.target.closest(".plate-btn");
    if (b) seleccionar(b.dataset.dominio);
  });

  /* ---------------------------------------------------------------
     Historial
     --------------------------------------------------------------- */
  async function seleccionar(dominio) {
    state.sel = dominio;
    renderPatentes();
    await cargarCambios();
    $("historial").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  async function cargarCambios() {
    if (!state.sel) return;
    const { data, error } = await sb
      .from(TABLA)
      .select("*")
      .eq("dominio", state.sel)
      .order("fecha_cambio", { ascending: true });
    if (error) return toast("No se pudo cargar el historial: " + mensajeError(error), true);
    state.cambios = data || [];
    renderHistorial();
  }

  const siNo = (v) => (v === true ? "Sí" : v === false ? "No" : '<span class="tag na">—</span>');

  function renderHistorial() {
    const sec = $("historial");
    if (!state.sel) return (sec.hidden = true);
    sec.hidden = false;

    // Los km desde el cambio anterior se calculan siempre en orden cronológico.
    const asc = state.cambios;
    const delta = new Map();
    asc.forEach((c, i) => {
      const prev = asc[i - 1];
      delta.set(c.id, prev && prev.kilometraje != null && c.kilometraje != null ? c.kilometraje - prev.kilometraje : null);
    });

    const filas = state.asc ? asc : [...asc].reverse();
    const ult = asc[asc.length - 1];

    $("hist-plate").textContent = state.sel;
    $("hist-resumen").textContent = asc.length
      ? `${asc.length} ${asc.length === 1 ? "cambio" : "cambios"} · último: ${fmtFecha(ult.fecha_cambio)}` +
        (ult.kilometraje != null ? ` a ${fmtNum(ult.kilometraje)} km` : "")
      : "Sin registros";
    $("btn-orden").textContent = state.asc ? "Fecha: creciente ↑" : "Fecha: decreciente ↓";

    $("tbody").innerHTML = filas
      .map((c) => {
        const d = delta.get(c.id);
        const alertas = [];
        if (d != null && d < 0) alertas.push('<span class="tag bad">Km menor al cambio anterior</span>');
        if (!c.pdf_path) alertas.push('<span class="tag warn">Sin PDF</span>');
        const dTxt = d == null ? '<span class="tag na">—</span>' : (d > 0 ? "+" : "") + fmtNum(d);
        return `
        <tr class="${alertas.length ? "alerta" : ""}">
          <td>${fmtFecha(c.fecha_cambio)}</td>
          <td class="num">${c.kilometraje != null ? fmtNum(c.kilometraje) : '<span class="tag na">—</span>'}</td>
          <td class="num">${dTxt}</td>
          <td>${esc(c.marca_neumatico)}</td>
          <td>${esc(c.medida)}</td>
          <td class="num">${c.cantidad ?? ""}</td>
          <td>${siNo(c.alineacion)}</td>
          <td>${siNo(c.balanceo)}</td>
          <td>${siNo(c.rotacion)}</td>
          <td>${siNo(c.valvulas)}</td>
          <td>${esc(c.chofer)}</td>
          <td>${esc(c.zona)}</td>
          <td class="obs">${esc(c.observaciones)}${alertas.length ? `<div class="alertas">${alertas.join("")}</div>` : ""}</td>
          <td class="acc">
            <button class="btn small primary" data-accion="ver" data-id="${c.id}" ${c.pdf_path ? "" : "disabled"}>Ver PDF</button>
          </td>
        </tr>`;
      })
      .join("");
  }

  $("btn-orden").addEventListener("click", () => {
    state.asc = !state.asc;
    renderHistorial();
  });

  $("tbody").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-accion='ver']");
    if (!b) return;
    const c = state.cambios.find((x) => String(x.id) === b.dataset.id);
    if (c) verPdf(c);
  });

  /* ---------------------------------------------------------------
     Visor de PDF
     --------------------------------------------------------------- */
  let pdfUrl = null;

  async function verPdf(c) {
    const { data, error } = await sb.storage.from(BUCKET).download(c.pdf_path);
    if (error) return toast("No se pudo abrir el PDF: " + mensajeError(error), true);
    cerrarVisor(false);
    pdfUrl = URL.createObjectURL(new Blob([data], { type: "application/pdf" }));
    $("pdf-titulo").textContent = `${c.dominio} · cambio del ${fmtFecha(c.fecha_cambio)}`;
    $("pdf-frame").src = pdfUrl;
    $("pdf-abrir").href = pdfUrl;
    $("pdf-descargar").href = pdfUrl;
    $("pdf-descargar").download = `${c.dominio}_${c.fecha_cambio}.pdf`;
    $("dlg-pdf").showModal();
  }

  function cerrarVisor(cerrarDialogo = true) {
    if (cerrarDialogo && $("dlg-pdf").open) $("dlg-pdf").close();
    $("pdf-frame").src = "about:blank";
    if (pdfUrl) URL.revokeObjectURL(pdfUrl);
    pdfUrl = null;
  }
  $("pdf-cerrar").addEventListener("click", () => cerrarVisor());
  $("dlg-pdf").addEventListener("close", () => cerrarVisor(false));

  /* ---------------------------------------------------------------
     Lectura del PDF
     --------------------------------------------------------------- */
  async function extraerTexto(file) {
    const buf = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
    let texto = "";
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      texto += content.items.map((it) => it.str).join(" ") + " ";
    }
    return texto.replace(/\s+/g, " ").trim();
  }

  // Etiquetas que delimitan el final de un valor en la plantilla
  const STOP =
    "(?=\\s+(?:Dominio|Marca|Modelo|A[ñn]o|Comb|Asignaci|Zona|Chofer|Aux|Fecha|Kilometraje|Medida|Cantidad|Cod|Alineaci|Rotaci|Balanceo|V[aá]lvulas|OBSERVACIONES|IM[ÁA]GENES|REPORTE)|$)";

  const siNoABool = (v) => (/^s[ií]/i.test(v || "") ? true : /^no/i.test(v || "") ? false : null);

  function parsear(texto, nombreArchivo) {
    const campo = (etiqueta) => {
      const m = texto.match(new RegExp(etiqueta + ":\\s*(.+?)" + STOP, "i"));
      return m ? m[1].trim() : "";
    };
    const simple = (re) => {
      const m = texto.match(re);
      return m ? m[1].trim() : "";
    };

    // "Marca" aparece dos veces: la 1.ª es del vehículo y la 2.ª del neumático
    const marcas = [...texto.matchAll(new RegExp("Marca:\\s*(.+?)" + STOP, "gi"))].map((m) => m[1].trim());

    // Fecha dd/mm/aaaa -> aaaa-mm-dd
    let fecha = "";
    const f = texto.match(/Fecha Cambio:\s*(\d{1,2})\/(\d{1,2})\/(\d{4})/i);
    if (f) fecha = `${f[3]}-${f[2].padStart(2, "0")}-${f[1].padStart(2, "0")}`;

    let dominio = limpiarDominio(simple(/Dominio:\s*([A-Z0-9 ]{6,9}?)\s+(?:Fecha|Marca)/i) || campo("Dominio"));
    const dominioArchivo = limpiarDominio((nombreArchivo.match(/^([A-Za-z]{2}\s?\d{3}\s?[A-Za-z]{2}|[A-Za-z]{3}\s?\d{3})/) || [])[1]);
    if (!dominio) dominio = dominioArchivo;

    const km = simple(/Kilometraje:\s*([\d.]+)/i).replace(/\./g, "");
    const obs = simple(/OBSERVACIONES:\s*(.+?)(?=\s+IM[ÁA]GENES|\s+REPORTE CAMBIO|\s+Zona:|\s+Chofer:|\s+Aux\.|$)/i);

    return {
      dominio,
      fecha_cambio: fecha,
      kilometraje: km ? parseInt(km, 10) : null,
      marca_neumatico: marcas.length >= 2 ? marcas[1] : "",
      medida: simple(/Medida:\s*(\d{3}\s?\/\s?\d{2}\s?\/?\s?R?\s?\d{2})/i).replace(/\s+/g, ""),
      cantidad: simple(/Cantidad:\s*(\d+)/i) ? parseInt(simple(/Cantidad:\s*(\d+)/i), 10) : null,
      alineacion: siNoABool(simple(/Alineaci[oó]n:\s*(SI|NO|S[ÍI]|NO)/i)),
      balanceo: siNoABool(simple(/Balanceo:\s*(SI|NO|S[ÍI])/i)),
      rotacion: siNoABool(simple(/Rotaci[oó]n:\s*(SI|NO|S[ÍI])/i)),
      valvulas: siNoABool(simple(/V[aá]lvulas:\s*(SI|NO|S[ÍI])/i)),
      chofer: campo("Chofer"),
      zona: campo("Zona"),
      asignacion: campo("Asignaci[oó]n"),
      observaciones: obs,
      _dominioArchivo: dominioArchivo,
    };
  }

  /* ---------------------------------------------------------------
     Revisión de datos (modal)
     --------------------------------------------------------------- */
  const formRev = $("form-revisar");
  const OPC_SINO =
    '<option value="">Sin dato</option><option value="true">Sí</option><option value="false">No</option>';
  ["alineacion", "balanceo", "rotacion", "valvulas"].forEach((n) => (formRev.elements[n].innerHTML = OPC_SINO));

  function llenarForm(d) {
    const set = (n, v) => (formRev.elements[n].value = v ?? "");
    ["dominio", "fecha_cambio", "kilometraje", "marca_neumatico", "medida", "cantidad", "chofer", "zona", "asignacion", "observaciones"].forEach((n) => set(n, d[n]));
    ["alineacion", "balanceo", "rotacion", "valvulas"].forEach((n) => set(n, d[n] === null ? "" : String(d[n])));
  }

  function leerForm() {
    const v = (n) => formRev.elements[n].value.trim();
    const num = (n) => (v(n) === "" ? null : parseInt(v(n), 10));
    const bool = (n) => (v(n) === "" ? null : v(n) === "true");
    return {
      dominio: limpiarDominio(v("dominio")),
      fecha_cambio: v("fecha_cambio"),
      kilometraje: num("kilometraje"),
      marca_neumatico: v("marca_neumatico") || null,
      medida: v("medida") || null,
      cantidad: num("cantidad"),
      alineacion: bool("alineacion"),
      balanceo: bool("balanceo"),
      rotacion: bool("rotacion"),
      valvulas: bool("valvulas"),
      chofer: v("chofer") || null,
      zona: v("zona") || null,
      asignacion: v("asignacion") || null,
      observaciones: v("observaciones") || null,
    };
  }

  function revisarDatos(datos, file, n, total) {
    return new Promise((resolve) => {
      llenarForm(datos);
      $("rev-progreso").textContent = total > 1 ? `Archivo ${n} de ${total}` : "";
      $("rev-archivo").textContent = file.name;

      const avisos = [];
      if (!datos.dominio) avisos.push("No se pudo leer la patente.");
      if (!datos.fecha_cambio) avisos.push("No se pudo leer la fecha del cambio.");
      if (datos.kilometraje == null) avisos.push("No se pudo leer el kilometraje.");
      if (datos._dominioArchivo && datos.dominio && datos._dominioArchivo !== datos.dominio)
        avisos.push(`La patente del archivo (${datos._dominioArchivo}) no coincide con la del contenido (${datos.dominio}).`);
      const aviso = $("rev-aviso");
      aviso.textContent = avisos.join(" ");
      aviso.hidden = !avisos.length;

      const dlg = $("dlg-revisar");
      const terminar = (valor) => {
        formRev.onsubmit = null;
        $("rev-omitir").onclick = null;
        dlg.oncancel = null;
        dlg.close();
        resolve(valor);
      };
      formRev.onsubmit = (e) => {
        e.preventDefault();
        const d = leerForm();
        if (!d.dominio || !d.fecha_cambio) return;
        terminar(d);
      };
      $("rev-omitir").onclick = () => terminar(null);
      dlg.oncancel = (e) => {
        e.preventDefault();
        terminar(null);
      };
      dlg.showModal();
    });
  }

  /* ---------------------------------------------------------------
     Guardado
     --------------------------------------------------------------- */
  async function guardar(d, file) {
    const { data: existente, error: e0 } = await sb
      .from(TABLA)
      .select("id")
      .eq("dominio", d.dominio)
      .eq("fecha_cambio", d.fecha_cambio)
      .maybeSingle();
    if (e0) throw e0;
    if (existente && !confirm(`Ya existe un cambio de ${d.dominio} con fecha ${fmtFecha(d.fecha_cambio)}. ¿Reemplazarlo?`))
      return "omitido";

    const path = `${d.dominio}/${d.fecha_cambio}.pdf`;
    const up = await sb.storage.from(BUCKET).upload(path, file, { upsert: true, contentType: "application/pdf" });
    if (up.error) throw up.error;

    const fila = { ...d, pdf_path: path, archivo_origen: file.name };
    delete fila._dominioArchivo;
    const { error } = await sb.from(TABLA).upsert(fila, { onConflict: "dominio,fecha_cambio" });
    if (error) throw error;
    return existente ? "reemplazado" : "nuevo";
  }

  /* ---------------------------------------------------------------
     Carga de archivos
     --------------------------------------------------------------- */
  let cargando = false;

  async function procesarArchivos(lista) {
    if (cargando) return toast("Ya hay una carga en curso", true);
    const pdfs = [...lista].filter((f) => f.type === "application/pdf" || /\.pdf$/i.test(f.name));
    if (!pdfs.length) return toast("Elegí archivos PDF", true);

    cargando = true;
    $("dropzone").style.opacity = ".6";
    const res = { nuevo: 0, reemplazado: 0, omitido: 0, error: 0 };
    let ultimoDominio = null;

    for (let i = 0; i < pdfs.length; i++) {
      const file = pdfs[i];
      try {
        const datos = parsear(await extraerTexto(file), file.name);
        const completo = datos.dominio && datos.fecha_cambio && datos.kilometraje != null;
        let final = datos;

        if ($("chk-revisar").checked || !completo) {
          final = await revisarDatos(datos, file, i + 1, pdfs.length);
          if (!final) {
            res.omitido++;
            continue;
          }
        } else {
          final = { ...datos, observaciones: datos.observaciones || null };
          ["marca_neumatico", "medida", "chofer", "zona", "asignacion"].forEach((k) => (final[k] = final[k] || null));
        }

        const r = await guardar(final, file);
        res[r]++;
        if (r !== "omitido") ultimoDominio = final.dominio;
      } catch (err) {
        res.error++;
        toast(`${file.name}: ${mensajeError(err)}`, true);
      }
    }

    cargando = false;
    $("dropzone").style.opacity = "";
    $("file-input").value = "";

    const partes = [];
    if (res.nuevo) partes.push(`${res.nuevo} nuevo${res.nuevo > 1 ? "s" : ""}`);
    if (res.reemplazado) partes.push(`${res.reemplazado} reemplazado${res.reemplazado > 1 ? "s" : ""}`);
    if (res.omitido) partes.push(`${res.omitido} omitido${res.omitido > 1 ? "s" : ""}`);
    if (res.error) partes.push(`${res.error} con error`);
    toast("Carga finalizada: " + (partes.join(", ") || "sin cambios"));

    await cargarPatentes();
    if (ultimoDominio) await seleccionar(ultimoDominio);
    else if (state.sel) await cargarCambios();
  }

  const dz = $("dropzone");
  dz.addEventListener("click", () => $("file-input").click());
  dz.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      $("file-input").click();
    }
  });
  $("file-input").addEventListener("change", (e) => procesarArchivos(e.target.files));
  ["dragenter", "dragover"].forEach((ev) =>
    dz.addEventListener(ev, (e) => {
      e.preventDefault();
      dz.classList.add("over");
    })
  );
  ["dragleave", "drop"].forEach((ev) =>
    dz.addEventListener(ev, (e) => {
      e.preventDefault();
      dz.classList.remove("over");
    })
  );
  dz.addEventListener("drop", (e) => procesarArchivos(e.dataTransfer.files));

  iniciar();
})();
