'use strict';

const $ = (sel) => document.querySelector(sel);
let TOKEN = localStorage.getItem('v4token') || new URL(location.href).searchParams.get('token') || '';
let selected = null;
let ultimoMsgId = 0;        // hasta donde se ha pintado la conversacion
let hayAnteriores = false;  // si queda historial por encima
let agents = [];
let lastEventId = 0;
let editing = null;
let OPCIONES = null;
let NOMBRE_APP = 'codex-web-v4';
let ACCESO_SEGURO = null;   // direccion https de esta instalacion, si la hay
let PROVEEDORES = [];       // quien puede ejecutar turnos en este servidor

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
  arrancarSondeo();
  vigilarProveedor();
  setInterval(vigilarProveedor, 60000);
  vigilarVersion();
  setInterval(vigilarVersion, 30000);
}

/**
 * Sondeo adaptativo.
 *
 * Con la pestana oculta no se pide nada: antes seguia preguntando cada 2,5
 * segundos aunque no estuvieras mirando, y con varias pestanas abiertas eso
 * se multiplica. Al volver se refresca de inmediato, asi que no se nota.
 *
 * Y cuando nadie trabaja se espaciar: mirar cada dos segundos y medio una
 * lista que no cambia no aporta nada.
 */
let relojSondeo = null;
let ritmoActual = 0;

function ritmoDeseado() {
  if (document.hidden) return 0;                       // parado
  return agents.some((a) => a.status === 'working' || a.status === 'queued') ? 2500 : 8000;
}

function arrancarSondeo() {
  const quiero = ritmoDeseado();
  if (quiero === ritmoActual) return;
  ritmoActual = quiero;
  if (relojSondeo) { clearInterval(relojSondeo); relojSondeo = null; }
  if (quiero > 0) relojSondeo = setInterval(refreshAll, quiero);
}

document.addEventListener('visibilitychange', () => {
  arrancarSondeo();
  // Al volver, ponerse al dia sin esperar al siguiente ciclo.
  if (!document.hidden) refreshAll();
});

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
    if (Array.isArray(state.proveedores)) PROVEEDORES = state.proveedores;
    if (state.app && state.app.zona) ZONA = state.app.zona;
    if (state.app && state.app.ahora) {
      // El navegador puede ir desajustado; manda el reloj del servidor.
      DESFASE_MS = new Date(state.app.ahora).getTime() - Date.now();
    }
    arrancarSondeo();            // acelera si alguien empieza a trabajar
    actualizarEspera(state.esperando);
    // La pestana del guardia avisa si alguien toco algo protegido.
    const tg = document.querySelector('.tab[data-tab="guardia"]');
    if (tg) tg.classList.toggle('avisa', !!(state.guardia && state.guardia.length));
    pintarReloj();
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
        // Aqui y no solo al pintar mensajes: el especialista puede ponerse a
        // trabajar o terminar sin que llegue ni un mensaje nuevo, y entonces
        // pintarMensajes sale antes de tiempo y no se enteraria nadie.
        ajustarCompositor();
        pintarTrabajando();
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
/**
 * Barra de contexto con el dato A LA VISTA.
 *
 * Antes era solo una linea de tres pixeles y el numero vivia en el tooltip,
 * que en el movil no existe. Enterarse tarde de que un especialista se queda
 * sin contexto venia de ahi tanto como de medirlo tarde.
 */
function barraContexto(c) {
  const nivel = c.pct >= 90 ? 'alto' : c.pct >= 70 ? 'medio' : '';
  const turnos = c.ritmo && c.ritmo.turnosRestantes !== null ? c.ritmo.turnosRestantes : null;

  // Lo que se dice al lado del numero, por orden de utilidad: cuantos turnos
  // le quedan (lo accionable) y, si no se sabe aun, cuando se compactara solo.
  let nota = '';
  if (turnos !== null && c.pct >= 40) {
    nota = turnos === 0 ? 'se llena ya' : `~${turnos} ${turnos === 1 ? 'turno' : 'turnos'}`;
  } else if (c.compactaAl && c.pct >= c.compactaAl) {
    nota = 'compacta ya';
  }

  const detalle = `contexto ${c.usado.toLocaleString()} / ${c.ventana.toLocaleString()} (${c.pct}%)`
    + (turnos !== null ? ` · le quedan unos ${turnos} turnos a este ritmo` : '')
    + (c.compactaAl ? ` · se compacta solo al ${c.compactaAl}%` : '');

  return `<span class="ctx-caja ${nivel}" title="${escapeHtml(detalle)}">
      <span class="ctx"><i style="width:${c.pct}%"></i></span>
      <span class="ctx-num">${c.pct}%${nota ? ` <em>${escapeHtml(nota)}</em>` : ''}</span>
    </span>`;
}

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
      // Habla solo cuando el especialista termina su propio trabajo: ni al
      // recibir correo de otro, ni en cada paso intermedio.
      if (a.ultimo_mensaje.rol === 'assistant' && previo.estado === 'working') {
        VOZ.anuncia(a.name, a.ultimo_mensaje.resumen || 'ha terminado');
      }
    }
    ultimoEstado.set(a.id, { id: idUlt, estado: a.status });
  }
  if (huboError) sonar('error');
  else if (huboFinal) sonar('fin');

  const pendientes = lista.filter(tienePendiente).length;
  document.title = pendientes ? `(${pendientes}) ${NOMBRE_APP}` : NOMBRE_APP;
}

/**
 * Orden de la lista: delante lo que esta pasando.
 *
 * Primero quien trabaja, luego quien tiene algo en marcha o esperando
 * cuota, luego quien tiene respuesta sin leer, y al final los parados.
 * Dentro de cada grupo se respeta el orden de siempre: reordenar de mas
 * formas haria que la lista bailara y se pulsara al que no es.
 */
function prioridad(a) {
  if (a.status === 'working') return 0;
  if (a.status === 'queued' || a.status === 'esperando_cuota') return 1;
  if (tienePendiente(a) && selected !== a.id) return 2;
  return 3;
}

function agentesOrdenados() {
  // El indice original desempata, asi que el orden dentro del grupo no cambia.
  return agents
    .map((a, i) => ({ a, i }))
    .sort((x, y) => prioridad(x.a) - prioridad(y.a) || x.i - y.i)
    .map((x) => x.a);
}

