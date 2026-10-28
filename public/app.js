'use strict';

const $ = (sel) => document.querySelector(sel);
let TOKEN = localStorage.getItem('v4token') || new URL(location.href).searchParams.get('token') || '';
let selected = null;
let agents = [];
let lastEventId = 0;
let editing = null;
let OPCIONES = null;

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
  refreshAll();
  setInterval(refreshAll, 2500);
  vigilarProveedor();
  setInterval(vigilarProveedor, 60000);
  vigilarVersion();
  setInterval(vigilarVersion, 30000);
}

// ----------------------------------------------------------------- datos

async function refreshAll() {
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
    if (state.opciones) {
      OPCIONES = state.opciones;
      const dl = $('#modelos');
      if (dl && dl.children.length !== OPCIONES.modelos.length) {
        dl.innerHTML = OPCIONES.modelos.map((m) => `<option value="${escapeHtml(m)}">`).join('');
      }
      // No basta con decir "por defecto": hay que decir cual es.
      const inputModelo = document.querySelector('#agent-form [name=model]');
      if (inputModelo) inputModelo.placeholder = `por defecto (${OPCIONES.modeloPorDefecto || 'sin fijar'})`;
      const selEsf = document.querySelector('#agent-form [name=effort] option[value=""]');
      if (selEsf) selEsf.textContent = `por defecto (${OPCIONES.esfuerzoPorDefecto || 'el del CLI'})`;
    }
    if (verActividad) await refrescarActividad(false);
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
  document.title = pendientes ? `(${pendientes}) codex-web-v4` : 'codex-web-v4 · especialistas';
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
  $('#ver-actividad-caja').hidden = false;
  $('#parar').hidden = !a || a.status !== 'working';
  verActividad = localStorage.getItem(claveActividad(id)) === '1';
  $('#ver-actividad').checked = verActividad;
  $('#actividad').hidden = !verActividad;
  await refrescarActividad(true);
  marcarVisto(id);
  renderAgents();
  setView('chat');
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
let verActividad = false;

function claveActividad(id) { return `v4-actividad-${id}`; }

async function refrescarActividad(reiniciar) {
  if (!verActividad || !selected) return;
  if (reiniciar) { actividadDesde = 0; $('#actividad').innerHTML = ''; }
  try {
    const { actividad } = await api(`/api/agents/${selected}/activity?desde=${actividadDesde}`);
    if (!actividad.length) {
      if (!$('#actividad').children.length) {
        $('#actividad').innerHTML = '<div class="vacia">Sin actividad registrada todavia. Aparecera aqui en cuanto el especialista use una herramienta.</div>';
      }
      return;
    }
    const vacia = $('#actividad').querySelector('.vacia');
    if (vacia) vacia.remove();
    const abajo = $('#actividad').scrollHeight - $('#actividad').scrollTop - $('#actividad').clientHeight < 40;
    for (const a of actividad) {
      actividadDesde = Math.max(actividadDesde, a.id);
      const el = document.createElement('div');
      el.className = 'act';
      el.innerHTML = `<span class="hora">${new Date(a.created_at).toLocaleTimeString()}</span>
        <span class="herr">${escapeHtml(a.herramienta || a.tipo)}</span>
        <span class="res" title="pulsa para ver el detalle">${escapeHtml(a.resumen || '')}</span>`;
      const res = el.querySelector('.res');
      res.onclick = () => {
        res.classList.toggle('abierto');
        res.textContent = res.classList.contains('abierto') ? (a.detalle || a.resumen || '') : (a.resumen || '');
      };
      $('#actividad').appendChild(el);
    }
    if (abajo) $('#actividad').scrollTop = $('#actividad').scrollHeight;
  } catch { /* se reintenta en el siguiente ciclo */ }
}

$('#ver-actividad').addEventListener('change', (e) => {
  verActividad = e.target.checked;
  $('#actividad').hidden = !verActividad;
  if (selected) localStorage.setItem(claveActividad(selected), verActividad ? '1' : '0');
  if (verActividad) refrescarActividad(true);
});

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
    const cabecera = `<div class="who">${escapeHtml(roleLabel(m))} · ${new Date(m.created_at).toLocaleTimeString()}
      <button type="button" class="copiar-msg" title="Copiar este mensaje">⧉ copiar</button></div>`;
    const cuerpo = `<div class="cuerpo-msg">${cabecera}${formatearCuerpo(m.body)}</div>`;

    if (m.role === 'assistant' && actual) {
      el.innerHTML = avatar(actual, 30, 'normal') + cuerpo;
    } else if (m.role === 'peer') {
      const emisor = agents.find((x) => x.name === (m.meta && m.meta.from));
      el.innerHTML = (emisor ? avatar(emisor, 30, 'normal')
                             : robotSvg((m.meta && m.meta.from) || 'peer', 'normal', 30)) + cuerpo;
    } else {
      const adj = (m.meta && m.meta.attachments) || [];
      el.innerHTML = `<div class="who">${escapeHtml(roleLabel(m))} · ${new Date(m.created_at).toLocaleTimeString()}
        <button type="button" class="copiar-msg" title="Copiar este mensaje">⧉ copiar</button></div>${formatearCuerpo(m.body)}` +
        (adj.length ? `<div class="adjuntos">${adj.map((f) => `
          <a class="adj" href="${f.url}" target="_blank" rel="noopener">
            ${esImagen(f.nombre) ? `<img src="${f.url}" alt="">` : '<span>📄</span>'}
            <span class="nom">${escapeHtml(f.nombre)}</span>
            <span class="peso">${pesoLegible(f.bytes || 0)}</span>
          </a>`).join('')}</div>` : '');
    }
    box.appendChild(el);
  }
  if (force || atBottom) box.scrollTop = box.scrollHeight;
}

