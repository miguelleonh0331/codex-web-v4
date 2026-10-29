'use strict';

const $ = (sel) => document.querySelector(sel);
let TOKEN = localStorage.getItem('v4token') || new URL(location.href).searchParams.get('token') || '';
let selected = null;
let agents = [];
let lastEventId = 0;
let editing = null;
let OPCIONES = null;
let NOMBRE_APP = 'codex-web-v4';
let ACCESO_SEGURO = null;   // direccion https de esta instalacion, si la hay

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { 'content-type': 'application/json', 'x-v4-token': TOKEN, ...(options.headers || {}) }
  });
  if (res.status === 401) { logout(); throw new Error('token invalido'); }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

function logout() {
  localStorage.removeItem('v4token');
  TOKEN = '';
  // Cuando el servidor no exige token, el documento ni siquiera trae pantalla de acceso.
  if (!$('#login')) return;
  $('#login').hidden = false;
  $('#app').hidden = true;
}

// ----------------------------------------------------------------- arranque

if ($('#login-form')) $('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  TOKEN = $('#token-input').value.trim();
  try {
    await api('/api/state');
    localStorage.setItem('v4token', TOKEN);
    start();
  } catch (err) {
    $('#login-error').textContent = 'Token invalido';
  }
});

async function boot() {
  // Si el documento no trae pantalla de acceso, el servidor no pide token.
  if (!$('#login')) return start();
  try {
    const h = await (await fetch('/api/health')).json();
    if (h && h.auth === false) return start();
  } catch { /* si health falla, caemos al flujo con token */ }

  if (!TOKEN) return;
  try { await api('/api/state'); localStorage.setItem('v4token', TOKEN); start(); }
  catch { logout(); }
}

function start() {
  $('#sonido').checked = sonidoActivo;
  $('#sonido-icono').textContent = sonidoActivo ? '🔔' : '🔕';
  if ($('#login')) $('#login').hidden = true;
  $('#app').hidden = false;
  if (history.replaceState) history.replaceState({}, '', location.pathname);
  setView(esMovil() ? 'agents' : 'agents');
  MATRIZ.iniciar();
  ajustarPistaEscribir();
  prepararPush();
  pintarVacioChat();
  refreshAll();
  setInterval(refreshAll, 2500);
  vigilarProveedor();
  setInterval(vigilarProveedor, 60000);
  vigilarVersion();
  setInterval(vigilarVersion, 30000);
}

// ----------------------------------------------------------------- datos

// Si un ciclo tarda mas de los 2,5 s del intervalo, el siguiente arrancaba
// encima y los dos pintaban lo mismo. Solo corre un ciclo a la vez.
let refrescando = false;
async function refreshAll() {
  if (refrescando) return;
  refrescando = true;
  try { await refreshAllInterno(); } finally { refrescando = false; }
}

async function refreshAllInterno() {
  try {
    const state = await api('/api/state');
    agents = state.agents;
    detectarFinales(agents);
    if (selected) marcarVisto(selected);
    renderAgents();
    $('#status-line').textContent = `${agents.length} especialistas · ${state.running} en ejecucion · ${state.pending} en cola`;
    if (state.project && state.project.name) {
      $('#project-label').textContent = state.project.name;
    }
    if (state.app && state.app.acceso !== undefined && state.app.acceso !== ACCESO_SEGURO) {
      ACCESO_SEGURO = state.app.acceso;
      avisarOrigenInseguro();
    }
    if (state.app && state.app.nombre && state.app.nombre !== NOMBRE_APP) {
      NOMBRE_APP = state.app.nombre;
      if ($('#app-nombre-edit').hidden) $('#app-nombre').textContent = NOMBRE_APP;
    }
    if (state.opciones) {
      OPCIONES = state.opciones;
      const selEsf = document.querySelector('#agent-form [name=effort] option[value=""]');
      if (selEsf) selEsf.textContent = `por defecto (${OPCIONES.esfuerzoPorDefecto || 'el del CLI'})`;
    }
    await refrescarActividad(false);
    if (selected) {
      const act = agents.find((x) => x.id === selected);
      if (act) {
        $('#chat-face').innerHTML = avatar(act, 42);
        $('#chat-area').textContent = resumenAgente(act);
        $('#parar').hidden = act.status !== 'working';
      }
      await renderMessages();
    }
    await renderPanel();
  } catch (err) { /* reintenta en el siguiente ciclo */ }
}

/**
 * Mientras un especialista trabaja, su linea de area se convierte en una cinta
 * con sus propias palabras clave pasando. Son las suyas, no relleno: salen del
 * campo "area" del agente.
 */
function cintaTrabajando(a) {
  const palabras = String(a.area || '')
    .split(/[,;·]+/).map((x) => x.trim()).filter(Boolean);
  if (!palabras.length) palabras.push('trabajando');

  // Se repite la lista hasta que la cinta sea mas larga que la fila, para que
  // el bucle no muestre un hueco al volver al principio.
  const suficientes = [];
  while (suficientes.length < 14) suficientes.push(...palabras);

  const tramo = suficientes.map((w, i) =>
    `<span class="w${i % 3}">${escapeHtml(w)}</span>`).join('');

  return `<span class="cinta" aria-label="trabajando">
      <span class="fila">${tramo}${tramo}</span>
      <span class="hilo"></span>
    </span>`;
}

// ------------------------------------------------------- avisos y sonido

const VISTOS = 'v4-vistos';
let vistos = {};
try { vistos = JSON.parse(localStorage.getItem(VISTOS) || '{}'); } catch { vistos = {}; }
let sonidoActivo = localStorage.getItem('v4-sonido') !== '0';
let audio = null;

function guardarVistos() { localStorage.setItem(VISTOS, JSON.stringify(vistos)); }

function marcarVisto(id) {
  const a = agents.find((x) => x.id === id);
  if (a && a.ultimo_mensaje) { vistos[id] = a.ultimo_mensaje.id; guardarVistos(); }
}

function tienePendiente(a) {
  if (!a.ultimo_mensaje) return false;
  if (a.ultimo_mensaje.rol === 'user') return false;   // lo ultimo lo escribiste tu
  return a.ultimo_mensaje.id > (vistos[a.id] || 0);
}

/**
 * Dos notas cortas, sintetizadas al vuelo: no hace falta ningun archivo de
 * sonido y por tanto tampoco una descarga ni un permiso extra.
 */
function sonar(tipo = 'fin') {
  if (!sonidoActivo) return;
  try {
    audio = audio || new (window.AudioContext || window.webkitAudioContext)();
    if (audio.state === 'suspended') audio.resume();
    const notas = tipo === 'error' ? [392, 294] : [660, 880];
    notas.forEach((hz, i) => {
      const osc = audio.createOscillator();
      const vol = audio.createGain();
      osc.type = 'sine';
      osc.frequency.value = hz;
      const t0 = audio.currentTime + i * 0.13;
      vol.gain.setValueAtTime(0.0001, t0);
      vol.gain.exponentialRampToValueAtTime(0.16, t0 + 0.02);
      vol.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.26);
      osc.connect(vol); vol.connect(audio.destination);
      osc.start(t0); osc.stop(t0 + 0.3);
    });
  } catch { /* si el navegador no deja sonar, el aviso visual sigue */ }
}

$('#sonido').addEventListener('change', (e) => {
  sonidoActivo = e.target.checked;
  localStorage.setItem('v4-sonido', sonidoActivo ? '1' : '0');
  $('#sonido-icono').textContent = sonidoActivo ? '🔔' : '🔕';
  if (sonidoActivo) sonar();          // confirma que se oye y desbloquea el audio
});

/** Compara el estado nuevo con el anterior y avisa de lo que acaba de terminar. */
let ultimoEstado = new Map();
function detectarFinales(lista) {
  let huboFinal = false;
  let huboError = false;
  for (const a of lista) {
    const previo = ultimoEstado.get(a.id);
    const idUlt = a.ultimo_mensaje ? a.ultimo_mensaje.id : 0;
    if (previo !== undefined && idUlt > previo.id && a.ultimo_mensaje) {
      if (a.ultimo_mensaje.rol === 'assistant' || a.ultimo_mensaje.rol === 'peer') huboFinal = true;
      if (a.ultimo_mensaje.rol === 'system') huboError = true;
    }
    ultimoEstado.set(a.id, { id: idUlt, estado: a.status });
  }
  if (huboError) sonar('error');
  else if (huboFinal) sonar('fin');

  const pendientes = lista.filter(tienePendiente).length;
  document.title = pendientes ? `(${pendientes}) ${NOMBRE_APP}` : NOMBRE_APP;
}