function renderAgents() {
  const box = $('#agent-list');
  box.innerHTML = '';
  for (const a of agentesOrdenados()) {
    const el = document.createElement('div');
    const pendiente = tienePendiente(a) && selected !== a.id;
    el.className = 'agent' + (selected === a.id ? ' sel' : '') + (pendiente ? ' pendiente' : '');
    el.innerHTML = `${avatar(a, 36)}
      <span class="txt">
        <span class="n"><i class="pill ${a.status}"></i>${escapeHtml(a.name)}</span>
        ${a.status === 'working'
          ? cintaTrabajando(a)
          : `<span class="a">${escapeHtml(a.area || 'sin area')}</span>`}
        ${a.contexto ? barraContexto(a.contexto) : ''}
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
  $('#edit-agent').hidden = false;
  $('#reset-session').hidden = false;
  $('#compactar').hidden = false;
  $('#notas').hidden = false;
  marcarBotonNotas(a);
  $('#parar').hidden = !a || a.status !== 'working';
  // Otro especialista, otra situacion: el cuadro se decide de nuevo.
  composerForzado = false;
  ajustarCompositor();
  ultimoMsgId = 0;          // conversacion nueva: se pinta de cero
  await refrescarActividad(true);
  marcarVisto(id);
  renderAgents();
  setView('chat');
  setTimeout(() => MATRIZ.remedir(), 50);   // el lienzo cambia de tamano al abrir el chat
  await renderMessages(true);
}

// ------------------------------------------------- trabajando / compositor

// El usuario pidio ver el cuadro de escribir aunque el especialista trabaje.
// Se olvida en cuanto termina: es una excepcion para este rato, no un ajuste.
let composerForzado = false;

/**
 * Mientras trabaja, el cuadro de escribir estorba: ocupa un tercio de la
 * pantalla para algo que no se puede hacer aun. Se esconde y su sitio lo
 * ocupa el aviso de que esta trabajando, que es la informacion que falta.
 *
 * Con una excepcion que manda sobre todo lo demas: si hay algo escrito sin
 * enviar, no se esconde. Tapar lo que alguien acaba de teclear es perderlo
 * de vista sin avisar, y eso no lo arregla ningun boton.
 */
function ajustarCompositor() {
  const a = agents.find((x) => x.id === selected);
  const trabajando = !!a && a.status === 'working';
  if (!trabajando) composerForzado = false;

  const campo = $('#send-text');
  const borrador = !!campo && campo.value.trim().length > 0;
  const conAdjuntos = Array.isArray(adjuntos) && adjuntos.length > 0;

  $('#send-form').hidden = !a || (trabajando && !composerForzado && !borrador && !conAdjuntos);

  const btn = $('#ver-compositor');
  if (btn) {
    // Solo aparece mientras trabaja: el resto del tiempo no esconde nada.
    btn.hidden = !trabajando;
    const abierto = !$('#send-form').hidden;
    btn.classList.toggle('activo', abierto);
    const txt = abierto ? 'Ocultar el cuadro de escribir' : 'Escribir mientras trabaja';
    btn.title = txt;
    btn.setAttribute('aria-label', txt);
  }
}

/**
 * Aviso de "esta trabajando" debajo del ultimo mensaje.
 *
 * Se reubica al final en cada pintada en vez de crearse una sola vez: los
 * mensajes se anaden por abajo, y si no se moviera quedaria enterrado entre
 * la conversacion.
 */
function pintarTrabajando() {
  const box = $('#messages');
  if (!box) return;
  const a = agents.find((x) => x.id === selected);
  const activo = !!a && a.status === 'working';
  let el = box.querySelector('.trabajando');

  if (!activo) { if (el) el.remove(); return; }
  if (!el) {
    el = document.createElement('div');
    el.className = 'trabajando';
    el.setAttribute('role', 'status');      // los lectores de pantalla lo anuncian
    el.innerHTML = '<span class="puntos"><i></i><i></i><i></i></span><span class="quien"></span>';
    box.appendChild(el);
  } else if (el !== box.lastElementChild) {
    box.appendChild(el);
  }
  // textContent y no innerHTML: el nombre lo pone el usuario.
  el.querySelector('.quien').textContent = `${a.name} esta trabajando…`;
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

/**
 * Pinta la conversacion.
 *
 * Con force se carga de cero —al abrir un especialista—; sin force solo se
 * piden los mensajes posteriores al ultimo que ya hay y se anaden al final.
 * Antes se pedia el historial entero cada 2,5 segundos y se repintaba todo,
 * que es lo que hacia pesada una conversacion larga.
 */
let pintandoMensajes = false;

async function renderMessages(force) {
  if (!selected) return;
  // Sin marcador todavia, la conversacion aun no se ha pintado: hay que
  // cargarla de cero. Pedir "lo posterior a cero" devolveria los ultimos 120
  // y se anadirian a lo que hubiera en pantalla, duplicando o mezclando.
  if (!ultimoMsgId) force = true;

  // Dos pintados a la vez se pisan: selectAgent y el ciclo automatico pueden
  // coincidir, porque entre medias hay esperas.
  if (pintandoMensajes) return;
  pintandoMensajes = true;
  try {
    await pintarMensajes(force);
  } finally {
    pintandoMensajes = false;
  }
}

async function pintarMensajes(force) {
  const box = $('#messages');
  const deQuien = selected;
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;

  const ruta = force
    ? `/api/agents/${deQuien}/messages`
    : `/api/agents/${deQuien}/messages?desde=${ultimoMsgId}`;

  let datos;
  try { datos = await api(ruta); } catch { return; }
  // Si se cambio de especialista mientras llegaba la respuesta, se descarta:
  // pintarla meteria los mensajes de uno en la conversacion de otro.
  if (selected !== deQuien) return;

  const nuevos = datos.messages || [];
  if (!force && !nuevos.length) return;          // nada que hacer: ni un repintado

  const actual = agents.find((x) => x.id === selected);
  if (force) {
    box.innerHTML = '';
    hayAnteriores = !!datos.hayAnteriores;
    if (hayAnteriores) box.appendChild(botonAnteriores());
  }
  for (const m of nuevos) {
    box.appendChild(filaMensaje(m, actual));
    if (m.id > ultimoMsgId) ultimoMsgId = m.id;
  }
  // Antes de bajar del todo: el aviso tiene alto propio y colocarlo despues
  // dejaria el scroll justo por encima de el.
  pintarTrabajando();
  if (force || atBottom) box.scrollTop = box.scrollHeight;
}

/** Boton para traer lo anterior, arriba del todo. */
function botonAnteriores() {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'cargar-antes';
  b.textContent = '↑ cargar mensajes anteriores';
  b.onclick = async () => {
    const box = $('#messages');
    const primera = box.querySelector('.msg');
    const antes = primera ? Number(primera.dataset.id) : 0;
    if (!antes) return;
    b.disabled = true;
    b.textContent = 'cargando…';
    try {
      const d = await api(`/api/agents/${selected}/messages?antes=${antes}&limite=100`);
      const actual = agents.find((x) => x.id === selected);
      // Se conserva la posicion de lectura: insertar arriba sin esto
      // empujaria el texto y se perderia de vista lo que se estaba leyendo.
      const altoAntes = box.scrollHeight;
      for (const m of (d.messages || []).reverse()) box.insertBefore(filaMensaje(m, actual), b.nextSibling);
      box.scrollTop += box.scrollHeight - altoAntes;
      if (!d.messages || !d.messages.length) b.remove();
      else { b.disabled = false; b.textContent = '↑ cargar mensajes anteriores'; }
    } catch {
      b.disabled = false;
      b.textContent = '↑ cargar mensajes anteriores';
    }
  };
  return b;
}

/** Construye la fila de un mensaje. Se saca aparte para poder anadir de uno
 *  en uno sin repintar la conversacion entera. */
function filaMensaje(m, actual) {
  {
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
    el.dataset.id = m.id;
    return el;
  }
}

let notaAbierta = null;    // {titulo, carpeta} mientras se lee una nota
let diasInforme = 7;       // periodo del informe de gasto

async function pintarIndiceVault() {
  const { notas, raiz } = await api('/api/vault');
  const caja = $('#tab-vault');
  const html = notas.length
    ? `<p class="muted" style="font-size:.72rem">${escapeHtml(raiz)}</p>` + notas.map((n) => `
        <div class="item nota" data-t="${escapeHtml(n.titulo)}" data-c="${escapeHtml(n.carpeta)}">
          <div class="hdr"><span>${escapeHtml(n.titulo)}</span>
          <span>${escapeHtml(n.carpeta || 'raiz')}</span></div>
          <div class="body">${n.bytes} bytes · ${n.editada ? new Date(n.editada).toLocaleString() : ''}</div>
        </div>`).join('')
    : '<p class="muted">El vault esta vacio. Los especialistas escriben aqui lo que vale para manana.</p>';
  // Solo se toca el DOM si cambio: repintar cada 2,5 s cerraria cualquier
  // seleccion de texto que estuvieras haciendo.
  if (caja.dataset.firma !== html.length + ':' + notas.length) {
    caja.innerHTML = html;
    caja.dataset.firma = html.length + ':' + notas.length;
    caja.querySelectorAll('.nota').forEach((el) => {
      el.onclick = () => {
        notaAbierta = { titulo: el.dataset.t, carpeta: el.dataset.c };
        caja.dataset.firma = '';
        pintarNota(notaAbierta);
      };
    });
  }
}

async function pintarNota(ref) {
  const caja = $('#tab-vault');
  let n;
  try {
    n = await api(`/api/vault?titulo=${encodeURIComponent(ref.titulo)}`
      + `&carpeta=${encodeURIComponent(ref.carpeta || '')}`);
  } catch {
    notaAbierta = null;
    caja.dataset.firma = '';
    return pintarIndiceVault();
  }
  const atras = (n.retroenlaces || []).map((r) => r.titulo);
  // Se quita la cabecera YAML: es util en Obsidian, ruido aqui.
  const cuerpo = n.texto.replace(/^---\n[\s\S]*?\n---\n/, '');
  const html = `
    <button type="button" id="vault-volver">‹ todas las notas</button>
    <div class="item"><div class="hdr"><span>${escapeHtml(n.titulo)}</span>
    <span>${escapeHtml(n.carpeta || 'raiz')}</span></div>
    <div class="body" style="white-space:pre-wrap">${escapeHtml(cuerpo)}</div></div>
    ${n.enlaces.length ? `<div class="item"><div class="hdr"><span>enlaza a</span></div>
      <div class="body enlaces">${n.enlaces.map((e) =>
        `<a href="#" data-ir="${escapeHtml(e)}">${escapeHtml(e)}</a>`).join(' · ')}</div></div>` : ''}
    ${atras.length ? `<div class="item"><div class="hdr"><span>la enlazan</span></div>
      <div class="body enlaces">${atras.map((e) =>
        `<a href="#" data-ir="${escapeHtml(e)}">${escapeHtml(e)}</a>`).join(' · ')}</div></div>` : ''}`;
  if (caja.dataset.firma === 'nota:' + html.length) return;
  caja.innerHTML = html;
  caja.dataset.firma = 'nota:' + html.length;
  $('#vault-volver').onclick = () => {
    notaAbierta = null;
    caja.dataset.firma = '';
    pintarIndiceVault();
  };
  // Navegar por los enlaces es lo que convierte esto en un mapa y no en
  // una lista de ficheros.
  caja.querySelectorAll('[data-ir]').forEach((a) => {
    a.onclick = (e) => {
      e.preventDefault();
      notaAbierta = { titulo: a.dataset.ir, carpeta: '' };
      caja.dataset.firma = '';
      pintarNota(notaAbierta);
    };
  });
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

  if (active === 'vault') {
    // El panel se repinta solo cada pocos segundos. Si hay una nota abierta
    // hay que volver a pintarla: antes la lista la borraba al instante y
    // parecia que no se podia abrir nada.
    if (notaAbierta) await pintarNota(notaAbierta);
    else await pintarIndiceVault();
  }

  if (active === 'guardia') {
    const { vigilando, incidentes } = await api('/api/guardia');
    const cab = vigilando.length
      ? `<p class="muted" style="font-size:.74rem">Vigilando: ${vigilando.map(escapeHtml).join(', ')}</p>`
      : '<p class="muted">Sin rutas protegidas. Anade rutasProtegidas en la configuracion para vigilar lo que no debe cambiar sin que te enteres.</p>';
    $('#tab-guardia').innerHTML = cab + (incidentes.length ? incidentes.map((i) => `
      <div class="item ${i.revertido ? '' : 'blocked'}">
        <div class="hdr"><span>${escapeHtml(i.nombre)}</span>
        <span>${new Date(i.created_at).toLocaleString()}</span></div>
        <div class="body">${i.cambios.map((c) => `${c.cambio}: ${escapeHtml(c.ruta)}`).join('\n')}</div>
        ${i.revertido
          ? '<div class="hdr"><span>deshecho</span></div>'
          : `<menu style="justify-content:flex-start;margin:.4rem 0 0">
               <button type="button" class="peligro" data-rev="${i.id}">Deshacer</button>
               <button type="button" data-visto="${i.id}">Visto</button>
             </menu>`}
      </div>`).join('') : '<p class="muted">Nadie ha tocado nada protegido.</p>');

    $('#tab-guardia').querySelectorAll('[data-rev]').forEach((b) => {
      b.onclick = async () => {
        if (!confirm('Deshacer estos cambios y volver al estado anterior al turno?')) return;
        b.disabled = true;
        try {
          const r = await api(`/api/guardia/${b.dataset.rev}/revertir`, { method: 'POST' });
          alert(`Deshechos ${r.hecho.length}. Fallos: ${r.fallos.length}.`);
        } catch (e) { alert(e.message); }
        renderPanel();
      };
    });
    $('#tab-guardia').querySelectorAll('[data-visto]').forEach((b) => {
      b.onclick = async () => {
        await api(`/api/guardia/${b.dataset.visto}/visto`, { method: 'POST' }).catch(() => {});
        renderPanel();
      };
    });
  }

  if (active === 'lilit') {
    const { hallazgos, modelo, actividad } = await api('/api/lilit');
    const act = actividad || {};
    const cab = `
      <div class="item ${act.trabajando && act.trabajando.length ? 'activo' : ''}">
        <div class="hdr"><span>ahora mismo</span>
        <span>${act.inactivos ?? 0} de ${act.total ?? 0} libres</span></div>
        <div class="body">${escapeHtml(act.texto || '')}</div>
      </div>
      <p class="muted" style="font-size:.74rem">
      Vigila el equipo y avisa por voz. ${modelo ? `Redaccion natural con ${escapeHtml(modelo)}.` : 'Sin modelo externo: frases propias.'}
      </p>`;
    $('#tab-lilit').innerHTML = cab + (hallazgos.length ? hallazgos.map((h) => `
      <div class="item ${h.nivel === 'urgente' ? 'blocked' : ''}">
        <div class="hdr"><span>${escapeHtml(h.tipo)}</span><span>${escapeHtml(h.nivel)}</span></div>
        <div class="body">${escapeHtml(h.texto)}</div>
      </div>`).join('') : '<p class="muted">Todo en orden. LILIT calla cuando no hay nada que contar.</p>');
  }

  if (active === 'gasto') {
    const d = await api(`/api/informe?dias=${diasInforme}`);
    const mil = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
    const dolar = (n) => `$${n.toFixed(n < 1 ? 4 : 2)}`;

    // El mayor gasto marca la escala de las barras: comparar entre
    // especialistas es justo para lo que se mira esto.
    const tope = Math.max(...d.porAgente.map((a) => a.coste), 0.0001);

    $('#tab-gasto').innerHTML = `
      <div class="periodo">
        ${[1, 7, 30].map((n) => `<button type="button" data-dias="${n}"
          class="${n === diasInforme ? 'sel' : ''}">${n === 1 ? 'hoy' : `${n} dias`}</button>`).join('')}
      </div>
      <div class="item">
        <div class="hdr"><span>total</span><span>${d.total.turnos} turnos</span></div>
        <div class="body">${dolar(d.total.coste)} · entrada ${mil(d.total.entrada)} ·
          cache ${mil(d.total.cache)} · salida ${mil(d.total.salida)}</div>
      </div>
      ${d.porAgente.length ? d.porAgente.map((a) => `
        <div class="item gasto-fila">
          <div class="hdr">
            <span>${escapeHtml(a.name)} <small class="muted">${escapeHtml(a.prov)}</small></span>
            <span>${a.costeConocido ? dolar(a.coste) : '<em class="muted">sin coste informado</em>'}</span>
          </div>
          <div class="barra"><i style="width:${Math.max(2, (a.coste / tope) * 100)}%"></i></div>
          <div class="body">${a.turnos} turnos · ${a.costeConocido ? `${dolar(a.costePorTurno)} por turno · ` : ''}${mil(a.tokens)} tokens</div>
        </div>`).join('') : '<p class="muted">Sin actividad en el periodo.</p>'}
      ${d.sinMedir ? `<p class="muted" style="font-size:.72rem">
        ${d.sinMedir} turnos anteriores a esta version tienen coste pero no tokens:
        se midieron antes de que se guardaran.</p>` : ''}
      ${d.porDia.length ? `<div class="item"><div class="hdr"><span>por dia</span></div>
        <div class="body">${d.porDia.map((x) =>
          `${x.dia.slice(5)}  ${dolar(x.coste).padStart(8)}  ${x.turnos} turnos`).join('\n')}</div></div>` : ''}`;

    $('#tab-gasto').querySelectorAll('[data-dias]').forEach((b) => {
      b.onclick = () => { diasInforme = Number(b.dataset.dias); renderPanel(); };
    });
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
    ['mailbox', 'salida', 'claims', 'vault', 'guardia', 'lilit', 'gasto', 'activity'].forEach((n) => { $(`#tab-${n}`).hidden = n !== t.dataset.tab; });
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
  // Enviado y sin borrador: ya puede esconderse si el especialista arranca.
  composerForzado = false;
  ajustarCompositor();
  await renderMessages(true);
});