async function renderPanel() {
  const active = document.querySelector('.tab.active').dataset.tab;

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

document.querySelectorAll('.tab').forEach((t) => {
  t.onclick = () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
    t.classList.add('active');
    ['mailbox', 'claims', 'activity'].forEach((n) => { $(`#tab-${n}`).hidden = n !== t.dataset.tab; });
    renderPanel();
  };
});

// ----------------------------------------------------------------- acciones

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

  $('#send-text').value = '';
  adjuntos = [];
  pintarAdjuntos();
  await api(`/api/agents/${selected}/messages`, {
    method: 'POST',
    body: JSON.stringify({ text, attachments: listos.map((f) => ({ nombre: f.nombre, ruta: f.ruta, url: f.url, bytes: f.bytes })) })
  });
  await renderMessages(true);
});

$('#send-text').addEventListener('keydown', (e) => {
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
  c.model.value = agent ? (agent.model || '') : '';
  c.effort.value = agent ? (agent.effort || '') : '';
  $('#dialog-error').textContent = '';
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
    model: c.model.value.trim() || null,
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

function setView(v) {
  vista = v;
  document.body.className = `view-${v}`;
  document.querySelectorAll('.mobile-nav button').forEach((b) => {
    b.classList.toggle('active', b.dataset.view === v);
    if (b.dataset.view === v) b.classList.remove('avisa');
  });
  // Al volver al escritorio no debe quedar ninguna columna oculta.
  if (!esMovil()) document.body.className = '';
  if (v === 'panel') renderPanel();
}

document.querySelectorAll('.mobile-nav button').forEach((b) => {
  b.onclick = () => setView(b.dataset.view);
});
if ($('#back-agents')) $('#back-agents').onclick = () => setView('agents');

window.addEventListener('resize', () => {
  document.body.className = esMovil() ? `view-${vista}` : '';
});

// Aviso en la pestana del equipo cuando llega correo entre agentes estando en otra vista.
let ultimoCorreo = 0;
function avisarCorreo(n) {
  if (n > ultimoCorreo && ultimoCorreo !== 0 && vista !== 'panel') {
    const b = document.querySelector('.mobile-nav button[data-view="panel"]');
    if (b) b.classList.add('avisa');
  }
  ultimoCorreo = n;
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
    return enriquecer(escapeHtml(parte));
  }).join('');
}

/** Sobre texto YA escapado: enlaces, codigo en linea y rutas copiables. */
function enriquecer(seguro) {
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
