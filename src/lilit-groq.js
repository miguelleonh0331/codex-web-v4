'use strict';
/**
 * Mejora opcional del aviso de LILIT con un modelo externo (Groq).
 *
 * El diccionario de frases es la via principal y siempre funciona. Esto solo
 * reescribe el aviso para que suene mas natural cuando hay varias cosas a la
 * vez y una lista de frases sueltas queda torpe.
 *
 * Tres reglas que no se negocian:
 *   - Si no hay clave, no responde o tarda, se usa el diccionario. LILIT
 *     nunca se queda muda por culpa de esto.
 *   - Nunca se le manda contenido del trabajo: solo el tipo de incidencia y
 *     el nombre del especialista. Lo que hablas con tu equipo no sale de
 *     aqui.
 *   - Tiene su propio limite de ritmo: avisar no puede costar mas que
 *     trabajar.
 */
const fs = require('node:fs');
const path = require('node:path');

const MODELO = 'openai/gpt-oss-20b';
const URL = 'https://api.groq.com/openai/v1/chat/completions';
// gpt-oss razona antes de escribir y ese razonamiento gasta presupuesto: con
// menos margen devuelve el campo de texto vacio.
const MAX_TOKENS = 220;
const ESPERA_MS = 6000;
const MIN_ENTRE_LLAMADAS = 20000;

let ultima = 0;

function clave(cfg) {
  if (process.env.GROQ_API_KEY) return process.env.GROQ_API_KEY.trim();
  const f = cfg.groqKeyFile || path.join(cfg.dataDir, 'secretos', 'groq.key');
  try { return fs.readFileSync(f, 'utf8').trim() || null; } catch { return null; }
}

function disponible(cfg) { return !!clave(cfg); }

/**
 * Reescribe los avisos en una sola frase hablada.
 * Devuelve null si no se puede: el llamante usa entonces el diccionario.
 */
async function redactar(cfg, hallazgos, respaldo) {
  const k = clave(cfg);
  if (!k || !hallazgos.length) return null;
  if (Date.now() - ultima < MIN_ENTRE_LLAMADAS) return null;
  ultima = Date.now();

  // Solo el tipo y el nombre. Ni una linea de lo que hablaste con nadie.
  const resumen = hallazgos
    .map((h) => `${h.tipo}${h.quien ? ` (${h.quien})` : ''}${h.n != null ? ` x${h.n}` : ''}`)
    .join('; ');

  try {
    const r = await fetch(URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${k}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: MODELO,
        max_tokens: MAX_TOKENS,
        temperature: 0.8,
        messages: [
          { role: 'system', content:
            'Eres LILIT, auditora de un equipo de agentes. Avisas por voz en espanol. '
            + 'Responde UNA sola frase corta y natural, como se lo dirias a alguien al lado. '
            + 'Sin emojis, sin markdown, sin rutas ni cifras largas. Nunca inventes detalles.' },
          { role: 'user', content: `Incidencias: ${resumen}. Avisame en una frase.` }
        ]
      }),
      signal: AbortSignal.timeout(ESPERA_MS)
    });
    if (!r.ok) return null;
    const d = await r.json();
    const texto = ((d.choices && d.choices[0] && d.choices[0].message
      && d.choices[0].message.content) || '').trim();
    // Una frase vacia o kilometrica no sirve para hablar: mejor el respaldo.
    if (!texto || texto.length > 240) return null;
    return texto.replace(/\s+/g, ' ');
  } catch {
    return null;   // red, tiempo agotado, clave mala: da igual, hay respaldo
  }
}

/** Donde vive la clave. Fuera del repositorio y solo legible por el servicio. */
function archivoClave(cfg) {
  return cfg.groqKeyFile || path.join(cfg.dataDir, 'secretos', 'groq.key');
}

/**
 * Estado de la clave SIN devolverla.
 *
 * Se ensenan los cuatro ultimos caracteres, lo justo para reconocer cual
 * tienes puesta. Devolverla entera seria regalar en cada carga de la pagina
 * lo que se guardo con permisos 600.
 */
function estadoClave(cfg) {
  const k = clave(cfg);
  if (!k) return { configurada: false, cola: null, origen: null };
  return {
    configurada: true,
    cola: k.slice(-4),
    origen: process.env.GROQ_API_KEY ? 'variable de entorno' : archivoClave(cfg)
  };
}

/** Comprueba contra el servicio que una clave sirve de verdad. */
async function probar(k) {
  try {
    const r = await fetch('https://api.groq.com/openai/v1/models', {
      headers: { authorization: `Bearer ${String(k || '').trim()}` },
      signal: AbortSignal.timeout(ESPERA_MS)
    });
    if (r.status === 401) return { ok: false, error: 'la clave no es valida' };
    if (!r.ok) return { ok: false, error: `el servicio respondio ${r.status}` };
    const d = await r.json();
    const modelos = (d.data || []).map((m) => m.id);
    return {
      ok: true,
      modelos: modelos.length,
      // Si el modelo que usamos no esta, conviene saberlo antes de depender de el.
      tieneElNuestro: modelos.includes(MODELO)
    };
  } catch (e) {
    return { ok: false, error: `no se pudo comprobar: ${e.message}` };
  }
}

/**
 * Guarda la clave, pero solo si funciona.
 *
 * Guardar una clave mala sin avisar dejaria a LILIT usando el diccionario
 * para siempre sin que nadie entendiera por que.
 */
async function guardarClave(cfg, k) {
  const limpia = String(k || '').trim();
  if (!limpia) throw new Error('clave vacia');
  if (process.env.GROQ_API_KEY) {
    throw new Error('hay una clave en la variable de entorno GROQ_API_KEY: esa manda sobre el fichero');
  }
  const prueba = await probar(limpia);
  if (!prueba.ok) throw new Error(prueba.error);

  const f = archivoClave(cfg);
  fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
  fs.writeFileSync(f, limpia, { mode: 0o600 });
  try { fs.chmodSync(f, 0o600); } catch { /* ya estaba */ }
  ultima = 0;                      // que la siguiente redaccion pueda salir ya
  return { ...estadoClave(cfg), ...prueba };
}

function borrarClave(cfg) {
  try { fs.rmSync(archivoClave(cfg), { force: true }); } catch { /* no estaba */ }
  return estadoClave(cfg);
}

module.exports = { redactar, disponible, MODELO, estadoClave, guardarClave, borrarClave, probar, archivoClave };
