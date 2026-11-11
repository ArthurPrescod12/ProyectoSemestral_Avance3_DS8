"use strict";

const $ = id => document.getElementById(id);
const ESTACION = "ESP32_ESTACION_01";
const CAMPOS = ["dispositivo_id", "gas_adc", "temperatura_c", "humedad_pct",
  "clasificacion", "alarma_activa", "umbral_gas"];
const RIESGOS = ["NORMAL", "ADVERTENCIA", "PELIGRO"];
const ESTADOS = ["ONLINE", "SIN_DATOS", "OFFLINE"];
const FORMATO_HORA = new Intl.DateTimeFormat("es-PA", {
  hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, timeZone: "America/Panama"
});
const FORMATO_NUM = new Intl.NumberFormat("es-PA", { maximumFractionDigits: 1 });
const SENSORES = {
  gas_adc: { nombre: "Gas simulado", unidad: "ADC", min: 0, max: 4095, umbral: r => r.umbral_gas },
  temperatura_c: { nombre: "Temperatura", unidad: "°C", min: 20, max: 45, umbral: () => 40 },
  humedad_pct: { nombre: "Humedad", unidad: "%", min: 0, max: 100 }
};
const ACTIVIDAD = [
  ["Orden válida", "umbral_gas = 2200", "Aplicada por el ESP32. La lectura de 2402 ADC pasó a PELIGRO."],
  ["Orden inválida", "umbral_gas = 9999", "Rechazada en Wokwi. El umbral siguió en 2200."],
  ["Orden de pausa", "publicar = false / true", "El monitor registró SIN_DATOS y luego ONLINE."],
  ["Validación del receptor", "Cinco mensajes inválidos", "JSON ilegible, campo ausente, ADC fuera de rango, estado del buzzer incoherente y temperatura enviada como texto."]
];

const panel = {
  modo: "prueba", lecturas: [], eventos: [], actividad: [], descartes: 0, pagina: "resumen",
  sensor: "gas_adc", prefijo: "", cliente: null, enlace: false, presencia: null, ultimoMs: null,
  esperando: false, estadoActual: "", textoEnlace: ""
};

function csv(texto) {
  const filas = [];
  let fila = [], valor = "", citado = false;
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i];
    if (citado) {
      if (c === '"' && texto[i + 1] === '"') { valor += '"'; i++; }
      else if (c === '"') citado = false;
      else valor += c;
    } else if (c === '"' && !valor) citado = true;
    else if (c === ",") { fila.push(valor); valor = ""; }
    else if (c === "\r" || c === "\n") {
      if (c === "\r" && texto[i + 1] === "\n") i++;
      fila.push(valor);
      if (fila.some(Boolean)) filas.push(fila);
      fila = [];
      valor = "";
    } else valor += c;
  }
  if (citado) throw Error("El CSV tiene un campo entre comillas sin cerrar.");
  fila.push(valor);
  if (fila.some(Boolean)) filas.push(fila);
  const columnas = filas.shift()?.map(c => c.replace(/^\uFEFF/, "").trim()) ?? [];
  return { columnas, filas };
}

function campoNumerico(valor) {
  return typeof valor === "string" && valor.trim() ? Number(valor) : NaN;
}

function campoBooleano(valor) {
  const v = valor?.toLowerCase();
  return v === "true" ? true : v === "false" ? false : valor ? valor : undefined;
}

function validar(d) {
  if (!d || typeof d !== "object" || CAMPOS.some(c => !(c in d))) throw Error("Faltan campos de telemetría.");
  if (d.dispositivo_id !== ESTACION) throw Error("Identificador de estación desconocido.");
  const { gas_adc: gas, temperatura_c: temp, humedad_pct: humedad, umbral_gas: umbral } = d;
  if (!Number.isInteger(gas) || gas < 0 || gas > 4095) throw Error("Gas ADC fuera de 0–4095.");
  if (!Number.isFinite(temp) || temp < -40 || temp > 80) throw Error("Temperatura fuera de −40 a 80 °C.");
  if (!Number.isFinite(humedad) || humedad < 0 || humedad > 100) throw Error("Humedad fuera de 0–100 %.");
  if (!Number.isInteger(umbral) || umbral < 1501 || umbral > 4095) throw Error("Umbral fuera de 1501–4095 ADC.");
  const peligro = gas >= umbral || temp >= 40;
  const clase = peligro ? "PELIGRO" : gas >= 1500 || temp >= 32 ? "ADVERTENCIA" : "NORMAL";
  if (d.clasificacion !== clase || d.alarma_activa !== peligro) throw Error("Clasificación o alarma incoherente.");
  if ("buzzer_silenciado" in d && (typeof d.buzzer_silenciado !== "boolean" || (d.buzzer_silenciado && !peligro))) {
    throw Error("Estado del buzzer incoherente.");
  }
  return d;
}