// Trae de vuelta el cuadro de escribir mientras trabaja, para dejar la
// siguiente tarea en cola sin esperar. El mismo boton lo vuelve a esconder.
$('#ver-compositor').onclick = () => {
  composerForzado = !composerForzado;
  ajustarCompositor();
  if (composerForzado) $('#send-text').focus();
};

// Si escribes con el cuadro abierto a mano, deja de ser una excepcion: ya
// hay un borrador y esconderlo seria perderlo de vista.
$('#send-text').addEventListener('input', () => {
  const btn = $('#ver-compositor');
  if (btn && !btn.hidden) ajustarCompositor();
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
    etiquetaProveedores(proveedores, malo);
    $('#prov-logout').hidden = !p.conectado;
  } catch (e) {
    caja.textContent = `No se pudo consultar el proveedor: ${e.message}`;
  }
}

// ---------------------------------------------------- conectar con Codex

/**
 * Codex usa codigo de dispositivo: se muestran enlace y codigo, y el propio
 * CLI termina solo cuando el usuario autoriza en el navegador. Por eso aqui
 * no hay nada que pegar de vuelta; solo hay que preguntar si ya esta.
 */
let relojCodex = null;

/** Gasto del dia y su tope, dentro del dialogo de proveedor. */
async function pintarGasto() {
  const el = $('#gasto-hoy');
  if (!el) return;
  try {
    const st = await api('/api/state');
    const g = st.gasto || {};
    const tope = Number(g.tope) || 0;
    el.textContent = tope
      ? `$${(g.total || 0).toFixed(4)} de $${tope.toFixed(2)} · ${g.turnos || 0} turnos`
      : `$${(g.total || 0).toFixed(4)} · ${g.turnos || 0} turnos · sin tope`;
    el.className = g.frenado ? 'mal' : '';
    if (document.activeElement !== $('#tope-gasto')) $('#tope-gasto').value = tope || 0;
    if (g.frenado) $('#tope-estado').textContent = 'alcanzado: no se lanzan turnos nuevos';

    // Umbral de compactacion automatica. Comparte pantalla con el tope porque
    // los dos son frenos de gasto, solo que uno corta y el otro abarata.
    const aj = st.ajustes || {};
    const campo = $('#compactar-pct');
    if (campo && document.activeElement !== campo) campo.value = aj.compactarAlPorcentaje || 0;
    if ($('#compactar-estado') && !$('#compactar-estado').textContent) {
      $('#compactar-estado').textContent = aj.compactarAlPorcentaje
        ? (aj.rtk ? 'rtk disponible' : 'sin rtk: los especialistas reconocen sin filtro')
        : 'desactivado';
    }
  } catch (e) {
    el.textContent = `no se pudo consultar: ${e.message}`;
  }
}

if ($('#compactar-guardar')) {
  $('#compactar-guardar').onclick = async () => {
    const v = Number($('#compactar-pct').value);
    const av = Number($('#aviso-ctx-pct').value);
    $('#compactar-estado').textContent = 'guardando…';
    try {
      await api('/api/app', {
        method: 'PATCH',
        body: JSON.stringify({ compactarAlPorcentaje: v, avisoContextoPorcentaje: av })
      });
      $('#compactar-estado').textContent = v
        ? `guardado: aviso al ${Math.round(av)}%, compacta al ${Math.round(v)}%`
        : 'guardado: no se compacta solo';
      await pintarGasto();
    } catch (e) {
      $('#compactar-estado').textContent = e.message;
    }
  };
}

