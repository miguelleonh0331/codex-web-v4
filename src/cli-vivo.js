// La consola del CLI, en vivo.
//
// No se puede leer del fichero de registro: ese se escribe entero de golpe
// cuando el turno TERMINA (runner.js, en el evento close), que es justo
// cuando ya no sirve para ver si algo se atasco. La fuente tiene que ser el
// flujo de eventos segun llega, que el runner ya entrega linea a linea.
//
// Aqui se guarda en memoria, por especialista, SOLO lo del turno en curso:
// un anillo corto que se vacia al empezar cada turno. Era el encargo:
// "solo lo ultimo que esta ejecutando, no un scroll con todo el historial".
//
// Memoria: LINEAS x TOPE_DETALLE por especialista, y como mucho AGENTES
// anillos vivos. Con los valores de abajo son unos 240 KB por especialista
// y techo de 5 MB en total, pase lo que pase.

const LINEAS = 120;          // se sirven 100; el resto es colchon
const TOPE_DETALLE = 2000;   // por linea, en caracteres
const TOPE_TEXTO = 600;      // lo que se ve sin desplegar
const AGENTES = 20;          // anillos vivos a la vez

/** agentId -> {turno, seq, lineas:[], ultimo, tocado} */
const anillos = new Map();

function recortar(s, n) {
  const t = String(s == null ? '' : s);
  if (t.length <= n) return t;
  // Cabeza y cola: en una salida larga lo que importa suele estar en los
  // dos extremos, y quedarse solo con el principio esconde el error final.
  const mitad = Math.floor((n - 20) / 2);
  return `${t.slice(0, mitad)}\n […${t.length - n + 20} caracteres mas…]\n${t.slice(-mitad)}`;
}

function unaLinea(s) {
  return String(s == null ? '' : s).replace(/\s*\n\s*/g, ' ⏎ ').trim();
}

function anillo(agentId) {
  let a = anillos.get(agentId);
  if (!a) {
    a = { turno: null, seq: 0, lineas: [], ultimo: Date.now() };
    anillos.set(agentId, a);
    // Techo duro: si hay demasiados, se tira el que lleva mas tiempo sin
    // tocarse. Sin esto, un servidor con muchos especialistas acumularia
    // anillos de turnos terminados hace horas.
    if (anillos.size > AGENTES) {
      let viejo = null;
      for (const [k, v] of anillos) if (!viejo || v.ultimo < anillos.get(viejo).ultimo) viejo = k;
      if (viejo && viejo !== agentId) anillos.delete(viejo);
    }
  }
  return a;
}

/** Turno nuevo: la consola se vacia. Solo se ve lo que esta pasando ahora. */
function empezar(agentId, turnId) {
  const a = anillo(agentId);
  a.turno = turnId;
  a.lineas = [];
  a.ultimo = Date.now();
  // seq NO se reinicia: el navegador pregunta "dame lo posterior a N" y si
  // los numeros volvieran a empezar, se perderia todo el turno nuevo.
  apuntar(agentId, turnId, 'sistema', `— turno ${turnId} —`);
}

function apuntar(agentId, turnId, clase, texto, detalle) {
  const a = anillo(agentId);
  const corto = unaLinea(recortar(texto, TOPE_TEXTO));
  if (!corto) return;
  a.seq += 1;
  a.ultimo = Date.now();
  const fila = { seq: a.seq, t: a.ultimo, clase, texto: corto };
  const largo = detalle == null ? null : recortar(detalle, TOPE_DETALLE);
  if (largo && largo !== corto) fila.detalle = largo;
  a.lineas.push(fila);
  if (a.lineas.length > LINEAS) a.lineas.splice(0, a.lineas.length - LINEAS);
  if (turnId != null) a.turno = turnId;
}