function renderAgents() {
  const box = $('#agent-list');
  box.innerHTML = '';
  for (const a of agents) {
    const el = document.createElement('div');
    const pendiente = tienePendiente(a) && selected !== a.id;
    el.className = 'agent' + (selected === a.id ? ' sel' : '') + (pendiente ? ' pendiente' : '');
    el.innerHTML = `${avatar(a, 36)}
      <span class="txt">
        <span class="n"><i class="pill ${a.status}"></i>${escapeHtml(a.name)}</span>
        ${a.status === 'working'
          ? cintaTrabajando(a)
          : `<span class="a">${escapeHtml(a.area || 'sin area')}</span>`}
        ${a.contexto ? `<span class="ctx ${a.contexto.pct >= 90 ? 'alto' : a.contexto.pct >= 70 ? 'medio' : ''}"
             title="contexto ${a.contexto.usado.toLocaleString()} / ${a.contexto.ventana.toLocaleString()} (${a.contexto.pct}%)"><i style="width:${a.contexto.pct}%"></i></span>` : ''}
        ${(a.model || a.effort) ? `<span class="meta">
           ${a.model ? `<span class="tag">${escapeHtml(a.model)}</span>` : ''}
           ${a.effort ? `<span class="tag">${escapeHtml(a.effort)}</span>` : ''}</span>` : ''}
      </span>`;
    if (pendiente) {
      const b = document.createElement('span');
      b.className = 'aviso';
      b.textContent = '!';
      b.title = 'Hay respuesta sin revisar';
      el.appendChild(b);
    }
    el.onclick = () => selectAgent(a.id);
    box.appendChild(el);
  }
}

async function selectAgent(id) {
  selected = id;
  const a = agents.find((x) => x.id === id);
  $('#chat-name').textContent = a ? a.name : '';
  $('#chat-area').textContent = a ? resumenAgente(a) : '';
  $('#chat-face').innerHTML = a ? avatar(a, 42) : '';
  $('#send-form').hidden = false;
  $('#edit-agent').hidden = false;
  $('#reset-session').hidden = false;
  $('#compactar').hidden = false;
  $('#parar').hidden = !a || a.status !== 'working';
  await refrescarActividad(true);
  marcarVisto(id);
  renderAgents();
  setView('chat');
  setTimeout(() => MATRIZ.remedir(), 50);   // el lienzo cambia de tamano al abrir el chat
  await renderMessages(true);
}

function resumenAgente(a) {
  const trozos = [a.area, a.model, a.effort].filter(Boolean);
  if (a.contexto) {
    const miles = (n) => n >= 1000 ? `${(n / 1000).toFixed(n >= 100000 ? 0 : 1)}k` : String(n);
    trozos.push(`contexto ${miles(a.contexto.usado)} / ${miles(a.contexto.ventana)} · ${a.contexto.pct}%`);
  }
  return trozos.join(' · ');
}

// ------------------------------------------------------------ actividad

let actividadDesde = 0;
let agenteActividad = null;   // de quien es lo que hay pintado ahora

function pestanaActiva() {
  const t = document.querySelector('.tab.active');
  return t ? t.dataset.tab : 'mailbox';
}

// Dos ciclos solapados (el refresco cada 2,5 s y el clic en la pestana) pedian
// la actividad con el mismo "desde" y cada uno pintaba el mismo bloque: la
// salida salia duplicada. El candado impide el solape y el conjunto de ids
// vistos impide repetir una linea aunque llegue dos veces.
let actividadEnVuelo = false;
const actividadVistos = new Set();

async function refrescarActividad(reiniciar) {
  if (pestanaActiva() !== 'salida') return;
  if (actividadEnVuelo && !reiniciar) return;
  const caja = $('#tab-salida');
  if (!selected) {
    caja.innerHTML = '<p class="muted" style="font-size:.78rem">Elige un especialista para ver lo que ejecuta.</p>';
    return;
  }
  // Al cambiar de especialista se empieza de cero, o se mezclarian salidas.
  if (reiniciar || agenteActividad !== selected) {
    actividadDesde = 0;
    agenteActividad = selected;
    actividadVistos.clear();
    caja.innerHTML = '';
  }
  actividadEnVuelo = true;
  try {
    const { actividad } = await api(`/api/agents/${selected}/activity?desde=${actividadDesde}`);
    if (!actividad.length) {
      if (!caja.children.length) {
        caja.innerHTML = '<div class="vacia">Sin salida todavia. Aparecera aqui en cuanto el especialista use una herramienta.</div>';
      }
      return;
    }
    const vacia = caja.querySelector('.vacia');
    if (vacia) vacia.remove();
    const abajo = caja.scrollHeight - caja.scrollTop - caja.clientHeight < 40;
    for (const a of actividad) {
      actividadDesde = Math.max(actividadDesde, a.id);
      if (actividadVistos.has(a.id)) continue;
      actividadVistos.add(a.id);
      const el = document.createElement('div');
      el.className = 'act';
      el.innerHTML = `<span class="herr">${escapeHtml(a.herramienta || a.tipo)}</span>
        <span class="res" title="pulsa para ver el detalle">${escapeHtml(a.resumen || '')}</span>`;
      const res = el.querySelector('.res');
      res.onclick = () => {
        res.classList.toggle('abierto');
        res.textContent = res.classList.contains('abierto') ? (a.detalle || a.resumen || '') : (a.resumen || '');
      };
      caja.appendChild(el);
    }
    if (abajo) caja.scrollTop = caja.scrollHeight;
  } catch { /* se reintenta en el siguiente ciclo */ }
  finally { actividadEnVuelo = false; }
}

function pintarVacioChat() {
  $('#messages').innerHTML = `
    <div class="vacio-chat">
      <p>No hay ningun especialista abierto.</p>
      <button type="button" id="ir-a-especialistas">Ver especialistas</button>
    </div>`;
  const b = $('#ir-a-especialistas');
  if (b) b.onclick = () => setView('agents');
}

function roleLabel(m) {
  if (m.role === 'user') return 'tu';
  if (m.role === 'assistant') return 'especialista';
  if (m.role === 'peer') return `mensaje de ${m.meta && m.meta.from ? m.meta.from : 'otro agente'}`;
  return 'sistema';
}

let lastMsgCount = 0;
async function renderMessages(force) {
  if (!selected) return;
  const { messages } = await api(`/api/agents/${selected}/messages`);
  if (!force && messages.length === lastMsgCount) return;
  lastMsgCount = messages.length;
  const box = $('#messages');
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  box.innerHTML = '';
  const actual = agents.find((x) => x.id === selected);

  for (const m of messages) {
    const el = document.createElement('div');
    el.className = `msg ${m.role}`;

    // Quien habla y de que color: el especialista usa el suyo, para poder
    // seguir una conversacion de tres sin leer los nombres.
    let quien = 'tu';
    let color = '#2bd4a0';

    if (m.role === 'assistant' && actual) {
      quien = actual.name;
      color = colorDe(actual.avatar_seed || actual.id, actual.avatar_color);
    } else if (m.role === 'peer') {
      const de = (m.meta && m.meta.from) || 'otro agente';
      const emisor = agents.find((x) => x.name === de);
      quien = de;
      color = emisor ? colorDe(emisor.avatar_seed || emisor.id, emisor.avatar_color) : '#b98cff';
    } else if (m.role === 'system') {
      quien = 'sistema';
      color = '#ffb020';
    }

    const adj = (m.meta && m.meta.attachments) || [];

    // Una sola linea: "nombre > texto". El color ya dice quien habla, asi que
    // no hace falta ningun simbolo delante, y el texto no se parte en dos.
    // El texto va dentro de un bloque propio: la franja de color ocupa toda la
    // fila, pero lo escrito mantiene un ancho legible.
    el.innerHTML = `<span class="linea">` +
      `<span class="quien" style="color:${color}">${escapeHtml(quien)}</span>` +
      `<span class="sep">&gt;</span>` +
      `<span class="dicho">${formatearCuerpo(m.body)}</span>` +
      `<span class="hora">${new Date(m.created_at).toLocaleTimeString()}</span>` +
      `<button type="button" class="copiar-msg" title="Copiar este mensaje">⧉</button>` +
      (adj.length ? `<span class="adjuntos">${adj.map((f) => `
        <a class="adj" href="${f.url}" target="_blank" rel="noopener">
          ${esImagen(f.nombre) ? `<img src="${f.url}" alt="">` : '<span>📄</span>'}
          <span class="nom">${escapeHtml(f.nombre)}</span>
          <span class="peso">${pesoLegible(f.bytes || 0)}</span>
        </a>`).join('')}</span>` : '') + `</span>`;
    el.style.setProperty('--color-quien', color);
    box.appendChild(el);
  }
  if (force || atBottom) box.scrollTop = box.scrollHeight;
}