function normalizarFecha(fecha) {
  const d = new Date(fecha);
  if (!fecha || !Number.isFinite(d.valueOf())) throw Error("Fecha de registro inválida.");
  return d.toISOString();
}

function objetosCsv(texto, campos) {
  const { columnas, filas } = csv(texto);
  if (new Set(columnas).size !== columnas.length || campos.some(c => !columnas.includes(c))) {
    throw Error("El encabezado no coincide con el CSV del receptor.");
  }
  return filas.map((f, i) => {
    if (f.length !== columnas.length) throw Error("Cantidad de columnas inválida en el registro " + (i + 1) + ".");
    return Object.fromEntries(columnas.map((c, j) => [c, f[j]]));
  });
}

function leerLecturas(texto) {
  return objetosCsv(texto, ["fecha_recepcion", ...CAMPOS]).map(r => {
    const d = { fecha_recepcion: normalizarFecha(r.fecha_recepcion), dispositivo_id: r.dispositivo_id,
      gas_adc: campoNumerico(r.gas_adc), temperatura_c: campoNumerico(r.temperatura_c),
      humedad_pct: campoNumerico(r.humedad_pct), clasificacion: r.clasificacion,
      alarma_activa: campoBooleano(r.alarma_activa), umbral_gas: campoNumerico(r.umbral_gas) };
    const b = campoBooleano(r.buzzer_silenciado);
    if (b !== undefined) d.buzzer_silenciado = b;
    return validar(d);
  }).sort((a,b) => a.fecha_recepcion.localeCompare(b.fecha_recepcion));
}

function leerEventos(texto) {
  return objetosCsv(texto, ["fecha", "tipo", "gravedad", "detalle"]).map(e => {
    if (!ESTADOS.includes(e.tipo)) throw Error("El CSV contiene un estado de comunicación desconocido.");
    return { ...e, fecha: normalizarFecha(e.fecha) };
  }).sort((a,b) => a.fecha.localeCompare(b.fecha));
}

function texto(id, valor) { $(id).textContent = valor; }
function hora(fecha) { return fecha ? FORMATO_HORA.format(new Date(fecha)) : "—"; }
function fechaPanama(fecha) {
  const d = new Date(fecha);
  return d.toLocaleDateString("en-CA", { timeZone: "America/Panama" }) + "T" + hora(fecha) + "-05:00";
}
function numero(valor) { return Number.isFinite(valor) ? FORMATO_NUM.format(valor) : "—"; }
function claseEstado(e) { return [...ESTADOS, ...RIESGOS].includes(e) ? e.toLowerCase() : ""; }
function insignia(e) {
  const s = document.createElement("span");
  s.className = "pill " + claseEstado(e);
  s.textContent = e || "—";
  return s;
}
function buzzer(r) {
  if (!r || r.buzzer_silenciado === undefined) return "Sin dato";
  if (r.buzzer_silenciado) return "Silenciado";
  return r.alarma_activa ? "Habilitado" : "En reposo";
}

function llenar(id, filas, vacio, columnas) {
  const tbody = $(id);
  const frag = document.createDocumentFragment();
  for (const celdas of filas) {
    const tr = document.createElement("tr");
    for (const contenido of celdas) {
      const td = document.createElement("td");
      if (contenido instanceof Node) td.append(contenido);
      else td.textContent = contenido;
      tr.append(td);
    }
    frag.append(tr);
  }
  if (!filas.length) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = columnas;
    td.textContent = vacio;
    tr.append(td);
    frag.append(tr);
  }
  tbody.replaceChildren(frag);
}

