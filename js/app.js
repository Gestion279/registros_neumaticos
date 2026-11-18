/* =====================================================================
   Historial de cambios de neumáticos
   - Acceso libre: cualquiera con el link puede ver y cargar
   - Lista de vehículos con los datos de la póliza (descripción del vehículo
     y zona), solo para patentes con cambios registrados
   - Ficha por vehículo con gráfico de kilometraje e historial
   - Si la patente no figura en la póliza, marca, modelo, año y zona salen del PDF
   - Aviso en pantalla cuando faltan los datos de la póliza
   - Lectura de PDF en el navegador (pdf.js) y controles de consistencia
   ===================================================================== */
(() => {
  "use strict";

  const { SUPABASE_URL, SUPABASE_ANON_KEY } = window.APP_CONFIG || {};
  const BUCKET = "pdfs";
  const TABLA = "cambios_neumaticos";
  const FN_POLIZA = "vehiculos_poliza_con_cambios"; // supabase/vehiculos_poliza.sql
  const PAGINA = 1000; // límite de filas por consulta de Supabase
  const DIAS_ALERTA = 180; // amarillo: entre 6 y 12 meses sin cambio
  const DIAS_VENCIDO = 365; // rojo: más de 12 meses sin cambio

  pdfjsLib.GlobalWorkerOptions.workerSrc =
    "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

  const configurado = !!SUPABASE_URL && !SUPABASE_URL.includes("TU-PROYECTO");
  const sb = configurado ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null;

  const $ = (id) => document.getElementById(id);

  const state = {
    registros: [],          // filas tal como vienen de la base (no se modifican)
    poliza: new Map(),      // dominio -> { marca, anio, zona, periodo_id, vigencia_hasta }
    polizaError: null,      // la función de póliza todavía no existe o falló
    polizaCodigo: null,     // código del error (PGRST202 = la función no existe)
    colsVehiculo: null,     // la tabla tiene las columnas del vehículo del PDF (null = no se sabe)
    completando: null,      // { i, n } mientras se leen los PDF para completar datos
    intentados: new Set(),  // patentes cuyo PDF ya se leyó en esta sesión sin éxito
    vehiculos: new Map(),   // dominio -> { dominio, cambios[], ultimo, ultimoConKm, aRevisar, pol, dias, ... }
    cargando: true,
    errorCarga: null,
    vista: "lista",         // lista | ficha
    q: "",
    fEstado: "",
    fZona: "",
    sort: { k: "patente", dir: 1 },
    marcados: new Set(),    // patentes tildadas para exportar
    sel: null,              // patente abierta en la ficha
    asc: false,             // ficha: más reciente primero
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
  const MESES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
  const fmtMesAnio = (ms) => {
    const d = new Date(ms);
    return `${MESES[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  };
  const fmtNum = (n) => (n == null ? "" : Number(n).toLocaleString("es-AR"));
  const limpiarDominio = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const hoyMs = () =>
    fechaMs(new Date().toLocaleDateString("en-CA", { timeZone: "America/Argentina/Buenos_Aires" }));
  const DIA = 86400000;

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

  const plural = (n, uno, varios) => `${fmtNum(n)} ${n === 1 ? uno : varios}`;

  // "Hace 3 semanas", "Hace 8 meses", "Hace 1 año y 2 meses"
  function haceTxt(dias) {
    if (dias == null) return "Sin fecha";
    if (dias < 0) return "Fecha futura";
    if (dias === 0) return "Hoy";
    if (dias < 14) return dias === 1 ? "Hace 1 día" : `Hace ${dias} días`;
    if (dias < 60) return `Hace ${Math.round(dias / 7)} semanas`;
    const meses = Math.round(dias / 30.44);
    if (meses < 12) return `Hace ${meses} meses`;
    const a = Math.floor(meses / 12), m = meses % 12;
    return `Hace ${a} año${a > 1 ? "s" : ""}${m ? ` y ${m} mes${m > 1 ? "es" : ""}` : ""}`;
  }

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
  const plate = (dom, cls = "plate") => `<span class="${cls}"><span>${esc(dom)}</span></span>`;
  const zonaHtml = (z) => (z ? `<span class="zona">${esc(z)}</span>` : '<span class="zona none">Sin zona</span>');

  /* ---------------------------------------------------------------
     Carga de datos: cambios (paginado) + datos de póliza (una llamada)
     --------------------------------------------------------------- */
  async function leerCambios() {
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
    return filas;
  }

  // Si la función de póliza todavía no se creó, la app sigue funcionando sin esos datos.
  async function leerPoliza() {
    const { data, error } = await sb.rpc(FN_POLIZA);
    if (error) throw error;
    return new Map((data || []).map((p) => [limpiarDominio(p.patente), p]));
  }

  async function cargarDatos() {
    state.cargando = true;
    state.errorCarga = null;
    renderTodo();
    const [rc, rp] = await Promise.allSettled([leerCambios(), leerPoliza()]);
    if (rc.status === "fulfilled") {
      state.registros = rc.value;
      if (rc.value.length) state.colsVehiculo = "marca_vehiculo" in rc.value[0];
    } else {
      state.errorCarga = mensajeError(rc.reason);
    }
    if (rp.status === "fulfilled") {
      state.poliza = rp.value;
      state.polizaError = state.polizaCodigo = null;
    } else {
      state.poliza = new Map();
      state.polizaError = mensajeError(rp.reason);
      state.polizaCodigo = rp.reason?.code || null;
      console.warn("Póliza:", rp.reason);
    }
    if (!state.errorCarga) procesar();
    state.cargando = false;
    if (state.sel && !state.vehiculos.has(state.sel)) state.sel = null;
    for (const d of [...state.marcados]) if (!state.vehiculos.has(d)) state.marcados.delete(d);
    llenarZonas();
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
      if (!dominio) continue;
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

      // Promedios entre cambios consecutivos (solo tramos válidos)
      const tramosKm = [], tramosDias = [];
      for (let i = 1; i < validos.length; i++) {
        const a = validos[i - 1], b = validos[i];
        if (a.km != null && b.km != null && b.km > a.km) tramosKm.push(b.km - a.km);
        if (b.ms > a.ms) tramosDias.push((b.ms - a.ms) / DIA);
      }
      const prom = (xs) => (xs.length ? Math.round(xs.reduce((s, x) => s + x, 0) / xs.length) : null);

      const dias = ultimo ? Math.round((hoy - ultimo.ms) / DIA) : null;
      const edad = dias == null ? "nd" : dias > DIAS_VENCIDO ? "vencido" : dias > DIAS_ALERTA ? "alerta" : "ok";

      // Datos del vehículo: primero la póliza; si falta, el PDF más reciente que los tenga
      const pol = state.poliza.get(dominio) || null;
      const recientes = [...cambios].reverse();
      const rVeh = recientes.find((c) => c.r.marca_vehiculo || c.r.modelo_vehiculo)?.r;
      const descPdf = rVeh ? [rVeh.marca_vehiculo, rVeh.modelo_vehiculo].map((x) => String(x || "").trim()).filter(Boolean).join(" - ") : "";
      const anioPdf = recientes.find((c) => c.r.anio_vehiculo)?.r.anio_vehiculo || "";
      const zonaPdf = recientes.find((c) => c.r.zona)?.r.zona || "";
      const descDePdf = !pol?.marca && !!descPdf;

      vehiculos.set(dominio, {
        dominio,
        pol,
        desc: pol?.marca || descPdf || null,
        descPdf: descDePdf,
        anio: (pol?.marca ? pol.anio : anioPdf || pol?.anio) || null,
        zona: pol?.zona || zonaPdf || null,
        zonaPdf: !pol?.zona && !!zonaPdf,
        tieneDatosPdf: !!descPdf,
        cambios,
        ultimo,
        ultimoConKm,
        aRevisar: cambios.filter((c) => c.problemas.some((x) => x.nivel !== "falta")).length,
        dias,
        edad,
        kmProm: prom(tramosKm),
        tramosKm,
        diasProm: prom(tramosDias),
      });
    }
    state.vehiculos = vehiculos;
  }

  // Problemas de un cambio, sumando los PDF que fallaron en esta sesión.
  function problemasDe(c) {
    if (!state.pdfFallidos.has(c.r.id)) return c.problemas;
    return [...c.problemas, { nivel: "error", txt: "PDF no disponible", det: "El archivo no se pudo abrir. Revisalo en Supabase Storage." }];
  }
  const aRevisarDe = (c) => problemasDe(c).filter((p) => p.nivel !== "falta");

  /* ---------------------------------------------------------------
     Lista de vehículos: filtros, orden y exportación
     --------------------------------------------------------------- */
  function llenarZonas() {
    const cnt = new Map();
    let sinZona = 0;
    for (const v of state.vehiculos.values()) {
      const z = v.zona;
      if (z) cnt.set(z, (cnt.get(z) || 0) + 1);
      else sinZona++;
    }
    const total = state.vehiculos.size;
    const lista = [...cnt].sort((a, b) => a[0].localeCompare(b[0], "es"));
    $("f-zona").innerHTML =
      `<option value="">Todas las zonas (${fmtNum(total)})</option>` +
      lista.map(([z, n]) => `<option value="${esc(z)}">${esc(z)} (${fmtNum(n)})</option>`).join("") +
      (sinZona ? `<option value="__none">Sin zona (${fmtNum(sinZona)})</option>` : "");
    if (state.fZona && state.fZona !== "__none" && !cnt.has(state.fZona)) state.fZona = "";
    if (state.fZona === "__none" && !sinZona) state.fZona = "";
    $("f-zona").value = state.fZona;
  }

  function cumpleEstado(v, e) {
    switch (e) {
      case "revisar": return v.aRevisar > 0;
      case "vencido": return v.edad === "vencido";
      case "alerta": return v.edad === "alerta";
      case "sinpoliza": return !v.pol;
      default: return true;
    }
  }

  function vehiculosVisibles() {
    const q = state.q.trim().toLowerCase();
    const qDom = limpiarDominio(state.q);
    const lista = [...state.vehiculos.values()].filter((v) => {
      if (!cumpleEstado(v, state.fEstado)) return false;
      if (state.fZona === "__none" ? v.zona : state.fZona && v.zona !== state.fZona) return false;
      if (!q) return true;
      if (qDom && v.dominio.includes(qDom)) return true;
      const txt = [v.desc, v.anio, v.zona].filter(Boolean).join(" ").toLowerCase();
      return txt.includes(q);
    });

    const { k, dir } = state.sort;
    const porPat = (a, b) => a.dominio.localeCompare(b.dominio, "es", { numeric: true });
    // Los valores faltantes van siempre al final, en cualquier sentido.
    const cmpNulos = (va, vb, cmp) => (va == null && vb == null ? 0 : va == null ? 1 : vb == null ? -1 : dir * cmp(va, vb));
    const num = (a, b) => a - b;
    const txt = (a, b) => String(a).localeCompare(String(b), "es", { numeric: true });
    const clave = {
      patente: (v) => v.dominio,
      marca: (v) => v.desc || null,
      zona: (v) => v.zona || null,
      ultimo: (v) => (v.ultimo ? v.ultimo.ms : null),
      km: (v) => (v.ultimoConKm ? v.ultimoConKm.km : null),
      cambios: (v) => v.cambios.length,
    }[k];
    const tipo = ["ultimo", "km", "cambios"].includes(k) ? num : txt;
    return lista.sort((a, b) => cmpNulos(clave(a), clave(b), tipo) || porPat(a, b));
  }

  const filtrosActivos = () => !!(state.q.trim() || state.fEstado || state.fZona);

  function estadosHtml(v) {
    const e = [];
    if (v.aRevisar) e.push(`<span class="estado revisar" title="${plural(v.aRevisar, "registro para revisar", "registros para revisar")}">Para revisar</span>`);
    if (v.edad === "vencido") e.push('<span class="estado vencido">Más de 12 meses</span>');
    if (!e.length) e.push(v.edad === "alerta" ? '<span class="estado alerta">6 a 12 meses</span>' : '<span class="estado ok">Al día</span>');
    return `<div class="estados">${e.join("")}</div>`;
  }

  function edadHtml(v) {
    if (v.dias == null) return '<span class="nd">Sin fecha válida</span>';
    const pct = Math.max(3, Math.min(100, Math.round((Math.max(0, v.dias) / DIAS_VENCIDO) * 100)));
    return `<div class="edad ${v.edad}"><span class="barra" aria-hidden="true"><i style="width:${pct}%"></i></span><span>${haceTxt(v.dias)}</span></div>`;
  }

  const TAG_PDF = '<span class="fuente-pdf" title="No figura en la póliza: dato tomado del último PDF del reporte">PDF</span>';
  const descHtml = (v) =>
    v.desc
      ? `${esc(v.desc)}${v.descPdf ? TAG_PDF : ""}${v.anio ? `<small>${esc(v.anio)}</small>` : ""}`
      : `<span class="nd">${v.pol ? "Sin descripción" : "Sin datos de póliza ni del PDF"}</span>${v.anio ? `<small>${esc(v.anio)}</small>` : ""}`;

  function filaVehiculo(v) {
    const u = v.ultimo?.r;
    const marcado = state.marcados.has(v.dominio);
    const cls = [marcado ? "sel" : "", v.aRevisar ? "revisar" : ""].filter(Boolean).join(" ");
    return `<tr data-dominio="${esc(v.dominio)}" class="${cls}">
      <td class="chk"><input type="checkbox" class="marca-chk" ${marcado ? "checked" : ""} aria-label="Seleccionar ${esc(v.dominio)}"></td>
      <td class="pat">${plate(v.dominio)}</td>
      <td class="marca">${descHtml(v)}</td>
      <td class="zn">${zonaHtml(v.zona)}${v.zonaPdf ? TAG_PDF : ""}</td>
      <td class="ult"><span class="fecha">${u ? esc(fmtFecha(u.fecha_cambio)) : ""}</span>${edadHtml(v)}</td>
      <td class="num km">${v.ultimoConKm ? fmtNum(v.ultimoConKm.km) : '<span class="nd">Sin dato</span>'}</td>
      <td class="neum">${u?.marca_neumatico ? esc(u.marca_neumatico) : '<span class="nd">—</span>'}${u?.medida || u?.cantidad != null ? `<small>${[u.medida && esc(u.medida), u.cantidad != null && `${u.cantidad} u.`].filter(Boolean).join(" · ")}</small>` : ""}</td>
      <td class="num ncamb">${fmtNum(v.cambios.length)}</td>
      <td class="est">${estadosHtml(v)}</td>
      <td class="acc"><button class="btn small" type="button" data-accion="abrir" data-dominio="${esc(v.dominio)}">Historial</button></td>
    </tr>`;
  }

  function vacio(colspan, msg, acciones = "", error = false) {
    return `<tr class="vacio${error ? " error" : ""}"><td colspan="${colspan}"><p style="margin:0">${msg}</p>${acciones}</td></tr>`;
  }

  function renderKpis() {
    const set = (id, v) => ($(id).textContent = v);
    if (state.cargando) return ["k-total", "k-revisar", "k-vencido", "k-prom"].forEach((id) => set(id, "…"));
    if (state.errorCarga) return ["k-total", "k-revisar", "k-vencido", "k-prom"].forEach((id) => set(id, "—"));
    const vs = [...state.vehiculos.values()];
    set("k-total", fmtNum(vs.length));
    const sinPol = vs.filter((v) => !v.pol).length;
    $("k-total-sub").textContent =
      state.polizaError ? "Sin datos de póliza disponibles" : sinPol ? `${fmtNum(sinPol)} sin datos de póliza` : "Con cambios registrados";
    set("k-revisar", fmtNum(vs.filter((v) => v.aRevisar).length));
    set("k-vencido", fmtNum(vs.filter((v) => v.edad === "vencido").length));
    const tramos = vs.flatMap((v) => v.tramosKm);
    set("k-prom", tramos.length ? `${fmtNum(Math.round(tramos.reduce((s, x) => s + x, 0) / tramos.length))} km` : "—");
    document.querySelectorAll(".kpi[data-estado]").forEach((b) =>
      b.setAttribute("aria-pressed", String(b.dataset.estado === state.fEstado && (b.dataset.estado !== "" || !filtrosActivos())))
    );
  }

  const COLS_VEHICULO = ["marca_vehiculo", "modelo_vehiculo", "anio_vehiculo"];

  // Vehículos sin descripción en la póliza a los que todavía no se les leyó el PDF
  function pendientesPdf() {
    if (state.colsVehiculo !== true) return [];
    return [...state.vehiculos.values()].filter(
      (v) => !v.pol?.marca && !v.tieneDatosPdf && !state.intentados.has(v.dominio) && v.cambios.some((c) => c.r.pdf_path)
    );
  }

  // Explica en pantalla por qué faltan datos del vehículo y ofrece completarlos.
  function renderAviso() {
    const el = $("aviso-poliza");
    const vs = [...state.vehiculos.values()];
    const msgs = [];
    let tipo = "info";
    if (!state.cargando && !state.errorCarga && vs.length) {
      const sinPol = vs.filter((v) => !v.pol).length;
      if (state.polizaError) {
        tipo = "error";
        const falta = state.polizaCodigo === "PGRST202" || /could not find the function/i.test(state.polizaError);
        msgs.push(falta
          ? "<strong>Falta crear la función de la póliza.</strong> Ejecutá <code>supabase/vehiculos_poliza.sql</code> en el SQL Editor de Supabase. Mientras tanto se muestran los datos del PDF."
          : `<strong>No se pudieron leer los datos de la póliza.</strong> ${esc(state.polizaError)}. Ejecutá <code>supabase/diagnostico_poliza.sql</code> en Supabase para ver la causa.`);
      } else if (sinPol === vs.length) {
        tipo = "error";
        msgs.push(`<strong>La póliza no devolvió datos para ninguna de las ${fmtNum(vs.length)} patentes con cambios.</strong> Se muestran los datos del PDF. Ejecutá <code>supabase/diagnostico_poliza.sql</code> en Supabase para ver la causa.`);
      } else if (sinPol) {
        msgs.push(`${plural(sinPol, "patente no figura", "patentes no figuran")} en la póliza: se muestran marca, modelo y zona del último PDF, marcados <span class="fuente-pdf">PDF</span>. <button class="linkbtn" type="button" data-accion="ver-sinpoliza">Ver cuáles</button>`);
      }
      if (state.completando) {
        msgs.push(`Leyendo los PDF para completar marca y modelo… ${fmtNum(state.completando.i)} de ${fmtNum(state.completando.n)}`);
      } else if (state.colsVehiculo === false && vs.some((v) => !v.pol?.marca)) {
        tipo = "error";
        msgs.push("Para guardar y mostrar marca y modelo del vehículo según el PDF, ejecutá <code>supabase/vehiculo_pdf.sql</code> en Supabase.");
      } else {
        const pend = pendientesPdf().length;
        if (pend)
          msgs.push(`${plural(pend, "vehículo sin datos de póliza todavía no tiene", "vehículos sin datos de póliza todavía no tienen")} marca y modelo leídos de su PDF. <button class="btn small" type="button" data-accion="completar-pdf">Completar desde los PDF</button>`);
      }
    }
    el.hidden = !msgs.length;
    el.className = "aviso-banda " + tipo;
    el.innerHTML = msgs.map((m) => `<span class="aviso-linea">${m}</span>`).join("");
  }

  // Lee el PDF más reciente de cada vehículo pendiente y guarda marca, modelo y año.
  // Solo completa esas columnas: no modifica ningún otro dato del registro.
  async function completarDesdePdf() {
    const lista = pendientesPdf();
    if (!lista.length || state.completando) return;
    let ok = 0, sinDato = 0, err = 0;
    state.completando = { i: 0, n: lista.length };
    renderAviso();
    for (const v of lista) {
      state.completando.i++;
      renderAviso();
      const c = [...v.cambios].reverse().find((x) => x.r.pdf_path);
      try {
        const { data: blob, error } = await sb.storage.from(BUCKET).download(c.r.pdf_path);
        if (error || !blob) throw error || new Error("PDF vacío");
        const d = parsear(await extraerTexto(blob), c.r.archivo_origen || "");
        const upd = {};
        if (d.marca_vehiculo) upd.marca_vehiculo = d.marca_vehiculo;
        if (d.modelo_vehiculo) upd.modelo_vehiculo = d.modelo_vehiculo;
        if (/^\d{4}$/.test(d.anio_vehiculo || "")) upd.anio_vehiculo = d.anio_vehiculo;
        if (!Object.keys(upd).length) {
          sinDato++;
          state.intentados.add(v.dominio);
          continue;
        }
        const { error: e2 } = await sb.from(TABLA).update(upd).eq("id", c.r.id);
        if (e2) throw e2;
        ok++;
      } catch (e) {
        err++;
        state.intentados.add(v.dominio);
        console.warn("Completar desde PDF", v.dominio, e);
      }
    }
    state.completando = null;
    const partes = [`${plural(ok, "vehículo completado", "vehículos completados")}`];
    if (sinDato) partes.push(`${fmtNum(sinDato)} PDF sin marca ni modelo legibles`);
    if (err) partes.push(`${fmtNum(err)} con error`);
    toast("Datos del PDF: " + partes.join(", "), err > 0 && !ok);
    await cargarDatos();
  }

  function renderLista() {
    const tb = $("tb"), tf = $("tf");
    $("filtros-limpiar").hidden = !filtrosActivos();
    document.querySelectorAll("#tabla-veh th[data-sort]").forEach((th) => {
      if (th.dataset.sort === state.sort.k) th.setAttribute("aria-sort", state.sort.dir > 0 ? "ascending" : "descending");
      else th.removeAttribute("aria-sort");
    });

    if (!configurado) {
      tf.innerHTML = "";
      tb.innerHTML = vacio(10, "Falta configurar <code>js/config.js</code> con la URL y la anon key de Supabase.");
      return;
    }
    if (state.cargando) {
      tf.innerHTML = "";
      $("lista-n").textContent = "Cargando…";
      tb.innerHTML = Array.from({ length: 6 }, () => `<tr class="esq" aria-hidden="true"><td colspan="10"><span></span></td></tr>`).join("");
      return;
    }
    if (state.errorCarga) {
      tf.innerHTML = "";
      $("lista-n").textContent = "";
      tb.innerHTML = vacio(10, `No se pudieron cargar los registros. <span class="muted">${esc(state.errorCarga)}</span>`,
        `<div><button class="btn" type="button" data-accion="reintentar">${ico("refresh")}Reintentar</button></div>`, true);
      return;
    }
    if (!state.vehiculos.size) {
      tf.innerHTML = "";
      $("lista-n").textContent = "";
      tb.innerHTML = vacio(10, "Todavía no hay registros. Usá <strong>Cargar PDF</strong> para cargar el primero.");
      return;
    }

    const lista = vehiculosVisibles();
    const total = state.vehiculos.size;
    $("lista-n").textContent = lista.length === total ? plural(total, "vehículo", "vehículos") : `${fmtNum(lista.length)} de ${plural(total, "vehículo", "vehículos")}`;
    $("sel-todos").checked = lista.length > 0 && lista.every((v) => state.marcados.has(v.dominio));
    $("sel-todos").indeterminate = !$("sel-todos").checked && lista.some((v) => state.marcados.has(v.dominio));

    if (!lista.length) {
      tf.innerHTML = "";
      tb.innerHTML = vacio(10, "Ningún vehículo coincide con la búsqueda o los filtros.",
        `<div><button class="btn" type="button" data-accion="limpiar-filtros">Limpiar filtros</button></div>`);
      return;
    }
    tb.innerHTML = lista.map(filaVehiculo).join("");
    tf.innerHTML = `<tr><td colspan="5">${lista.length === total ? "Total" : "Subtotal"} ${plural(lista.length, "vehículo", "vehículos")}</td>
      <td colspan="5" class="fuente">Vehículo y zona: póliza${state.polizaError ? " (no disponible)" : ""}; si falta, último PDF (marcado PDF) · Solo vehículos con cambios registrados</td></tr>`;
  }

  function renderBulk() {
    const n = state.marcados.size;
    $("bulk").hidden = !n;
    $("bulk-n").textContent = n === 1 ? "1 vehículo seleccionado" : `${fmtNum(n)} vehículos seleccionados`;
  }

  /* ---------------------------------------------------------------
     Ficha del vehículo
     --------------------------------------------------------------- */
  const SERVICIOS = [["alineacion", "Alineación", "Alin."], ["balanceo", "Balanceo", "Bal."], ["rotacion", "Rotación", "Rot."], ["valvulas", "Válvulas", "Válv."]];
  const serviciosHtml = (r, corto = false) =>
    `<div class="servicios">${SERVICIOS.map(([k, nombre, abrev]) => {
      const t = corto ? abrev : nombre;
      const v = r[k];
      return v === true ? `<span class="serv si" title="${nombre}: sí">${t}</span>`
        : v === false ? `<span class="serv no" title="${nombre}: no">${t}</span>`
        : `<span class="serv nd" title="${nombre}: sin dato">${t} ?</span>`;
    }).join("")}</div>`;

  function deltaHtml(c) {
    const d = c.delta;
    if (d.tipo === "primero") return '<span class="nd" title="Es el primer cambio registrado">Primer registro</span>';
    if (d.tipo === "nd") return '<span class="nd" title="Falta el kilometraje de este cambio o del anterior">No disponible</span>';
    if (d.tipo === "neg")
      return `<span class="tag revisar" title="Diferencia: ${fmtNum(d.valor)} km. El kilometraje es menor al del cambio anterior.">${ico("alert")}${fmtNum(d.valor)}</span>`;
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
      <button class="btn small${compacto ? " solo-ico" : ""}" type="button" data-accion="descargar" data-id="${c.r.id}" aria-label="Descargar PDF del ${fmtFecha(c.r.fecha_cambio)}" title="Descargar">${ico("download")}${compacto ? "" : "<span>Descargar</span>"}</button>
    </div>`;
  }

  // Escala "redonda" para el eje: pasos de 1, 2, 2,5 o 5 por potencia de 10.
  function pasoRedondo(rango, divisiones) {
    const bruto = Math.max(1, rango) / divisiones;
    const mag = Math.pow(10, Math.floor(Math.log10(bruto)));
    const n = bruto / mag;
    return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * mag;
  }

  // El gráfico se dibuja al ancho real del contenedor (texto siempre legible).
  function graficoKm(v, ancho) {
    const pts = v.cambios.filter((c) => !isNaN(c.ms) && c.km != null);
    if (pts.length < 2) return `<p class="grafico-vacio">Hacen falta al menos dos cambios con fecha y kilometraje para dibujar el gráfico.</p>`;
    const W = Math.round(Math.max(320, Math.min(1000, ancho || 760)));
    const H = W < 520 ? 210 : 250;
    const x0 = 58, x1 = W - 34, y0 = H - 40, y1 = 28;
    const t0 = pts[0].ms, t1 = pts[pts.length - 1].ms;
    const kms = pts.map((p) => p.km);
    const paso = pasoRedondo(Math.max(...kms) - Math.min(...kms), 3);
    const kmin = Math.floor(Math.min(...kms) / paso) * paso;
    let kmax = Math.ceil(Math.max(...kms) / paso) * paso;
    if (kmax === kmin) kmax = kmin + paso;
    const marcas = [];
    for (let m = kmin; m <= kmax + 1e-6; m += paso) marcas.push(m);
    const X = (ms) => (t1 === t0 ? (x0 + x1) / 2 : x0 + ((ms - t0) / (t1 - t0)) * (x1 - x0));
    const Y = (km) => y0 - ((km - kmin) / (kmax - kmin)) * (y0 - y1);
    const fmtEje = (n) => (n >= 1000 ? `${(n / 1000).toLocaleString("es-AR", { maximumFractionDigits: 1 })} mil` : fmtNum(Math.round(n)));
    // Etiquetas de fecha y de km sin superponerse
    const maxEtiq = Math.max(2, Math.floor((x1 - x0) / 80));
    const cada = Math.ceil(pts.length / maxEtiq);
    const conEtiq = pts.filter((_, i) => i % cada === 0 || i === pts.length - 1);
    const linea = pts.map((p) => `${X(p.ms).toFixed(1)},${Y(p.km).toFixed(1)}`).join(" ");
    const desc = `Kilometraje de ${v.dominio}: de ${fmtNum(pts[0].km)} km (${fmtFecha(pts[0].r.fecha_cambio)}) a ${fmtNum(pts[pts.length - 1].km)} km (${fmtFecha(pts[pts.length - 1].r.fecha_cambio)}).`;
    return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(desc)}">
      ${marcas.map((m) => `<line class="eje" x1="${x0}" x2="${x1}" y1="${Y(m).toFixed(1)}" y2="${Y(m).toFixed(1)}"/><text class="lbl-eje" x="${x0 - 8}" y="${(Y(m) + 4).toFixed(1)}" text-anchor="end">${fmtEje(m)}</text>`).join("")}
      <polyline class="linea" points="${linea}"/>
      ${pts.map((p) => {
        const rev = aRevisarDe(p).length > 0;
        return `<circle class="pt${rev ? " rev" : ""}" cx="${X(p.ms).toFixed(1)}" cy="${Y(p.km).toFixed(1)}" r="${rev ? 7 : 5}"><title>${esc(fmtFecha(p.r.fecha_cambio))}: ${fmtNum(p.km)} km${rev ? " · para revisar" : ""}</title></circle>`;
      }).join("")}
      ${conEtiq.map((p) => `<text class="lbl-pt" x="${X(p.ms).toFixed(1)}" y="${(Y(p.km) - 12).toFixed(1)}" text-anchor="${p === pts[0] ? "start" : p === pts[pts.length - 1] ? "end" : "middle"}">${fmtNum(p.km)}</text>`).join("")}
      ${conEtiq.map((p) => `<text class="lbl-eje" x="${X(p.ms).toFixed(1)}" y="${H - 12}" text-anchor="${p === pts[0] ? "start" : p === pts[pts.length - 1] ? "end" : "middle"}">${fmtMesAnio(p.ms)}</text>`).join("")}
    </svg>`;
  }

  // Al cambiar el ancho de la ventana se vuelve a dibujar el gráfico.
  let anchoGrafico = 0;
  function dibujarGrafico(v) {
    const cont = $("hist-grafico");
    anchoGrafico = cont.clientWidth - 28;
    cont.innerHTML = graficoKm(v, anchoGrafico);
  }
  let tResize = null;
  window.addEventListener("resize", () => {
    clearTimeout(tResize);
    tResize = setTimeout(() => {
      const v = state.vista === "ficha" && state.sel && state.vehiculos.get(state.sel);
      if (v && Math.abs($("hist-grafico").clientWidth - 28 - anchoGrafico) > 8) dibujarGrafico(v);
    }, 150);
  });

  function filaCambio(c) {
    const r = c.r;
    const ps = problemasDe(c);
    const nivel = ps.some((p) => p.nivel === "error") ? "error" : ps.some((p) => p.nivel === "revisar") ? "revisar" : "";
    const choferZona = [r.chofer, r.zona].filter(Boolean).map(esc).join('<span class="sep">·</span>');
    return `
      <tr class="${nivel ? "fila-" + nivel : ""}">
        <td class="fecha" title="${r.created_at ? "Cargado el " + esc(fmtFechaHora(r.created_at)) : ""}">${esc(fmtFecha(r.fecha_cambio))}</td>
        <td class="num km">${c.km != null ? fmtNum(c.km) : '<span class="nd">Sin dato</span>'}</td>
        <td class="num">${deltaHtml(c)}</td>
        <td>${esc(r.marca_neumatico) || '<span class="nd">—</span>'}${r.medida || r.cantidad != null ? `<small>${[r.medida && esc(r.medida), r.cantidad != null && `${r.cantidad} u.`].filter(Boolean).join(" · ")}</small>` : ""}</td>
        <td>${serviciosHtml(r, true)}</td>
        <td class="persona">${choferZona || '<span class="nd">—</span>'}${r.asignacion ? `<small title="Asignación">${esc(r.asignacion)}</small>` : ""}</td>
        <td class="obs">${r.observaciones ? `<span class="clamp" title="${esc(r.observaciones)}">${esc(r.observaciones)}</span>` : '<span class="nd">—</span>'}</td>
        <td>${tagsHtml(ps) || '<span class="nd" title="Sin observaciones de consistencia">—</span>'}</td>
        <td class="acc">${pdfBotones(c, true)}</td>
      </tr>`;
  }

  function fichaCambio(c) {
    const r = c.r;
    const ps = problemasDe(c);
    const nivel = ps.some((p) => p.nivel === "error") ? "error" : ps.some((p) => p.nivel === "revisar") ? "revisar" : "";
    const neum = [r.medida && esc(r.medida), r.cantidad != null && `${r.cantidad} u.`].filter(Boolean).join(" · ");
    const det = [
      ["Chofer", esc(r.chofer) || '<span class="nd">—</span>'],
      ["Zona del reporte", esc(r.zona) || '<span class="nd">—</span>'],
      ["Asignación", esc(r.asignacion) || '<span class="nd">—</span>', true],
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
        <div>
          <span class="lbl">Neumático</span>
          <span><strong>${esc(r.marca_neumatico) || '<span class="nd">Sin dato</span>'}</strong>${neum ? ` <span class="muted">· ${neum}</span>` : ""}</span>
        </div>
        ${serviciosHtml(r)}
        ${pdfBotones(c)}
        <details class="ficha-det">
          <summary>Ver detalle</summary>
          <dl>${det.map(([k, val, full]) => `<div${full ? ' class="full"' : ""}><dt>${k}</dt><dd>${val}</dd></div>`).join("")}</dl>
        </details>
      </li>`;
  }

  function renderFicha() {
    const v = state.sel && state.vehiculos.get(state.sel);
    if (state.vista !== "ficha" || !v) return;
    const u = v.ultimo?.r;

    $("hist-plate").firstElementChild.textContent = v.dominio;
    $("hist-marca").innerHTML =
      (v.desc ? `${esc(v.desc)}${v.anio ? `<small>${esc(v.anio)}</small>` : ""}${v.descPdf ? TAG_PDF : ""}` : "") +
      (!v.pol ? `<div><span class="aviso-poliza">${state.polizaError ? "Datos de póliza no disponibles" : "No figura en la póliza"}${v.desc ? ": datos del último PDF" : ""}</span></div>` : "");

    const datos = [];
    datos.push(["Zona", zonaHtml(v.zona) + (v.zonaPdf ? TAG_PDF : "")]);
    datos.push(
      ["Chofer (último reporte)", esc(u?.chofer) || '<span class="nd">—</span>'],
      ["Asignación", esc(u?.asignacion) || '<span class="nd">—</span>'],
      ["Neumático actual", u?.marca_neumatico ? `${esc(u.marca_neumatico)}${u.medida ? " " + esc(u.medida) : ""}` : '<span class="nd">—</span>']
    );
    $("hist-datos").innerHTML = datos.map(([k, val]) => `<div><dt>${k}</dt><dd>${val}</dd></div>`).join("");

    const kpis = [
      ["Km en el último cambio", v.ultimoConKm ? `${fmtNum(v.ultimoConKm.km)}` : "—", v.ultimoConKm && v.ultimoConKm !== v.ultimo ? `Del ${fmtFecha(v.ultimoConKm.r.fecha_cambio)}` : "km"],
      ["Último cambio", u ? fmtFecha(u.fecha_cambio) : "—", haceTxt(v.dias)],
      ["Km promedio entre cambios", v.kmProm != null ? fmtNum(v.kmProm) : "—", v.kmProm != null ? "km" : "Faltan datos"],
      ["Días promedio entre cambios", v.diasProm != null ? fmtNum(v.diasProm) : "—", plural(v.cambios.length, "cambio registrado", "cambios registrados")],
    ];
    const cls = v.edad === "vencido" ? " bad" : v.aRevisar ? "" : "";
    $("hist-kpis").innerHTML = kpis
      .map(([l, val, sub], i) => `<div class="kpi${i === 1 ? cls : ""}"><span class="kpi-lbl">${l}</span><strong class="kpi-val">${val}</strong><span class="kpi-sub">${esc(sub)}</span></div>`)
      .join("");

    dibujarGrafico(v);

    const conPdf = [...v.cambios].reverse().find((c) => c.r.pdf_path && !isNaN(c.ms));
    const btnUlt = $("btn-ultimo-pdf");
    btnUlt.disabled = !conPdf;
    btnUlt.dataset.id = conPdf ? conPdf.r.id : "";
    btnUlt.title = conPdf ? `Abre el PDF del ${fmtFecha(conPdf.r.fecha_cambio)}` : "Ningún cambio de este vehículo tiene PDF";

    $("btn-orden").innerHTML = `${ico("sort")}${state.asc ? "Más antiguo primero" : "Más reciente primero"}`;
    $("btn-orden").setAttribute("aria-label", `Orden por fecha: ${state.asc ? "más antiguo primero" : "más reciente primero"}. Cambiar orden`);

    const filas = state.asc ? v.cambios : [...v.cambios].reverse();
    $("tbody").innerHTML = filas.map(filaCambio).join("");
    $("fichas").innerHTML = filas.map(fichaCambio).join("");
  }

  /* ---------------------------------------------------------------
     Vistas y navegación
     --------------------------------------------------------------- */
  function mostrarVista() {
    const v = state.vista;
    $("vista-lista").hidden = v !== "lista";
    $("vista-ficha").hidden = v !== "ficha";
  }

  function renderTodo() {
    mostrarVista();
    renderKpis();
    renderLista();
    renderBulk();
    renderAviso();
    renderFicha();
  }

  function seleccionar(dominio, { historial = true } = {}) {
    if (!state.vehiculos.has(dominio)) return;
    state.sel = dominio;
    state.vista = "ficha";
    if (historial) {
      const hash = "#" + encodeURIComponent(dominio);
      if (location.hash !== hash) {
        if (location.hash) history.replaceState({ p: dominio }, "", hash);
        else history.pushState({ p: dominio }, "", hash);
      }
    }
    renderTodo();
    window.scrollTo({ top: 0 });
    $("hist-titulo").focus({ preventScroll: true });
  }

  function irA(vista, { historial = true } = {}) {
    const desde = state.sel;
    state.vista = vista;
    if (historial && location.hash) history.pushState(null, "", location.pathname + location.search);
    renderTodo();
    if (vista === "lista" && desde) {
      const fila = $("tb").querySelector(`tr[data-dominio="${CSS.escape(desde)}"]`);
      if (fila) {
        fila.scrollIntoView({ block: "center" });
        fila.querySelector("button")?.focus({ preventScroll: true });
        return;
      }
    }
    window.scrollTo({ top: 0 });
  }

  function volver() {
    // Si se llegó desde la lista con la app, Atrás del navegador hace lo mismo.
    if (history.state && history.state.p) history.back();
    else irA("lista");
  }

  window.addEventListener("popstate", () => {
    const dom = decodeURIComponent(location.hash.slice(1));
    if (dom && state.vehiculos.has(dom)) seleccionar(dom, { historial: false });
    else irA("lista", { historial: false });
  });

  /* ---------------------------------------------------------------
     Exportar (CSV que Excel abre directamente)
     --------------------------------------------------------------- */
  function exportar() {
    const base = state.marcados.size
      ? vehiculosVisibles().filter((v) => state.marcados.has(v.dominio))
      : vehiculosVisibles();
    const lista = state.marcados.size && !base.length ? [...state.marcados].map((d) => state.vehiculos.get(d)).filter(Boolean) : base;
    if (!lista.length) return toast("No hay vehículos para exportar", true);
    const cab = ["Patente", "Vehículo", "Año", "Zona", "Origen de vehículo y zona", "Último cambio", "Días desde el último cambio",
      "Km en el último cambio", "Neumático", "Medida", "Cambios", "Km promedio entre cambios", "Registros para revisar"];
    const filas = lista.map((v) => {
      const u = v.ultimo?.r;
      return [v.dominio, v.desc ?? "", v.anio ?? "", v.zona ?? "",
        v.pol ? (v.descPdf || v.zonaPdf ? "Póliza y PDF" : "Póliza") : v.desc || v.zona ? "PDF" : "",
        u ? fmtFecha(u.fecha_cambio) : "", v.dias ?? "", v.ultimoConKm?.km ?? "", u?.marca_neumatico ?? "", u?.medida ?? "",
        v.cambios.length, v.kmProm ?? "", v.aRevisar];
    });
    const celda = (x) => {
      const s = String(x ?? "");
      return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const csv = "\uFEFF" + [cab, ...filas].map((f) => f.map(celda).join(";")).join("\r\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `neumaticos_vehiculos_${new Date().toLocaleDateString("en-CA", { timeZone: "America/Argentina/Buenos_Aires" })}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    toast(`Exportados ${plural(lista.length, "vehículo", "vehículos")}`);
  }

  /* ---------------------------------------------------------------
     PDF: se abre en una pestaña nueva con un enlace temporal firmado.
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
          win.document.body.innerHTML = '<p style="font:16px system-ui,sans-serif;padding:24px;color:#1C2B30">Abriendo PDF…</p>';
        } catch (_) { /* sin acceso al documento: no importa */ }
      }
    }

    const { data, error } = await sb.storage
      .from(BUCKET)
      .createSignedUrl(c.r.pdf_path, 600, descargar ? { download: nombre } : undefined);

    if (error || !data?.signedUrl) {
      if (win) win.close();
      state.pdfFallidos.add(c.r.id);
      renderTodo();
      return toast("No se pudo abrir el PDF: " + mensajeError(error || "enlace vacío"), true);
    }
    if (state.pdfFallidos.delete(c.r.id)) renderTodo();

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
      toast(`El navegador bloqueó la ventana. <a href="${esc(data.signedUrl)}" target="_blank" rel="noopener">Abrir el PDF</a>`, false, true);
    }
  }

  /* ---------------------------------------------------------------
     Eventos de la interfaz
     --------------------------------------------------------------- */
  $("buscar").addEventListener("input", (e) => {
    state.q = e.target.value;
    renderLista();
    renderKpis();
  });
  $("f-estado").addEventListener("change", (e) => {
    state.fEstado = e.target.value;
    renderLista();
    renderKpis();
  });
  $("f-zona").addEventListener("change", (e) => {
    state.fZona = e.target.value;
    renderLista();
    renderKpis();
  });
  function limpiarFiltros() {
    state.q = state.fEstado = state.fZona = "";
    $("buscar").value = "";
    $("f-estado").value = "";
    $("f-zona").value = "";
    renderLista();
    renderKpis();
  }
  $("filtros-limpiar").addEventListener("click", limpiarFiltros);

  // Indicadores: filtran la lista
  document.querySelectorAll(".kpi[data-estado]").forEach((b) =>
    b.addEventListener("click", () => {
      if (b.dataset.estado === "") limpiarFiltros();
      else {
        state.fEstado = state.fEstado === b.dataset.estado ? "" : b.dataset.estado;
        $("f-estado").value = state.fEstado;
        renderLista();
        renderKpis();
      }
      $("panel-lista").scrollIntoView({ block: "start", behavior: "smooth" });
    })
  );

  // Orden por columna
  const ordenar = (k) => {
    state.sort = state.sort.k === k ? { k, dir: -state.sort.dir } : { k, dir: ["ultimo", "km", "cambios"].includes(k) ? -1 : 1 };
    renderLista();
  };
  document.querySelectorAll("#tabla-veh th[data-sort]").forEach((th) => {
    th.addEventListener("click", () => ordenar(th.dataset.sort));
    th.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        ordenar(th.dataset.sort);
      }
    });
  });

  // Selección para exportar
  $("sel-todos").addEventListener("change", (e) => {
    const vis = vehiculosVisibles();
    vis.forEach((v) => (e.target.checked ? state.marcados.add(v.dominio) : state.marcados.delete(v.dominio)));
    renderLista();
    renderBulk();
  });
  $("tb").addEventListener("change", (e) => {
    if (!e.target.classList.contains("marca-chk")) return;
    const dom = e.target.closest("tr").dataset.dominio;
    if (e.target.checked) state.marcados.add(dom);
    else state.marcados.delete(dom);
    e.target.closest("tr").classList.toggle("sel", e.target.checked);
    renderBulk();
    const vis = vehiculosVisibles();
    $("sel-todos").checked = vis.length > 0 && vis.every((v) => state.marcados.has(v.dominio));
    $("sel-todos").indeterminate = !$("sel-todos").checked && vis.some((v) => state.marcados.has(v.dominio));
  });

  // Clic en una fila de la lista (fuera de casillas y botones) abre la ficha
  $("tb").addEventListener("click", (e) => {
    if (e.target.closest("input, button, a, label")) return;
    const tr = e.target.closest("tr[data-dominio]");
    if (tr) seleccionar(tr.dataset.dominio);
  });

  document.addEventListener("click", (e) => {
    const b = e.target.closest("[data-accion]");
    if (!b) return;
    switch (b.dataset.accion) {
      case "abrir": return seleccionar(b.dataset.dominio);
      case "ver": return abrirPdf(buscarCambio(b.dataset.id));
      case "descargar": return abrirPdf(buscarCambio(b.dataset.id), true);
      case "reintentar": return cargarDatos();
      case "limpiar-filtros": return limpiarFiltros();
      case "exportar": return exportar();
      case "completar-pdf": return completarDesdePdf();
      case "ver-sinpoliza":
        state.fEstado = "sinpoliza";
        $("f-estado").value = "sinpoliza";
        renderLista();
        renderKpis();
        return $("panel-lista").scrollIntoView({ block: "start", behavior: "smooth" });
      case "deseleccionar":
        state.marcados.clear();
        renderLista();
        return renderBulk();
    }
  });


  $("btn-exportar").addEventListener("click", exportar);
  $("btn-orden").addEventListener("click", () => {
    state.asc = !state.asc;
    renderFicha();
  });
  $("btn-volver").addEventListener("click", volver);
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
      marca_vehiculo: marcas.length >= 2 ? marcas[0] : "",
      modelo_vehiculo: campo("Modelo"),
      anio_vehiculo: simple(/A[ñn]o(?:\s+modelo)?:\s*(\d{4})\b/i),
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
    ["dominio", "fecha_cambio", "kilometraje", "marca_neumatico", "medida", "cantidad", "chofer", "zona", "asignacion", "observaciones",
      "marca_vehiculo", "modelo_vehiculo", "anio_vehiculo"].forEach((n) => set(n, d[n]));
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
      marca_vehiculo: v("marca_vehiculo") || null,
      modelo_vehiculo: v("modelo_vehiculo") || null,
      anio_vehiculo: /^\d{4}$/.test(v("anio_vehiculo")) ? v("anio_vehiculo") : null,
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
    // Si todavía no se ejecutó supabase/vehiculo_pdf.sql, se guarda sin los datos del vehículo.
    const sinVehiculo = (f) => {
      const g = { ...f };
      COLS_VEHICULO.forEach((k) => delete g[k]);
      return g;
    };
    let { error } = await sb.from(TABLA).upsert(state.colsVehiculo === false ? sinVehiculo(fila) : fila, { onConflict: "dominio,fecha_cambio" });
    if (error && /(marca|modelo|anio)_vehiculo/.test(error.message || "")) {
      state.colsVehiculo = false;
      ({ error } = await sb.from(TABLA).upsert(sinVehiculo(fila), { onConflict: "dominio,fecha_cambio" }));
    }
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
    btnReg.querySelector("span").textContent = txt || "Cargar PDF";
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
          ["marca_neumatico", "medida", "chofer", "zona", "asignacion", "marca_vehiculo", "modelo_vehiculo", "anio_vehiculo"].forEach((k) => (final[k] = final[k] || null));
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
    // Si se entra con una patente en la dirección (#AB500CM), se abre su ficha
    const dom = decodeURIComponent(location.hash.slice(1));
    if (dom && state.vehiculos.has(dom)) seleccionar(dom, { historial: false });
  }

  iniciar();
})();
