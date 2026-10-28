'use strict';
/**
 * Proveedores de modelo y su sesion.
 *
 * Hoy solo Claude. El inicio de sesion es el flujo OAuth del propio CLI, que
 * por suerte no necesita terminal: imprime una URL y espera el codigo por la
 * entrada estandar. Esta capa lo lanza, saca la URL, guarda el proceso vivo y
 * le entrega el codigo cuando el usuario lo pega.
 */
const { spawn, execFile } = require('node:child_process');
const fs = require('node:fs');
const crypto = require('node:crypto');
const sesion = require('./session');

/**
 * Huella del archivo de credenciales. Sirve para saber si un login REALMENTE
 * escribio algo: preguntar solo "hay sesion" daria por bueno un codigo
 * invalido cuando ya existia una sesion anterior.
 */
function huellaSesion(cfg) {
  try {
    const bruto = fs.readFileSync(sesion.archivoSesion(cfg));
    return crypto.createHash('sha256').update(bruto).digest('hex');
  } catch { return null; }
}

const CADUCA_LOGIN_MS = 10 * 60 * 1000;   // una URL de OAuth no vive eternamente

let enCurso = null;   // { proc, url, salida, creado, temporizador }

function entorno(cfg) {
  return { ...process.env, HOME: cfg.dataDir, CLAUDE_CONFIG_DIR: cfg.sessionDir };
}

/** Estado de la cuenta segun el propio CLI, mas la caducidad del token. */
function estado(cfg) {
  return new Promise((resolve) => {
    const credenciales = sesion.estado(sesion.archivoSesion(cfg));
    if (!cfg.claudeBin) {
      return resolve({ proveedor: 'claude', disponible: false, motivo: 'no hay binario de Claude Code configurado', credenciales });
    }
    execFile(cfg.claudeBin, ['auth', 'status'], { env: entorno(cfg), timeout: 30000 }, (err, stdout) => {
      let info = null;
      try { info = JSON.parse(String(stdout).trim()); } catch { /* salida inesperada */ }
      resolve({
        proveedor: 'claude',
        disponible: true,
        conectado: !!(info && info.loggedIn),
        cuenta: info ? info.email || null : null,
        organizacion: info ? info.orgName || null : null,
        plan: info ? info.subscriptionType || null : null,
        metodo: info ? info.authMethod || null : null,
        credenciales,
        sessionDir: cfg.sessionDir,
        error: err && !info ? String(err.message).slice(0, 200) : null,
        login_en_curso: !!enCurso
      });
    });
  });
}

function cancelar(motivo) {
  if (!enCurso) return;
  clearTimeout(enCurso.temporizador);
  try { enCurso.proc.kill('SIGTERM'); } catch { /* ya murio */ }
  enCurso = null;
  if (motivo) console.warn(`[auth] login cancelado: ${motivo}`);
}

/**
 * Arranca el login y devuelve la URL que el usuario debe abrir.
 * El proceso queda esperando el codigo.
 */
function iniciarLogin(cfg, { consola = false } = {}) {
  return new Promise((resolve, reject) => {
    if (!cfg.claudeBin) return reject(new Error('no hay binario de Claude Code configurado'));
    cancelar('se inicia uno nuevo');

    const args = ['auth', 'login', consola ? '--console' : '--claudeai'];
    const proc = spawn(cfg.claudeBin, args, { env: entorno(cfg), stdio: ['pipe', 'pipe', 'pipe'] });

    let salida = '';
    let resuelto = false;

    const mirar = (trozo) => {
      salida += trozo;
      const m = salida.match(/https:\/\/\S*oauth\S*/);
      if (m && !resuelto) {
        resuelto = true;
        enCurso = {
          proc,
          url: m[0],
          salida: () => salida,
          creado: Date.now(),
          temporizador: setTimeout(() => cancelar('caduco la espera del codigo'), CADUCA_LOGIN_MS)
        };
        resolve({ url: m[0], caduca_en_ms: CADUCA_LOGIN_MS });
      }
    };

    proc.stdout.on('data', (d) => mirar(String(d)));
    proc.stderr.on('data', (d) => mirar(String(d)));
    proc.on('error', (e) => { if (!resuelto) { resuelto = true; reject(new Error(`no se pudo lanzar el login: ${e.message}`)); } });
    proc.on('close', () => { if (enCurso && enCurso.proc === proc) { clearTimeout(enCurso.temporizador); enCurso = null; } });

    setTimeout(() => {
      if (!resuelto) {
        resuelto = true;
        try { proc.kill('SIGTERM'); } catch { /* da igual */ }
        reject(new Error(`el CLI no devolvio una URL de acceso. Salida: ${salida.slice(0, 300) || '(vacia)'}`));
      }
    }, 45000);
  });
}

/** Entrega el codigo pegado por el usuario y espera el desenlace. */
function enviarCodigo(cfg, codigo) {
  return new Promise((resolve) => {
    if (!enCurso) return resolve({ ok: false, error: 'no hay ningun inicio de sesion en curso; vuelve a empezar' });

    const limpio = String(codigo || '').trim();
    if (!limpio) return resolve({ ok: false, error: 'el codigo esta vacio' });

    const { proc } = enCurso;
    const huellaPrevia = huellaSesion(cfg);
    let cerrado = false;
    let codigoSalida = null;

    const terminar = async () => {
      if (cerrado) return;
      cerrado = true;
      clearTimeout(espera);
      const salida = enCurso ? enCurso.salida() : '';
      enCurso = null;

      const st = await estado(cfg);
      const cambio = huellaSesion(cfg) !== huellaPrevia;

      // Exito solo si quedo sesion valida Y el archivo cambio: asi un codigo
      // rechazado no se cuela como bueno por culpa de la sesion anterior.
      if (st.conectado && cambio) {
        return resolve({ ok: true, cuenta: st.cuenta, plan: st.plan, expira: st.credenciales.expiraIso });
      }
      const pista = /invalid|expired|error|denied|failed/i.exec(salida);
      resolve({
        ok: false,
        error: cambio ? 'el inicio de sesion no dejo una sesion valida'
                      : 'el codigo no fue aceptado: no se guardo ninguna sesion nueva',
        detalle: (pista ? salida.slice(Math.max(0, pista.index - 80)) : salida.slice(-300)).trim(),
        codigo_salida: codigoSalida
      });
    };

    proc.once('close', (c) => { codigoSalida = c; terminar(); });
    const espera = setTimeout(terminar, 60000);

    try { proc.stdin.write(limpio + '\n'); } catch (e) {
      cerrado = true;
      enCurso = null;
      resolve({ ok: false, error: `no se pudo entregar el codigo: ${e.message}` });
    }
  });
}

function cerrarSesion(cfg) {
  return new Promise((resolve) => {
    cancelar('se cierra la sesion');
    if (!cfg.claudeBin) return resolve({ ok: false, error: 'no hay binario de Claude Code configurado' });
    execFile(cfg.claudeBin, ['auth', 'logout'], { env: entorno(cfg), timeout: 30000 }, (err, stdout, stderr) => {
      resolve(err ? { ok: false, error: String(stderr || err.message).slice(0, 200) } : { ok: true });
    });
  });
}

module.exports = { estado, iniciarLogin, enviarCodigo, cerrarSesion, cancelar };