function mostrarRegistros() {
  const riesgo = $("filtro-lecturas").value;
  const estado = $("filtro-eventos").value;
  const l = panel.lecturas.filter(r => !riesgo || riesgo === r.clasificacion).reverse();
  const e = panel.eventos.filter(r => !estado || estado === r.tipo).reverse();
  texto("lecturas-count", l.length + (l.length === 1 ? " lectura" : " lecturas") + (l.length > 250 ? " · últimas 250 visibles" : ""));
  texto("eventos-count", e.length + (e.length === 1 ? " evento" : " eventos") + (e.length > 250 ? " · últimos 250 visibles" : ""));
  llenar("tabla-lecturas", l.slice(0,250).map(r => [hora(r.fecha_recepcion), numero(r.gas_adc),
    numero(r.temperatura_c) + " °C", numero(r.humedad_pct) + " %", insignia(r.clasificacion),
    numero(r.umbral_gas), buzzer(r)]), "Sin lecturas para este filtro.", 7);
  llenar("tabla-eventos", e.slice(0,250).map(r => [hora(r.fecha), insignia(r.tipo), r.gravedad, r.detalle]),
    "Sin eventos para este filtro.", 4);
  llenar("tabla-actividad", panel.actividad.slice(0,100), "Sin actividad disponible para esta fuente.", 3);
  texto("actividad-fuente", panel.modo === "prueba" ? "Resultados observados en las pruebas." :
    panel.modo === "vivo" ? "Órdenes observadas en el broker y descartes del panel." : "Los CSV de Python no incluyen el registro de órdenes.");
}

function dibujar() {
  const sensor = SENSORES[panel.sensor];
  const limite = Number($("rango").value);
  const filas = panel.lecturas.slice(-Math.min(limite || 240, 240));
  const contenedor = $("chart");
  texto("chart-sub", filas.length ? filas.length + " lecturas · hora de Panamá" : "Lecturas registradas en el tiempo");
  texto("chart-legend", sensor.nombre + " · " + sensor.unidad);
  $("leyenda-umbral").hidden = !sensor.umbral;
  if (!filas.length) {
    contenedor.innerHTML = '<p class="chart-empty">Todavía no hay lecturas en esta fuente.</p>';
    return;
  }
  const w = 640, h = 238, x0 = 42, x1 = 614, y0 = 13, y1 = 201;
  const valores = filas.map(r => r[panel.sensor]);
  const tiempos = filas.map(r => Date.parse(r.fecha_recepcion));
  const min = Math.min(sensor.min, ...valores), max = Math.max(sensor.max, ...valores);
  const t0 = tiempos[0], t1 = tiempos.at(-1);
  const x = t => x0 + (t1 === t0 ? .5 : (t - t0) / (t1 - t0)) * (x1 - x0);
  const y = v => y1 - (v - min) / (max - min) * (y1 - y0);
  const grid = Array.from({length:5}, (_,i) => {
    const v = min + i * (max - min) / 4, a = y(v);
    return '<line class="grid" x1="' + x0 + '" x2="' + x1 + '" y1="' + a + '" y2="' + a +
      '"/><text x="34" y="' + (a+4) + '" text-anchor="end">' + Math.round(v) + '</text>';
  }).join("");
  const ticks = [0,.25,.5,.75,1].map((f,i) => {
    if (t0 === t1 && i !== 2) return "";
    const t = t0 + f * (t1 - t0);
    return '<text x="' + x(t) + '" y="222" text-anchor="middle">' + hora(t) + '</text>';
  }).join("");
  const trayectoria = fn => filas.map((r,i) =>
    (i === 0 || tiempos[i] - tiempos[i-1] > 12000 ? "M" : "L") + x(tiempos[i]).toFixed(2) + "," + y(fn(r)).toFixed(2)
  ).join(" ");
  const base = sensor.umbral ? '<path class="critical" d="' + trayectoria(sensor.umbral) + '"/>' : "";
  const puntos = filas.map((r,i) => {
    if (i === filas.length - 1 || tiempos[i+1] - tiempos[i] > 12000 || i === 0) {
      return '<circle fill="#69e3ce" r="2.5" cx="' + x(tiempos[i]) + '" cy="' + y(r[panel.sensor]) + '"/>';
    }
    return "";
  }).join("");
  contenedor.innerHTML = '<svg tabindex="0" role="img" aria-label="Gráfico de ' + sensor.nombre +
    '. Usa las flechas para recorrer las lecturas." viewBox="0 0 ' + w + ' ' + h +
    '">' + grid + ticks + base + '<path class="series" d="' + trayectoria(r => r[panel.sensor]) +
    '"/>' + puntos + '<circle class="selected" r="5" visibility="hidden"/><title></title></svg>';
  const svg = contenedor.firstElementChild;
  const seleccionado = svg.querySelector(".selected");
  let cursor = filas.length - 1;
  const detalle = i => {
    cursor = i;
    seleccionado.setAttribute("cx", x(tiempos[i]));
    seleccionado.setAttribute("cy", y(valores[i]));
    seleccionado.setAttribute("visibility","visible");
    const resumen = hora(tiempos[i]) + " · " + numero(valores[i]) + " " + sensor.unidad;
    svg.querySelector("title").textContent = resumen;
    texto("chart-sub", resumen);
  };
  svg.addEventListener("pointermove", e => {
    const rect = svg.getBoundingClientRect();
    const px = (e.clientX - rect.left) * w / rect.width;
    detalle(tiempos.reduce((prev,t,i) => Math.abs(x(t)-px) < Math.abs(x(tiempos[prev])-px) ? i : prev, 0));
  });
  svg.addEventListener("keydown", e => {
    if (!["ArrowLeft","ArrowRight"].includes(e.key)) return;
    e.preventDefault();
    detalle(Math.min(filas.length - 1, Math.max(0,cursor + (e.key === "ArrowLeft" ? -1 : 1))));
  });
}