async function renderPanel() {
  const active = pestanaActiva();
  if (active === 'salida') return refrescarActividad(false);

  if (active === 'mailbox') {
    const { mailbox } = await api('/api/mailbox?limit=60');
    avisarCorreo(mailbox.length);
    $('#tab-mailbox').innerHTML = mailbox.length
      ? mailbox.map((m) => `
        <div class="item ${m.status === 'blocked' ? 'blocked' : ''}">
          <div class="hdr"><span class="caritas">${caraDe(m.from_agent, m.from_name)}<span class="flow">${escapeHtml(m.from_name)} → ${escapeHtml(m.to_name)}</span>${caraDe(m.to_agent, m.to_name)}</span>
          <span>${m.status}</span></div>
          <div class="body">${escapeHtml(m.body)}</div>
          ${m.reason ? `<div class="hdr">${escapeHtml(m.reason)}</div>` : ''}
        </div>`).join('')
      : '<p class="muted">Todavia no hay mensajes entre especialistas.</p>';
  }

  if (active === 'claims') {
    const { claims } = await api('/api/claims');
    $('#tab-claims').innerHTML = claims.length
      ? claims.map((c) => `<div class="item"><div class="hdr"><span class="caritas">${caraDe(c.agent_id, c.agent_name)}<span class="flow">${escapeHtml(c.agent_name)}</span></span>
         <span>${new Date(c.created_at).toLocaleTimeString()}</span></div>
         <div class="body">${escapeHtml(c.path)}${c.note ? `\n${escapeHtml(c.note)}` : ''}</div></div>`).join('')
      : '<p class="muted">Ningun archivo reservado.</p>';
  }

  if (active === 'activity') {
    const { events } = await api('/api/events?since=0');
    $('#tab-activity').innerHTML = events.slice(0, 50).map((e) => `
      <div class="item"><div class="hdr"><span>${escapeHtml(e.kind)}</span>
      <span>${new Date(e.created_at).toLocaleTimeString()}</span></div>
      <div class="body">${escapeHtml(e.agent_name || '')}</div></div>`).join('');
  }
}

// Pantalla completa para el panel: la salida y los eventos del sistema se leen
// fatal en una columna de 320px. Escape devuelve el panel a su sitio.
const botonAncho = $('#panel-ancho');
if (botonAncho) {
  const anchoOn = () => document.body.classList.contains('panel-ancho');
  const ponerAncho = (v) => {
    document.body.classList.toggle('panel-ancho', v);
    botonAncho.textContent = v ? '\u2715' : '\u26f6';
    botonAncho.title = v ? 'Volver al panel lateral' : 'Ver a pantalla completa';
  };
  botonAncho.onclick = () => ponerAncho(!anchoOn());
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && anchoOn()) ponerAncho(false); });
}

document.querySelectorAll('.tab').forEach((t) => {
  t.onclick = () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
    t.classList.add('active');
    ['mailbox', 'salida', 'claims', 'activity'].forEach((n) => { $(`#tab-${n}`).hidden = n !== t.dataset.tab; });
    renderPanel();
  };
});

// ----------------------------------------------------------------- acciones

// ------------------------------------------------------------ menciones

let menOpciones = [];
let menIndice = 0;
let menInicio = -1;      // posicion del @ que se esta escribiendo

/** Nombres que el texto menciona de verdad, de mas largo a mas corto. */
function mencionesEn(texto) {
  return [...agents]
    .sort((a, b) => b.name.length - a.name.length)
    .filter((a) => a.id !== selected &&
      new RegExp(`@${a.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(texto));
}

function cerrarMenciones() {
  $('#menciones').hidden = true;
  menOpciones = [];
  menInicio = -1;
}

function pintarMenciones() {
  const caja = $('#menciones');
  if (!menOpciones.length) return cerrarMenciones();
  caja.innerHTML = menOpciones.map((a, i) => `
    <div class="op ${i === menIndice ? 'sel' : ''}" data-i="${i}">
      ${avatar(a, 26, 'normal')}
      <span><b>${escapeHtml(a.name)}</b><br><span class="a">${escapeHtml(a.area || '')}</span></span>
    </div>`).join('');
  caja.hidden = false;
  caja.querySelectorAll('.op').forEach((el) => {
    el.onmousedown = (e) => { e.preventDefault(); elegirMencion(Number(el.dataset.i)); };
  });
}

function elegirMencion(i) {
  const a = menOpciones[i];
  if (!a) return;
  const ta = $('#send-text');
  const antes = ta.value.slice(0, menInicio);
  const despues = ta.value.slice(ta.selectionStart);
  ta.value = `${antes}@${a.name} ${despues}`;
  const pos = (antes + '@' + a.name + ' ').length;
  ta.setSelectionRange(pos, pos);
  cerrarMenciones();
  ta.focus();
}

/** Se dispara al escribir: busca el @ mas cercano antes del cursor. */
function buscarMencion() {
  const ta = $('#send-text');
  const hasta = ta.value.slice(0, ta.selectionStart);
  const m = hasta.match(/@([^@\n]{0,40})$/);
  if (!m) return cerrarMenciones();

  menInicio = hasta.length - m[0].length;
  const filtro = m[1].toLowerCase();
  menOpciones = agents
    .filter((a) => a.id !== selected && a.name.toLowerCase().includes(filtro))
    .slice(0, 8);
  menIndice = 0;
  pintarMenciones();
}

$('#send-text').addEventListener('input', buscarMencion);
$('#send-text').addEventListener('blur', () => setTimeout(cerrarMenciones, 120));

// ------------------------------------------------------------- adjuntos

let adjuntos = [];   // {nombre, ruta, bytes, url, esImagen}

const esImagen = (n) => /\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i.test(n);
const pesoLegible = (b) => b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(0)} KB` : `${(b / 1048576).toFixed(1)} MB`;

function pintarAdjuntos() {
  const caja = $('#adjuntos-pendientes');
  caja.hidden = adjuntos.length === 0;
  caja.innerHTML = adjuntos.map((f, i) => `
    <div class="adj ${f.subiendo ? 'subiendo' : ''}">
      ${f.url && esImagen(f.nombre) ? `<img src="${f.url}" alt="">` : '<span>📄</span>'}
      <span class="nom">${escapeHtml(f.nombre)}</span>
      <span class="peso">${f.subiendo ? '…' : pesoLegible(f.bytes)}</span>
      <button type="button" class="quitar-adj" data-i="${i}" title="Quitar">×</button>
    </div>`).join('');
  caja.querySelectorAll('.quitar-adj').forEach((b) => {
    b.onclick = () => { adjuntos.splice(Number(b.dataset.i), 1); pintarAdjuntos(); };
  });
}

async function subir(archivos) {
  if (!selected) return;
  for (const file of archivos) {
    const pendiente = { nombre: file.name || 'captura.png', bytes: file.size, subiendo: true };
    adjuntos.push(pendiente);
    pintarAdjuntos();
    try {
      const res = await fetch(`/api/agents/${selected}/attachments`, {
        method: 'POST',
        headers: { 'x-v4-token': TOKEN, 'x-v4-filename': encodeURIComponent(pendiente.nombre) },
        body: file
      });
      const out = await res.json();
      if (!res.ok) throw new Error(out.error || 'no se pudo subir');
      Object.assign(pendiente, out, { subiendo: false });
    } catch (err) {
      adjuntos = adjuntos.filter((x) => x !== pendiente);
      alert(`No se pudo adjuntar ${pendiente.nombre}: ${err.message}`);
    }
    pintarAdjuntos();
  }
}

// pegar: lo habitual para una captura de pantalla
$('#send-text').addEventListener('paste', (e) => {
  const archivos = [...(e.clipboardData?.files || [])];
  if (archivos.length) { e.preventDefault(); subir(archivos); }
});

// arrastrar y soltar sobre el cuadro de escritura
const composer = $('#send-form');
['dragenter', 'dragover'].forEach((ev) => composer.addEventListener(ev, (e) => {
  e.preventDefault(); composer.classList.add('arrastrando');
}));
['dragleave', 'drop'].forEach((ev) => composer.addEventListener(ev, (e) => {
  e.preventDefault(); composer.classList.remove('arrastrando');
}));
composer.addEventListener('drop', (e) => {
  const archivos = [...(e.dataTransfer?.files || [])];
  if (archivos.length) subir(archivos);
});

$('#btn-adjuntar').onclick = () => $('#file-input').click();
$('#file-input').onchange = (e) => { subir([...e.target.files]); e.target.value = ''; };

$('#send-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = $('#send-text').value.trim();
  const listos = adjuntos.filter((f) => !f.subiendo);
  if ((!text && !listos.length) || !selected) return;
  if (adjuntos.some((f) => f.subiendo)) return alert('Espera a que terminen de subir los archivos.');

  // Un nombre mal escrito costaria un turno entero para acabar en "no existe".
  const sueltas = (text.match(/@[\w][\w .-]{0,30}/g) || [])
    .filter((tok) => !agents.some((a) => tok.toLowerCase().startsWith(`@${a.name.toLowerCase()}`)));
  if (sueltas.length && !confirm(
    `No reconozco ${sueltas.map((x) => `"${x.trim()}"`).join(', ')} como especialista.\n\n¿Enviar igualmente?`)) return;

  $('#send-text').value = '';
  cerrarMenciones();
  adjuntos = [];
  pintarAdjuntos();
  await api(`/api/agents/${selected}/messages`, {
    method: 'POST',
    body: JSON.stringify({ text, attachments: listos.map((f) => ({ nombre: f.nombre, ruta: f.ruta, url: f.url, bytes: f.bytes })) })
  });
  await renderMessages(true);
});

/**
 * En el movil Enter hace salto de linea (es lo que ofrece el teclado virtual)
 * y se envia con el boton, asi que el texto de ayuda no puede prometer lo
 * contrario. Se recalcula tambien al girar el telefono.
 */
function ajustarPistaEscribir() {
  const t = $('#send-text');
  if (!t) return;
  t.placeholder = esMovil()
    ? 'Escribe una tarea…  @ para mencionar · pulsa ➤ para enviar'
    : 'Escribe una tarea…  @ para mencionar · Enter envia · Mayus+Enter salta de linea';
}
window.addEventListener('resize', ajustarPistaEscribir);

$('#send-text').addEventListener('keydown', (e) => {
  // Con la lista de menciones abierta, las flechas y el Enter son suyos.
  if (!$('#menciones').hidden && menOpciones.length) {
    if (e.key === 'ArrowDown') { e.preventDefault(); menIndice = (menIndice + 1) % menOpciones.length; return pintarMenciones(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); menIndice = (menIndice - 1 + menOpciones.length) % menOpciones.length; return pintarMenciones(); }
    if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); return elegirMencion(menIndice); }
    if (e.key === 'Escape') { e.preventDefault(); return cerrarMenciones(); }
  }
  if (e.key !== 'Enter') return;
  // Enter envia; Mayus+Enter hace salto de linea. En movil manda el boton:
  // el Enter del teclado virtual es el salto de linea de toda la vida.
  if (e.shiftKey || e.isComposing) return;
  if (esMovil() && !(e.ctrlKey || e.metaKey)) return;
  e.preventDefault();
  $('#send-form').requestSubmit();
});

