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
const TOPE_ORDEN = 4000;     // la orden tal cual; un python -c largo cabe
const AGENTES = 20;          // anillos vivos a la vez

/** Eventos que no se pintan: ya se ven en otro sitio de la interfaz. */
const RUIDO = new Set(['rate_limit_event', 'tools_changed', 'stream_event']);

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

function apuntar(agentId, turnId, clase, texto, detalle, extra) {
  const a = anillo(agentId);
  const corto = unaLinea(recortar(texto, TOPE_TEXTO));
  if (!corto) return;
  a.seq += 1;
  a.ultimo = Date.now();
  const fila = { seq: a.seq, t: a.ultimo, clase, texto: corto };
  const largo = detalle == null ? null : recortar(detalle, TOPE_DETALLE);
  if (largo && largo !== corto) fila.detalle = largo;
  if (extra) Object.assign(fila, extra);
  a.lineas.push(fila);
  if (a.lineas.length > LINEAS) a.lineas.splice(0, a.lineas.length - LINEAS);
  if (turnId != null) a.turno = turnId;
}

// Herramientas que tocan ficheros sin pasar por la consola. Son las que no
// dejarian ni rastro si solo se pintaran las ordenes de shell: un fichero
// reescrito con Write no es ningun comando, y es justo lo que hay que ver.
const VERBOS = {
  Read: 'lee', Write: 'escribe', Edit: 'edita', NotebookEdit: 'edita',
  Glob: 'busca', Grep: 'busca',
  WebFetch: 'web', WebSearch: 'busca web',
  Task: 'delega', Agent: 'delega'
};

/**
 * Que esta lanzando, para la tira en vivo.
 *
 * Devuelve `orden` cuando es un comando de consola (y entonces va TAL CUAL,
 * con sus saltos de linea: ahi es donde se ve lo que intenta hacer, como en
 * un python -c de varias lineas) o `verbo`+`ruta` cuando es una herramienta
 * propia.
 *
 * No se parte por "&&". En las capturas de referencia los encadenados van en
 * una sola linea, los varios "$" son varias EJECUCIONES distintas. Y partir
 * por "&&" romperia por la mitad tanto un cuerpo de python entre comillas
 * como un grep "a && b": para saber si un && esta entrecomillado haria falta
 * interpretar shell de verdad.
 */
function accion(nombre, input) {
  const i = input && typeof input === 'object' ? input : {};
  const n = String(nombre || '');

  if (n === 'Bash') return { orden: String(i.command || '') };
  if (n === 'BashOutput') return { verbo: 'mira consola', ruta: String(i.bash_id || '') };
  if (n === 'KillShell') return { verbo: 'corta consola', ruta: String(i.shell_id || '') };

  const verbo = VERBOS[n];
  if (verbo) {
    if (n === 'Glob' || n === 'Grep') {
      return { verbo, ruta: `${i.pattern || ''}${i.path ? `  en ${i.path}` : ''}` };
    }
    if (n === 'WebFetch' || n === 'WebSearch') return { verbo, ruta: i.url || i.query || '' };
    if (n === 'Task' || n === 'Agent') return { verbo, ruta: i.description || '' };
    return { verbo, ruta: i.file_path || i.notebook_path || '' };
  }

  // Herramienta desconocida (MCP, por ejemplo): su nombre y poco mas. Mejor
  // una linea escueta que un hueco donde deberia verse lo que hace.
  const s = JSON.stringify(i);
  return { verbo: n, ruta: s === '{}' ? '' : recortar(s, 200) };
}

/** Resumen de una linea, para la pestaña de detalle. */
function argumentos(nombre, input) {
  const a = accion(nombre, input);
  return a.orden != null ? a.orden : `${a.ruta || ''}`;
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
        const acc = accion(b.name, b.input);
        // La orden se guarda APARTE y sin tocar. El campo `texto` la aplasta
        // a una linea para la lista de detalle, y en un python -c de varias
        // lineas eso se lleva por delante justo lo que hay que leer.
        const extra = acc.orden != null
          ? { orden: recortar(acc.orden, TOPE_ORDEN) }
          : { verbo: acc.verbo, ruta: recortar(String(acc.ruta || ''), TOPE_ORDEN) };
        apuntar(agentId, turnId, 'herramienta',
          `${b.name} ${argumentos(b.name, b.input)}`.trim(),
          `${b.name}\n${JSON.stringify(b.input || {}, null, 1)}`, extra);
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

  // Ruido conocido que ya se ve en otro sitio. Visto en un turno real: el
  // aviso de limite de uso aparecia como una linea de JSON en crudo entre
  // la orden y su resultado, y ese dato ya esta en el indicador de uso.
  if (RUIDO.has(ev.type)) return;

  // Formato desconocido: en crudo antes que en blanco.
  if (ev.type) apuntar(agentId, turnId, 'otro', `${ev.type}: ${JSON.stringify(ev)}`);
}

/**
 * Lo posterior a `desde`. Devuelve tambien cuanto lleva callado, que es el
 * dato que de verdad dice si se atasco: el contenido dice en que.
 */
function leer(agentId, desde = 0, limite = 100, solo = null) {
  const a = anillos.get(agentId);
  if (!a) return { lineas: [], seq: 0, turno: null, quietoMs: null, vacio: true };
  let nuevas = a.lineas.filter((l) => l.seq > Number(desde || 0));
  // La tira en vivo solo pinta lo que LANZA. Filtrar aqui y no en el
  // navegador evita mandar en cada sondeo el razonamiento y los resultados
  // enteros para luego tirarlos: son el grueso de los bytes.
  if (solo === 'ordenes') {
    nuevas = nuevas.filter((l) => l.clase === 'herramienta')
      .map((l) => ({ seq: l.seq, t: l.t, clase: l.clase, orden: l.orden, verbo: l.verbo, ruta: l.ruta }));
  }
  return {
    lineas: nuevas.slice(-limite),
    seq: a.seq,
    turno: a.turno,
    quietoMs: Date.now() - a.ultimo,
    vacio: a.lineas.length === 0
  };
}

function olvidar(agentId) { anillos.delete(agentId); }

module.exports = { empezar, anotar, apuntar, leer, olvidar, accion, argumentos, salida, recortar,
  LINEAS, TOPE_DETALLE, TOPE_TEXTO, TOPE_ORDEN, AGENTES, VERBOS };