function render() {
  const r = panel.lecturas.at(-1);
  const e = panel.eventos.at(-1);
  const vivo = panel.modo === "vivo";
  const historico = panel.modo === "prueba";
  const nombre = historico ? "PRUEBA REGISTRADA" : vivo ? "MQTT EN VIVO" : "CSV IMPORTADO";
  texto("fuente", nombre);
  $("fuente").classList.toggle("live", vivo);
  texto("fuente-detalle", historico ? "10 nov 2026 · Panamá" : vivo ? panel.prefijo : "Archivos del receptor Python");
  texto("actualizacion", r ? "Última lectura · " + hora(r.fecha_recepcion) : vivo ? panel.textoEnlace : "");
  texto("registros-fuente", nombre + " · hora de Panamá");
  texto("gas", numero(r?.gas_adc));
  texto("temperatura", numero(r?.temperatura_c));
  texto("humedad", numero(r?.humedad_pct));
  texto("umbral", "Umbral crítico " + numero(r?.umbral_gas) + " ADC");
  texto("alarma", r?.clasificacion || "—");
  $("alarma").className = "metric-value state-value " + claseEstado(r?.clasificacion);
  texto("buzzer", "Buzzer · " + buzzer(r));
  const estado = vivo ? panel.enlace ? panel.estadoActual : "" : e?.tipo;
  $("estado").className = "pill " + claseEstado(estado);
  texto("estado", estado || (vivo && !panel.enlace ? "SIN ENLACE" : "SIN ESTADO"));
  texto("estado-hora", estado && e ? hora(e.fecha) : "");
  texto("comunicacion-caption", vivo ? "Estado observado por el panel" : "Último estado registrado");
  texto("estado-nota", vivo && (!panel.enlace || !estado) ? panel.textoEnlace :
    ({ ONLINE: "Llegan lecturas válidas.", SIN_DATOS: "Conectado al broker sin telemetría.", OFFLINE: "El broker informó el testamento." }[estado] || "Carga el CSV de eventos para consultar el estado."));
  const items = panel.eventos.slice(-4).reverse().map(item => {
    const li = document.createElement("li");
    const time = document.createElement("time");
    time.dateTime = item.fecha;
    time.textContent = hora(item.fecha);
    li.append(insignia(item.tipo), time);
    return li;
  });
  if (!items.length) {
    const li = document.createElement("li");
    li.textContent = "Sin transiciones registradas.";
    items.push(li);
  }
  $("timeline").replaceChildren(...items);
  texto("total-lecturas", panel.lecturas.length);
  texto("total-eventos", panel.eventos.length);
  texto("total-descartes", panel.descartes ?? "—");
  $("desconectar").hidden = !vivo || !panel.enlace;
  if (panel.pagina === "registros") mostrarRegistros();
  if (panel.pagina === "resumen") dibujar();
}

function cambiarModo(modo, lecturas, eventos, descartes, actividad) {
  Object.assign(panel, { modo, lecturas, eventos, descartes, actividad, enlace: false,
    estadoActual: "", presencia: null, ultimoMs: null });
  $("filtro-lecturas").value = "";
  $("filtro-eventos").value = "";
}

function cerrarCliente() {
  const c = panel.cliente;
  panel.cliente = null;
  if (c?.isConnected()) c.disconnect();
  panel.enlace = false;
}

function cargarPrueba() {
  cerrarCliente();
  const d = window.EVIDENCIA;
  cambiarModo("prueba", leerLecturas(d["historial_lecturas.csv"]),
    leerEventos(d["eventos_comunicacion.csv"]), d.descartes, ACTIVIDAD);
  render();
}