// ----------------------------------------------------------- proveedor

// Los limites se refrescan solos: guardamos el instante en que llegaron y
// descontamos en local, para que el reloj corra sin castigar al servidor.
let LIMITES = { datos: [], recibido: 0 };

function formatoReloj(seg) {
  if (seg === null || seg === undefined) return '—';
  if (seg <= 0) return 'ya';
  const h = Math.floor(seg / 3600), m = Math.floor((seg % 3600) / 60), s2 = seg % 60;
  if (seg >= 86400) { const d = Math.floor(seg / 86400); return `${d} d ${Math.floor((seg % 86400) / 3600)} h`; }
  return h ? `${h} h ${String(m).padStart(2, '0')} min` : `${m}:${String(s2).padStart(2, '0')}`;
}

function restante(l) {
  if (l.faltan_seg === null || l.faltan_seg === undefined) return null;
  return Math.max(0, l.faltan_seg - Math.floor((Date.now() - LIMITES.recibido) / 1000));
}

function pintarLimites() {
  const caja = $('#prov-limites');
  if (!caja) return;
  if (!LIMITES.datos.length) {
    caja.innerHTML = '<p class="muted" style="font-size:.78rem">Todavia no hay datos de uso. Llegan del propio Claude cuando un especialista trabaja.</p>';
    return;
  }
  caja.innerHTML = LIMITES.datos.map((l) => {
    const seg = restante(l);
    const pct = l.usado_pct;
    return `<div class="lim ${l.sobreuso ? 'sobreuso' : ''}">
      <div class="cab"><b>Ventana de ${escapeHtml(l.etiqueta)}</b>
        <span class="reloj">reinicia en ${formatoReloj(seg)}</span></div>
      ${pct === null
        ? '<div class="nota">Claude solo informa del porcentaje cuando te acercas al limite.</div>'
        : `<div class="barra ${pct >= 80 ? 'alto' : ''}"><i style="width:${Math.min(100, pct)}%"></i></div>
           <div class="nota">${pct}% consumido</div>`}
      <div class="nota">estado: ${escapeHtml(l.estado || '—')}${l.sobreuso ? ' · usando sobreconsumo' : ''}</div>
    </div>`;
  }).join('');
}

function pintarUsoMini() {
  const mini = $('#proveedor-uso');
  if (!mini) return;
  if (!LIMITES.datos.length) { mini.textContent = ''; return; }

  // Solo el tiempo que queda: poner "5h" junto a "3 h 26 min" se leia como dos
  // tiempos distintos. Que ventana es se ve al abrir el proveedor.
  const proxima = LIMITES.datos
    .filter((l) => restante(l) !== null)
    .sort((a, b) => restante(a) - restante(b))[0];
  if (!proxima) { mini.textContent = ''; return; }

  const pct = proxima.usado_pct;
  mini.textContent = `${pct !== null ? pct + '% · ' : ''}${formatoReloj(restante(proxima))} para reiniciar`;
  mini.title = `Ventana de ${proxima.etiqueta}`;
}

setInterval(() => { pintarUsoMini(); if ($('#proveedor-dialog').open) pintarLimites(); }, 1000);

async function pintarProveedor() {
  const caja = $('#proveedor-estado');
  try {
    const { proveedores } = await api('/api/providers');
    const p = proveedores[0];
    LIMITES = { datos: p.limites || [], recibido: Date.now() };
    pintarLimites();
    pintarUsoMini();
    const cad = p.credenciales && p.credenciales.expiraIso
      ? new Date(p.credenciales.expiraIso).toLocaleString() : '—';
    const vigente = p.credenciales && p.credenciales.vigente;

    caja.innerHTML = `
      <div class="fila"><span class="k">Proveedor</span><span>${NOMBRE_PROVEEDOR}</span></div>
      <div class="fila"><span class="k">Estado</span>
        <span class="${p.conectado && vigente ? 'bien' : 'mal'}">
          ${p.conectado ? (vigente ? 'conectado' : 'sesion caducada') : 'sin sesion'}</span></div>
      <div class="fila"><span class="k">Cuenta</span><span>${escapeHtml(p.cuenta || '—')}</span></div>
      <div class="fila"><span class="k">Plan</span><span>${escapeHtml(p.plan || '—')}</span></div>
      <div class="fila"><span class="k">Caduca</span><span>${escapeHtml(cad)}</span></div>
      <div class="fila"><span class="k">Sesion en</span><span style="font-size:.72rem">${escapeHtml(p.sessionDir || '')}</span></div>
      ${p.disponible ? '' : `<div class="fila mal">${escapeHtml(p.motivo || 'Claude Code no disponible')}</div>`}`;

    const boton = $('#btn-proveedor');
    const malo = !(p.conectado && vigente);
    boton.classList.toggle('aviso', malo);
    $('#proveedor-etiqueta').textContent = malo ? `${NOMBRE_PROVEEDOR} · sin sesion` : NOMBRE_PROVEEDOR;
    $('#prov-logout').hidden = !p.conectado;
  } catch (e) {
    caja.textContent = `No se pudo consultar el proveedor: ${e.message}`;
  }
}

