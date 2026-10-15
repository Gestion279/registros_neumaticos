/* =====================================================================
   Historial de cambios de neumáticos
   - Acceso libre: cualquiera con el link puede ver y cargar
   - Lectura de PDF en el navegador (pdf.js)
   - Historial por patente con tabla (PC) y fichas (celular)
   - Filtros, ordenamiento y controles de consistencia
   - Los registros se leen una sola vez y se reutilizan en toda la pantalla
   ===================================================================== */
(() => {
  "use strict";

  const { SUPABASE_URL, SUPABASE_ANON_KEY } = window.APP_CONFIG || {};
  const BUCKET = "pdfs";
  const TABLA = "cambios_neumaticos";
  const PAGINA = 1000; // límite de filas por consulta de Supabase

  pdfjsLib.GlobalWorkerOptions.workerSrc =
    "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

  const configurado = !!SUPABASE_URL && !SUPABASE_URL.includes("TU-PROYECTO");
  const sb = configurado ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null;

  const $ = (id) => document.getElementById(id);
  const mqMovil = window.matchMedia("(max-width: 760px)");

  const state = {
    registros: [],          // filas tal como vienen de la base (no se modifican)
    vehiculos: new Map(),   // dominio -> { dominio, cambios[], ultimo, ultimoKm, aRevisar }
    cargando: true,
    errorCarga: null,
    filtro: "",
    ordenPat: "patente-asc",
    filtros: { desde: "", hasta: "", marca: "", zona: "", chofer: "" },
    sel: null,
    asc: false,             // historial: más reciente primero
    pdfFallidos: new Set(), // ids cuyo PDF no se pudo abrir en esta sesión
  };

  /* ---------------------------------------------------------------
     Utilidades
     --------------------------------------------------------------- */
  const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // Fecha ISO (aaaa-mm-dd) -> milisegundos. NaN si no es una fecha real.
  function fechaMs(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ""));
    if (!m) return NaN;
    const [y, mo, d] = [+m[1], +m[2], +m[3]];
    const t = Date.UTC(y, mo - 1, d);
    const f = new Date(t);
    return f.getUTCFullYear() === y && f.getUTCMonth() === mo - 1 && f.getUTCDate() === d ? t : NaN;
  }
  const fmtFecha = (iso) => {
    if (!iso) return "";
    if (isNaN(fechaMs(iso))) return String(iso);
    const [y, m, d] = iso.split("-");
    return `${d}/${m}/${y}`;
  };
  const fmtFechaHora = (ts) => {
    if (!ts) return "";
    const d = new Date(ts);
    return isNaN(d) ? "" : d.toLocaleString("es-AR", { dateStyle: "short", timeStyle: "short" });
  };
  const fmtNum = (n) => (n == null ? "" : Number(n).toLocaleString("es-AR"));
  const limpiarDominio = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const hoyMs = () =>
    fechaMs(new Date().toLocaleDateString("en-CA", { timeZone: "America/Argentina/Buenos_Aires" }));

  // Kilometraje -> número entero. Acepta 213411, "213411", "213.411" o "213.411 km".
  // El punto se toma como separador de miles (formato argentino), nunca como decimal.
  function parseKm(v) {
    if (v == null || v === "") return null;
    if (typeof v === "number") return Number.isFinite(v) && v >= 0 ? Math.round(v) : null;
    const s = String(v).replace(/km/i, "").replace(/\s/g, "");
    if (/^\d{1,3}(\.\d{3})+$/.test(s)) return parseInt(s.replace(/\./g, ""), 10);
    if (/^\d+$/.test(s)) return parseInt(s, 10);
    return null;
  }

  // Normaliza textos libres para agrupar en filtros ("Mendoza " = "MENDOZA").
  const clave = (s) => String(s ?? "").trim().replace(/\s+/g, " ").toUpperCase();

  const plural = (n, uno, varios) => `${fmtNum(n)} ${n === 1 ? uno : varios}`;

  function toast(msg, esError = false, html = false) {
    const el = document.createElement("div");
    el.className = "toast" + (esError ? " err" : "");
    el.setAttribute("role", esError ? "alert" : "status");
    if (html) el.innerHTML = msg;
    else el.textContent = msg;
    $("toasts").appendChild(el);
    setTimeout(() => el.remove(), esError ? 8000 : 4500);
  }

  const mensajeError = (e) => (e && (e.message || e.error_description)) || String(e);
  const ico = (id, cls = "ico") => `<svg class="${cls}" aria-hidden="true"><use href="#i-${id}"/></svg>`;

  /* ---------------------------------------------------------------
     Carga de datos (una sola lectura, paginada)
     --------------------------------------------------------------- */
  async function cargarDatos() {
    state.cargando = true;
    state.errorCarga = null;
    renderTodo();
    try {
      const filas = [];
      for (let desde = 0; ; desde += PAGINA) {
        const { data, error } = await sb
          .from(TABLA)
          .select("*")
          .order("dominio", { ascending: true })
          .order("fecha_cambio", { ascending: true })
          .order("id", { ascending: true })
          .range(desde, desde + PAGINA - 1);
        if (error) throw error;
        filas.push(...(data || []));
        if (!data || data.length < PAGINA) break;
      }
      state.registros = filas;
      procesar();
    } catch (e) {
      state.errorCarga = mensajeError(e);
    }
    state.cargando = false;
    if (state.sel && !state.vehiculos.has(state.sel)) state.sel = null;
    llenarFiltros();
    renderTodo();
  }

  /* ---------------------------------------------------------------
     Procesamiento: orden cronológico, km recorridos y consistencia
     (solo lectura: nunca se modifican los valores originales)
     --------------------------------------------------------------- */
  function procesar() {
    const hoy = hoyMs();
    const grupos = new Map();
    for (const r of state.registros) {
      const dom = r.dominio || "";
      if (!grupos.has(dom)) grupos.set(dom, []);
      grupos.get(dom).push(r);
    }

    const vehiculos = new Map();
    for (const [dominio, filas] of grupos) {
      // Orden cronológico real; a igual fecha, por id (orden de carga).
      const cambios = filas
        .map((r) => ({ r, ms: fechaMs(r.fecha_cambio), km: parseKm(r.kilometraje) }))
        .sort((a, b) => (isNaN(a.ms) ? 1 : 0) - (isNaN(b.ms) ? 1 : 0) || a.ms - b.ms || a.r.id - b.r.id);

      const porKm = new Map();
      const mismaFecha = new Map();
      cambios.forEach((c) => {
        if (!isNaN(c.ms)) mismaFecha.set(c.ms, (mismaFecha.get(c.ms) || 0) + 1);
      });

      cambios.forEach((c, i) => {
        const prev = cambios[i - 1];
        const p = []; // problemas: { nivel: "error" | "revisar" | "falta", txt, det }

        // Km desde el registro anterior
        if (!prev) c.delta = { tipo: "primero" };
        else if (c.km == null || prev.km == null) c.delta = { tipo: "nd" };
        else if (c.km < prev.km) {
          c.delta = { tipo: "neg", valor: c.km - prev.km };
          p.push({
            nivel: "revisar",
            txt: "Km menor al anterior",
            det: `El cambio anterior (${fmtFecha(prev.r.fecha_cambio)}) registra ${fmtNum(prev.km)} km. Posible error de carga o de odómetro.`,
          });
        } else c.delta = { tipo: "ok", valor: c.km - prev.km };

        // Fechas
        if (isNaN(c.ms)) p.push({ nivel: "error", txt: "Fecha inválida", det: `Valor guardado: "${c.r.fecha_cambio ?? ""}".` });
        else if (c.ms > hoy) p.push({ nivel: "revisar", txt: "Fecha posterior a hoy", det: "La fecha del cambio es futura." });
        if (!isNaN(c.ms) && mismaFecha.get(c.ms) > 1)
          p.push({ nivel: "revisar", txt: "Misma fecha que otro cambio", det: "No se puede saber el orden real; se usa el orden de carga." });

        // Posible duplicado: mismo kilometraje que otro cambio del mismo vehículo
        if (c.km != null && c.km > 0) {
          const otro = porKm.get(c.km);
          if (otro)
            p.push({
              nivel: "revisar",
              txt: "Posible duplicado",
              det: `Mismo kilometraje (${fmtNum(c.km)} km) que el cambio del ${fmtFecha(otro.r.fecha_cambio)}.`,
            });
          else porKm.set(c.km, c);
        }

        // Datos faltantes
        if (c.km == null) p.push({ nivel: "falta", txt: "Sin kilometraje", det: "El registro no tiene kilometraje cargado." });
        if (!c.r.pdf_path) p.push({ nivel: "falta", txt: "Sin PDF", det: "El registro no tiene un PDF asociado." });

        c.problemas = p;
      });

      const validos = cambios.filter((c) => !isNaN(c.ms));
      const ultimo = validos[validos.length - 1] || null;
      const ultimoConKm = [...validos].reverse().find((c) => c.km != null) || null;

      vehiculos.set(dominio, {
        dominio,
        cambios,
        ultimo,
        ultimoConKm,
        aRevisar: cambios.filter((c) => c.problemas.some((x) => x.nivel !== "falta")).length,
      });
    }
    state.vehiculos = vehiculos;
  }

  // Problemas de un cambio, sumando los PDF que fallaron en esta sesión.
  function problemasDe(c) {
    if (!state.pdfFallidos.has(c.r.id)) return c.problemas;
    return [...c.problemas, { nivel: "error", txt: "PDF no disponible", det: "El archivo no se pudo abrir. Revisalo en Supabase Storage." }];
  }

  /* ---------------------------------------------------------------
     Filtros
     --------------------------------------------------------------- */
  const CAMPOS_FILTRO = { marca: "marca_neumatico", zona: "zona", chofer: "chofer" };

  function llenarFiltros() {
    for (const [f, col] of Object.entries(CAMPOS_FILTRO)) {
      const opciones = new Map();
      for (const r of state.registros) {
        const k = clave(r[col]);
        if (k && !opciones.has(k)) opciones.set(k, String(r[col]).trim().replace(/\s+/g, " "));
      }
      const sel = $("f-" + f);
      const lista = [...opciones].sort((a, b) => a[1].localeCompare(b[1], "es"));
      sel.innerHTML =
        '<option value="">Todos</option>' + lista.map(([k, txt]) => `<option value="${esc(k)}">${esc(txt)}</option>`).join("");
      if (!opciones.has(state.filtros[f])) state.filtros[f] = "";
      sel.value = state.filtros[f];
      // Solo se ofrece el filtro si hay al menos dos valores distintos
      sel.closest("label").hidden = lista.length < 2;
    }
  }

  const filtrosActivos = () => Object.values(state.filtros).filter(Boolean).length;

  function coincide(c) {
    const f = state.filtros;
    if (f.desde && !(c.ms >= fechaMs(f.desde))) return false;
    if (f.hasta && !(c.ms <= fechaMs(f.hasta))) return false;
    for (const [k, col] of Object.entries(CAMPOS_FILTRO)) if (f[k] && clave(c.r[col]) !== f[k]) return false;
    return true;
  }

  /* ---------------------------------------------------------------
     Indicadores
     --------------------------------------------------------------- */
  function renderKpis() {
    const set = (id, v) => ($(id).textContent = v);
    if (state.cargando) return ["kpi-vehiculos", "kpi-registros", "kpi-ultimo"].forEach((id) => set(id, "…"));
    if (state.errorCarga || !state.registros.length)
      return ["kpi-vehiculos", "kpi-registros", "kpi-ultimo"].forEach((id) => set(id, "—"));

    const hoy = hoyMs();
    let validos = 0;
    let ultimo = null;
    for (const v of state.vehiculos.values())
      for (const c of v.cambios) {
        if (isNaN(c.ms) || !v.dominio) continue; // registros sin fecha válida no cuentan
        validos++;
        if (c.ms <= hoy && (!ultimo || c.ms > ultimo.ms)) ultimo = c;
      }
    set("kpi-vehiculos", fmtNum([...state.vehiculos.keys()].filter(Boolean).length));
    set("kpi-registros", fmtNum(validos));
    set("kpi-ultimo", ultimo ? fmtFecha(ultimo.r.fecha_cambio) : "—");
  }

  /* ---------------------------------------------------------------
     Patentes
     --------------------------------------------------------------- */
  function vehiculosVisibles() {
    const q = limpiarDominio(state.filtro);
    const hayFiltros = filtrosActivos() > 0;
    const lista = [...state.vehiculos.values()].filter(
      (v) => v.dominio.includes(q) && (!hayFiltros || v.cambios.some(coincide))
    );
    const porPatente = (a, b) => a.dominio.localeCompare(b.dominio, "es", { numeric: true });
    const ms = (v) => (v.ultimo ? v.ultimo.ms : -Infinity);
    const km = (v) => (v.ultimoConKm ? v.ultimoConKm.km : -Infinity);
    const ord = {
      "patente-asc": porPatente,
      "patente-desc": (a, b) => porPatente(b, a),
      reciente: (a, b) => ms(b) - ms(a) || porPatente(a, b),
      cambios: (a, b) => b.cambios.length - a.cambios.length || porPatente(a, b),
      km: (a, b) => km(b) - km(a) || porPatente(a, b),
    }[state.ordenPat];
    return lista.sort(ord);
  }

  function renderPatentes() {
    const cont = $("patentes");
    const count = $("pat-count");
    cont.removeAttribute("aria-busy");

    if (!configurado) {
      count.textContent = "";
      cont.innerHTML = estado("Falta configurar <code>js/config.js</code> con la URL y la anon key de Supabase.");
      return;
    }
    if (state.cargando) {
      count.textContent = "";
      cont.setAttribute("aria-busy", "true");
      cont.innerHTML = Array.from({ length: 6 }, () => '<div class="pcard esqueleto" aria-hidden="true"></div>').join("") +
        '<span class="sr-only">Cargando patentes…</span>';
      return;
    }
    if (state.errorCarga) {
      count.textContent = "";
      cont.innerHTML = estado(
        `No se pudieron cargar los registros. <span class="muted">${esc(state.errorCarga)}</span>`,
        `<button class="btn ghost" type="button" data-accion="reintentar">${ico("refresh")}Reintentar</button>`,
        true
      );
      return;
    }
    if (!state.vehiculos.size) {
      count.textContent = "";
      cont.innerHTML = estado("Todavía no hay registros. Usá <strong>Registros</strong> para cargar el primer PDF.");
      return;
    }

    const lista = vehiculosVisibles();
    const total = state.vehiculos.size;
    count.textContent = lista.length === total ? `(${fmtNum(total)})` : `(${fmtNum(lista.length)} de ${fmtNum(total)})`;

    if (!lista.length) {
      const acciones = [];
      if (state.filtro) acciones.push('<button class="btn ghost" type="button" data-accion="limpiar-busqueda">Limpiar búsqueda</button>');
      if (filtrosActivos()) acciones.push('<button class="btn ghost" type="button" data-accion="limpiar-filtros">Limpiar filtros</button>');
      cont.innerHTML = estado("Ninguna patente coincide con la búsqueda o los filtros.", acciones.join(""));
      return;
    }

    cont.innerHTML = lista
      .map((v) => {
        const n = v.cambios.length;
        const alerta = v.aRevisar
          ? `<span class="pcard-alerta" title="${plural(v.aRevisar, "registro para revisar", "registros para revisar")}">${ico("alert")}${v.aRevisar}</span>`
          : "";
        return `
        <button class="pcard" type="button" data-dominio="${esc(v.dominio)}" aria-pressed="${v.dominio === state.sel}">
          <span class="plate">${esc(v.dominio)}</span>
          <span class="pcard-info">
            <span class="pcard-n">${plural(n, "cambio", "cambios")}${alerta}</span>
            <span class="pcard-f">${v.ultimo ? "Último: " + fmtFecha(v.ultimo.r.fecha_cambio) : "Sin fecha válida"}</span>
          </span>
          ${ico("chev", "ico pcard-chev")}
        </button>`;
      })
      .join("");
  }

  function estado(msg, acciones = "", error = false) {
    return `<div class="estado${error ? " error" : ""}"><p>${msg}</p>${acciones ? `<div class="estado-acc">${acciones}</div>` : ""}</div>`;
  }

  /* ---------------------------------------------------------------
     Selección y navegación
     --------------------------------------------------------------- */
  function seleccionar(dominio, { historial = true, desplazar = true } = {}) {
    if (!state.vehiculos.has(dominio)) return;
    state.sel = dominio;
    if (historial) {
      const hash = "#" + encodeURIComponent(dominio);
      if (location.hash !== hash) {
        // Desde el listado se agrega una entrada (el botón Atrás vuelve al listado);
        // de una patente a otra se reemplaza, para no acumular historial.
        if (location.hash) history.replaceState({ p: dominio }, "", hash);
        else history.pushState({ p: dominio }, "", hash);
      }
    }
    renderPatentes();
    renderHistorial();
    if (desplazar) {
      const sec = $("historial");
      sec.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
      $("hist-titulo").focus({ preventScroll: true });
    }
  }

  function volverAlListado() {
    const card = state.sel && $("patentes").querySelector(`[data-dominio="${CSS.escape(state.sel)}"]`);
    const destino = card || $("panel-patentes");
    destino.scrollIntoView({ behavior: "smooth", block: "center" });
    if (card) card.focus({ preventScroll: true });
  }

  window.addEventListener("popstate", () => {
    const dom = decodeURIComponent(location.hash.slice(1));
    if (dom && state.vehiculos.has(dom)) seleccionar(dom, { historial: false });
    else volverAlListado(); // la selección se mantiene marcada
  });

  /* ---------------------------------------------------------------
     Historial
     --------------------------------------------------------------- */
  const siNo = (v) =>
    v === true ? '<span class="sn si">Sí</span>' : v === false ? '<span class="sn no">No</span>' : '<span class="nd" title="Sin dato">—</span>';

  function deltaHtml(c) {
    const d = c.delta;
    if (d.tipo === "primero") return '<span class="nd" title="Es el primer cambio registrado">Sin registro anterior</span>';
    if (d.tipo === "nd") return '<span class="nd" title="Falta el kilometraje de este cambio o del anterior">No disponible</span>';
    if (d.tipo === "neg")
      return `<span class="tag revisar" title="Diferencia: ${fmtNum(d.valor)} km. El kilometraje es menor al del cambio anterior.">${ico("alert")}Revisar</span>`;
    return `+${fmtNum(d.valor)}`;
  }

  const tagsHtml = (ps) =>
    ps.length
      ? `<div class="tags">${ps
          .map((p) => `<span class="tag ${p.nivel}" title="${esc(p.det)}">${p.nivel === "falta" ? "" : ico("alert")}${esc(p.txt)}</span>`)
          .join("")}</div>`
      : "";

  function pdfBotones(c, compacto = false) {
    if (!c.r.pdf_path) return '<span class="nd">Sin PDF</span>';
    const titulo = c.r.archivo_origen ? ` title="Archivo original: ${esc(c.r.archivo_origen)}"` : "";
    return `<div class="pdf-acc">
      <button class="btn small primary" type="button" data-accion="ver" data-id="${c.r.id}"${titulo}>${ico("file")}Ver PDF</button>
      <button class="btn small ghost${compacto ? " solo-ico" : ""}" type="button" data-accion="descargar" data-id="${c.r.id}" aria-label="Descargar PDF del ${fmtFecha(c.r.fecha_cambio)}" title="Descargar">${ico("download")}${compacto ? "" : "<span>Descargar</span>"}</button>
    </div>`;
  }

  function renderHistorial() {
    const sec = $("historial");
    const v = state.sel && state.vehiculos.get(state.sel);
    if (!v || state.cargando || state.errorCarga) {
      sec.hidden = true;
      return;
    }
    sec.hidden = false;

    // Encabezado del vehículo
    $("hist-plate").textContent = v.dominio;
    const datos = [
      ["Cambios", fmtNum(v.cambios.length)],
      ["Último cambio", v.ultimo ? fmtFecha(v.ultimo.r.fecha_cambio) : "—"],
      [
        "Km más reciente",
        v.ultimoConKm
          ? `${fmtNum(v.ultimoConKm.km)} km` +
            (v.ultimoConKm !== v.ultimo ? ` <span class="muted">(${fmtFecha(v.ultimoConKm.r.fecha_cambio)})</span>` : "")
          : "—",
      ],
    ];
    if (v.aRevisar) datos.push(["Para revisar", `<span class="tag revisar">${ico("alert")}${v.aRevisar}</span>`]);
    $("hist-datos").innerHTML = datos.map(([k, val]) => `<div><dt>${k}</dt><dd>${val}</dd></div>`).join("");

    const conPdf = [...v.cambios].reverse().find((c) => c.r.pdf_path && !isNaN(c.ms));
    const btnUlt = $("btn-ultimo-pdf");
    btnUlt.disabled = !conPdf;
    btnUlt.dataset.id = conPdf ? conPdf.r.id : "";
    btnUlt.title = conPdf ? `Abre el PDF del ${fmtFecha(conPdf.r.fecha_cambio)}` : "Ningún cambio de este vehículo tiene PDF";

    $("btn-orden").innerHTML = state.asc
      ? `${ico("sort")}Más antiguo primero`
      : `${ico("sort")}Más reciente primero`;
    $("btn-orden").setAttribute("aria-label", `Orden por fecha: ${state.asc ? "más antiguo primero" : "más reciente primero"}. Cambiar orden`);

    // Filas (los km recorridos ya se calcularon sobre el historial completo)
    const visibles = v.cambios.filter(coincide);
    const filas = state.asc ? visibles : [...visibles].reverse();

    const nota = $("hist-nota");
    if (visibles.length < v.cambios.length) {
      nota.innerHTML = `Mostrando ${fmtNum(visibles.length)} de ${plural(v.cambios.length, "registro", "registros")} por los filtros activos. ` +
        `<button class="link" type="button" data-accion="limpiar-filtros">Limpiar filtros</button>`;
      nota.hidden = false;
    } else nota.hidden = true;

    if (!filas.length) {
      const msg = '<td colspan="13">' + estado("Ningún registro de este vehículo coincide con los filtros.") + "</td>";
      $("tbody").innerHTML = `<tr class="vacia">${msg}</tr>`;
      $("fichas").innerHTML = `<li class="ficha vacia">${estado("Ningún registro de este vehículo coincide con los filtros.")}</li>`;
      return;
    }

    $("tbody").innerHTML = filas.map(filaTabla).join("");
    $("fichas").innerHTML = filas.map(ficha).join("");
  }

  function filaTabla(c) {
    const r = c.r;
    const ps = problemasDe(c);
    const nivel = ps.some((p) => p.nivel === "error") ? "error" : ps.some((p) => p.nivel === "revisar") ? "revisar" : "";
    const choferZona = [r.chofer, r.zona].filter(Boolean).map(esc).join('<span class="sep">·</span>');
    return `
      <tr class="${nivel ? "fila-" + nivel : ""}">
        <td class="fecha" title="${r.created_at ? "Cargado el " + esc(fmtFechaHora(r.created_at)) : ""}">${esc(fmtFecha(r.fecha_cambio))}</td>
        <td class="num km">${c.km != null ? fmtNum(c.km) : '<span class="nd">Sin dato</span>'}</td>
        <td class="num delta">${deltaHtml(c)}</td>
        <td class="neum"><strong>${esc(r.marca_neumatico) || '<span class="nd">—</span>'}</strong>${r.medida ? `<span class="sub">${esc(r.medida)}</span>` : ""}</td>
        <td class="num">${r.cantidad ?? '<span class="nd">—</span>'}</td>
        <td class="c">${siNo(r.alineacion)}</td>
        <td class="c">${siNo(r.balanceo)}</td>
        <td class="c">${siNo(r.rotacion)}</td>
        <td class="c">${siNo(r.valvulas)}</td>
        <td class="persona">${choferZona || '<span class="nd">—</span>'}${r.asignacion ? `<span class="sub" title="Asignación">${esc(r.asignacion)}</span>` : ""}</td>
        <td class="obs">${r.observaciones ? esc(r.observaciones) : '<span class="nd">—</span>'}</td>
        <td class="rev">${tagsHtml(ps) || '<span class="ok-txt" title="Sin observaciones de consistencia">—</span>'}</td>
        <td class="acc">${pdfBotones(c, true)}</td>
      </tr>`;
  }

  function ficha(c) {
    const r = c.r;
    const ps = problemasDe(c);
    const nivel = ps.some((p) => p.nivel === "error") ? "error" : ps.some((p) => p.nivel === "revisar") ? "revisar" : "";
    const neum = [r.medida && esc(r.medida), r.cantidad != null && `${r.cantidad} u.`].filter(Boolean).join(" · ");
    const det = [
      ["Alineación", siNo(r.alineacion)],
      ["Balanceo", siNo(r.balanceo)],
      ["Rotación", siNo(r.rotacion)],
      ["Válvulas", siNo(r.valvulas)],
      ["Chofer", esc(r.chofer) || '<span class="nd">—</span>'],
      ["Zona", esc(r.zona) || '<span class="nd">—</span>'],
      ["Asignación", esc(r.asignacion) || '<span class="nd">—</span>'],
      ["Observaciones", esc(r.observaciones) || '<span class="nd">—</span>', true],
      ["Archivo original", esc(r.archivo_origen) || '<span class="nd">—</span>', true],
      ["Cargado el", esc(fmtFechaHora(r.created_at)) || '<span class="nd">—</span>', true],
    ];
    return `
      <li class="ficha${nivel ? " ficha-" + nivel : ""}">
        <div class="ficha-top">
          <span class="ficha-fecha">${esc(fmtFecha(r.fecha_cambio))}</span>
          ${tagsHtml(ps)}
        </div>
        <div class="ficha-km">
          <div><span class="lbl">Kilometraje</span><strong>${c.km != null ? fmtNum(c.km) + " km" : '<span class="nd">Sin dato</span>'}</strong></div>
          <div><span class="lbl">Desde el anterior</span><strong>${deltaHtml(c)}</strong></div>
        </div>
        <div class="ficha-neum">
          <span class="lbl">Neumático</span>
          <span><strong>${esc(r.marca_neumatico) || '<span class="nd">Sin dato</span>'}</strong>${neum ? ` <span class="muted">· ${neum}</span>` : ""}</span>
        </div>
        <div class="ficha-acc">${pdfBotones(c)}</div>
        <details class="ficha-det">
          <summary>Ver detalle</summary>
          <dl>${det.map(([k, val, full]) => `<div${full ? ' class="full"' : ""}><dt>${k}</dt><dd>${val}</dd></div>`).join("")}</dl>
        </details>
      </li>`;
  }

  function renderTodo() {
    renderKpis();
    renderPatentes();
    renderHistorial();
    actualizarControles();
  }

  function actualizarControles() {
    const n = filtrosActivos();
    $("filtros-n").textContent = n;
    $("filtros-n").hidden = !n;
    $("filtros-limpiar").disabled = !n;
    $("buscar-limpiar").hidden = !state.filtro;
  }

  /* ---------------------------------------------------------------
     PDF: se abre en una pestaña nueva con un enlace temporal firmado.
     Funciona igual en PC y celular, y la app conserva su estado.
     --------------------------------------------------------------- */
  const buscarCambio = (id) => {
    for (const v of state.vehiculos.values()) {
      const c = v.cambios.find((x) => String(x.r.id) === String(id));
      if (c) return c;
    }
    return null;
  };

  async function abrirPdf(c, descargar = false) {
    if (!c || !c.r.pdf_path) return;
    const nombre = `${c.r.dominio}_${c.r.fecha_cambio}.pdf`;

    // La pestaña se abre en el mismo clic para que el navegador no la bloquee.
    let win = null;
    if (!descargar) {
      win = window.open("", "_blank");
      if (win) {
        try {
          win.opener = null;
          win.document.title = "Abriendo PDF…";
          win.document.body.innerHTML = '<p style="font:16px system-ui,sans-serif;padding:24px;color:#263431">Abriendo PDF…</p>';
        } catch (_) { /* sin acceso al documento: no importa */ }
      }
    }

    const { data, error } = await sb.storage
      .from(BUCKET)
      .createSignedUrl(c.r.pdf_path, 600, descargar ? { download: nombre } : undefined);

    if (error || !data?.signedUrl) {
      if (win) win.close();
      state.pdfFallidos.add(c.r.id);
      renderHistorial();
      return toast("No se pudo abrir el PDF: " + mensajeError(error || "enlace vacío"), true);
    }
    if (state.pdfFallidos.delete(c.r.id)) renderHistorial();

    if (descargar) {
      const a = document.createElement("a");
      a.href = data.signedUrl;
      a.rel = "noopener";
      document.body.appendChild(a);
      a.click();
      a.remove();
    } else if (win) {
      win.location.replace(data.signedUrl);
    } else {
      // El navegador bloqueó la pestaña: se ofrece el enlace
      toast(`El navegador bloqueó la ventana. <a href="${esc(data.signedUrl)}" target="_blank" rel="noopener">Abrir el PDF</a>`, false, true);
    }
  }

  /* ---------------------------------------------------------------
     Eventos de la interfaz
     --------------------------------------------------------------- */
  $("buscar").addEventListener("input", (e) => {
    state.filtro = e.target.value;
    renderPatentes();
    actualizarControles();
  });
  function limpiarBusqueda() {
    state.filtro = "";
    $("buscar").value = "";
    renderPatentes();
    actualizarControles();
    $("buscar").focus();
  }
  $("buscar-limpiar").addEventListener("click", limpiarBusqueda);

  $("orden-patentes").addEventListener("change", (e) => {
    state.ordenPat = e.target.value;
    renderPatentes();
  });

  const inputsFiltro = { desde: "f-desde", hasta: "f-hasta", marca: "f-marca", zona: "f-zona", chofer: "f-chofer" };
  for (const [k, id] of Object.entries(inputsFiltro)) {
    $(id).addEventListener("change", (e) => {
      state.filtros[k] = e.target.value;
      renderPatentes();
      renderHistorial();
      actualizarControles();
    });
  }
  function limpiarFiltros() {
    for (const [k, id] of Object.entries(inputsFiltro)) {
      state.filtros[k] = "";
      $(id).value = "";
    }
    renderPatentes();
    renderHistorial();
    actualizarControles();
  }
  $("filtros-limpiar").addEventListener("click", limpiarFiltros);

  // Filtros: abiertos en PC, plegados en celular
  const ajustarFiltros = () => ($("filtros").open = !mqMovil.matches);
  mqMovil.addEventListener("change", ajustarFiltros);
  ajustarFiltros();

  document.addEventListener("click", (e) => {
    const b = e.target.closest("[data-accion], .pcard");
    if (!b) return;
    if (b.classList.contains("pcard")) return seleccionar(b.dataset.dominio);
    switch (b.dataset.accion) {
      case "ver": return abrirPdf(buscarCambio(b.dataset.id));
      case "descargar": return abrirPdf(buscarCambio(b.dataset.id), true);
      case "reintentar": return cargarDatos();
      case "limpiar-busqueda": return limpiarBusqueda();
      case "limpiar-filtros": return limpiarFiltros();
    }
  });

  $("btn-orden").addEventListener("click", () => {
    state.asc = !state.asc;
    renderHistorial();
  });
  $("btn-volver").addEventListener("click", volverAlListado);
  $("btn-ultimo-pdf").addEventListener("click", (e) => abrirPdf(buscarCambio(e.currentTarget.dataset.id)));

  /* ---------------------------------------------------------------
     Lectura del PDF (sin cambios respecto de la versión anterior)
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

  // Avisos de consistencia contra el historial ya cargado de esa patente
  function avisosHistorial(d) {
    const v = state.vehiculos.get(d.dominio);
    const ms = fechaMs(d.fecha_cambio);
    if (!v || isNaN(ms)) return [];
    const avisos = [];
    if (v.cambios.some((c) => c.ms === ms))
      avisos.push(`Ya existe un cambio de ${d.dominio} con fecha ${fmtFecha(d.fecha_cambio)}; al guardar se pedirá confirmación para reemplazarlo.`);
    const km = parseKm(d.kilometraje);
    if (km != null) {
      const prev = [...v.cambios].reverse().find((c) => c.ms < ms && c.km != null);
      const sig = v.cambios.find((c) => c.ms > ms && c.km != null);
      if (prev && km < prev.km)
        avisos.push(`El kilometraje es menor al del cambio anterior (${fmtFecha(prev.r.fecha_cambio)}: ${fmtNum(prev.km)} km).`);
      if (sig && km > sig.km)
        avisos.push(`El kilometraje es mayor al del cambio siguiente (${fmtFecha(sig.r.fecha_cambio)}: ${fmtNum(sig.km)} km).`);
    }
    return avisos;
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
      avisos.push(...avisosHistorial(datos));
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
     Guardado (sin cambios: misma ruta de PDF y mismo upsert)
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
  const btnReg = $("btn-registros");

  function estadoBoton(txt) {
    btnReg.disabled = !!txt;
    btnReg.querySelector("span").textContent = txt || "Registros";
  }

  async function procesarArchivos(lista) {
    if (!configurado) return toast("Falta configurar js/config.js", true);
    if (cargando) return toast("Ya hay una carga en curso", true);
    const pdfs = [...lista].filter((f) => f.type === "application/pdf" || /\.pdf$/i.test(f.name));
    if (!pdfs.length) return toast("Elegí archivos PDF", true);

    cargando = true;
    const res = { nuevo: 0, reemplazado: 0, omitido: 0, error: 0 };
    let ultimoDominio = null;

    for (let i = 0; i < pdfs.length; i++) {
      const file = pdfs[i];
      estadoBoton(pdfs.length > 1 ? `Cargando ${i + 1}/${pdfs.length}…` : "Cargando…");
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
    estadoBoton(null);
    $("file-input").value = "";

    const partes = [];
    if (res.nuevo) partes.push(`${res.nuevo} nuevo${res.nuevo > 1 ? "s" : ""}`);
    if (res.reemplazado) partes.push(`${res.reemplazado} reemplazado${res.reemplazado > 1 ? "s" : ""}`);
    if (res.omitido) partes.push(`${res.omitido} omitido${res.omitido > 1 ? "s" : ""}`);
    if (res.error) partes.push(`${res.error} con error`);
    toast("Carga finalizada: " + (partes.join(", ") || "sin cambios"));

    if (res.nuevo || res.reemplazado) {
      await cargarDatos();
      if (ultimoDominio) seleccionar(ultimoDominio);
    }
  }

  btnReg.addEventListener("click", () => $("file-input").click());
  $("file-input").addEventListener("change", (e) => procesarArchivos(e.target.files));

  // Arrastrar PDF a cualquier parte de la página
  let arrastres = 0;
  const overlay = $("drop-overlay");
  const tieneArchivos = (e) => [...(e.dataTransfer?.types || [])].includes("Files");
  document.addEventListener("dragenter", (e) => {
    if (!tieneArchivos(e)) return;
    e.preventDefault();
    arrastres++;
    overlay.hidden = false;
  });
  document.addEventListener("dragover", (e) => {
    if (tieneArchivos(e)) e.preventDefault();
  });
  document.addEventListener("dragleave", (e) => {
    if (!tieneArchivos(e)) return;
    arrastres = Math.max(0, arrastres - 1);
    if (!arrastres) overlay.hidden = true;
  });
  document.addEventListener("drop", (e) => {
    if (!tieneArchivos(e)) return;
    e.preventDefault();
    arrastres = 0;
    overlay.hidden = true;
    procesarArchivos(e.dataTransfer.files);
  });

  /* ---------------------------------------------------------------
     Arranque
     --------------------------------------------------------------- */
  async function iniciar() {
    if (!configurado) {
      state.cargando = false;
      renderTodo();
      return;
    }
    await cargarDatos();
    // Si se entra con una patente en la dirección (#AB500CM), se abre su historial
    const dom = decodeURIComponent(location.hash.slice(1));
    if (dom && state.vehiculos.has(dom)) seleccionar(dom, { historial: false });
  }

  iniciar();
})();