function registrarEstado(tipo, detalle) {
  if (panel.estadoActual === tipo) return;
  const anterior = panel.estadoActual || "INICIO";
  panel.estadoActual = tipo;
  if (panel.eventos.at(-1)?.tipo === tipo) return;
  panel.eventos.push({ fecha: new Date().toISOString(), tipo,
    gravedad: { ONLINE: "INFO", SIN_DATOS: "ADVERTENCIA", OFFLINE: "CRITICA" }[tipo],
    detalle: anterior + " → " + tipo + ". " + detalle });
}

function recibir(mensaje, prefijo) {
  const sufijo = mensaje.destinationName.slice(prefijo.length + 1);
  if (!["estado","telemetria","orden"].includes(sufijo)) return;
  try {
    if (mensaje.payloadBytes.byteLength > 1024) throw Error("Mensaje superior a 1024 bytes.");
    const d = JSON.parse(mensaje.payloadString);
    if (sufijo === "orden") {
      panel.actividad.unshift(["Orden observada", JSON.stringify(d), "La aplicación de la orden se comprueba en Wokwi."]);
    } else if (sufijo === "estado") {
      if (d?.dispositivo_id !== ESTACION || !["online","offline"].includes(d.estado)) throw Error("Presencia inválida.");
      if (d.estado === "offline") {
        panel.presencia = false;
        panel.ultimoMs = null;
        registrarEstado("OFFLINE", "El broker informó offline.");
      } else if (panel.presencia !== true) {
        panel.presencia = true;
        panel.ultimoMs = performance.now();
        panel.estadoActual = "";
        panel.textoEnlace = "El ESP32 publicó online. Esperando telemetría válida.";
      }
    } else {
      if (mensaje.retained) throw Error("Telemetría retenida.");
      const r = validar(d);
      panel.lecturas.push({ ...r, fecha_recepcion: new Date().toISOString() });
      panel.presencia = true;
      panel.ultimoMs = performance.now();
      registrarEstado("ONLINE", "Se recibió telemetría válida.");
    }
  } catch (error) {
    panel.descartes++;
    panel.actividad.unshift(["Mensaje descartado", "/" + sufijo, error.message]);
  }
  if (panel.actividad.length > 100) panel.actividad.length = 100;
  render();
}

function conectar(prefijo) {
  const Cliente = window.Paho?.Client || window.Paho?.MQTT?.Client;
  if (!Cliente) throw Error("El cliente WebSocket de MQTT no está disponible.");
  if (!/^utp\/ds8\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+$/.test(prefijo)) throw Error("Usa el formato utp/ds8/GRUPO/PROYECTO.");
  cerrarCliente();
  const id = "panel-iot-" + Math.random().toString(36).slice(2,13);
  const c = new Cliente("broker.hivemq.com", 8884, "/mqtt", id);
  const pendientes = [];
  panel.cliente = c;
  panel.esperando = true;
  $("conectar").disabled = true;
  texto("feedback","Conectando con HiveMQ…");
  const fallo = msg => {
    if (panel.cliente !== c) return;
    panel.esperando = false;
    cerrarCliente();
    $("conectar").disabled = false;
    texto("feedback",msg);
    if (panel.modo === "vivo") { panel.textoEnlace = msg; render(); }
  };
  c.onMessageArrived = m => {
    if (panel.cliente !== c) return;
    if (panel.enlace) recibir(m, prefijo);
    else if (pendientes.length < 25) pendientes.push(m);
  };
  c.onConnectionLost = () => fallo("Se perdió el enlace del panel con HiveMQ. Puedes volver a conectarlo.");
  try {
    c.connect({ useSSL: true, timeout: 8, cleanSession: true, mqttVersion: 4,
      onSuccess: () => {
        if (panel.cliente !== c) { c.disconnect(); return; }
        c.subscribe(prefijo + "/+", { qos: 1,
          onSuccess: () => {
            if (panel.cliente !== c) return;
            cambiarModo("vivo", [], [], 0, []);
            panel.prefijo = prefijo;
            panel.enlace = true;
            panel.esperando = false;
            panel.textoEnlace = "Suscripción activa. Esperando al ESP32.";
            $("conectar").disabled = false;
            texto("feedback","");
            $("modal-fuente").close();
            for (const mensaje of pendientes) recibir(mensaje, prefijo);
            pendientes.length = 0;
            render();
          },
          onFailure: () => fallo("HiveMQ rechazó la suscripción al prefijo.") });
      },
      onFailure: () => fallo("No se pudo conectar por WebSocket seguro. Puedes consultar la evidencia o importar tus CSV.") });
  } catch {
    fallo("El navegador no pudo iniciar la conexión MQTT.");
  }
}

