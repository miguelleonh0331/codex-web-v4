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
  if ($('#login')) $('#login').hidden = true;
  $('#app').hidden = false;
  if (history.replaceState) history.replaceState({}, '', location.pathname);
  setView(esMovil() ? 'agents' : 'agents');
  refreshAll();
  setInterval(refreshAll, 2500);
}

// ----------------------------------------------------------------- datos

async function refreshAll() {
  try {
    const state = await api('/api/state');
    agents = state.agents;
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
    if (selected) {
      const act = agents.find((x) => x.id === selected);
      if (act) $('#chat-face').innerHTML = avatar(act, 42);
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

function renderAgents() {
  const box = $('#agent-list');
  box.innerHTML = '';
  for (const a of agents) {
    const el = document.createElement('div');
    el.className = 'agent' + (selected === a.id ? ' sel' : '');
    el.innerHTML = `${avatar(a, 36)}
      <span class="txt">
        <span class="n"><i class="pill ${a.status}"></i>${escapeHtml(a.name)}</span>
        ${a.status === 'working'
          ? cintaTrabajando(a)
          : `<span class="a">${escapeHtml(a.area || 'sin area')}</span>`}
        ${(a.model || a.effort) ? `<span class="meta">
           ${a.model ? `<span class="tag">${escapeHtml(a.model)}</span>` : ''}
           ${a.effort ? `<span class="tag">${escapeHtml(a.effort)}</span>` : ''}</span>` : ''}
      </span>`;
    el.onclick = () => selectAgent(a.id);
    box.appendChild(el);
  }
}

async function selectAgent(id) {
  selected = id;
  const a = agents.find((x) => x.id === id);
  $('#chat-name').textContent = a ? a.name : '';
  $('#chat-area').textContent = a
    ? [a.area, a.model, a.effort].filter(Boolean).join(' · ')
    : '';
  $('#chat-face').innerHTML = a ? avatar(a, 42) : '';
  $('#send-form').hidden = false;
  $('#edit-agent').hidden = false;
  $('#reset-session').hidden = false;
  renderAgents();
  setView('chat');
  await renderMessages(true);
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
    const cuerpo = `<div class="cuerpo-msg"><div class="who">${escapeHtml(roleLabel(m))} · ${new Date(m.created_at).toLocaleTimeString()}</div>${escapeHtml(m.body)}</div>`;

    if (m.role === 'assistant' && actual) {
      el.innerHTML = avatar(actual, 30, 'normal') + cuerpo;
    } else if (m.role === 'peer') {
      const emisor = agents.find((x) => x.name === (m.meta && m.meta.from));
      el.innerHTML = (emisor ? avatar(emisor, 30, 'normal')
                             : robotSvg((m.meta && m.meta.from) || 'peer', 'normal', 30)) + cuerpo;
    } else {
      const adj = (m.meta && m.meta.attachments) || [];
      el.innerHTML = `<div class="who">${escapeHtml(roleLabel(m))} · ${new Date(m.created_at).toLocaleTimeString()}</div>${escapeHtml(m.body)}` +
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

$('#new-agent').onclick = () => openDialog(null);

if ($('#ask-team')) $('#ask-team').onclick = () => {
  $('#broadcast-error').textContent = '';
  $('#broadcast-form').text.value = '';
  $('#broadcast-dialog').showModal();
};
if ($('#broadcast-cancel')) $('#broadcast-cancel').onclick = () => $('#broadcast-dialog').close();

if ($('#broadcast-form')) $('#broadcast-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = e.target.text.value.trim();
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

$('#reset-session').onclick = async () => {
  if (!selected) return;
  await api(`/api/agents/${selected}/reset`, { method: 'POST' });
  alert('Contexto reiniciado: el proximo mensaje empieza una conversacion nueva.');
};

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
  const f = $('#agent-form');
  $('#dialog-title').textContent = agent ? `Editar ${agent.name}` : 'Nuevo especialista';
  f.name.value = agent ? agent.name : '';
  f.area.value = agent ? (agent.area || '') : '';
  f.instructions.value = agent ? agent.instructions : PLANTILLA;
  f.model.value = agent ? (agent.model || '') : '';
  f.effort.value = agent ? (agent.effort || '') : '';
  $('#dialog-error').textContent = '';
  $('#agent-dialog').showModal();
}

$('#agent-form').addEventListener('submit', async (e) => {
  const f = e.target;
  const payload = {
    name: f.name.value.trim(),
    area: f.area.value.trim(),
    instructions: f.instructions.value.trim(),
    model: f.model.value.trim() || null,
    effort: f.effort.value || null,
    avatarSeed: semillaActual,
    avatarColor: colorActual
  };
  e.preventDefault();
  try {
    if (editing) {
      await api(`/api/agents/${editing.id}`, { method: 'PATCH', body: JSON.stringify(payload) });
    } else {
      const a = await api('/api/agents', { method: 'POST', body: JSON.stringify(payload) });
      selected = a.id;
    }
    $('#agent-dialog').close();
    await refreshAll();
    if (selected) selectAgent(selected);
  } catch (err) {
    $('#dialog-error').textContent = err.message;
  }
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

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

boot();
