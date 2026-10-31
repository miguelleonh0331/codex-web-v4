// Actualizaciones desde la propia web.
//
// Este modulo solo mira y lanza. El trabajo sucio lo hace tools/actualizar.sh
// en un proceso aparte, porque el reinicio del servicio mata a cualquiera que
// viva dentro de el. Aqui leemos su diario y contamos lo que va pasando.

const { execFile, spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const RAIZ = path.resolve(__dirname, '..');
const UNIDAD = 'v4-actualizacion';   // nombre del proceso suelto que lanzamos

// Nombre del servicio de systemd. Se deduce de la carpeta para que esto
// funcione igual en otra instalacion sin tocar codigo.
function servicioDe() {
  return process.env.V4_SERVICIO || `codex-web-${path.basename(RAIZ).replace(/^codex-web-/, '')}`;
}

function git(args, { timeout = 20000 } = {}) {
  return new Promise((resolve) => {
    execFile('git', ['-C', RAIZ, ...args], { timeout, encoding: 'utf8' },
      (err, stdout, stderr) => resolve({
        ok: !err, salida: (stdout || '').trim(), error: (stderr || '').trim()
      }));
  });
}

function rutaLog(cfg) { return path.join(cfg.dataDir, 'actualizacion.log'); }
function rutaAnterior(cfg) { return path.join(cfg.dataDir, 'version-anterior'); }

// ---------------------------------------------------------------------------
// El diario que escribe el script, convertido en algo que la web pueda pintar.
function progreso(cfg) {
  let bruto = '';
  try { bruto = fs.readFileSync(rutaLog(cfg), 'utf8'); } catch { return null; }
  const pasos = bruto.split('\n').filter(Boolean).map((l) => {
    const [estado, paso, mensaje] = l.split('\t');
    return { estado, paso, mensaje: mensaje || '' };
  });
  if (!pasos.length) return null;

  const ultimo = pasos[pasos.length - 1];
  return {
    pasos,
    estado: ultimo.estado,            // curso | listo | error | revertido
    mensaje: ultimo.mensaje,
    terminado: ultimo.estado !== 'curso',
    avisos: pasos.filter((p) => p.estado === 'aviso').map((p) => p.mensaje)
  };
}

// ¿Sigue corriendo el proceso de actualizacion?
function enCurso() {
  return new Promise((resolve) => {
    execFile('systemctl', ['is-active', `${UNIDAD}.service`], { timeout: 5000 },
      (_e, out) => resolve((out || '').trim() === 'active'));
  });
}

// ---------------------------------------------------------------------------
async function estado(cfg, store) {
  const [actual, fechaActual, tituloActual, rama, sucio] = await Promise.all([
    git(['rev-parse', 'HEAD']),
    git(['log', '-1', '--pretty=%cI']),
    git(['log', '-1', '--pretty=%s']),
    git(['rev-parse', '--abbrev-ref', 'HEAD']),
    git(['status', '--porcelain'])
  ]);

  // Commits que estan en GitHub y aqui todavia no. No hacemos fetch: eso lo
  // pide la web aparte, porque tarda y puede fallar por red.
  const pendientes = await git(['log', '--pretty=%h%x1f%cI%x1f%s',
    `HEAD..origin/${rama.salida || 'main'}`]);
  const nuevos = (pendientes.salida || '').split('\n').filter(Boolean).map((l) => {
    const [sha, fecha, titulo] = l.split('\x1f');
    return { sha, fecha, titulo };
  });

  // Cuando se trajeron noticias de GitHub por ultima vez.
  let comprobado = null;
  try { comprobado = fs.statSync(path.join(RAIZ, '.git', 'FETCH_HEAD')).mtime.toISOString(); }
  catch { /* nunca se ha hecho fetch */ }

  let anterior = null;
  try { anterior = fs.readFileSync(rutaAnterior(cfg), 'utf8').trim() || null; } catch { /* sin vuelta atras */ }
  // Tras una vuelta atras automatica, el registro apunta a la version en la
  // que ya estamos. Ofrecer "volver" a donde ya estas no significa nada.
  if (anterior && anterior === actual.salida) anterior = null;
  let tituloAnterior = null;
  if (anterior) {
    const t = await git(['log', '-1', '--pretty=%h %s', anterior]);
    if (t.ok) tituloAnterior = t.salida;
  }

  // Especialistas a los que el reinicio les cortaria el turno a medias.
  let trabajando = [];
  try {
    trabajando = store.listAgents()
      .filter((a) => a.status === 'working' || a.status === 'queued')
      .map((a) => a.name);
  } catch { /* la base manda, si falla seguimos sin el aviso */ }

  return {
    version: (actual.salida || '').slice(0, 7),
    commit: actual.salida || null,
    fecha: fechaActual.salida || null,
    titulo: tituloActual.salida || null,
    rama: rama.salida || null,
    limpio: actual.ok && !sucio.salida,
    sucio: (sucio.salida || '').split('\n').filter(Boolean).length,
    nuevos,
    hayNuevos: nuevos.length > 0,
    comprobado,
    anterior,
    tituloAnterior,
    trabajando,
    enCurso: await enCurso(),
    progreso: progreso(cfg),
    servicio: servicioDe()
  };
}

// Pregunta a GitHub si hay algo nuevo. Separado de estado() porque usa red.
async function buscar(cfg, store) {
  const r = await git(['fetch', 'origin'], { timeout: 60000 });
  if (!r.ok) {
    const e = new Error('No pude contactar con GitHub: ' + (r.error.split('\n')[0] || 'sin detalle'));
    e.codigo = 502;
    throw e;
  }
  return estado(cfg, store);
}

// ---------------------------------------------------------------------------
// Lanza el script fuera del servicio. systemd-run le da un hogar propio: ya
// no es hijo nuestro, asi que el reinicio no se lo lleva por delante.
async function aplicar(cfg, store, { destino = '', aunqueTrabajen = false } = {}) {
  if (await enCurso()) {
    const e = new Error('Ya hay una actualizacion en marcha');
    e.codigo = 409;
    throw e;
  }

  const est = await estado(cfg, store);

  if (!est.limpio) {
    const e = new Error(`Hay ${est.sucio} archivo(s) con cambios sin guardar en el servidor. `
      + 'Actualizar los machacaria, asi que no sigo.');
    e.codigo = 409;
    throw e;
  }
  if (!est.hayNuevos && !destino) {
    const e = new Error('No hay nada nuevo que instalar');
    e.codigo = 409;
    throw e;
  }
  if (est.trabajando.length && !aunqueTrabajen) {
    const e = new Error(`Hay ${est.trabajando.length} especialista(s) trabajando: `
      + est.trabajando.join(', ') + '. El reinicio les cortaria el turno.');
    e.codigo = 409;
    e.trabajando = est.trabajando;
    throw e;
  }

  const guion = path.join(RAIZ, 'tools', 'actualizar.sh');
  if (!fs.existsSync(guion)) {
    const e = new Error('Falta tools/actualizar.sh en esta instalacion');
    e.codigo = 500;
    throw e;
  }

  // Dejamos el diario vacio ya, para que la web vea "empezando" al instante
  // y no un hueco con el estado de la vez anterior.
  try { fs.writeFileSync(rutaLog(cfg), 'curso\tinicio\tPreparando la actualizacion\n'); } catch { /* lo escribira el script */ }

  const hijo = spawn('sudo', [
    '-n', 'systemd-run',
    `--unit=${UNIDAD}`,
    '--collect',                      // que no deje la unidad muerta por ahi
    `--setenv=V4_REPO=${RAIZ}`,
    `--setenv=V4_DATA=${cfg.dataDir}`,
    `--setenv=V4_SERVICIO=${servicioDe()}`,
    `--setenv=V4_PUERTO=${cfg.port}`,
    `--setenv=V4_NODE=${process.execPath}`,
    `--setenv=V4_DESTINO=${destino}`,
    `--uid=${process.getuid()}`,
    `--gid=${process.getgid()}`,
    '/bin/bash', guion
  ], { detached: true, stdio: 'ignore' });
  hijo.unref();

  return { lanzada: true, desde: est.version, cuantos: est.nuevos.length };
}

// Volver a la version de antes, a mano. Mismo script, pero apuntando atras.
async function revertir(cfg, store) {
  let anterior = null;
  try { anterior = fs.readFileSync(rutaAnterior(cfg), 'utf8').trim(); } catch { /* no hay */ }
  if (!anterior) {
    const e = new Error('No tengo registrada ninguna version anterior a la que volver');
    e.codigo = 409;
    throw e;
  }
  return aplicar(cfg, store, { destino: anterior, aunqueTrabajen: true });
}

module.exports = { estado, buscar, aplicar, revertir, progreso, enCurso, RAIZ, servicioDe };
