'use strict';
const fs = require('node:fs');
const path = require('node:path');

/**
 * Lee la caducidad del token sin exponer el secreto.
 *
 * "Caducado" NO es lo mismo que "sin sesion". El token de acceso dura unas
 * horas y el CLI lo renueva solo con el refresh token en cuanto corre un
 * turno. Decir "los agentes no podran trabajar" por un token que caduco hace
 * diez minutos es una falsa alarma: ya nos la dimos una vez.
 */
function estado(archivo) {
  try {
    const d = JSON.parse(fs.readFileSync(archivo, 'utf8'));
    const o = d.claudeAiOauth || d;
    const exp = Number(o.expiresAt || 0);
    const renovable = !!(o.refreshToken || o.refresh_token);
    return {
      existe: true,
      expiraEn: exp,
      vigente: exp > Date.now(),
      renovable,
      // Lo que de verdad importa: si podra trabajar o no.
      utilizable: exp > Date.now() || renovable,
      expiraIso: exp ? new Date(exp).toISOString() : null
    };
  } catch {
    return { existe: false, expiraEn: 0, vigente: false, renovable: false, utilizable: false, expiraIso: null };
  }
}

function archivoSesion(cfg) {
  return path.join(cfg.sessionDir, '.credentials.json');
}

/**
 * Recupera la sesion desde el perfil de origen.
 *
 * Hace falta porque dos copias del mismo token compiten: cuando una refresca,
 * la rotacion invalida a la otra. Si el origen tiene un token vigente, lo
 * traemos y el turno puede reintentarse.
 */
function recuperar(cfg) {
  if (!cfg.sessionSource) return { ok: false, motivo: 'no hay sessionSource configurado' };

  const origen = estado(cfg.sessionSource);
  if (!origen.existe) return { ok: false, motivo: `no se pudo leer ${cfg.sessionSource}` };
  if (!origen.vigente) return { ok: false, motivo: `el origen tambien esta caducado (${origen.expiraIso})` };

  const destino = archivoSesion(cfg);
  const actual = estado(destino);
  // Solo se recupera hacia adelante: si el origen es mas viejo, copiarlo seria un retroceso.
  if (origen.expiraEn <= actual.expiraEn) {
    return { ok: false, motivo: `el origen no es mas reciente que la sesion actual (${origen.expiraIso} vs ${actual.expiraIso})` };
  }

  const tmp = destino + '.nuevo';
  fs.copyFileSync(cfg.sessionSource, tmp);
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, destino);
  return { ok: true, expira: origen.expiraIso };
}

module.exports = { estado, recuperar, archivoSesion };