if ($('#tope-guardar')) {
  $('#tope-guardar').onclick = async () => {
    const v = Number($('#tope-gasto').value);
    $('#tope-estado').textContent = 'guardando…';
    try {
      const r = await api('/api/app', {
        method: 'PATCH', body: JSON.stringify({ topeGastoDiario: v })
      });
      // Avisar si el tope que acaba de poner ya esta superado: guardarlo en
      // silencio dejaria el equipo parado sin explicacion.
      $('#tope-estado').textContent = r.frenaYa
        ? `guardado, pero hoy ya llevas $${r.gasto.toFixed(2)}: el equipo queda parado`
        : (v ? 'guardado' : 'sin tope');
      await pintarGasto();
    } catch (e) {
      $('#tope-estado').textContent = e.message;
    }
  };
}

/** Agentes de otras maquinas: credenciales y su estado. */
/** Clave del modelo externo de LILIT. Nunca se muestra entera. */
async function pintarClaveLilit() {
  const el = $('#lilit-clave-estado');
  if (!el) return;
  try {
    const d = await api('/api/lilit/clave');
    el.textContent = d.configurada
      ? `configurada (termina en ${d.cola}) · ${d.modelo}`
      : 'sin clave: usa sus propias frases';
    el.className = d.configurada ? 'bien' : 'muted';
    $('#lilit-clave-borrar').hidden = !d.configurada;
    $('#lilit-clave').placeholder = d.configurada ? 'pega otra para reemplazarla' : 'gsk_…';
  } catch (e) {
    el.textContent = e.message;
    el.className = 'mal';
  }
}

if ($('#lilit-clave-guardar')) {
  $('#lilit-clave-guardar').onclick = async () => {
    const campo = $('#lilit-clave');
    const err = $('#lilit-clave-error');
    err.textContent = '';
    if (!campo.value.trim()) { err.textContent = 'pega la clave'; return; }
    $('#lilit-clave-guardar').disabled = true;
    $('#lilit-clave-guardar').textContent = 'comprobando…';
    try {
      // Se comprueba contra el servicio ANTES de guardar: una clave mala
      // dejaria a LILIT con el diccionario para siempre sin decir por que.
      const r = await api('/api/lilit/clave', { method: 'POST', body: JSON.stringify({ clave: campo.value.trim() }) });
      campo.value = '';
      err.textContent = '';
      $('#lilit-clave-estado').textContent =
        `guardada · ${r.modelos} modelos${r.tieneElNuestro ? '' : ' (OJO: no incluye el que usamos)'}`;
      $('#lilit-clave-estado').className = r.tieneElNuestro ? 'bien' : 'mal';
      await pintarClaveLilit();
    } catch (e) {
      err.textContent = e.message;
    }
    $('#lilit-clave-guardar').disabled = false;
    $('#lilit-clave-guardar').textContent = 'Comprobar y guardar';
  };

  $('#lilit-clave-borrar').onclick = async () => {
    if (!confirm('Quitar la clave? LILIT seguira avisando con sus propias frases.')) return;
    await api('/api/lilit/clave', { method: 'DELETE' }).catch(() => {});
    await pintarClaveLilit();
  };
}

async function pintarExternos() {
  const caja = $('#externos-lista');
  if (!caja) return;
  try {
    const { externos, recepcion } = await api('/api/externos');
    $('#externos-resumen').textContent = recepcion.length
      ? `atiende: ${recepcion.map((r) => r.nombre).join(', ')}`
      : 'nadie atiende la puerta';
    $('#externos-resumen').className = recepcion.length ? 'muted' : 'mal';
    caja.innerHTML = externos.length ? externos.map((e) => `
      <div class="fila">
        <span class="k">${escapeHtml(e.nombre)}${e.activo ? '' : ' (revocado)'}</span>
        <span>
          ${e.pendientes ? `${e.pendientes} sin recoger · ` : ''}
          ${e.ultimo_visto ? new Date(e.ultimo_visto).toLocaleString() : 'nunca conectado'}
          ${e.activo ? `<button type="button" class="enlace" data-rev="${e.id}">revocar</button>` : ''}
          <button type="button" class="enlace" data-del="${e.id}">borrar</button>
        </span>
      </div>`).join('') : '<p class="muted" style="font-size:.74rem">Ninguno todavia.</p>';

    caja.querySelectorAll('[data-rev]').forEach((b) => {
      b.onclick = async () => {
        await api(`/api/externos/${b.dataset.rev}`, { method: 'POST' }).catch(() => {});
        pintarExternos();
      };
    });
    caja.querySelectorAll('[data-del]').forEach((b) => {
      b.onclick = async () => {
        if (!confirm('Borrar esta credencial y su cola de mensajes?')) return;
        await api(`/api/externos/${b.dataset.del}`, { method: 'DELETE' }).catch(() => {});
        pintarExternos();
      };
    });
  } catch (e) {
    caja.innerHTML = `<p class="error">${escapeHtml(e.message)}</p>`;
  }
}

if ($('#externo-crear')) {
  $('#externo-crear').onclick = async () => {
    const nombre = $('#externo-nombre').value.trim();
    $('#externo-error').textContent = '';
    if (!nombre) { $('#externo-error').textContent = 'ponle un nombre'; return; }
    try {
      const r = await api('/api/externos', { method: 'POST', body: JSON.stringify({ nombre }) });
      // Se ensena una sola vez: solo se guarda su huella.
      $('#externo-token-valor').textContent = r.token;
      $('#externo-token').hidden = false;
      $('#externo-copiado').textContent = '';
      // Copiar importa mas que de costumbre: es la unica vez que se ve.
      $('#externo-copiar').onclick = async () => {
        try {
          await navigator.clipboard.writeText(r.token);
          $('#externo-copiado').textContent = 'copiado';
        } catch {
          $('#externo-copiado').textContent = 'el navegador no dejo copiar: seleccionalo a mano';
        }
      };
      $('#externo-nombre').value = '';
      await pintarExternos();
    } catch (e) {
      $('#externo-error').textContent = e.message;
    }
  };
}

async function pintarCodex() {
  const est = $('#codex-estado');
  if (!est) return;
  try {
    const { proveedores } = await api('/api/providers');
    const c = proveedores.find((x) => x.proveedor === 'codex') || {};
    if (!c.instalado) {
      est.textContent = 'no instalado en este servidor';
      est.className = 'mal';
      $('#codex-login').disabled = true;
      return;
    }
    est.textContent = c.conectado ? 'conectado' : 'sin sesion';
    est.className = c.conectado ? 'bien' : 'mal';

    // Misma ficha que Claude. El CLI de Codex no publica nada de esto: sale
    // del id_token de la sesion, que es un JWT y se puede leer.
    const ficha = $('#codex-ficha');
    if (ficha) {
      if (!c.conectado) { ficha.innerHTML = ''; } else {
        const cad = c.expiraIso ? new Date(c.expiraIso).toLocaleString() : '—';
        ficha.innerHTML = `
          <div class="fila"><span class="k">Cuenta</span><span>${escapeHtml(c.cuenta || '—')}</span></div>
          <div class="fila"><span class="k">Titular</span><span>${escapeHtml(c.nombre || '—')}</span></div>
          <div class="fila"><span class="k">Plan</span><span>${escapeHtml(c.plan || '—')}</span></div>
          <div class="fila"><span class="k">Credencial</span>
            <span class="${c.vigente ? 'bien' : ''}">${escapeHtml(cad)}${c.vigente ? '' : ' · se renovara sola'}</span></div>
          <div class="fila"><span class="k">Sesion en</span>
            <span style="font-size:.72rem">${escapeHtml(c.sessionDir || '')}</span></div>
          <div class="fila muted" style="font-size:.74rem">
            <span>Consumo de la ventana: Codex no lo publica. Aparecera aqui si lo informa durante un turno.</span></div>`;
      }
    }
    $('#codex-logout').hidden = !c.conectado;
    $('#codex-login').hidden = c.conectado;
    if (c.conectado) pararEsperaCodex();
  } catch (e) {
    est.textContent = `no se pudo consultar: ${e.message}`;
    est.className = 'mal';
  }
}

function pararEsperaCodex() {
  if (relojCodex) { clearInterval(relojCodex); relojCodex = null; }
  $('#codex-paso').hidden = true;
  $('#codex-cancelar').hidden = true;
  $('#codex-login').disabled = false;
  $('#codex-login').textContent = 'Conectar ChatGPT';
}

// Interruptor de voz. Se prueba al encenderlo: ademas de confirmar que se
// oye, muchos navegadores exigen un gesto del usuario antes de dejar hablar.
// Escuchar como suena un especialista antes de guardarlo. Util porque la
// voz sale de su nombre: cambiar el nombre cambia la voz.
if ($('#voz-probar')) {
  const nota = $('#voz-prueba-nota');
  $('#voz-probar').onclick = () => {
    if (!VOZ.soportado) { nota.textContent = 'este navegador no sabe hablar'; return; }
    const n = ($('#agent-form').elements.name.value || '').trim() || 'Sin nombre';
    nota.textContent = VOZ.cuantas
      ? `${n} · ${VOZ.cuantas} voces disponibles`
      : 'sin voces instaladas en el sistema';
    VOZ.prueba(n);
  };
}