$('#btn-proveedor').onclick = async () => {
  $('#prov-paso-url').hidden = true;
  $('#prov-acciones').hidden = false;
  $('#prov-error').textContent = '';
  $('#prov-codigo').value = '';
  $('#proveedor-dialog').showModal();
  await pintarProveedor();
};
$('#prov-cerrar').onclick = () => $('#proveedor-dialog').close();

$('#prov-login').onclick = async () => {
  $('#prov-login').disabled = true;
  $('#prov-login').textContent = 'Pidiendo enlace…';
  try {
    const out = await api('/api/providers/claude/login', { method: 'POST', body: JSON.stringify({}) });
    $('#prov-url').href = out.url;
    $('#prov-url').textContent = out.url;
    $('#prov-paso-url').hidden = false;
    $('#prov-acciones').hidden = true;
    $('#prov-codigo').focus();
  } catch (e) {
    $('#proveedor-estado').innerHTML += `<div class="fila mal">${escapeHtml(e.message)}</div>`;
  }
  $('#prov-login').disabled = false;
  $('#prov-login').textContent = 'Iniciar sesion';
};

$('#prov-confirmar').onclick = async () => {
  const codigo = $('#prov-codigo').value.trim();
  if (!codigo) return;
  $('#prov-error').textContent = '';
  $('#prov-confirmar').disabled = true;
  $('#prov-confirmar').textContent = 'Comprobando…';
  try {
    const out = await api('/api/providers/claude/code', { method: 'POST', body: JSON.stringify({ codigo }) });
    $('#prov-paso-url').hidden = true;
    $('#prov-acciones').hidden = false;
    await pintarProveedor();
    alert(`Sesion iniciada como ${out.cuenta || 'tu cuenta'}.`);
  } catch (e) {
    $('#prov-error').textContent = e.message;
  }
  $('#prov-confirmar').disabled = false;
  $('#prov-confirmar').textContent = 'Confirmar codigo';
};

$('#prov-cancelar').onclick = async () => {
  await api('/api/providers/claude/cancel', { method: 'POST' }).catch(() => {});
  $('#prov-paso-url').hidden = true;
  $('#prov-acciones').hidden = false;
};

$('#prov-logout').onclick = async () => {
  if (!confirm('Se cerrara la sesion y los especialistas dejaran de poder trabajar hasta que inicies otra. Continuar?')) return;
  await api('/api/providers/claude/logout', { method: 'POST' }).catch((e) => alert(e.message));
  await pintarProveedor();
};

// Aviso permanente en la barra lateral si la sesion no sirve.
async function vigilarVersion() {
  try {
    const h = await (await fetch('/api/health', { cache: 'no-store' })).json();
    if (window.V4_VERSION && h.ui && String(h.ui) !== String(window.V4_VERSION)) {
      $('#aviso-version').hidden = false;
    }
  } catch { /* se reintenta */ }
}
if ($('#recargar-ya')) $('#recargar-ya').onclick = async () => {
  // Una recarga normal puede seguir sirviendo lo cacheado: se limpia antes.
  try {
    if (window.caches) for (const k of await caches.keys()) await caches.delete(k);
    if (navigator.serviceWorker) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
    }
  } catch { /* da igual: recargamos igualmente */ }
  location.reload(true);
};

async function vigilarProveedor() {
  try {
    const { proveedores } = await api('/api/providers');
    const p = proveedores[0];
    LIMITES = { datos: p.limites || [], recibido: Date.now() };
    pintarUsoMini();
    const malo = !(p.conectado && p.credenciales && p.credenciales.vigente);
    $('#btn-proveedor').classList.toggle('aviso', malo);
    $('#proveedor-etiqueta').textContent = malo ? `${NOMBRE_PROVEEDOR} · sin sesion` : NOMBRE_PROVEEDOR;
  } catch { /* se reintenta */ }
}

// Renombrar la instalacion desde la propia barra: con varios servidores,
// saber en cual estas no deberia exigir editar un archivo por SSH.
// ------------------------------------------------------------- fondo matrix

/**
 * Lluvia de caracteres detras de la conversacion. Suave a proposito: si pelea
 * con el texto deja de ser ambiente y pasa a estorbar.
 *
 * Se detiene cuando la pestana no se ve, porque una animacion continua gasta
 * bateria sin que nadie la mire.
 */
const MATRIZ = (() => {
  const letras = 'アイウエオカキクケコサシスセソタチツテトナニヌネノ01'.split('');
  let cv, ctx, cols = [], ancho = 0, alto = 0, timer = null, encendido = true;

  function medir() {
    if (!cv) return;
    const r = cv.getBoundingClientRect();
    ancho = cv.width = Math.max(1, Math.floor(r.width));
    alto = cv.height = Math.max(1, Math.floor(r.height));
    const paso = 16;
    cols = new Array(Math.ceil(ancho / paso)).fill(0).map(() => Math.random() * -alto);
  }

  function pintar() {
    if (!ctx) return;
    // Un velo oscuro en vez de borrar: deja la estela que da la sensacion de caida.
    ctx.fillStyle = 'rgba(8,10,13,0.08)';
    ctx.fillRect(0, 0, ancho, alto);
    ctx.font = '13px ui-monospace, monospace';
    for (let i = 0; i < cols.length; i++) {
      const x = i * 16;
      const y = cols[i];
      ctx.fillStyle = Math.random() < 0.015 ? '#9ff5cf' : '#2bd4a0';
      ctx.fillText(letras[Math.floor(Math.random() * letras.length)], x, y);
      cols[i] = y > alto + Math.random() * 400 ? 0 : y + 16;
    }
  }

  function arrancar() {
    if (timer || !encendido || document.hidden) return;
    timer = setInterval(pintar, 110);
  }
  function parar() { clearInterval(timer); timer = null; }

  return {
    iniciar() {
      cv = document.getElementById('matrix');
      if (!cv) return;
      ctx = cv.getContext('2d');
      medir();
      window.addEventListener('resize', () => { medir(); });
      document.addEventListener('visibilitychange', () => (document.hidden ? parar() : arrancar()));
      encendido = localStorage.getItem('v4-matrix') !== '0';
      const casilla = document.getElementById('matrix-on');
      if (casilla) {
        casilla.checked = encendido;
        casilla.addEventListener('change', (e) => {
          encendido = e.target.checked;
          localStorage.setItem('v4-matrix', encendido ? '1' : '0');
          cv.style.display = encendido ? '' : 'none';
          encendido ? arrancar() : parar();
        });
      }
      cv.style.display = encendido ? '' : 'none';
      arrancar();
    },
    remedir: medir
  };
})();

// ------------------------------------------------- exportar e importar