/** Como se resume lo que le entra a cada herramienta. */
function argumentos(nombre, input) {
  const i = input && typeof input === 'object' ? input : {};
  const n = String(nombre || '');
  // El encargo era ver lo que hace sin pedirselo: para eso el dato que
  // cuenta es el comando o la ruta COMPLETOS, no un resumen amable.
  if (n === 'Bash' || n === 'BashOutput') return i.command || i.bash_id || '';
  if (n === 'Read' || n === 'NotebookEdit') return i.file_path || i.notebook_path || '';
  if (n === 'Write') return `${i.file_path || ''}  (${String(i.content || '').length} caracteres)`;
  if (n === 'Edit') return `${i.file_path || ''}\n- ${i.old_string || ''}\n+ ${i.new_string || ''}`;
  if (n === 'Glob' || n === 'Grep') return `${i.pattern || ''}${i.path ? `  en ${i.path}` : ''}`;
  if (n === 'WebFetch' || n === 'WebSearch') return i.url || i.query || '';
  if (n === 'Task' || n === 'Agent') return i.description || i.prompt || '';
  const s = JSON.stringify(i);
  return s === '{}' ? '' : s;
}

/** Texto plano de lo que devolvio una herramienta, venga como venga. */
function salida(contenido) {
  if (typeof contenido === 'string') return contenido;
  if (Array.isArray(contenido)) {
    return contenido.map((c) => {
      if (typeof c === 'string') return c;
      if (c && c.type === 'text') return c.text || '';
      if (c && c.type === 'image') return '[imagen]';
      return '';
    }).filter(Boolean).join('\n');
  }
  return contenido == null ? '' : JSON.stringify(contenido);
}

/**
 * Un evento del CLI -> lineas de consola.
 *
 * Se reconoce el formato de Claude, que es el de los dos motores en modo
 * stream-json. Lo que no se reconozca se enseña en crudo y recortado: es
 * preferible una linea fea a un hueco donde deberia verse lo que pasa.
 */
function anotar(agentId, turnId, ev) {
  if (!ev || typeof ev !== 'object') return;

  if (ev.type === 'system') {
    if (ev.subtype === 'init') {
      apuntar(agentId, turnId, 'sistema',
        `sesion lista · ${ev.model || 'modelo por defecto'} · ${ev.cwd || ''}`);
    }
    return;   // el resto del ruido de sistema no aporta nada mirandolo
  }

  if (ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
    for (const b of ev.message.content) {
      if (b.type === 'thinking') apuntar(agentId, turnId, 'pensando', b.thinking, b.thinking);
      else if (b.type === 'text') apuntar(agentId, turnId, 'dice', b.text, b.text);
      else if (b.type === 'tool_use') {
        const args = argumentos(b.name, b.input);
        apuntar(agentId, turnId, 'herramienta', `${b.name} ${args}`.trim(),
          `${b.name}\n${JSON.stringify(b.input || {}, null, 1)}`);
      }
    }
    return;
  }

  if (ev.type === 'user' && ev.message && Array.isArray(ev.message.content)) {
    for (const b of ev.message.content) {
      if (b.type !== 'tool_result') continue;
      const txt = salida(b.content);
      apuntar(agentId, turnId, b.is_error ? 'error' : 'resultado',
        txt || '(sin salida)', txt);
    }
    return;
  }

  if (ev.type === 'result') {
    apuntar(agentId, turnId, ev.is_error ? 'error' : 'sistema',
      ev.is_error ? `terminado con error: ${ev.subtype || ''}` : '— fin del turno —');
    return;
  }

  // Formato desconocido: en crudo antes que en blanco.
  if (ev.type) apuntar(agentId, turnId, 'otro', `${ev.type}: ${JSON.stringify(ev)}`);
}

/**
 * Lo posterior a `desde`. Devuelve tambien cuanto lleva callado, que es el
 * dato que de verdad dice si se atasco: el contenido dice en que.
 */
function leer(agentId, desde = 0, limite = 100) {
  const a = anillos.get(agentId);
  if (!a) return { lineas: [], seq: 0, turno: null, quietoMs: null, vacio: true };
  const nuevas = a.lineas.filter((l) => l.seq > Number(desde || 0));
  return {
    lineas: nuevas.slice(-limite),
    seq: a.seq,
    turno: a.turno,
    quietoMs: Date.now() - a.ultimo,
    vacio: a.lineas.length === 0
  };
}

function olvidar(agentId) { anillos.delete(agentId); }

module.exports = { empezar, anotar, apuntar, leer, olvidar, argumentos, salida, recortar,
  LINEAS, TOPE_DETALLE, TOPE_TEXTO, AGENTES };