if ($('#voz-on')) {
  const caja = $('#voz-caja');
  if (!VOZ.soportado) { caja.hidden = true; } else {
    $('#voz-on').checked = VOZ.activa;
    $('#voz-on').onchange = (e) => {
      VOZ.activa = e.target.checked;
      if (VOZ.activa) VOZ.prueba(NOMBRE_APP.split('·')[0].trim() || 'Equipo');
    };
  }
}

if ($('#codex-login')) {
  $('#codex-login').onclick = async () => {
    $('#codex-error').textContent = '';
    $('#codex-login').disabled = true;
    $('#codex-login').textContent = 'Pidiendo codigo…';
    try {
      const r = await api('/api/providers/codex/login', { method: 'POST' });
      $('#codex-url').href = r.url;
      $('#codex-url').textContent = r.url;
      $('#codex-codigo').textContent = r.codigo;
      $('#codex-paso').hidden = false;
      $('#codex-cancelar').hidden = false;
      $('#codex-login').textContent = 'Esperando autorizacion…';

      let restan = r.expiraEn || 900;
      const tic = async () => {
        restan -= 3;
        const m = Math.max(0, Math.floor(restan / 60));
        const sg = Math.max(0, restan % 60);
        $('#codex-espera').textContent = `El codigo caduca en ${m}:${String(sg).padStart(2, '0')}`;
        try {
          const est = await api('/api/providers/codex/check');
          if (est.listo) {
            pararEsperaCodex();
            await pintarCodex();
            await refreshAll();
          } else if (est.error) {
            $('#codex-error').textContent = est.error;
            pararEsperaCodex();
          }
        } catch { /* se reintenta en el siguiente ciclo */ }
        if (restan <= 0) { $('#codex-error').textContent = 'El codigo caduco. Vuelve a empezar.'; pararEsperaCodex(); }
      };
      relojCodex = setInterval(tic, 3000);
    } catch (e) {
      $('#codex-error').textContent = e.message;
      pararEsperaCodex();
    }
  };

  $('#codex-cancelar').onclick = async () => {
    await api('/api/providers/codex/cancel', { method: 'POST' }).catch(() => {});
    pararEsperaCodex();
  };

  $('#codex-logout').onclick = async () => {
    if (!confirm('Desconectar ChatGPT? Los especialistas asignados a Codex dejaran de poder trabajar.')) return;
    await api('/api/providers/codex/logout', { method: 'POST' }).catch(() => {});
    await pintarCodex();
  };
}

// ---------------------------------------------------------------------------
// Temas. Un tema es un juego de variables CSS; aqui solo se elige cual.
// Se guarda en el navegador, no en el servidor: es como TU ves el sistema, y
// en el movil querras uno distinto que en el escritorio.

const TEMAS = [
  { id: 'oscuro', nombre: 'Oscuro', colores: ['#0f1115', '#1c2029', '#5b9dff', '#e6e9ef'] },
  { id: 'claro',  nombre: 'Claro',  colores: ['#ffffff', '#e9edf3', '#1f6feb', '#1a1f29'] },
  { id: 'matrix', nombre: 'Matrix', colores: ['#000500', '#07200f', '#2bd4a0', '#8cffb9'] }
];

// Al arrancar: deja la etiqueta de color del navegador acorde al tema que
// el script de la cabecera ya aplico.
function temaActual() {
  try { return localStorage.getItem('v4-tema') || 'oscuro'; } catch { return 'oscuro'; }
}

function aplicarTema(id) {
  if (id === 'oscuro') delete document.documentElement.dataset.tema;
  else document.documentElement.dataset.tema = id;
  try { localStorage.setItem('v4-tema', id); } catch { /* sin almacenamiento */ }

  // El color de la barra del navegador y del movil sale de esta etiqueta: sin
  // actualizarla, en claro quedaria una franja negra arriba.
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) {
    meta.content = getComputedStyle(document.documentElement)
      .getPropertyValue('--bg').trim() || '#080a0d';
  }
  const t = TEMAS.find((x) => x.id === id);
  if ($('#tema-nombre')) $('#tema-nombre').textContent = t ? t.nombre : id;
  pintarTemas();
}

function pintarTemas() {
  const caja = $('#temas');
  if (!caja) return;
  const actual = temaActual();
  caja.innerHTML = TEMAS.map((t) => `
    <button type="button" data-tema="${t.id}" class="${t.id === actual ? 'sel' : ''}">
      <span class="muestra">${t.colores.map((c) => `<i style="background:${c}"></i>`).join('')}</span>
      ${escapeHtml(t.nombre)}
    </button>`).join('');
  for (const b of caja.querySelectorAll('button')) {
    b.onclick = () => aplicarTema(b.dataset.tema);
  }
}

// ---------------------------------------------------------------------------
// Icono de la aplicacion. Se dibuja en el servidor a partir de una semilla,
// asi que elegir es solo decidir que semilla se guarda.

let iconoElegido = null;

function pintarIconos(d) {
  iconoElegido = d.actual;
  const r = d.receta || {};
  $('#icono-desc').textContent = r.forma ? `${r.forma}, ${r.nodos} nodos` : '';
  $('#icono-opciones').innerHTML = d.opciones.map((s) => {
    const sel = s === d.actual ? ' sel' : '';
    return `<button type="button" class="op${sel}" data-semilla="${escapeHtml(s)}"
      title="${s === d.actual ? 'el actual' : 'usar este'}">
      <img src="/icons/icon-192-${encodeURIComponent(s)}.png" alt="" loading="lazy"></button>`;
  }).join('');

  for (const b of $('#icono-opciones').querySelectorAll('button')) {
    b.onclick = async () => {
      const semilla = b.dataset.semilla;
      if (semilla === iconoElegido) return;
      $('#icono-error').textContent = '';
      $('#icono-estado').textContent = 'guardando…';
      try {
        const out = await api('/api/iconos', {
          method: 'POST', body: JSON.stringify({ semilla })
        });
        iconoElegido = out.actual;
        for (const o of $('#icono-opciones').querySelectorAll('button')) {
          o.classList.toggle('sel', o.dataset.semilla === out.actual);
        }
        $('#icono-desc').textContent = `${out.receta.forma}, ${out.receta.nodos} nodos`;
        // El icono de la pestana se cambia en caliente; el de la aplicacion
        // instalada lo refresca el sistema cuando le toca.
        const link = document.querySelector('link[rel="icon"]');
        if (link) link.href = `/icons/icon-192-${encodeURIComponent(out.actual)}.png`;
        $('#icono-estado').textContent = 'guardado. Si la tienes instalada, reinstalala para verlo ahi.';
      } catch (e) {
        $('#icono-error').textContent = e.message;
        $('#icono-estado').textContent = '';
      }
    };
  }
}

async function pintarIconosCaja(otras) {
  if (!$('#icono-opciones')) return;
  try {
    pintarIconos(await api('/api/iconos?n=' + (otras ? 12 : 8)));
  } catch (e) {
    $('#icono-error').textContent = e.message;
  }
}

if ($('#icono-otros')) {
  $('#icono-otros').onclick = async () => {
    $('#icono-estado').textContent = '';
    await pintarIconosCaja(true);
  };
}

// ---------------------------------------------------------------------------
// Actualizar desde la web. Lo unico que hace esta parte es mirar y pulsar: el
// trabajo corre en el servidor, en un proceso que sobrevive al reinicio.

let actEstado = null;
let actRelojId = null;

const ACT_ICONOS = {
  inicio: '•', copia: '🗃', traer: '↓', aplicar: '⤓', revisar: '🔍',
  reiniciar: '↻', comprobar: '✓', deshacer: '↺', fin: '●', sucio: '!'
};

function fechaCorta(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return d.toLocaleDateString([], { day: 'numeric', month: 'short' });
}

function pintarProgresoAct(pr) {
  const caja = $('#act-progreso');
  if (!pr || !pr.pasos.length) { caja.hidden = true; caja.innerHTML = ''; return; }
  caja.hidden = false;
  caja.innerHTML = pr.pasos.map((p, i) => {
    // Los pasos "curso" que ya tienen otro detras estan hechos; el ultimo es
    // el que esta ocurriendo ahora mismo.
    const esUltimo = i === pr.pasos.length - 1;
    const clase = p.estado === 'curso' ? (esUltimo && !pr.terminado ? 'curso' : 'hecho') : p.estado;
    const ic = p.estado === 'listo' ? '✓'
      : (p.estado === 'error' || p.estado === 'revertido') ? '✕'
      : p.estado === 'aviso' ? '⚠'
      : (clase === 'hecho' ? '✓' : (ACT_ICONOS[p.paso] || '•'));
    return `<div class="p ${clase}"><span class="ic">${ic}</span>`
      + `<span>${escapeHtml(p.mensaje)}</span></div>`;
  }).join('');
}

