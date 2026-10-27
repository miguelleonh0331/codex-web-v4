'use strict';

const $ = (sel) => document.querySelector(sel);
let TOKEN = localStorage.getItem('v4token') || new URL(location.href).searchParams.get('token') || '';
let selected = null;
let agents = [];
let lastEventId = 0;
let editing = null;

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
    if (selected) {
      const act = agents.find((x) => x.id === selected);
      if (act) $('#chat-face').innerHTML = caraSvg(act.avatar_seed || act.id, act.status, 40);
      await renderMessages();
    }
    await renderPanel();
  } catch (err) { /* reintenta en el siguiente ciclo */ }
}

function renderAgents() {
  const box = $('#agent-list');
  box.innerHTML = '';
  for (const a of agents) {
    const el = document.createElement('div');
    el.className = 'agent' + (selected === a.id ? ' sel' : '');
    el.innerHTML = `${caraSvg(a.avatar_seed || a.id, a.status, 34)}
      <span class="txt">
        <span class="n"><i class="pill ${a.status}"></i>${escapeHtml(a.name)}</span>
        <span class="a">${escapeHtml(a.area || 'sin area')}</span>
      </span>`;
    el.onclick = () => selectAgent(a.id);
    box.appendChild(el);
  }
}

async function selectAgent(id) {
  selected = id;
  const a = agents.find((x) => x.id === id);
  $('#chat-name').textContent = a ? a.name : '';
  $('#chat-area').textContent = a ? (a.area || '') : '';
  $('#chat-face').innerHTML = a ? caraSvg(a.avatar_seed || a.id, a.status, 40) : '';
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
      el.innerHTML = caraSvg(actual.avatar_seed || actual.id, 'idle', 28) + cuerpo;
    } else if (m.role === 'peer') {
      const emisor = agents.find((x) => x.name === (m.meta && m.meta.from));
      el.innerHTML = caraSvg(emisor ? (emisor.avatar_seed || emisor.id) : (m.meta && m.meta.from) || 'peer', 'idle', 28) + cuerpo;
    } else {
      el.innerHTML = `<div class="who">${escapeHtml(roleLabel(m))} · ${new Date(m.created_at).toLocaleTimeString()}</div>${escapeHtml(m.body)}`;
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

$('#send-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = $('#send-text').value.trim();
  if (!text || !selected) return;
  $('#send-text').value = '';
  await api(`/api/agents/${selected}/messages`, { method: 'POST', body: JSON.stringify({ text }) });
  await renderMessages(true);
});

$('#send-text').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) $('#send-form').requestSubmit();
});

$('#new-agent').onclick = () => openDialog(null);
$('#edit-agent').onclick = () => openDialog(agents.find((a) => a.id === selected));
$('#dialog-cancel').onclick = () => $('#agent-dialog').close();

$('#reset-session').onclick = async () => {
  if (!selected) return;
  await api(`/api/agents/${selected}/reset`, { method: 'POST' });
  alert('Contexto reiniciado: el proximo mensaje empieza una conversacion nueva.');
};

function caraDe(id, nombre) {
  const a = agents.find((x) => x.id === id) || agents.find((x) => x.name === nombre);
  return caraSvg(a ? (a.avatar_seed || a.id) : (id || nombre || '?'), 'idle', 20);
}

let semillaActual = null;
function pintarPreview() {
  $('#face-preview').innerHTML = caraSvg(semillaActual, 'idle', 62);
}

if ($('#shuffle-face')) $('#shuffle-face').onclick = () => {
  semillaActual = 'cara-' + Math.random().toString(36).slice(2, 10);
  pintarPreview();
};

function openDialog(agent) {
  editing = agent || null;
  semillaActual = agent ? (agent.avatar_seed || agent.id) : 'cara-' + Math.random().toString(36).slice(2, 10);
  pintarPreview();
  const f = $('#agent-form');
  $('#dialog-title').textContent = agent ? `Editar ${agent.name}` : 'Nuevo especialista';
  f.name.value = agent ? agent.name : '';
  f.area.value = agent ? (agent.area || '') : '';
  f.instructions.value = agent ? agent.instructions : PLANTILLA;
  f.model.value = agent ? (agent.model || '') : '';
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
    avatarSeed: semillaActual
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