$('#exportar').onclick = async () => {
  try {
    const datos = await api('/api/export');
    const blob = new Blob([JSON.stringify(datos, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    const sello = new Date().toISOString().slice(0, 10);
    a.download = `equipo-${(datos.instalacion || 'v4').replace(/[^\w.-]+/g, '-')}-${sello}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  } catch (e) { alert(`No se pudo exportar: ${e.message}`); }
};

$('#importar').onclick = () => $('#importar-archivo').click();

$('#importar-archivo').onchange = async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;

  let datos;
  try { datos = JSON.parse(await file.text()); }
  catch { return alert('Ese archivo no es un JSON valido.'); }

  try {
    // Primero un ensayo: nada se toca hasta que tu lo confirmes.
    const previa = await api('/api/import', { method: 'POST', body: JSON.stringify({ ...datos, dryRun: true }) });

    const lineas = [];
    lineas.push(`Nuevos: ${previa.nuevos.length}${previa.nuevos.length ? ` (${previa.nuevos.slice(0, 6).join(', ')}${previa.nuevos.length > 6 ? '…' : ''})` : ''}`);
    lineas.push(`Ya existen: ${previa.existentes.length}`);
    if (previa.invalidos.length) lineas.push(`Descartados por incompletos: ${previa.invalidos.join(', ')}`);

    const rutaOrigen = previa.proyecto_origen && previa.proyecto_origen.ruta;
    const rutaActual = previa.proyecto_actual && previa.proyecto_actual.ruta;
    if (rutaOrigen && rutaActual && rutaOrigen !== rutaActual) {
      lineas.push('');
      lineas.push('AVISO: el equipo venia de un proyecto en');
      lineas.push(`  ${rutaOrigen}`);
      lineas.push('y aqui el proyecto esta en');
      lineas.push(`  ${rutaActual}`);
      lineas.push('Sus instrucciones apuntaran a rutas que no existen hasta que las revises.');
    }

    let modo = 'saltar';
    if (previa.existentes.length) {
      modo = confirm(`${lineas.join('\n')}\n\n¿Actualizar tambien los ${previa.existentes.length} que ya existen?\n\nAceptar = actualizarlos · Cancelar = dejarlos como estan`)
        ? 'actualizar' : 'saltar';
    } else if (!confirm(`${lineas.join('\n')}\n\n¿Importar?`)) {
      return;
    }

    const out = await api('/api/import', { method: 'POST', body: JSON.stringify({ ...datos, modo, dryRun: false }) });
    await refreshAll();
    alert(`Importado.\n\nCreados: ${out.creados.length}\nActualizados: ${out.actualizados.length}\nSin tocar: ${out.saltados.length}` +
      (out.invalidos.length ? `\nDescartados: ${out.invalidos.length}` : ''));
  } catch (err) {
    alert(`No se pudo importar: ${err.message}`);
  }
};

$('#app-nombre').onclick = () => {
  const campo = $('#app-nombre-edit');
  campo.value = NOMBRE_APP;
  campo.hidden = false;
  $('#app-nombre').hidden = true;
  campo.focus();
  campo.select();
};

async function guardarNombreApp() {
  const campo = $('#app-nombre-edit');
  const nombre = campo.value.trim();
  campo.hidden = true;
  $('#app-nombre').hidden = false;
  if (!nombre || nombre === NOMBRE_APP) return;
  try {
    const out = await api('/api/app', { method: 'PATCH', body: JSON.stringify({ nombre }) });
    NOMBRE_APP = out.nombre;
    $('#app-nombre').textContent = NOMBRE_APP;
    document.title = NOMBRE_APP;
  } catch (e) {
    alert(`No se pudo renombrar: ${e.message}`);
  }
}

$('#app-nombre-edit').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); guardarNombreApp(); }
  if (e.key === 'Escape') { $('#app-nombre-edit').hidden = true; $('#app-nombre').hidden = false; }
});
$('#app-nombre-edit').addEventListener('blur', guardarNombreApp);

$('#new-agent').onclick = () => openDialog(null);

if ($('#ask-team')) $('#ask-team').onclick = () => {
  $('#broadcast-error').textContent = '';
  $('#broadcast-form').elements.text.value = '';
  $('#broadcast-dialog').showModal();
};
if ($('#broadcast-cancel')) $('#broadcast-cancel').onclick = () => $('#broadcast-dialog').close();

if ($('#broadcast-form')) $('#broadcast-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = e.target.elements.text.value.trim();
  if (!text) return;
  try {
    const out = await api('/api/broadcast', { method: 'POST', body: JSON.stringify({ text }) });
    $('#broadcast-dialog').close();
    await refreshAll();
    alert(`Preguntado a ${out.total} especialistas. Cada uno respondera en su conversacion.`);
  } catch (err) {
    $('#broadcast-error').textContent = err.message;
  }
});
$('#edit-agent').onclick = () => openDialog(agents.find((a) => a.id === selected));
$('#dialog-cancel').onclick = () => $('#agent-dialog').close();

$('#eliminar').onclick = async () => {
  if (!editing) return;
  const purgar = $('#eliminar-purgar').checked;
  const aviso = purgar
    ? `Se eliminara "${editing.name}" Y SU CONVERSACION ENTERA, sin vuelta atras.\n\n¿Seguro?`
    : `Se eliminara "${editing.name}" de la lista.\n\nSu conversacion se conserva en la base por si hiciera falta.\n\n¿Seguro?`;
  if (!confirm(aviso)) return;

  const b = $('#eliminar');
  b.disabled = true;
  const previo = b.textContent;
  b.textContent = 'Eliminando…';
  try {
    // Si estaba trabajando, primero se le para: borrarlo a media faena
    // dejaria un proceso suelto gastando cuota.
    await api(`/api/agents/${editing.id}/stop`, { method: 'POST' }).catch(() => {});
    await api(`/api/agents/${editing.id}${purgar ? '?purgar=1' : ''}`, { method: 'DELETE' });

    if (selected === editing.id) {
      selected = null;
      pintarVacioChat();
      $('#chat-name').textContent = 'Selecciona un especialista';
      $('#chat-area').textContent = '';
      $('#chat-face').innerHTML = '';
      ['send-form', 'edit-agent', 'reset-session', 'compactar', 'parar']
        .forEach((id) => { const el = $(`#${id}`); if (el) el.hidden = true; });
    }
    editing = null;
    $('#agent-dialog').close();
    await refreshAll();
  } catch (e) {
    $('#dialog-error').textContent = `No se pudo eliminar: ${e.message}`;
  }
  b.disabled = false;
  b.textContent = previo;
};

$('#parar').onclick = async () => {
  if (!selected) return;
  const b = $('#parar');
  b.disabled = true;
  try {
    const out = await api(`/api/agents/${selected}/stop`, { method: 'POST' });
    const partes = [];
    if (out.en_curso) partes.push(`${out.en_curso} turno en marcha`);
    if (out.en_cola) partes.push(`${out.en_cola} en cola`);
    if (!partes.length) partes.push('no habia nada que parar');
    $('#chat-area').textContent = `detenido: ${partes.join(' y ')}`;
    await refreshAll();
    await renderMessages(true);
  } catch (e) { alert(`No se pudo parar: ${e.message}`); }
  b.disabled = false;
};

$('#compactar').onclick = async () => {
  if (!selected) return;
  const b = $('#compactar');
  b.disabled = true;
  const previo = b.textContent;
  b.textContent = 'Compactando…';
  try {
    await api(`/api/agents/${selected}/compact`, { method: 'POST' });
    await refreshAll();
    await renderMessages(true);
  } catch (e) {
    alert(`No se pudo compactar: ${e.message}`);
  }
  b.disabled = false;
  b.textContent = previo;
};

$('#reset-session').onclick = async () => {
  if (!selected) return;
  await api(`/api/agents/${selected}/reset`, { method: 'POST' });
  alert('Contexto reiniciado: el proximo mensaje empieza una conversacion nueva.');
};

const NOMBRE_PROVEEDOR = 'Claudio';   // como se llama de cara al usuario
const COLORES = ['#5b9dff','#2bd4a0','#b98cff','#ffb020','#ff6b6b','#ff8fc7','#4fd1e8','#9ad14b','#c0893f','#8b93a7'];

function expresionDe(estado) {
  return estado === 'working' ? 'piensa' : 'normal';
}

/** Un unico punto para dibujar a un especialista, mire donde se mire. */
function avatar(a, tam, estado) {
  if (!a) return '';
  return robotSvg(a.avatar_seed || a.id, estado || expresionDe(a.status), tam, a.avatar_color || null);
}

function caraDe(id, nombre) {
  const a = agents.find((x) => x.id === id) || agents.find((x) => x.name === nombre);
  return a ? avatar(a, 22, 'normal') : robotSvg(id || nombre || '?', 'normal', 22);
}

let semillaActual = null;
let colorActual = null;

function pintarPreview() {
  $('#face-preview').innerHTML = robotSvg(semillaActual, 'normal', 74, colorActual);
  const d = listaDioses().find((x) => x.clave === String(semillaActual).toLowerCase());
  $('#avatar-nombre').textContent = d ? d.nombre : 'Propio';
  document.querySelectorAll('#galeria-avatares button').forEach((b) => {
    b.classList.toggle('sel', b.dataset.clave === semillaActual);
  });
  document.querySelectorAll('#colores button[data-color]').forEach((b) => {
    b.classList.toggle('sel', b.dataset.color === colorActual);
  });
  if ($('#color-libre')) $('#color-libre').value = colorActual || '#5b9dff';
}

function montarSelector() {
  const g = $('#galeria-avatares');
  if (g && !g.children.length) {
    g.innerHTML = listaDioses().map((d) =>
      `<button type="button" data-clave="${d.clave}" title="${d.nombre}">${robotSvg(d.clave, 'normal', 38)}</button>`).join('');
    g.querySelectorAll('button').forEach((b) => {
      b.onclick = () => { semillaActual = b.dataset.clave; pintarPreview(); };
    });
  }
  const c = $('#colores');
  if (c && !c.children.length) {
    c.innerHTML = COLORES.map((col) =>
      `<button type="button" data-color="${col}" style="background:${col}" title="${col}"></button>`).join('') +
      `<input type="color" id="color-libre" title="Color a medida">` +
      `<button type="button" class="quitar" id="color-quitar">por defecto</button>`;
    c.querySelectorAll('button[data-color]').forEach((b) => {
      b.onclick = () => { colorActual = b.dataset.color; pintarPreview(); };
    });
    $('#color-libre').oninput = (e) => { colorActual = e.target.value; pintarPreview(); };
    $('#color-quitar').onclick = () => { colorActual = null; pintarPreview(); };
  }
}

const OTRO = '__otro__';

/**
 * Rellena el selector de modelo. Antes era un campo con lista, y una lista
 * filtra por lo ya escrito: con "sonnet" dentro, el desplegable solo ofrecia
 * "sonnet" y no habia forma de cambiarlo sin vaciar el campo a mano.
 */
function montarModelos(actual) {
  const sel = $('#sel-modelo');
  if (!sel) return;
  const sugeridos = (OPCIONES && OPCIONES.modelos) || ['haiku', 'sonnet', 'opus', 'opusplan', 'fable'];
  const porDefecto = (OPCIONES && OPCIONES.modeloPorDefecto) || 'sonnet';

  const opciones = [`<option value="">por defecto (${escapeHtml(porDefecto)})</option>`]
    .concat(sugeridos.map((m) => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`));

  // Un modelo guardado que no este en la lista tambien debe poder verse.
  if (actual && !sugeridos.includes(actual)) {
    opciones.push(`<option value="${escapeHtml(actual)}">${escapeHtml(actual)}</option>`);
  }
  opciones.push(`<option value="${OTRO}">otro…</option>`);
  sel.innerHTML = opciones.join('');
  sel.value = actual || '';

  const otro = $('#modelo-otro');
  sel.onchange = () => {
    const libre = sel.value === OTRO;
    otro.hidden = !libre;
    if (libre) { otro.value = ''; otro.focus(); }
  };
  otro.hidden = true;
}

function openDialog(agent) {
  editing = agent || null;
  montarSelector();
  const dioses = listaDioses();
  semillaActual = agent ? (agent.avatar_seed || agent.id)
                        : dioses[Math.floor(Math.random() * dioses.length)].clave;
  colorActual = agent ? (agent.avatar_color || null) : null;
  pintarPreview();
  const c = $('#agent-form').elements;
  $('#dialog-title').textContent = agent ? `Editar ${agent.name}` : 'Nuevo especialista';
  c.name.value = agent ? agent.name : '';
  c.area.value = agent ? (agent.area || '') : '';
  c.instructions.value = agent ? agent.instructions : PLANTILLA;
  montarModelos(agent ? (agent.model || '') : '');
  c.effort.value = agent ? (agent.effort || '') : '';
  $('#dialog-error').textContent = '';
  // Solo se puede eliminar lo que ya existe.
  $('#eliminar').hidden = !agent;
  $('#purgar-caja').hidden = !agent;
  $('#eliminar-purgar').checked = false;
  $('#agent-dialog').showModal();
}

$('#agent-form').addEventListener('submit', async (e) => {
  // Primero cortar el envio: el dialogo es method="dialog" y, si algo falla
  // mas abajo, se cerraria solo y el cambio se perderia en silencio.
  e.preventDefault();

  // Siempre por f.elements: f.name no es el campo "name", es el nombre del
  // formulario, y leer .value sobre el rompe el guardado entero.
  const c = e.target.elements;
  const payload = {
    name: c.name.value.trim(),
    area: c.area.value.trim(),
    instructions: c.instructions.value.trim(),
    model: (c.model.value === OTRO ? c.modelOtro.value.trim() : c.model.value.trim()) || null,
    effort: c.effort.value || null,
    avatarSeed: semillaActual,
    avatarColor: colorActual
  };
  const guardar = $('#dialog-save');
  guardar.disabled = true;
  const textoPrevio = guardar.textContent;
  guardar.textContent = 'Guardando…';
  try {
    const guardado = editing
      ? await api(`/api/agents/${editing.id}`, { method: 'PATCH', body: JSON.stringify(payload) })
      : await api('/api/agents', { method: 'POST', body: JSON.stringify(payload) });
    selected = guardado.id;

    // Se confirma contra lo que devolvio el servidor, no contra lo que creiamos
    // haber enviado: si no cuadra, es mejor saberlo aqui que descubrirlo luego.
    if ((guardado.model || null) !== (payload.model || null) ||
        (guardado.effort || null) !== (payload.effort || null)) {
      $('#dialog-error').textContent =
        `El servidor guardo modelo="${guardado.model || 'por defecto'}" y esfuerzo="${guardado.effort || 'por defecto'}". Revisa.`;
      guardar.disabled = false;
      guardar.textContent = textoPrevio;
      return;
    }

    $('#agent-dialog').close();
    await refreshAll();
    if (selected) selectAgent(selected);
  } catch (err) {
    // Cualquier fallo, incluido uno de programacion, se ve aqui.
    $('#dialog-error').textContent = `No se guardo: ${err && err.message ? err.message : err}`;
    console.error('[v4] fallo al guardar el especialista', err);
  }
  guardar.disabled = false;
  guardar.textContent = textoPrevio;
});

const PLANTILLA = `Tu responsabilidad es [ALCANCE].
El codigo que te corresponde esta en [RUTA REAL].
Antes de editar, lee las instrucciones del repositorio y revisa el estado de Git.
Reserva los archivos con claim_files antes de tocarlos.
Coordina con [OTROS ESPECIALISTAS] cuando el cambio afecte sus areas.
Valida con [COMANDO O PRUEBA].
Entrega: resultado, archivos cambiados, validacion y pendientes.
No despliegues ni administres servicios salvo que la tarea lo autorice.`;

// ------------------------------------------------------------- movil / PWA

const ANCHO_MOVIL = 900;
const esMovil = () => window.matchMedia(`(max-width:${ANCHO_MOVIL}px)`).matches;
let vista = 'agents';

/**
 * Marca en <body> que vista toca en el movil.
 *
 * Se tocan solo las clases view-*: asignar body.className entero borraba
 * cualquier otra clase puesta por otra parte de la interfaz (por ejemplo
 * panel-ancho), que desaparecia sola al cambiar de pestana.
 */
function aplicarVista(v) {
  const movil = esMovil();
  for (const c of ['view-agents', 'view-chat', 'view-panel']) {
    document.body.classList.toggle(c, movil && c === `view-${v}`);
  }
}

function setView(v) {
  vista = v;
  aplicarVista(v);
  document.querySelectorAll('.mobile-nav button').forEach((b) => {
    b.classList.toggle('active', b.dataset.view === v);
    if (b.dataset.view === v) b.classList.remove('avisa');
  });
  if (v === 'panel') renderPanel();
}

document.querySelectorAll('.mobile-nav button').forEach((b) => {
  b.onclick = () => setView(b.dataset.view);
});

window.addEventListener('resize', () => aplicarVista(vista));

// Aviso en la pestana del equipo cuando llega correo entre agentes estando en otra vista.
let ultimoCorreo = 0;
function avisarCorreo(n) {
  if (n > ultimoCorreo && ultimoCorreo !== 0 && vista !== 'panel') {
    const b = document.querySelector('.mobile-nav button[data-view="panel"]');
    if (b) b.classList.add('avisa');
  }
  ultimoCorreo = n;
}

// ------------------------------------------------------- notificaciones

/**
 * Suscripcion a los avisos del telefono.
 *
 * El permiso solo se pide al marcar la casilla: pedirlo nada mas abrir es la
 * forma mas rapida de que lo denieguen para siempre, y una vez denegado no se
 * puede volver a preguntar desde la pagina.
 */
const PUSH_SOPORTADO = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

function estadoPush(texto, clase) {
  const el = $('#push-estado');
  if (!el) return;
  el.textContent = texto || '';
  el.className = `push-estado${clase ? ` ${clase}` : ''}`;
}

const aBytes = (b64) => {
  const s = (b64 + '='.repeat((4 - b64.length % 4) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
};

async function suscripcionActual() {
  if (!PUSH_SOPORTADO) return null;
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

async function activarPush() {
  const permiso = await Notification.requestPermission();
  if (permiso !== 'granted') {
    $('#push-on').checked = false;
    estadoPush(permiso === 'denied'
      ? 'Permiso denegado: hay que darlo desde los ajustes del navegador.'
      : 'Permiso no concedido.', 'mal');
    return;
  }
  const { clave } = await api('/api/push/clave');
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,                 // obligatorio en Chrome
    applicationServerKey: aBytes(clave)
  });
  const j = sub.toJSON();
  await api('/api/push/suscribir', { method: 'POST', body: JSON.stringify({ endpoint: j.endpoint, keys: j.keys }) });
  localStorage.setItem('v4-push', '1');
  estadoPush('');
}

async function desactivarPush() {
  const sub = await suscripcionActual();
  if (sub) {
    await api('/api/push/baja', { method: 'POST', body: JSON.stringify({ endpoint: sub.endpoint }) }).catch(() => {});
    await sub.unsubscribe().catch(() => {});
  }
  localStorage.setItem('v4-push', '0');
  estadoPush('');
  if ('clearAppBadge' in navigator) navigator.clearAppBadge().catch(() => {});
}

/**
 * Por HTTP el navegador no registra el service worker, asi que no hay PWA ni
 * notificaciones. Se dice en pantalla en vez de dejar que el usuario lo
 * descubra peleandose con el menu de Chrome.
 */
const CLAVE_AVISO_HTTP = `v4-aviso-http-${location.host}`;

function avisarOrigenInseguro() {
  const aviso = $('#aviso-inseguro');
  if (!aviso || window.isSecureContext) return;
  // Se puede descartar para siempre en este equipo. El dato sigue siendo
  // cierto, pero quien entra por IP a proposito no necesita que se lo
  // repitan en cada carga.
  if (localStorage.getItem(CLAVE_AVISO_HTTP) === '1') return;
  const cerrar = $('#cerrar-inseguro');
  if (cerrar) {
    cerrar.onclick = () => {
      localStorage.setItem(CLAVE_AVISO_HTTP, '1');
      aviso.hidden = true;
    };
  }
  const enlace = $('#ir-seguro');
  if (enlace) {
    if (ACCESO_SEGURO) {
      // El servidor sabe por que direccion se llega a el con certificado.
      // Cambiar http por https sobre una IP no funcionaria: el certificado
      // se emite para el nombre, no para la IP.
      enlace.href = ACCESO_SEGURO;
      enlace.textContent = `Abrir ${new URL(ACCESO_SEGURO).host}`;
      enlace.hidden = false;
    } else {
      enlace.hidden = true;
    }
  }
  aviso.hidden = false;
}

async function prepararPush() {
  const caja = $('#push-caja');
  if (!caja) return;
  if (!PUSH_SOPORTADO) {
    caja.hidden = true;
    avisarOrigenInseguro();
    return;
  }
  const sub = await suscripcionActual().catch(() => null);
  $('#push-on').checked = !!sub && Notification.permission === 'granted';
  if (!$('#push-on').checked && Notification.permission === 'denied') estadoPush('Notificaciones bloqueadas en los ajustes.', 'mal');

  $('#push-on').onchange = async (e) => {
    estadoPush('…');
    try {
      if (e.target.checked) await activarPush();
      else await desactivarPush();
    } catch (err) {
      e.target.checked = false;
      estadoPush(`No se pudo activar: ${err.message}`, 'mal');
    }
  };
}

// Al tocar una notificacion, el service worker pide abrir ese especialista.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data && e.data.tipo === 'abrir-agente' && e.data.agente) selectAgent(e.data.agente);
  });
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => { /* sin PWA, la app sigue igual */ });
  });
}

// --------------------------------------------------- texto de los mensajes

/**
 * Da formato al texto del especialista: bloques de codigo con boton de copiar,
 * enlaces pulsables y rutas que se copian al hacer clic.
 *
 * Se escapa SIEMPRE antes de transformar: el texto viene de un modelo y no se
 * puede confiar en el. Las sustituciones se hacen sobre el texto ya escapado,
 * donde ya no quedan < ni > capaces de abrir una etiqueta.
 */
function formatearCuerpo(texto) {
  const partes = String(texto == null ? '' : texto).split(/```/);
  return partes.map((parte, i) => {
    if (i % 2 === 1) {
      // El lenguaje va pegado a la apertura (```bash), asi que solo existe si
      // el bloque NO empieza por salto de linea. Si empieza por salto, la
      // primera linea ya es codigo aunque parezca el nombre de un lenguaje.
      const lineas = parte.split('\n');
      const idioma = (!parte.startsWith('\n') && /^[a-z0-9_+-]{1,15}$/i.test((lineas[0] || '').trim()))
        ? lineas.shift().trim()
        : (lineas.shift(), '');
      const codigo = lineas.join('\n').replace(/\n+$/, '');
      return `<div class="bloque">
        <div class="bloque-cab">${escapeHtml(idioma || 'texto')}
          <button type="button" class="copiar">Copiar codigo</button></div>
        <pre><code>${escapeHtml(codigo)}</code></pre></div>`;
    }
    // Fuera de los bloques de codigo, dos o mas saltos seguidos se quedan en
    // uno: el modelo separa parrafos con lineas en blanco y eso, en una
    // conversacion compacta, deja huecos que parecen mensajes distintos.
    const compacto = parte.replace(/[ \t]*\n[ \t]*(?:\n[ \t]*)+/g, '\n');
    return enriquecer(escapeHtml(compacto));
  }).join('');
}

/** Sobre texto YA escapado: enlaces, codigo en linea y rutas copiables. */
function enriquecer(seguro) {
  const nombres = [...agents].sort((a, b) => b.name.length - a.name.length);
  for (const a of nombres) {
    const esc = escapeHtml(a.name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    seguro = seguro.replace(new RegExp(`@${esc}\\b`, 'gi'),
      (hit) => `<span class="mencion">${hit}</span>`);
  }
  return seguro
    // `codigo en linea` -> copiable de un clic
    .replace(/`([^`\n]{1,200})`/g, (_, c) => `<code class="copiable" title="pulsa para copiar">${c}</code>`)
    // enlaces
    .replace(/\bhttps?:\/\/[^\s<>"')]+/g, (u) =>
      `<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`)
    // rutas absolutas del servidor
    .replace(/(^|[\s(])(\/(?:opt|srv|etc|var|usr|home|tmp)\/[^\s<>"'`),;]{2,})/g,
      (_, pre, ruta) => `${pre}<span class="ruta copiable" title="pulsa para copiar">${ruta}</span>`);
}