function pintarActualizacion(e) {
  if (!e) return;
  actEstado = e;

  $('#act-version').textContent = e.version
    ? `${e.version}${e.fecha ? ' · ' + fechaCorta(e.fecha) : ''}`
    : 'desconocida';
  $('#act-titulo').textContent = e.titulo || '';

  const corriendo = e.enCurso || (e.progreso && !e.progreso.terminado);

  // Lista de cambios que entrarian al instalar.
  const nov = $('#act-novedades');
  if (e.hayNuevos && !corriendo) {
    nov.hidden = false;
    nov.innerHTML = e.nuevos.map((c) =>
      `<div class="cambio"><code>${escapeHtml(c.sha)}</code>${escapeHtml(c.titulo)}</div>`).join('');
  } else {
    nov.hidden = true;
    nov.innerHTML = '';
  }

  pintarProgresoAct(e.progreso);

  const nota = $('#act-nota');
  const err = $('#act-error');
  err.textContent = '';

  if (corriendo) {
    nota.textContent = 'Instalando. Puedes cerrar esta ventana: el trabajo no se para.';
  } else if (e.progreso && e.progreso.estado === 'error') {
    nota.textContent = 'No se instalo nada. Tu version sigue intacta.';
  } else if (e.progreso && e.progreso.estado === 'revertido') {
    nota.textContent = 'Se volvio sola a la version anterior.';
  } else if (!e.limpio) {
    nota.innerHTML = `<span class="act-hay">Hay ${e.sucio} archivo(s) editados en el servidor.</span> `
      + 'Actualizar los machacaria, asi que el boton esta desactivado.';
  } else if (e.hayNuevos) {
    const n = e.nuevos.length;
    nota.innerHTML = `<span class="act-hay">${n} cambio${n === 1 ? '' : 's'} nuevo${n === 1 ? '' : 's'} esperando.</span>`
      + (e.trabajando.length
        ? ` Ojo: ${escapeHtml(e.trabajando.join(', '))} esta${e.trabajando.length === 1 ? '' : 'n'} trabajando y el reinicio les cortaria el turno.`
        : '');
  } else {
    nota.innerHTML = `<span class="act-dia">Estas al dia.</span>`
      + (e.comprobado ? ` Mirado el ${fechaCorta(e.comprobado)}.` : '');
  }

  $('#act-instalar').hidden = !(e.hayNuevos && e.limpio) || corriendo;
  $('#act-buscar').disabled = corriendo;
  $('#act-revertir').hidden = !e.anterior || corriendo;
  if (e.anterior && e.tituloAnterior) {
    $('#act-revertir').title = 'Volver a ' + e.tituloAnterior;
  }

  // Mientras instala, refrescamos para ver avanzar los pasos. Al terminar
  // dejamos de molestar al servidor.
  if (corriendo && !actRelojId) {
    actRelojId = setInterval(refrescarActualizacion, 2000);
  } else if (!corriendo && actRelojId) {
    clearInterval(actRelojId); actRelojId = null;
    // Si acabo de instalarse algo, la pagina que tienes cargada es la vieja.
    if (e.progreso && e.progreso.estado === 'listo' && e.progreso.pasos.length > 1) {
      $('#aviso-version').hidden = false;
    }
  }
}

async function refrescarActualizacion() {
  try { pintarActualizacion(await api('/api/actualizacion')); }
  catch { /* si el servicio esta reiniciandose, el siguiente intento lo coge */ }
}

if ($('#act-buscar')) {
  $('#act-buscar').onclick = async () => {
    const b = $('#act-buscar');
    b.disabled = true; b.textContent = 'Preguntando a GitHub…';
    $('#act-error').textContent = '';
    try {
      pintarActualizacion(await api('/api/actualizacion/buscar', { method: 'POST', body: '{}' }));
    } catch (e) {
      $('#act-error').textContent = e.message;
    }
    b.disabled = false; b.textContent = 'Buscar actualizacion';
  };

  $('#act-instalar').onclick = async () => {
    const b = $('#act-instalar');
    const ocupados = (actEstado && actEstado.trabajando) || [];
    if (ocupados.length && !confirm(
      `${ocupados.join(', ')} esta${ocupados.length === 1 ? '' : 'n'} trabajando ahora mismo.\n\n`
      + 'Al reiniciar se les corta el turno a medias y habra que volver a pedirlo.\n\n'
      + '¿Instalar de todos modos?')) return;

    b.disabled = true; b.textContent = 'Lanzando…';
    $('#act-error').textContent = '';
    try {
      await api('/api/actualizacion/aplicar', {
        method: 'POST', body: JSON.stringify({ aunqueTrabajen: ocupados.length > 0 })
      });
      await refrescarActualizacion();
    } catch (e) {
      $('#act-error').textContent = e.message;
      b.disabled = false; b.textContent = 'Instalar';
    }
  };

  $('#act-revertir').onclick = async () => {
    const a = actEstado && actEstado.tituloAnterior;
    if (!confirm(`Volver a la version anterior${a ? ':\n\n' + a : ''}\n\n`
      + 'Tus conversaciones y especialistas no se tocan.\n\n¿Seguir?')) return;
    const b = $('#act-revertir');
    b.disabled = true; b.textContent = 'Volviendo…';
    $('#act-error').textContent = '';
    try {
      await api('/api/actualizacion/revertir', { method: 'POST', body: '{}' });
      await refrescarActualizacion();
    } catch (e) {
      $('#act-error').textContent = e.message;
      b.disabled = false; b.textContent = 'Volver atras';
    }
  };
}