function exportar(nombre, campos, filas) {
  const escapar = v => {
    let s = String(v ?? "");
    if (typeof v === "string" && /^\s*[=+@-]/.test(s)) s = "'" + s;
    return /[",\r\n]/.test(s) ? '"' + s.replaceAll('"','""') + '"' : s;
  };
  const contenido = [campos.join(","), ...filas.map(f => campos.map(k => escapar(f[k])).join(","))].join("\r\n");
  const url = URL.createObjectURL(new Blob([contenido], { type:"text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = nombre;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function navegar() {
  const solicitada = location.hash.slice(1);
  panel.pagina = solicitada === "registros" ? "registros" : "resumen";
  document.querySelectorAll(".page").forEach(s => s.hidden = s.id !== panel.pagina);
  document.querySelectorAll("[data-page]").forEach(a => {
    if (a.dataset.page === panel.pagina) a.setAttribute("aria-current","page");
    else a.removeAttribute("aria-current");
  });
  render();
  window.scrollTo(0, 0);
}

function cancelarEspera() {
  if (!panel.esperando) return;
  cerrarCliente();
  panel.esperando = false;
  $("conectar").disabled = false;
}

function iniciar() {
  cargarPrueba();
  navegar();
  window.addEventListener("hashchange", navegar);
  $("abrir-fuente").onclick = () => { texto("feedback",""); $("modal-fuente").showModal(); };
  $("cerrar-fuente").onclick = () => $("modal-fuente").close();
  $("modal-fuente").addEventListener("close", cancelarEspera);
  $("usar-prueba").onclick = () => { cancelarEspera(); cargarPrueba(); $("modal-fuente").close(); };
  $("form-csv").onsubmit = async e => {
    e.preventDefault();
    cancelarEspera();
    const lectura = $("archivo-lecturas").files[0], evento = $("archivo-eventos").files[0];
    try {
      if (!lectura || [lectura,evento].some(f => f && f.size > 2_000_000)) throw Error("Selecciona CSV de hasta 2 MB.");
      const l = leerLecturas(await lectura.text());
      const ev = evento ? leerEventos(await evento.text()) : [];
      cerrarCliente();
      cambiarModo("csv", l, ev, null, []);
      $("modal-fuente").close();
      render();
    } catch (error) { texto("feedback",error.message); }
  };
  $("form-mqtt").onsubmit = e => {
    e.preventDefault();
    try { conectar($("prefijo").value.trim()); }
    catch (error) { texto("feedback",error.message); }
  };
  $("desconectar").onclick = () => {
    cerrarCliente();
    panel.textoEnlace = "El panel se desconectó de HiveMQ.";
    texto("feedback",panel.textoEnlace);
    render();
  };
  document.querySelectorAll("[data-sensor]").forEach(b => b.onclick = () => {
    panel.sensor = b.dataset.sensor;
    document.querySelectorAll("[data-sensor]").forEach(c => c.setAttribute("aria-pressed",String(c === b)));
    dibujar();
  });
  $("rango").onchange = dibujar;
  $("filtro-lecturas").onchange = mostrarRegistros;
  $("filtro-eventos").onchange = mostrarRegistros;
  $("descargar-lecturas").onclick = () => exportar("historial_lecturas.csv",
    ["fecha_recepcion", ...CAMPOS, "buzzer_silenciado"],
    panel.lecturas.map(r => ({...r, fecha_recepcion: fechaPanama(r.fecha_recepcion)})));
  $("descargar-eventos").onclick = () => exportar("eventos_comunicacion.csv",
    ["fecha","tipo","gravedad","detalle"], panel.eventos.map(e => ({...e, fecha:fechaPanama(e.fecha)})));
  setInterval(() => {
    if (panel.modo === "vivo" && panel.enlace && panel.presencia === true &&
        panel.estadoActual !== "SIN_DATOS" && performance.now() - panel.ultimoMs >= 15000) {
      registrarEstado("SIN_DATOS","Pasaron 15 s sin telemetría válida.");
      render();
    }
  }, 500);
}

if (typeof document !== "undefined") iniciar();
