'use strict';
/**
 * Notificaciones push para la aplicacion instalada.
 *
 * Todo se hace con node:crypto, sin dependencias: en esta maquina npm no
 * tiene salida a la red, asi que una libreria no era una opcion.
 *
 * Dos normas en juego:
 *   RFC 8291 — cifrado de la carga (aes128gcm)
 *   RFC 8292 — autenticacion del remitente ante el servicio de push (VAPID)
 *
 * El reparto no pasa por la tailnet: el servicio de push del navegador
 * (Google, Mozilla…) entrega al telefono. Por eso el aviso llega aunque el
 * movil este fuera de la red privada y con la aplicacion cerrada.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const CURVA = 'prime256v1';

// --------------------------------------------------------------- base64url

const b64u = (buf) => Buffer.from(buf).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const deB64u = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');

// ------------------------------------------------------------------- claves

/**
 * Claves VAPID de esta instalacion. Se generan una sola vez y se guardan
 * aparte de la configuracion, con permisos restringidos: la privada firma
 * los envios y no debe acabar en una exportacion ni en el repositorio.
 */
function cargarClaves(dir) {
  const archivo = path.join(dir, 'vapid.json');
  if (fs.existsSync(archivo)) {
    try { return JSON.parse(fs.readFileSync(archivo, 'utf8')); } catch { /* se regenera */ }
  }
  const ec = crypto.createECDH(CURVA);
  ec.generateKeys();
  const claves = {
    publica: b64u(ec.getPublicKey()),      // punto sin comprimir, 65 bytes
    privada: b64u(ec.getPrivateKey()),
    creada: new Date().toISOString()
  };
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(archivo, JSON.stringify(claves, null, 2), { mode: 0o600 });
  return claves;
}

/** Convierte una clave EC cruda en el formato que entiende node:crypto. */
function clavePrivadaPem(privadaB64u, publicaB64u) {
  const jwk = {
    kty: 'EC', crv: 'P-256',
    d: privadaB64u,
    x: b64u(deB64u(publicaB64u).subarray(1, 33)),
    y: b64u(deB64u(publicaB64u).subarray(33, 65))
  };
  return crypto.createPrivateKey({ key: jwk, format: 'jwk' });
}

// -------------------------------------------------------------------- VAPID

/**
 * Credencial que demuestra al servicio de push quien envia. Caduca pronto a
 * proposito: si se filtrase, sirve de poco.
 */
function cabeceraVapid(endpoint, claves, contacto) {
  const { origin } = new URL(endpoint);
  const cabecera = { typ: 'JWT', alg: 'ES256' };
  const cuerpo = {
    aud: origin,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: contacto
  };
  const firmable = `${b64u(JSON.stringify(cabecera))}.${b64u(JSON.stringify(cuerpo))}`;
  // ieee-p1363 da la firma como r||s crudos, que es lo que pide JWS.
  // El formato DER por omision seria rechazado por el servicio de push.
  const firma = crypto.sign('sha256', Buffer.from(firmable), {
    key: clavePrivadaPem(claves.privada, claves.publica),
    dsaEncoding: 'ieee-p1363'
  });
  return `vapid t=${firmable}.${b64u(firma)}, k=${claves.publica}`;
}

// ------------------------------------------------------------------ cifrado

const hmac = (clave, dato) => crypto.createHmac('sha256', clave).update(dato).digest();

/** HKDF reducido al unico caso que hace falta aqui (una sola iteracion). */
function derivar(prk, info, bytes) {
  return hmac(prk, Buffer.concat([info, Buffer.from([1])])).subarray(0, bytes);
}

/**
 * Cifra la carga para un destinatario concreto (RFC 8291).
 *
 * Nadie salvo ese navegador puede leerla: ni el servicio de push que la
 * transporta. Por eso el texto del aviso puede llevar el nombre real del
 * especialista sin exponerlo a terceros.
 */
function cifrar(texto, p256dhB64u, authB64u) {
  const clienteP = deB64u(p256dhB64u);
  const authSecreto = deB64u(authB64u);

  const efimero = crypto.createECDH(CURVA);
  efimero.generateKeys();
  const servidorP = efimero.getPublicKey();
  const compartido = efimero.computeSecret(clienteP);

  const prkClave = hmac(authSecreto, compartido);
  const infoClave = Buffer.concat([
    Buffer.from('WebPush: info\0'), clienteP, servidorP
  ]);
  const ikm = derivar(prkClave, infoClave, 32);

  const sal = crypto.randomBytes(16);
  const prk = hmac(sal, ikm);
  const cek = derivar(prk, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = derivar(prk, Buffer.from('Content-Encoding: nonce\0'), 12);

  const cifrador = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  // El 0x02 marca el final del texto: es el delimitador de relleno que
  // exige la norma, no un byte suelto.
  const cuerpo = Buffer.concat([
    cifrador.update(Buffer.concat([Buffer.from(texto, 'utf8'), Buffer.from([2])])),
    cifrador.final(),
    cifrador.getAuthTag()
  ]);

  const cabecera = Buffer.alloc(21);
  sal.copy(cabecera, 0);
  cabecera.writeUInt32BE(4096, 16);     // tamano de registro
  cabecera.writeUInt8(servidorP.length, 20);
  return Buffer.concat([cabecera, servidorP, cuerpo]);
}

// -------------------------------------------------------------------- envio

/**
 * Envia un aviso a una suscripcion.
 *
 * Devuelve {ok} o {ok:false, caducada} — caducada significa que el navegador
 * desinstalo la aplicacion o revoco el permiso, y esa suscripcion debe
 * borrarse: reintentarla no sirve de nada.
 */
async function enviarUno(sub, carga, claves, contacto) {
  let cuerpo = null;
  const cabeceras = {
    TTL: '86400',
    Urgency: 'normal',
    Authorization: cabeceraVapid(sub.endpoint, claves, contacto)
  };
  if (carga) {
    cuerpo = cifrar(JSON.stringify(carga), sub.p256dh, sub.auth);
    cabeceras['Content-Encoding'] = 'aes128gcm';
    cabeceras['Content-Type'] = 'application/octet-stream';
    cabeceras['Content-Length'] = String(cuerpo.length);
  }
  try {
    const res = await fetch(sub.endpoint, {
      method: 'POST', headers: cabeceras, body: cuerpo,
      signal: AbortSignal.timeout(10000)
    });
    if (res.status === 404 || res.status === 410) return { ok: false, caducada: true };
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { cargarClaves, enviarUno, b64u };