$('#btn-proveedor').onclick = async () => {
  $('#prov-paso-url').hidden = true;
  $('#prov-acciones').hidden = false;
  $('#prov-error').textContent = '';
  $('#prov-codigo').value = '';
  $('#proveedor-dialog').showModal();
  await pintarProveedor();
  pintarTemas();
  await pintarIconosCaja();
  await refrescarActualizacion();
  await pintarGasto();
  await pintarClaveLilit();
  await pintarExternos();
  await pintarCodex();
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
    // Los colores salen del tema, no del codigo: en claro la lluvia tiene que
    // ser gris azulada sobre blanco o no se ve nada.
    const css = getComputedStyle(document.documentElement);
    const estela = css.getPropertyValue('--matrix-estela').trim() || 'rgba(8,10,13,0.08)';
    const normal = css.getPropertyValue('--matrix').trim() || '#2bd4a0';
    const brillo = css.getPropertyValue('--matrix-brillo').trim() || '#9ff5cf';
    // Un velo en vez de borrar: deja la estela que da la sensacion de caida.
    ctx.fillStyle = estela;
    ctx.fillRect(0, 0, ancho, alto);
    ctx.font = '13px ui-monospace, monospace';
    for (let i = 0; i < cols.length; i++) {
      const x = i * 16;
      const y = cols[i];
      ctx.fillStyle = Math.random() < 0.015 ? brillo : normal;
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
      ['send-form', 'edit-agent', 'reset-session', 'compactar', 'parar', 'notas',
        'ver-compositor']
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

/**
 * Texto del boton de la barra lateral.
 *
 * Con un solo proveedor bastaba su nombre. Con dos, llamarlo "Claudio"
 * escondia que ahi dentro tambien se conecta ChatGPT: habia que saberlo de
 * antemano para encontrarlo. Ahora resume quien esta conectado.
 */
function etiquetaProveedores(lista, claudeMal) {
  const el = $('#proveedor-etiqueta');
  if (!el) return;
  const codex = (lista || []).find((x) => x.proveedor === 'codex');
  const partes = [claudeMal ? `${NOMBRE_PROVEEDOR} ⚠` : NOMBRE_PROVEEDOR];
  if (codex && codex.instalado) partes.push(codex.conectado ? 'ChatGPT' : 'ChatGPT ⚠');
  el.textContent = partes.join(' · ');
}
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
/**
 * Proveedor del especialista. Los modelos dependen de el, asi que al
 * cambiarlo se vuelven a montar: ofrecer modelos de Claude a un especialista
 * que corre sobre Codex solo lleva a un turno fallido.
 */
function montarProveedores(actual) {
  const sel = $('#sel-proveedor');
  if (!sel) return;
  const lista = PROVEEDORES.length ? PROVEEDORES : [{ nombre: 'claude', etiqueta: 'Claude', instalado: true, reanuda: true }];
  sel.innerHTML = lista.map((p) =>
    `<option value="${escapeHtml(p.nombre)}"${p.instalado ? '' : ' disabled'}>`
    + `${escapeHtml(p.etiqueta)}${p.instalado ? '' : ' — no instalado'}</option>`).join('');
  sel.value = actual || (lista.find((p) => p.instalado) || lista[0]).nombre;
  notaProveedor();
  sel.onchange = () => { notaProveedor(); montarModelos(''); };
}

function notaProveedor() {
  const sel = $('#sel-proveedor');
  const nota = $('#prov-nota');
  if (!sel || !nota) return;
  const p = PROVEEDORES.find((x) => x.nombre === sel.value);
  const avisos = [];
  if (p && !p.instalado) avisos.push('no esta instalado en este servidor');
  if (p && !p.reanuda) avisos.push('no conserva la conversacion entre turnos');
  nota.textContent = avisos.join(' · ');
  nota.style.color = avisos.length ? '#e8b84b' : '';
}

function montarModelos(actual) {
  const sel = $('#sel-modelo');
  if (!sel) return;
  // Los modelos son los del proveedor elegido, no una lista fija.
  const nomProv = ($('#sel-proveedor') && $('#sel-proveedor').value) || 'claude';
  const prov = PROVEEDORES.find((p) => p.nombre === nomProv);
  const sugeridos = (prov && prov.modelos)
    || (OPCIONES && OPCIONES.modelos) || ['haiku', 'sonnet', 'opus', 'opusplan', 'fable'];
  // El "por defecto" es el del proveedor elegido. Antes decia siempre
  // "sonnet", el de Claude, incluso con Codex seleccionado.
  const porDefecto = prov
    ? (prov.modeloPorDefecto || 'el que elija el CLI')
    : ((OPCIONES && OPCIONES.modeloPorDefecto) || 'sonnet');

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
  if ($('#agent-form').elements.recepcion) {
    $('#agent-form').elements.recepcion.checked = !!(agent && agent.recepcion);
  }
  montarProveedores(agent ? (agent.proveedor || '') : '');
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
    proveedor: (c.proveedor && c.proveedor.value) || null,
    recepcion: !!(c.recepcion && c.recepcion.checked),
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

// ------------------------------------------------------------- reloj

/**
 * Hora en la zona del servidor, junto al nombre de la instalacion.
 *
 * Importa que sea la del servidor y no la del navegador: el aviso de cuota
 * dice "resets 6:10pm (America/Lima)", y un reloj en otra zona obligaria a
 * hacer la cuenta justo cuando hay prisa. Debajo, cuanto falta para que
 * vuelva la cuota, si es que se agoto.
 */
let ZONA = 'America/Lima';
let DESFASE_MS = 0;     // diferencia entre el reloj del navegador y el del servidor

function pintarReloj() {
  const el = $('#reloj');
  if (!el) return;
  const ahora = new Date(Date.now() + DESFASE_MS);
  let hora;
  try {
    hora = ahora.toLocaleTimeString('es', { timeZone: ZONA, hour: '2-digit', minute: '2-digit' });
  } catch { hora = ahora.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' }); }
  const corta = ZONA.split('/').pop().replace(/_/g, ' ');
  // Solo la hora. El aviso de cuota tiene su propia linea: metido aqui no
  // cabia en la cabecera y se comia el nombre de la instalacion.
  el.textContent = `${hora} ${corta}`;
  el.classList.toggle('esperando', !!ESPERA_CUOTA.length);
  pintarAvisoCuota();
}

let ESPERA_CUOTA = [];

/** Hora de pared del servidor para un instante, sin la fecha. */
function horaDe(iso) {
  const d = new Date(iso);
  try {
    return d.toLocaleTimeString('es', { timeZone: ZONA, hour: '2-digit', minute: '2-digit' });
  } catch { return d.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' }); }
}

function pintarAvisoCuota() {
  const caja = $('#aviso-cuota');
  if (!caja) return;
  if (!ESPERA_CUOTA.length) { caja.hidden = true; return; }
  const proximo = ESPERA_CUOTA.reduce((a, b) => (a.proximo < b.proximo ? a : b));
  const n = ESPERA_CUOTA.length;
  caja.hidden = false;
  // Se da la hora ademas de la cuenta atras: "en 14m" obliga a mirar el
  // reloj y sumar, y estos avisos se leen de reojo.
  caja.innerHTML = `Sin cuota: ${n} ${n === 1 ? 'trabajo espera' : 'trabajos esperan'}.`
    + ` Reanuda <b>${escapeHtml(horaDe(proximo.proximo))}</b> (${escapeHtml(faltan(proximo.proximo))}).`;
}

function faltan(iso) {
  const ms = new Date(iso).getTime() - (Date.now() + DESFASE_MS);
  if (ms <= 0) return 'ya';
  const m = Math.round(ms / 60000);
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
}

function actualizarEspera(lista) {
  ESPERA_CUOTA = Array.isArray(lista) ? lista : [];
  pintarAvisoCuota();
}

setInterval(pintarReloj, 1000);

// -------------------------------------------------------------- notas

/**
 * Libreta privada por especialista.
 *
 * Sirve para dejar preparada una serie de ordenes y pegarlas a medida que
 * el especialista va terminando. El texto se guarda en el servidor, no en
 * el navegador, porque se entra desde el movil y desde el escritorio.
 *
 * No llega al modelo por ningun camino: no esta en las instrucciones, ni en
 * el prompt del turno, ni en el contexto. Es un margen, no parte de la
 * conversacion.
 */
async function abrirNotas() {
  if (!selected) return;
  const a = agents.find((x) => x.id === selected);
  $('#notas-quien').textContent = a ? a.name : '';
  $('#notas-estado').textContent = '';
  const caja = $('#notas-texto');
  caja.value = 'cargando…';
  caja.disabled = true;
  $('#notas-dialog').showModal();
  try {
    const { notas } = await api(`/api/agents/${selected}/notas`);
    caja.value = notas || '';
  } catch (e) {
    caja.value = '';
    $('#notas-estado').textContent = `No se pudieron cargar: ${e.message}`;
  }
  caja.disabled = false;
}

async function guardarNotas() {
  if (!selected) return;
  const texto = $('#notas-texto').value;
  try {
    await api(`/api/agents/${selected}/notas`, { method: 'PUT', body: JSON.stringify({ notas: texto }) });
    const a = agents.find((x) => x.id === selected);
    if (a) a.tiene_notas = !!texto.trim();
    marcarBotonNotas(a);
  } catch (e) {
    $('#notas-estado').textContent = `No se pudieron guardar: ${e.message}`;
  }
}

function marcarBotonNotas(a) {
  const b = $('#notas');
  if (b) b.classList.toggle('tiene', !!(a && a.tiene_notas));
}

if ($('#notas')) $('#notas').onclick = abrirNotas;
if ($('#notas-form')) {
  $('#notas-form').addEventListener('submit', () => { guardarNotas(); });
  $('#notas-cerrar').onclick = () => $('#notas-dialog').close();
  $('#notas-copiar').onclick = async () => {
    try {
      await navigator.clipboard.writeText($('#notas-texto').value);
      $('#notas-estado').textContent = 'Copiado.';
    } catch { $('#notas-estado').textContent = 'El navegador no dejo copiar.'; }
  };
  $('#notas-al-mensaje').onclick = () => {
    // Se añade a lo que ya hubiera escrito en vez de pisarlo.
    const caja = $('#send-text');
    const previo = caja.value.trim();
    caja.value = previo ? `${previo}\n${$('#notas-texto').value}` : $('#notas-texto').value;
    $('#notas-dialog').close();
    caja.focus();
  };
}

// ----------------------------------------------------------- LILIT

/**
 * Auditora: mira el estado cada minuto y habla solo si hay algo nuevo.
 *
 * Lo importante es lo que NO hace: no repite lo que ya dijo. Un aviso que
 * se repite cada minuto se deja de escuchar al segundo dia, y entonces no
 * sirve para nada.
 */
let LILIT_ACTIVA = localStorage.getItem('v4-lilit') === '1';
const lilitDichos = new Set();
let lilitReloj = null;

async function lilitMirar() {
  if (!LILIT_ACTIVA) return;
  let hallazgos = [];
  try { ({ hallazgos } = await api('/api/lilit')); } catch { return; }

  const nuevos = hallazgos.filter((h) => !lilitDichos.has(h.clave));
  // Lo que ya no aparece deja de estar "dicho": si vuelve a pasar, vuelve a avisar.
  const vivas = new Set(hallazgos.map((h) => h.clave));
  for (const c of [...lilitDichos]) if (!vivas.has(c)) lilitDichos.delete(c);
  if (!nuevos.length) return;
  for (const h of nuevos) lilitDichos.add(h.clave);

  const urgentes = nuevos.filter((h) => h.nivel === 'urgente');
  const hablar = urgentes.length ? urgentes : nuevos.filter((h) => h.nivel !== 'bajo');
  if (!hablar.length) return;

  let texto = hablar.map((h) => h.texto).join(' ');
  // Con varias cosas a la vez, una lista de frases sueltas suena torpe: se
  // intenta que el modelo externo lo diga de corrido. Si no puede, se usa
  // lo que ya tenemos.
  if (hablar.length > 1) {
    try {
      const r = await api('/api/lilit/redactar', { method: 'POST', body: JSON.stringify({ hallazgos: hablar }) });
      if (r.texto) texto = r.texto;
    } catch { /* el diccionario ya sirve */ }
  }
  VOZ.anuncia('Lilit', texto, { completo: true, sinNombre: true });
  const t = document.querySelector('.tab[data-tab="lilit"]');
  if (t && urgentes.length) t.classList.add('avisa');
}

/**
 * Informe a peticion: LILIT cuenta como esta todo ahora, aunque no haya
 * nada nuevo. Es distinto de la vigilancia automatica, que calla cuando no
 * hay novedades.
 */
if ($('#lilit-estado')) {
  $('#lilit-estado').onclick = async () => {
    const b = $('#lilit-estado');
    b.disabled = true;
    try {
      const { hallazgos, actividad } = await api('/api/lilit');
      // El parte empieza por "como vamos", que es lo que se pregunta al
      // pulsarlo. La vigilancia automatica no dice esto: anunciar quien
      // trabaja cada vez que cambia seria ruido continuo.
      const partes = [`Señor. ${actividad.texto}`];

      // Al pedirlo a mano se cuentan tambien los de nivel bajo: aqui se
      // quiere el parte completo, no solo lo urgente.
      if (!hallazgos.length) {
        partes.push('No hay nada que reportar.');
      } else {
        let texto = hallazgos.map((h) => h.texto).join(' ');
        if (hallazgos.length > 1) {
          try {
            const r = await api('/api/lilit/redactar', {
              method: 'POST', body: JSON.stringify({ hallazgos })
            });
            if (r.texto) texto = r.texto;
          } catch { /* el diccionario ya sirve */ }
        }
        partes.push(texto);
        // Se dan por dichos: no tiene sentido que los repita un minuto despues.
        for (const h of hallazgos) lilitDichos.add(h.clave);
      }
      VOZ.anunciaSiempre('Lilit', partes.join(' '), { completo: true, sinNombre: true });
      setView('panel');
      document.querySelector('.tab[data-tab="lilit"]').click();
    } catch (e) {
      alert(`No se pudo consultar a LILIT: ${e.message}`);
    }
    b.disabled = false;
  };
}

if ($('#lilit-on')) {
  const caja = $('#lilit-caja');
  if (!VOZ.soportado) { caja.hidden = true; } else {
    $('#lilit-on').checked = LILIT_ACTIVA;
    $('#lilit-on').onchange = (e) => {
      LILIT_ACTIVA = e.target.checked;
      localStorage.setItem('v4-lilit', LILIT_ACTIVA ? '1' : '0');
      if (LILIT_ACTIVA) {
        VOZ.activa = true;
        $('#voz-on').checked = true;
        VOZ.prueba('Lilit');
        lilitDichos.clear();          // al encenderla, cuenta lo que haya ahora
        if (!lilitReloj) lilitReloj = setInterval(lilitMirar, 60000);
        lilitMirar();
      }
    };
    if (LILIT_ACTIVA) { lilitReloj = setInterval(lilitMirar, 60000); lilitMirar(); }
  }
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
      // Se quitan las lineas en blanco de ARRIBA y de abajo. Antes solo se
      // quitaban las de abajo, y un bloque que empezaba con varios saltos
      // dejaba un hueco enorme con el codigo pegado al fondo de la caja.
      // Solo lineas vacias: la sangria de la primera linea real se respeta.
      const codigo = lineas.join('\n')
        .replace(/^(?:[ \t]*\n)+/, '')
        .replace(/(?:\n[ \t]*)+$/, '');
      // OJO: sin saltos ni sangria ENTRE etiquetas. El texto se pinta con
      // white-space:pre-wrap, asi que un salto de linea en la plantilla se
      // ve como un hueco real dentro de la caja. Escribir el HTML "bonito"
      // aqui dejaba el bloque medio vacio con el codigo pegado al fondo.
      return `<div class="bloque">`
        + `<div class="bloque-cab">${escapeHtml(idioma || 'texto')}`
        + `<button type="button" class="copiar">Copiar codigo</button></div>`
        + `<pre><code>${escapeHtml(codigo)}</code></pre></div>`;
    }
    // Las tablas se extraen ANTES de tocar los saltos de linea: una tabla
    // ES su estructura de lineas, y el compactado de abajo la destruiria.
    return conTablas(parte, (suelto) => {
      // Fuera de los bloques de codigo, dos o mas saltos seguidos se quedan en
      // uno: el modelo separa parrafos con lineas en blanco y eso, en una
      // conversacion compacta, deja huecos que parecen mensajes distintos.
      const compacto = suelto.replace(/[ \t]*\n[ \t]*(?:\n[ \t]*)+/g, '\n');
      return enriquecer(escapeHtml(compacto));
    });
  }).join('');
}

/**
 * Convierte las tablas de markdown en tablas de verdad.
 *
 * Llegaban como texto crudo —"| Paquete | Precio |" y su fila de guiones—,
 * que es justo donde peor se lee un dato: columnas desalineadas en cuanto
 * un valor es mas largo que otro.
 *
 * Una tabla son dos lineas como minimo: la cabecera y una fila de guiones
 * (|---|---|). Esa segunda linea es la unica señal fiable de que lo de
 * arriba era una cabecera y no un parrafo que empieza por barra.
 *
 * @param texto  el trozo sin bloques de codigo
 * @param resto  como formatear lo que NO es tabla
 */
function conTablas(texto, resto) {
  const lineas = String(texto).split('\n');
  const esFila = (l) => /^\s*\|.*\|\s*$/.test(l);
  const esGuiones = (l) => /^\s*\|(?:\s*:?-{2,}:?\s*\|)+\s*$/.test(l);

  const fuera = [];
  let sueltas = [];
  const volcar = () => {
    if (sueltas.length) { fuera.push(resto(sueltas.join('\n'))); sueltas = []; }
  };

  for (let i = 0; i < lineas.length; i++) {
    if (esFila(lineas[i]) && esGuiones(lineas[i + 1] || '')) {
      volcar();
      const cabecera = celdas(lineas[i]);
      // La fila de guiones dice como se alinea cada columna.
      const alineos = celdas(lineas[i + 1]).map((c) => (
        /^:-+:$/.test(c.trim()) ? 'center' : /-+:$/.test(c.trim()) ? 'right' : 'left'));
      i += 2;
      const filas = [];
      while (i < lineas.length && esFila(lineas[i])) { filas.push(celdas(lineas[i])); i += 1; }
      i -= 1;
      fuera.push(pintarTabla(cabecera, filas, alineos));
    } else {
      sueltas.push(lineas[i]);
    }
  }
  volcar();
  return fuera.join('');
}

/** Parte una fila por las barras, respetando las barras escapadas (\|). */
function celdas(linea) {
  return String(linea).trim()
    .replace(/^\|/, '').replace(/\|$/, '')
    .split(/(?<!\\)\|/)
    .map((c) => c.replace(/\\\|/g, '|').trim());
}

function pintarTabla(cabecera, filas, alineos) {
  const al = (i) => alineos[i] || 'left';
  // Una celda puede traer `codigo`, rutas o menciones: pasa por lo mismo
  // que el resto del texto.
  const celda = (c) => enriquecer(escapeHtml(c));
  const th = cabecera.map((c, i) => `<th style="text-align:${al(i)}">${celda(c)}</th>`).join('');
  const tr = filas.map((f) => {
    // Una fila corta no debe descuadrar la tabla: se rellena.
    const completa = cabecera.map((_, i) => f[i] === undefined ? '' : f[i]);
    return `<tr>${completa.map((c, i) => {
      // Las cifras se alinean a la derecha aunque la tabla no lo pida: una
      // columna de numeros desalineada no se puede comparar de un vistazo.
      const nIza = al(i) === 'left' && /^[-+]?[\d.,%$€ ]+$/.test(c) && /\d/.test(c);
      return `<td style="text-align:${nIza ? 'right' : al(i)}">${celda(c)}</td>`;
    }).join('')}</tr>`;
  }).join('');
  return `<div class="tabla-caja"><table class="tabla">`
    + `<thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table></div>`;
}

/** Sobre texto YA escapado: enlaces, codigo en linea y rutas copiables. */
function enriquecer(seguro) {
  const nombres = [...agents].sort((a, b) => b.name.length - a.name.length);
  for (const a of nombres) {
    const esc = escapeHtml(a.name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    seguro = seguro.replace(new RegExp(`@${esc}\\b`, 'gi'),
      (hit) => `<span class="mencion">${hit}</span>`);
  }
  // El codigo en linea se aparta ANTES de nada y vuelve al final.
  //
  // Si se convirtiera aqui mismo en etiquetas, la negrita ya no podria
  // cruzarlo: "** `costo` del paquete**" es negrita que CONTIENE codigo, y
  // una regla de negrita que evite < y > -como debe, para no partir el
  // HTML- se quedaria a medias y dejaria los asteriscos a la vista.
  const apartados = [];
  seguro = seguro.replace(/`([^`\n]{1,200})`/g, (_, c) => {
    apartados.push(`<code class="copiable" title="pulsa para copiar">${c}</code>`);
    return `\u0000${apartados.length - 1}\u0000`;
  });

  return seguro
    // Titulos de markdown. Van en un elemento EN LINEA a proposito: el texto
    // se pinta con white-space:pre-wrap, asi que el salto de la propia linea
    // ya separa. Con un elemento de bloque saldria el hueco por duplicado.
    .replace(/^(#{1,4})\s+([^\n]+)/gm, (_, almohadillas, t) =>
      `<span class="tit-md n${almohadillas.length}">${t}</span>`)
    // Negrita. Se excluyen < y > para no cruzar las etiquetas generadas.
    .replace(/\*\*([^*<>\n]{1,200})\*\*/g, '<strong>$1</strong>')
    // enlaces
    .replace(/\bhttps?:\/\/[^\s<>"')]+/g, (u) =>
      `<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`)
    // rutas absolutas del servidor
    .replace(/(^|[\s(])(\/(?:opt|srv|etc|var|usr|home|tmp)\/[^\s<>"'`),;]{2,})/g,
      (_, pre, ruta) => `${pre}<span class="ruta copiable" title="pulsa para copiar">${ruta}</span>`)
    // y vuelve el codigo que apartamos al principio
    .replace(/\u0000(\d+)\u0000/g, (_, n) => apartados[Number(n)] ?? '');
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