/** Copia respetando los navegadores sin portapapeles moderno (HTTP plano). */
async function copiarTexto(texto, elemento) {
  let ok = false;
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(texto);
      ok = true;
    }
  } catch { /* se intenta el modo antiguo */ }

  if (!ok) {
    // Sin HTTPS no hay API de portapapeles: hace falta el metodo de siempre.
    const ta = document.createElement('textarea');
    ta.value = texto;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:-1000px;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
  }

  if (elemento) {
    const previo = elemento.textContent;
    elemento.textContent = ok ? '¡copiado!' : 'no se pudo copiar';
    elemento.classList.toggle('copiado', ok);
    setTimeout(() => { elemento.textContent = previo; elemento.classList.remove('copiado'); }, 1400);
  }
  return ok;
}

// Un solo manejador para todo lo copiable, presente y futuro.
document.addEventListener('click', (e) => {
  const boton = e.target.closest('.copiar');
  if (boton) {
    const pre = boton.closest('.bloque').querySelector('code');
    return copiarTexto(pre.textContent, boton);
  }
  const botonMsg = e.target.closest('.copiar-msg');
  if (botonMsg) {
    // Se copia el texto tal cual lo escribio el especialista, sin el formato.
    const msg = botonMsg.closest('.msg');
    const cuerpo = msg.querySelector('.cuerpo-msg') || msg;
    const copia = cuerpo.cloneNode(true);
    copia.querySelectorAll('.who').forEach((x) => x.remove());
    return copiarTexto(copia.innerText.trim(), botonMsg);
  }

  const trozo = e.target.closest('.copiable');
  if (trozo) {
    copiarTexto(trozo.textContent);
    trozo.classList.add('copiado');
    setTimeout(() => trozo.classList.remove('copiado'), 900);
  }
});

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

boot();
