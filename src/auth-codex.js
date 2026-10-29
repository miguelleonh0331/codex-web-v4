'use strict';
/**
 * Conexion con ChatGPT a traves de Codex CLI.
 *
 * Usa el flujo de codigo de dispositivo: el CLI imprime un enlace y un
 * codigo de un solo uso, el usuario los lleva a su navegador, y el proceso
 * se completa por si mismo. A diferencia de Claude, no hay nada que pegar de
 * vuelta: aqui solo hay que esperar y comprobar.
 */
const { spawn, execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const codex = require('./proveedores/codex');

// Un unico intento de conexion a la vez: dos procesos pidiendo codigo a la
// vez se pisarian y el usuario no sabria cual de los dos autoriza.
let enCurso = null;

function entorno(cfg) {
  const dir = codex.dirSesion(cfg);
  fs.mkdirSync(dir, { recursive: true });
  return {
    ...process.env,
    // Igual que al ejecutar turnos: el CLI de npm necesita node en el PATH.
    PATH: `${path.dirname(process.execPath)}:${process.env.PATH || ''}`,
    CODEX_HOME: dir
  };
}

/** Quita los colores ANSI: el CLI los emite aunque no haya terminal. */
const limpio = (s) => String(s).replace(/\[[0-9;]*m/g, '');

function estado(cfg) {
  const bin = codex.binario(cfg);
  if (!bin) return Promise.resolve({ proveedor: 'codex', etiqueta: codex.etiqueta, instalado: false, conectado: false });

  return new Promise((resolve) => {
    execFile(bin, ['login', 'status'], { env: entorno(cfg), timeout: 15000 }, (err, stdout, stderr) => {
      const texto = limpio(`${stdout || ''}${stderr || ''}`);
      // "Not logged in" es la respuesta normal sin sesion, no un fallo.
      const conectado = /logged in/i.test(texto) && !/not logged in/i.test(texto);
      const cuenta = (texto.match(/(?:as|account)[:\s]+([^\s]+@[^\s]+)/i) || [])[1] || null;
      resolve({
        proveedor: 'codex',
        etiqueta: codex.etiqueta,
        instalado: true,
        conectado,
        cuenta,
        detalle: conectado ? null : texto.trim().split('\n').slice(-1)[0] || null,
        enCurso: !!enCurso
      });
    });
  });
}

/**
 * Arranca la conexion y devuelve el enlace y el codigo en cuanto el CLI los
 * imprime. El proceso sigue vivo esperando a que el usuario autorice.
 */
function iniciar(cfg) {
  const bin = codex.binario(cfg);
  if (!bin) return Promise.resolve({ error: codex.faltaBinario });
  if (enCurso) return Promise.resolve({ error: 'ya hay una conexion en curso. Cancelala antes de empezar otra.' });

  return new Promise((resolve) => {
    const hijo = spawn(bin, ['login', '--device-auth'], { env: entorno(cfg), stdio: ['ignore', 'pipe', 'pipe'] });
    let salida = '';
    let resuelto = false;

    // Quince minutos: es lo que dura el codigo que imprime el CLI.
    const limite = setTimeout(() => cancelar('se agoto el tiempo de la conexion'), 15 * 60 * 1000);
    enCurso = { hijo, limite, iniciado: Date.now(), completado: false, error: null };

    const mirar = (trozo) => {
      salida += limpio(trozo);
      if (resuelto) return;
      const url = (salida.match(/https:\/\/\S+/) || [])[0];
      // El codigo es del tipo ABCD-EFGH1, en su propia linea.
      const codigo = (salida.match(/^\s*([A-Z0-9]{4}-[A-Z0-9]{4,6})\s*$/m) || [])[1];
      if (url && codigo) {
        resuelto = true;
        resolve({ url, codigo, expiraEn: 15 * 60 });
      }
    };

    hijo.stdout.on('data', (d) => mirar(String(d)));
    hijo.stderr.on('data', (d) => mirar(String(d)));

    hijo.on('close', (code) => {
      clearTimeout(limite);
      if (enCurso && enCurso.hijo === hijo) {
        enCurso.completado = code === 0;
        if (code !== 0) enCurso.error = salida.trim().split('\n').slice(-1)[0] || `codigo ${code}`;
        // Se conserva un momento para que la interfaz pueda leer el desenlace.
        const quien = enCurso;
        setTimeout(() => { if (enCurso === quien) enCurso = null; }, 60000);
      }
      if (!resuelto) {
        resuelto = true;
        resolve({ error: `Codex no devolvio el enlace: ${salida.trim().slice(-300) || 'sin salida'}` });
      }
    });

    hijo.on('error', (e) => {
      clearTimeout(limite);
      enCurso = null;
      if (!resuelto) { resuelto = true; resolve({ error: `No se pudo lanzar Codex: ${e.message}` }); }
    });
  });
}

/** Como se completa solo, la interfaz pregunta si ya termino. */
async function comprobar(cfg) {
  const est = await estado(cfg);
  if (est.conectado) { cancelar(null, true); return { ...est, listo: true }; }
  if (enCurso && enCurso.error) return { ...est, listo: false, error: enCurso.error };
  return { ...est, listo: false, esperando: !!enCurso };
}

function cancelar(motivo, silencioso = false) {
  if (!enCurso) return { ok: true };
  try { enCurso.hijo.kill('SIGTERM'); } catch { /* ya murio */ }
  clearTimeout(enCurso.limite);
  enCurso = null;
  return { ok: true, motivo: silencioso ? null : motivo };
}

function cerrarSesion(cfg) {
  const bin = codex.binario(cfg);
  if (!bin) return Promise.resolve({ error: codex.faltaBinario });
  cancelar(null, true);
  return new Promise((resolve) => {
    execFile(bin, ['logout'], { env: entorno(cfg), timeout: 15000 }, (err, stdout, stderr) => {
      resolve({ ok: !err, detalle: limpio(`${stdout || ''}${stderr || ''}`).trim() || null });
    });
  });
}

module.exports = { estado, iniciar, comprobar, cancelar, cerrarSesion };
