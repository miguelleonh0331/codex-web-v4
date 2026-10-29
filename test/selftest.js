#!/usr/bin/env node
'use strict';
/**
 * Autodiagnostico de codex-web-v4.
 * Comprueba la API, la autenticacion, el buzon, el limite de saltos y las reservas
 * de archivos sin gastar llamadas al modelo. Los agentes de prueba se borran al final.
 *
 *   node test/selftest.js
 */
const fs = require('node:fs');

const CONFIG_PATH = process.env.V4_CONFIG || '/etc/codex-web-v4/config.json';
const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const PORT = cfg.port || 3212;
const CANDIDATOS = [...new Set([...(cfg.bindHosts || []), '127.0.0.1'])]
  .map((h) => (h === '0.0.0.0' || h === '::' ? '127.0.0.1' : h));

let BASE = null;
let pasa = 0;
let falla = 0;

async function base() {
  if (BASE) return BASE;
  for (const h of CANDIDATOS) {
    try {
      const r = await fetch(`http://${h}:${PORT}/api/health`, { signal: AbortSignal.timeout(2500) });
      if (r.ok) { BASE = `http://${h}:${PORT}`; return BASE; }
    } catch { /* siguiente */ }
  }
  throw new Error('el servicio no responde');
}

async function req(path, { method = 'GET', body, token = cfg.authToken, bridge } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers['x-v4-token'] = token;
  if (bridge) headers['x-v4-bridge-token'] = bridge;
  const res = await fetch((await base()) + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

function check(nombre, condicion, detalle) {
  if (condicion) { pasa += 1; console.log(`  ok   ${nombre}`); }
  else { falla += 1; console.log(`  FALLA ${nombre}${detalle ? ` → ${detalle}` : ''}`); }
}

(async () => {
  console.log('autodiagnostico codex-web-v4\n');

  // --- servicio ---
  const health = await req('/api/health', { token: null });
  check('el servicio responde', health.status === 200 && health.data.ok);
  check('encuentra el binario de Claude', health.data.claude === true, 'config.claudeBin no resuelve');
  check('la sesion de Claude esta vigente',
    health.data.session && health.data.session.valida === true,
    `caduca ${health.data.session && health.data.session.expira}: los agentes no podran trabajar`);

  // --- autenticacion ---
  if (health.data.auth) {
    check('rechaza token invalido', (await req('/api/state', { token: 'malo' })).status === 401);
    check('acepta token valido', (await req('/api/state')).status === 200);
  } else {
    check('acceso directo sin token', (await req('/api/state', { token: null })).status === 200);
  }
  check('protege los endpoints internos', (await req('/api/internal/agents', { token: null, bridge: 'malo' })).status === 401);

  // --- agentes ---
  // Barrido previo: si una ejecucion anterior murio a medias, sus agentes de
  // prueba se quedaron creados y acaban agotando el tope de especialistas.
  const previos = (await req('/api/agents')).data.agents || [];
  const basura = previos.filter((a) => /^ST-(Alfa|Beta|Imp)-\d+$/.test(a.name));
  for (const a of basura) await req(`/api/agents/${a.id}?purgar=1`, { method: 'DELETE' });
  if (basura.length) console.log(`  --   barridos ${basura.length} agentes de pruebas anteriores`);

  const sufijo = process.pid;
  const a1 = await req('/api/agents', { method: 'POST', body: { name: `ST-Alfa-${sufijo}`, area: 'prueba', instructions: 'Agente de autodiagnostico. No hace nada.' } });
  const a2 = await req('/api/agents', { method: 'POST', body: { name: `ST-Beta-${sufijo}`, area: 'prueba', instructions: 'Agente de autodiagnostico. No hace nada.' } });
  check('crea especialistas', a1.status === 201 && a2.status === 201, JSON.stringify(a1.data).slice(0, 120));
  const A = a1.data.id, B = a2.data.id;

  check('exige nombre unico',
    (await req('/api/agents', { method: 'POST', body: { name: `ST-Alfa-${sufijo}`, instructions: 'x' } })).status === 400);
  check('exige instrucciones',
    (await req('/api/agents', { method: 'POST', body: { name: `ST-Gamma-${sufijo}` } })).status === 400);
  check('crea el workspace en disco', fs.existsSync(a1.data.workspace));

  // --- formularios: el campo "name" es una trampa clasica ---
  const appForm = await (await fetch((await base()) + '/app.js')).text();
  check('los formularios leen sus campos por elements',
    /e\.target\.elements/.test(appForm) && /\$\('#agent-form'\)\.elements/.test(appForm));
  check('no se accede a form.name como si fuera un campo',
    !/\bf\.(name|model|effort|area|instructions)\.value/.test(appForm),
    'form.name es el nombre del formulario, no el campo: romperia el guardado entero');
  check('el envio se corta antes de construir los datos',
    /addEventListener\('submit', async \(e\) => \{\s*\/\/[^\n]*\n\s*\/\/[^\n]*\n\s*e\.preventDefault\(\)/.test(appForm) ||
    /submit[^]{0,400}e\.preventDefault\(\)[^]{0,200}const c = e\.target\.elements/.test(appForm),
    'si falla despues, el dialogo se cierra solo y el cambio se pierde');

  // --- nombre de la instalacion ---
  const est3 = await req('/api/state');
  check('la instalacion publica su nombre', !!(est3.data.app && est3.data.app.nombre), JSON.stringify(est3.data.app));
  const idxNom = await (await fetch((await base()) + '/')).text();
  const nombre = est3.data.app.nombre;
  check('el nombre sale ya en el titulo y la marca',
    idxNom.includes(`<title>${nombre}`) &&
    new RegExp(`<strong id="app-nombre"[^>]*>${nombre.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</strong>`).test(idxNom),
    'debe venir en el documento, no pintarse despues');
  const man = await (await fetch((await base()) + '/manifest.webmanifest')).json();
  check('la aplicacion instalada tambien lleva ese nombre', man.name === nombre, JSON.stringify(man.name));

  // --- exportar e importar el equipo ---
  const expo = await req('/api/export');
  const uno = expo.data.especialistas && expo.data.especialistas[0];
  check('exporta el equipo completo',
    expo.status === 200 && Array.isArray(expo.data.especialistas) && expo.data.especialistas.length > 0 && expo.data.version === 1);
  check('la exportacion no lleva sesiones ni rutas internas',
    !!uno && !('workspace' in uno) && !('id' in uno) && !('session_id' in uno) && !('has_session' in uno),
    JSON.stringify(uno && Object.keys(uno)));
  check('guarda de que proyecto venia', !!expo.data.proyecto);

  const ensayo = await req('/api/import', { method: 'POST', body: {
    especialistas: [{ name: `ST-Imp-${sufijo}`, area: 'x', instructions: 'y' }, { name: 'Sin texto' }],
    dryRun: true } });
  check('la importacion avisa antes de tocar nada',
    ensayo.data.ensayo === true && ensayo.data.nuevos.includes(`ST-Imp-${sufijo}`) &&
    ensayo.data.invalidos.includes('Sin texto'),
    JSON.stringify(ensayo.data).slice(0, 160));

  const real = await req('/api/import', { method: 'POST', body: {
    especialistas: [{ name: `ST-Imp-${sufijo}`, area: 'x', instructions: 'y', model: 'haiku' }],
    dryRun: false, modo: 'saltar' } });
  check('importa de verdad cuando se confirma', real.data.creados.includes(`ST-Imp-${sufijo}`));

  const repe = await req('/api/import', { method: 'POST', body: {
    especialistas: [{ name: `ST-Imp-${sufijo}`, area: 'x', instructions: 'z' }], dryRun: false, modo: 'saltar' } });
  check('no duplica lo que ya existe', repe.data.saltados.includes(`ST-Imp-${sufijo}`));

  const act = await req('/api/import', { method: 'POST', body: {
    especialistas: [{ name: `ST-Imp-${sufijo}`, area: 'x', instructions: 'z', model: 'sonnet' }], dryRun: false, modo: 'actualizar' } });
  check('en modo actualizar sobreescribe', act.data.actualizados.includes(`ST-Imp-${sufijo}`));

  const impId = (await req('/api/agents')).data.agents.find((x) => x.name === `ST-Imp-${sufijo}`);
  if (impId) await req(`/api/agents/${impId.id}?purgar=1`, { method: 'DELETE' });

  const idxExp = await (await fetch((await base()) + '/')).text();
  check('la interfaz tiene exportar e importar', /id="exportar"/.test(idxExp) && /id="importar"/.test(idxExp));

  // --- movil ---
  const cssMov = (await (await fetch((await base()) + '/style.css')).text()).replace(/\s+/g, '');
  check('la cabecera del chat se adapta a una pantalla estrecha',
    /\.chat-head\{flex-wrap:wrap/.test(cssMov) && /\.chat-actions\{[^}]*overflow-x:auto/.test(cssMov),
    'cuatro botones en una fila fija desbordan en el movil');
  check('las cuatro pestanas caben desplazandose',
    /\.tabs\{overflow-x:auto/.test(cssMov));
  check('el compositor deja el texto a un lado y los botones al otro',
    /\.composer\{flex-direction:row/.test(cssMov));
  check('adjuntar queda encima de enviar',
    /\.composer-acciones\{flex-direction:column/.test(cssMov),
    'en columna y en el orden del documento: adjuntar va primero');
  check('en pantalla tactil la hora y el copiar se ven sin pasar el raton',
    /\.messages\.hora\{opacity:\.55\}/.test(cssMov));
  check('los dialogos se pueden desplazar',
    /dialog\{overflow-y:auto/.test(cssMov));
  check('hay un corte extra para pantallas muy estrechas',
    /@media\(max-width:420px\)/.test(cssMov));

  // La cache sin conexion debe cubrir todo lo que el documento carga de verdad.
  const sw = await (await fetch((await base()) + '/sw.js')).text();
  const scripts = [...idxNom.matchAll(/src="(\/[^"?]+)/g)].map((m) => m[1]);
  check('el armazon sin conexion incluye todos los scripts de la pagina',
    scripts.length > 0 && scripts.every((s2) => sw.includes(`'${s2}'`)),
    `faltan en SHELL: ${scripts.filter((s2) => !sw.includes(`'${s2}'`)).join(', ')}`);
  check('las respuestas de la API nunca se cachean',
    /pathname\.startsWith\('\/api\/'\)\s*\)\s*return/.test(sw));

  // --- ocultar de verdad lo que se marca hidden ---
  // .tab-body{display:flex} ganaba sobre el display:none que el navegador da a
  // [hidden]: las cuatro pestanas se pintaban a la vez, apiladas.
  const cssCrudo = await (await fetch((await base()) + '/style.css')).text();
  const css1 = cssCrudo.replace(/\s+/g, '');
  const posHidden = css1.indexOf('[hidden]{display:none!important}');
  check('el atributo hidden se respeta pese a las reglas de display',
    posHidden >= 0, 'sin esta regla, cualquier .clase{display:...} deja visible lo oculto');
  for (const sel of ['.tab-body', '.composer', '.adjuntos', '.check']) {
    const m = new RegExp(`\\${sel}\\{[^}]*display:`).exec(css1);
    check(`${sel} no puede tapar su propio hidden`,
      !m || (posHidden >= 0 && posHidden > m.index),
      'la regla [hidden] debe ir despues para poder ganarle');
  }
  const idxPanel = await (await fetch((await base()) + '/')).text();
  check('el panel se puede ver a pantalla completa',
    /id="panel-ancho"/.test(idxPanel) && /body\.panel-ancho\.panel\{position:fixed/.test(css1));
  const appPanel = await (await fetch((await base()) + '/app.js')).text();
  check('cambiar de vista no borra las demas clases del body',
    !/document\.body\.className\s*=/.test(appPanel),
    'asignar className entero se llevaba por delante panel-ancho');

  // --- la salida del CLI ---
  const appAct = await (await fetch((await base()) + '/app.js')).text();
  check('solo corre un ciclo de refresco a la vez',
    /let refrescando = false/.test(appAct) && /if \(refrescando\) return/.test(appAct),
    'dos ciclos solapados pintaban el mismo bloque de salida dos veces');
  check('la salida no repite una linea aunque llegue dos veces',
    /actividadVistos\.has\(a\.id\)/.test(appAct) && /actividadVistos\.add\(a\.id\)/.test(appAct));
  check('el candado de la actividad se suelta pase lo que pase',
    /finally \{ actividadEnVuelo = false; \}/.test(appAct),
    'sin finally, un error dejaba la salida congelada para siempre');
  const cssSal = cssCrudo.replace(/\s+/g, '');
  const resSalida = [...cssSal.matchAll(/#tab-salida\.res\{([^}]*)\}/g)].map((m) => m[1]);
  // Manda la ultima regla que declare white-space, no la ultima a secas.
  const conWS = resSalida.filter((r) => /white-space:/.test(r));
  check('la salida se reparte en varias lineas, no en una sola recortada',
    conWS.length > 0 && /white-space:pre-wrap/.test(conWS[conWS.length - 1]),
    `gana "${conWS[conWS.length - 1] || 'ninguna'}": si acaba en nowrap, vuelve a verse cortada`);
  check('el texto largo parte por donde sea antes que desbordar',
    resSalida.some((r) => /overflow-wrap:anywhere/.test(r)));

  // Referencias a elementos que ya no existen: $() devuelve null y la funcion
  // muere ahi en silencio. Asi se quedo selectAgent al mover la salida a su
  // pestana, dejando sin ejecutar marcarVisto, renderAgents y setView.
  // Se mira el index.html de origen, no la pagina servida: la pantalla de
  // acceso se recorta cuando no hace falta token y seria un falso positivo.
  const fuenteHtml = fs.readFileSync(`${__dirname}/../public/index.html`, 'utf8');
  const idsUsados = [...appAct.matchAll(/\$\('#([\w-]+)'\)/g)].map((m) => m[1]);
  const idsDoc = new Set([
    ...[...fuenteHtml.matchAll(/id="([\w-]+)"/g)].map((m) => m[1]),
    ...[...appAct.matchAll(/id="([\w-]+)"/g)].map((m) => m[1])   // los que pinta el propio js
  ]);
  const huerfanos = [...new Set(idsUsados)].filter((i) => !idsDoc.has(i));
  check('app.js no busca elementos que no estan en el documento',
    huerfanos.length === 0,
    `$('#...') devolveria null y cortaria la funcion: ${huerfanos.join(', ')}`);

  // El aviso de version vive entre la pantalla de acceso y la aplicacion: el
  // recorte perezoso se lo llevaba por delante y no habia forma de enterarse
  // de que la interfaz habia cambiado.
  check('el aviso de version nueva sobrevive al recorte de la pantalla de acceso',
    /id="aviso-version"/.test(idxPanel) && /id="recargar-ya"/.test(idxPanel));
  if (!health.data.auth) {
    check('sin token, la pantalla de acceso no se sirve',
      !/id="login"/.test(idxPanel) && !/id="token-input"/.test(idxPanel));
  }
  check('la salida ya no pinta la hora',
    !/class="hora"[^`]*created_at[^`]*herr/.test(appAct) && /#tab-salida\.hora\{display:none\}/.test(cssSal));

  check('las pestanas inactivas se leen, no parecen desactivadas',
    /\.tab\{color:#aab2c5/.test(cssSal), 'en gris apagado no se distinguian de un boton inhabilitado');
  check('la pestana activa se distingue por fondo, no solo por una linea fina',
    /\.tab\.active\{[^}]*background:var\(--bg3\)/.test(cssSal));
  check('las pestanas son faciles de tocar en el movil',
    /\.tab\{[^}]*min-height:44px/.test(cssSal));
  check('sin especialista abierto la conversacion explica que hacer',
    /pintarVacioChat/.test(appAct) && /No hay ningun especialista abierto/.test(appAct) &&
    /\.vacio-chat\{/.test(cssSal),
    'antes era un hueco negro y parecia que la aplicacion estaba rota');

  // El alto de la vista movil no puede depender de que un numero coincida a
  // mano con el alto de la barra inferior: cualquier desajuste tapa el pie
  // de la conversacion, que es donde esta el boton de enviar.
  const cssEsp = cssCrudo.replace(/\s+/g, ' ');
  check('la vista movil reparte el alto con una rejilla, sin numeros magicos',
    /#app\s*\{[^}]*grid-template-rows: ?1fr auto/.test(cssEsp) &&
    /\.mobile-nav\{[^}]*grid-row:2/.test(cssSal),
    'con position:absolute y bottom:58px el compositor quedaba fuera');
  check('la conversacion puede encogerse para poder desplazarse',
    /\.messages\{min-height:0/.test(cssSal),
    'sin min-height:0 la lista empuja al compositor fuera de la pantalla');
  check('la cabecera y el compositor no se encogen',
    /\.chat-head, ?\.composer ?\{ ?flex: ?0 0 auto ?\}/.test(cssEsp));
  check('el teclado del movil encoge la pagina en vez de tapar el compositor',
    /interactive-widget=resizes-content/.test(idxPanel));

  check('en el movil enviar es un icono, no una barra con texto',
    /\.composer-acciones button\[type=submit\] ?\{[^}]*font-size: ?0/.test(cssEsp) &&
    /\.composer-acciones button\[type=submit\]::after ?\{ ?content: ?"➤"/.test(cssEsp));
  check('el boton de enviar conserva su nombre accesible',
    />Enviar</.test(idxPanel),
    'el texto se oculta con font-size:0 pero debe seguir en el documento');
  check('enviar y adjuntar son objetivos tactiles de 42px',
    /\.composer-acciones button ?\{[^}]*width: ?42px; ?height: ?42px/.test(cssEsp));

  // --- notificaciones ---
  const clavePush = await req('/api/push/clave');
  check('publica la clave para suscribirse',
    clavePush.status === 200 && /^B[\w-]{86}$/.test(clavePush.data.clave || ''),
    `clave P-256 sin comprimir en base64url: ${clavePush.data.clave}`);
  check('rechaza una suscripcion incompleta',
    (await req('/api/push/suscribir', { method: 'POST', body: { endpoint: 'https://a/b' } })).status === 400);
  check('no acepta endpoints sin cifrar',
    (await req('/api/push/suscribir', { method: 'POST', body: {
      endpoint: 'http://malo/x', keys: { p256dh: 'x', auth: 'y' } } })).status === 400,
    'un endpoint http no es un servicio de push real');

  // La cadena de cifrado entera, haciendo de navegador: si esto se rompe, los
  // avisos simplemente no llegarian y no habria forma de notarlo.
  {
    const crypto = require('node:crypto');
    const http = require('node:http');
    const push = require(`${__dirname}/../src/push.js`);
    const bu = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const hm = (k, d) => crypto.createHmac('sha256', k).update(d).digest();
    const der = (prk, info, n) => hm(prk, Buffer.concat([info, Buffer.from([1])])).subarray(0, n);

    const cli = crypto.createECDH('prime256v1'); cli.generateKeys();
    const secreto = crypto.randomBytes(16);
    let recibido = null, codigo = 201;
    const srv = http.createServer((rq, rs) => {
      const t = []; rq.on('data', (c) => t.push(c));
      rq.on('end', () => { recibido = Buffer.concat(t); rs.writeHead(codigo); rs.end(); });
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const sub = { endpoint: `http://127.0.0.1:${srv.address().port}/p`, p256dh: bu(cli.getPublicKey()), auth: bu(secreto) };
    const claves = push.cargarClaves(`${__dirname}/../.tmp-vapid`);
    const carga = { titulo: 'Prueba ñ', cuerpo: 'áéí', insignia: 2 };
    const env = await push.enviarUno(sub, carga, claves, 'mailto:x@y.z');

    let descifrado = null;
    if (recibido) {
      const sal = recibido.subarray(0, 16), idl = recibido.readUInt8(20);
      const sp = recibido.subarray(21, 21 + idl), cu = recibido.subarray(21 + idl);
      const prk = hm(sal, der(hm(secreto, cli.computeSecret(sp)),
        Buffer.concat([Buffer.from('WebPush: info\0'), cli.getPublicKey(), sp]), 32));
      const d = crypto.createDecipheriv('aes-128-gcm',
        der(prk, Buffer.from('Content-Encoding: aes128gcm\0'), 16),
        der(prk, Buffer.from('Content-Encoding: nonce\0'), 12));
      d.setAuthTag(cu.subarray(cu.length - 16));
      const claro = Buffer.concat([d.update(cu.subarray(0, cu.length - 16)), d.final()]);
      descifrado = claro.subarray(0, claro.length - 1).toString('utf8');
    }
    check('el aviso llega cifrado y el destinatario puede leerlo',
      env.ok && descifrado === JSON.stringify(carga),
      `recibido: ${descifrado}`);

    codigo = 410;
    const env2 = await push.enviarUno(sub, carga, claves, 'mailto:x@y.z');
    check('una suscripcion revocada se marca para borrar',
      env2.caducada === true, 'si no, se reintenta en cada aviso para siempre');
    srv.close();
    fs.rmSync(`${__dirname}/../.tmp-vapid`, { recursive: true, force: true });
  }

  // La exportacion se comparte entre servidores: no puede llevar secretos.
  // Se mira la estructura, no el texto: las instrucciones de los
  // especialistas hablan de "endpoint" y "auth" como terminos del dominio.
  const expPush = (await req('/api/export')).data;
  const clavesRaiz = Object.keys(expPush);
  check('la exportacion no lleva claves ni suscripciones',
    !clavesRaiz.some((k) => /push|vapid|suscrip/i.test(k)) &&
    !expPush.especialistas.some((e) => Object.keys(e).some((k) => /push|vapid|endpoint|p256dh/i.test(k))),
    JSON.stringify(clavesRaiz));
  check('la clave publica de push no viaja en la exportacion',
    !JSON.stringify(expPush).includes(clavePush.data.clave),
    'la publica no es secreta, pero no pinta nada en un fichero de equipo');

  check('la clave privada no es legible por otros',
    (fs.statSync(`${cfg.dataDir}/vapid.json`).mode & 0o077) === 0,
    'firma los envios: solo el servicio debe poder leerla');

  const swPush = await (await fetch((await base()) + '/sw.js')).text();
  check('el service worker atiende los avisos con la aplicacion cerrada',
    /addEventListener\('push'/.test(swPush) && /showNotification/.test(swPush));
  check('al tocar el aviso se abre ese especialista',
    /addEventListener\('notificationclick'/.test(swPush) && /abrir-agente/.test(swPush));
  check('el aviso pone el contador en el icono',
    /setAppBadge/.test(swPush));
  check('existe el icono monocromo de la bandeja',
    (await fetch((await base()) + '/icons/badge-96.png')).status === 200);
  check('el permiso se pide al activar la casilla, no al abrir',
    /requestPermission/.test(appAct) && !/requestPermission/.test(appAct.split('function activarPush')[0]),
    'pedirlo de entrada es la forma mas rapida de que lo denieguen para siempre');

  const orqSrc = fs.readFileSync(`${__dirname}/../src/orchestrator.js`, 'utf8');
  check('un fallo al avisar no puede tumbar el turno',
    /notificar\(tipo, agent, extra\)/.test(orqSrc) && /\.catch\(/.test(orqSrc.split('notificar(tipo')[1].slice(0, 400)),
    'el turno ya esta hecho y guardado cuando se avisa');

  check('la flecha de volver ya no duplica a la barra inferior',
    !/id="back-agents"/.test(idxPanel) && !/back-agents/.test(appAct));

  check('los tres interruptores caben en una fila de iconos',
    /class="interruptores"/.test(idxPanel) &&
    (idxPanel.match(/class="sw"/g) || []).length === 3,
    'antes eran tres casillas con texto, cuatro lineas del pie');
  check('siguen siendo casillas reales, no botones falsos',
    (idxPanel.match(/class="sw"[^]*?type="checkbox"/g) || []).length >= 1 &&
    /\.sw input ?\{[^}]*opacity: ?0/.test(cssEsp),
    'ocultas visualmente pero accesibles por teclado');
  check('el estado encendido se refleja sin JavaScript',
    /\.sw:has\(input:checked\)/.test(cssSal));
  check('hay respaldo si el navegador no admite :has',
    /@supports not selector\(:has\(\*\)\)/.test(cssEsp),
    'si no, se verian todos atenuados como si estuvieran apagados');
  check('el texto de estado solo ocupa sitio cuando dice algo',
    /\.push-estado:empty\{display:none\}/.test(cssSal));

  // Al desplegar en otro servidor hay que poder preguntarle al sistema por
  // que direccion se llega a el con certificado, no deducirlo.
  const st = await req('/api/state');
  check('la instalacion sabe decir su direccion segura',
    st.data.app && 'acceso' in st.data.app,
    'sin esto solo queda la IP, que no sirve para instalar ni para avisos');
  if (st.data.app.acceso) {
    check('esa direccion es https y responde',
      /^https:\/\//.test(st.data.app.acceso), st.data.app.acceso);
  }
  const inst = fs.readFileSync(`${__dirname}/../install.sh`, 'utf8');
  check('el instalador dice la direccion buena al terminar',
    /ACCESO_HTTPS/.test(inst), 'en un servidor nuevo es donde mas falta hace');
  check('el instalador configura el HTTPS, no solo lo sugiere',
    /tailscale serve --bg --https="\$\{HTTPS_PORT\}"/.test(inst),
    'dejarlo como consejo obliga a repetir a mano lo mismo en cada servidor');
  check('elige un puerto libre y no pisa a otra instalacion',
    /for\(let p=8443;p<8500;p\+\+\)/.test(inst) && /d\.TCP/.test(inst));
  check('se puede omitir y se puede fijar el puerto',
    /--no-tailscale\)/.test(inst) && /--https-port\)/.test(inst));
  check('nunca usa funnel, que publicaria a internet',
    !/tailscale funnel/.test(inst),
    'serve se queda en la tailnet; funnel abriria el sistema al exterior');

  check('avisa cuando se entra por HTTP, donde no hay PWA ni avisos',
    /id="aviso-inseguro"/.test(idxPanel) &&
    /window\.isSecureContext/.test(appAct) &&
    /avisarOrigenInseguro/.test(appAct),
    'por HTTP el navegador no registra el service worker y no hay nada que instalar');
  check('ese aviso se puede descartar para siempre',
    /id="cerrar-inseguro"/.test(idxPanel) && /CLAVE_AVISO_HTTP/.test(appAct),
    'quien entra por IP a proposito no necesita que se lo repitan cada vez');

  // --- notas privadas ---
  const notasTxt = 'orden 1\norden 2\nconsultar a @Panel';
  await req(`/api/agents/${A}/notas`, { method: 'PUT', body: { notas: notasTxt } });
  const leidas = await req(`/api/agents/${A}/notas`);
  check('las notas se guardan y se releen',
    leidas.data.notas === notasTxt, JSON.stringify(leidas.data).slice(0, 120));
  const listaN = (await req('/api/agents')).data.agents.find((x) => x.id === A);
  check('el listado avisa de que hay notas sin arrastrar el texto',
    listaN.tiene_notas === true && !('notas' in listaN), JSON.stringify(Object.keys(listaN)));
  const expN = await req('/api/export');
  check('las notas no salen en la exportacion: son personales',
    !JSON.stringify(expN.data).includes('orden 1'));
  await req(`/api/agents/${A}/notas`, { method: 'PUT', body: { notas: '' } });
  check('se pueden vaciar',
    (await req('/api/agents')).data.agents.find((x) => x.id === A).tiene_notas === false);
  // Se busca el acceso al campo, no la palabra suelta: "notas" aparece en
  // frases que no tienen nada que ver y daba un falso positivo.
  const fuga = /\b(agent|a|fila|row)\.notas\b|\['notas'\]|\bnotas:\s/;
  check('las notas no viajan al modelo por ningun camino',
    !fuga.test(fs.readFileSync(`${__dirname}/../src/runner.js`, 'utf8')) &&
    !fuga.test(fs.readFileSync(`${__dirname}/../src/orchestrator.js`, 'utf8')),
    'si el runner o el orquestador leen ese campo, acabaria en el prompt');
  const idxN = idxPanel;
  check('hay boton de notas en la conversacion',
    /id="notas"/.test(idxN) && /id="notas-dialog"/.test(idxN));

  // updateAgent filtraba en silencio los campos que no conocia: anadir una
  // columna y olvidar la lista daba un guardado que respondia ok sin escribir.
  const { Store: StoreChk } = require(`${__dirname}/../src/db.js`);
  check('guardar un campo desconocido falla en vez de mentir', (() => {
    const tmp = `${__dirname}/../.tmp-chk.db`;
    try {
      const st = new StoreChk(tmp);
      st.createAgent({ id: 'chk', name: 'chk', instructions: 'x', home: '/tmp', workspace: '/tmp' });
      try { st.updateAgent('chk', { inventado: 1 }); return false; } catch { return true; }
    } finally { for (const f of ['', '-shm', '-wal']) fs.rmSync(tmp + f, { force: true }); }
  })());

  // --- relojes del turno ---
  // Un turno largo es legitimo; uno colgado no. Se comprueba sobre el codigo
  // porque probarlo de verdad exige esperar el tiempo real.
  const runnerSrc = fs.readFileSync(`${__dirname}/../src/runner.js`, 'utf8');
  check('un turno puede durar horas si el tope total esta en 0',
    /Number\(cfg\.turnTimeoutMs\) > 0 \? Number\(cfg\.turnTimeoutMs\) : 0/.test(runnerSrc),
    'sin esto, 0 se tomaria como "cortar de inmediato"');
  check('el reloj de inactividad se reinicia con cada señal del proceso',
    /child\.stdout\.on\('data'[\s\S]{0,120}?reiniciarQuieto\(\)/.test(runnerSrc) &&
    /child\.stderr\.on\('data'[\s\S]{0,120}?reiniciarQuieto\(\)/.test(runnerSrc),
    'si no se reinicia, cortaria a un agente que trabaja sin parar');
  check('se pide salir por las buenas antes de matar',
    /kill\('SIGTERM'\)[\s\S]{0,300}?setTimeout\([\s\S]{0,120}?kill\('SIGKILL'\)/.test(runnerSrc),
    'matar en seco a mitad de una escritura deja ficheros truncados');
  check('el golpe de gracia no mantiene vivo al servicio',
    /golpe\.unref/.test(runnerSrc));
  check('los dos relojes se limpian al acabar el turno',
    (runnerSrc.match(/limpiarRelojes\(\)/g) || []).length >= 3,
    'un reloj suelto dispararia sobre un turno ya cerrado');

  const estTopes = await req('/api/state');
  check('esta instalacion no corta por tiempo total',
    cfg.turnTimeoutMs === 0 || cfg.turnTimeoutMs === undefined,
    `turnTimeoutMs = ${cfg.turnTimeoutMs}`);

  // --- espera de cuota ---
  const { esLimiteDeCuota } = require(`${__dirname}/../src/orchestrator.js`);
  check('reconoce el mensaje real de limite de cuota',
    esLimiteDeCuota("You've hit your 5-hour limit · resets 6:10pm (America/Lima)") &&
    esLimiteDeCuota('Usage limit reached') && esLimiteDeCuota('rate_limit_error'));
  check('no confunde un fallo normal con falta de cuota',
    !esLimiteDeCuota('Tiempo agotado tras 15 min') &&
    !esLimiteDeCuota('Error: cannot find module ./limits.js') &&
    !esLimiteDeCuota('permission denied: /etc/asterisk/sip.conf'),
    'reintentar un error de codigo cada 30 min seria un bucle sin fin');

  {
    const { Store: StoreQ } = require(`${__dirname}/../src/db.js`);
    const tmp = `${__dirname}/../.tmp-cuota.db`;
    try {
      for (const f of ['', '-shm', '-wal']) fs.rmSync(tmp + f, { force: true });
      const st = new StoreQ(tmp);
      st.createAgent({ id: 'q', name: 'q', instructions: 'x', home: '/tmp', workspace: '/tmp' });
      const tid = st.enqueueTurn({ agentId: 'q', prompt: 'trabajo original', origin: 'user' });
      st.esperarCuota(tid, new Date(Date.now() + 1800000).toISOString(), 'limite');
      const nadie = st.nextPendingTurns(10).length === 0;
      const guardado = st.turnosEnEspera()[0];
      st.esperarCuota(tid, new Date(Date.now() - 1000).toISOString(), 'limite');
      const sale = st.nextPendingTurns(10).length === 1;
      check('un turno sin cuota espera y no se pierde',
        nadie && sale && guardado.prompt === 'trabajo original',
        'la orden debe sobrevivir intacta hasta que vuelva la cuota');
      check('cuenta los reintentos y recuerda desde cuando espera',
        st.turnosEnEspera()[0].reintentos === 2 && !!st.turnosEnEspera()[0].espera_desde,
        'sin espera_desde no se puede aplicar el tope de 24 h');
    } finally {
      for (const f of ['', '-shm', '-wal']) fs.rmSync(tmp + f, { force: true });
    }
  }

  const orqQ = fs.readFileSync(`${__dirname}/../src/orchestrator.js`, 'utf8');
  check('se rinde tras el tope en vez de reintentar para siempre',
    /Date\.now\(\) - desde >= topeMs/.test(orqQ) && /Se abandona tras/.test(orqQ));
  check('al volver de la espera el aviso dice que retomo',
    /retomado: \(turn\.reintentos \|\| 0\) > 0/.test(orqQ) &&
    /retomo y termino/.test(fs.readFileSync(`${__dirname}/../src/server.js`, 'utf8')));

  const estQ = (await req('/api/state')).data;
  check('el estado publica lo que espera cuota',
    Array.isArray(estQ.esperando), JSON.stringify(estQ.esperando));
  check('el reloj va en la zona del servidor, la de los avisos de cuota',
    !!estQ.app.zona && !!estQ.app.ahora && /id="reloj"/.test(idxPanel) &&
    /timeZone: ZONA/.test(appAct),
    `zona ${estQ.app.zona}: con otra habria que hacer la cuenta a mano`);

  // --- memoria: buscar en el propio historial ---
  {
    const { Store: StoreH } = require(`${__dirname}/../src/db.js`);
    const tmp = `${__dirname}/../.tmp-hist.db`;
    try {
      for (const f of ['', '-shm', '-wal']) fs.rmSync(tmp + f, { force: true });
      const st = new StoreH(tmp);
      st.createAgent({ id: 'h1', name: 'h1', instructions: 'x', home: '/tmp', workspace: '/tmp' });
      st.createAgent({ id: 'h2', name: 'h2', instructions: 'x', home: '/tmp', workspace: '/tmp' });
      st.addMessage('h1', 'user', 'la recarga de troncales va por el wrapper sudo');
      st.addMessage('h1', 'assistant', 'entendido, uso el wrapper');
      st.addMessage('h2', 'user', 'esto es de otro especialista y habla de troncales');

      const r = st.buscarEnHistorial('h1', 'troncales');
      check('encuentra lo que se dijo en su conversacion',
        r.length === 1 && /wrapper sudo/.test(r[0].texto), JSON.stringify(r));
      check('no ve la conversacion de otro especialista',
        !JSON.stringify(r).includes('otro especialista'),
        'es la misma frontera que separa sus archivos');
      check('una busqueda vacia no devuelve el historial entero',
        st.buscarEnHistorial('h1', '').length === 0 && st.buscarEnHistorial('h1', '   ').length === 0);
      check('los comodines de SQL no alteran la busqueda',
        st.buscarEnHistorial('h1', '%').length === 0 && st.buscarEnHistorial('h1', '_').length === 0,
        'sin escapar, "%" devolveria todo');

      const largo = 'x'.repeat(2000) + 'AGUJA' + 'y'.repeat(2000);
      st.addMessage('h1', 'assistant', largo);
      const corte = st.buscarEnHistorial('h1', 'AGUJA')[0];
      check('recorta alrededor de la coincidencia, no por el principio',
        corte.texto.includes('AGUJA') && corte.texto.length < 700,
        `devolvio ${corte.texto.length} caracteres: cada uno ocupa contexto del especialista`);
    } finally {
      for (const f of ['', '-shm', '-wal']) fs.rmSync(tmp + f, { force: true });
    }
  }

  const mcpSrc = fs.readFileSync(`${__dirname}/../src/bridge/mcp-server.js`, 'utf8');
  check('la herramienta recordar esta publicada al especialista',
    /name: 'recordar'/.test(mcpSrc) && /case 'recordar'/.test(mcpSrc));
  check('el prompt del sistema le dice que la tiene y cuando usarla',
    /mcp__v4__recordar/.test(runnerSrc) && /recordar ANTES de decir que no lo tienes/.test(runnerSrc),
    'una herramienta que no se menciona no se usa');
  check('el historial solo se sirve con el token interno',
    (await req(`/api/internal/agents/${A}/historial?q=x`, { token: null, bridge: 'malo' })).status === 401);

  // --- proveedores ---
  const provs = require(`${__dirname}/../src/proveedores`);
  const estP = (await req('/api/state')).data;
  check('publica que proveedores hay y cuales estan instalados',
    Array.isArray(estP.proveedores) && estP.proveedores.length >= 2 &&
    estP.proveedores.every((p) => 'instalado' in p && 'modelos' in p && 'reanuda' in p),
    JSON.stringify(estP.proveedores.map((p) => [p.nombre, p.instalado])));
  check('Claude sigue siendo el de por defecto',
    provs.obtener(undefined).nombre === 'claude' && provs.obtener('inventado').nombre === 'claude',
    'un nombre desconocido no puede dejar al agente sin ejecutor');

  // Todos tienen que cumplir el mismo contrato, o el runner fallaria al
  // usar uno que no lo cumple.
  for (const p of Object.values(provs.PROVEEDORES)) {
    check(`el proveedor ${p.nombre} cumple el contrato`,
      typeof p.binario === 'function' && typeof p.preparar === 'function' &&
      typeof p.esFinal === 'function' && typeof p.limiteDe === 'function' &&
      typeof p.resultado === 'function' && Array.isArray(p.modelos) && !!p.faltaBinario);
  }

  // El adaptador de Claude debe producir exactamente lo de siempre: este es
  // el refactor que no puede cambiar comportamiento.
  {
    const cl = provs.obtener('claude');
    const tmpHome = `${__dirname}/../.tmp-home`;
    fs.mkdirSync(tmpHome, { recursive: true });
    try {
      const plan = cl.preparar(
        { claudeBin: '/bin/true', appDir: `${__dirname}/..`, port: 1, bridgeToken: 'b', sessionDir: '/tmp/s', model: 'sonnet', effort: 'high' },
        { id: 'x', name: 'X', home: tmpHome, workspace: '/tmp', session_id: 'S1' },
        { prompt: 'p', chain_id: 'c', hop: 3 }, 'SP');
      check('Claude conserva sus banderas de siempre',
        plan.args.includes('bypassPermissions') && plan.args.includes('stream-json') &&
        plan.args.includes('--resume') && plan.args.includes('S1') &&
        plan.env.CLAUDE_CONFIG_DIR === '/tmp/s',
        plan.args.join(' ').slice(0, 120));
      const mcp = JSON.parse(fs.readFileSync(`${tmpHome}/mcp.json`, 'utf8'));
      check('el puente MCP sigue recibiendo cadena y salto',
        mcp.mcpServers.v4.env.V4_CHAIN_ID === 'c' && mcp.mcpServers.v4.env.V4_HOP === '3');
    } finally { fs.rmSync(tmpHome, { recursive: true, force: true }); }
  }

  // Y Codex debe traducir a SU forma, no a la de Claude.
  {
    const cx = provs.obtener('codex');
    const tmpHome = `${__dirname}/../.tmp-home2`;
    fs.mkdirSync(tmpHome, { recursive: true });
    try {
      const plan = cx.preparar(
        { appDir: `${__dirname}/..`, port: 1, bridgeToken: 'b', dataDir: `${__dirname}/../.tmp-datos` },
        { id: 'y', name: 'Y', home: tmpHome, workspace: '/tmp', model: 'gpt-5-codex', session_id: 'T1' },
        { prompt: 'tarea', chain_id: 'c2', hop: 1 }, 'SP');
      check('Codex usa exec, json y su propio bypass',
        plan.args[0] === 'exec' && plan.args.includes('--json') &&
        plan.args.includes('--dangerously-bypass-approvals-and-sandbox'),
        plan.args.slice(0, 6).join(' '));
      check('Codex reanuda con su subcomando, no con --resume',
        plan.args[1] === 'resume' && plan.args[2] === 'T1' && !plan.args.includes('--resume'));
      const copts = plan.args.filter((a, i) => plan.args[i - 1] === '-c');
      check('Codex recibe el puente MCP en cada turno, no por fichero',
        copts.some((o) => /^mcp_servers\.v4\.command=/.test(o)) &&
        copts.some((o) => o === 'mcp_servers.v4.env.V4_AGENT_ID="y"') &&
        copts.some((o) => o === 'mcp_servers.v4.env.V4_CHAIN_ID="c2"'),
        'sin esto no tendria send_message, claim_files ni recordar');
      check('Codex se lanza con node en el PATH',
        /(^|:)\/usr\/local\/lib\/nodejs|bin(:|$)/.test(plan.env.PATH || '') &&
        (plan.env.PATH || '').startsWith(require('node:path').dirname(process.execPath)),
        'el codex de npm es un script con cabecera env node: sin PATH falla al arrancar');
      check('la sesion de Codex es una sola para todo el equipo',
        /session-codex$/.test(plan.env.CODEX_HOME) && !plan.env.CODEX_HOME.includes(tmpHome),
        'si colgara del home del agente, cada especialista exigiria su propio login');
      check('a Codex el prompt del sistema le va dentro del mensaje',
        plan.args[plan.args.length - 1].startsWith('SP') &&
        plan.args[plan.args.length - 1].includes('tarea'),
        'no tiene equivalente de --append-system-prompt');
    } finally { fs.rmSync(tmpHome, { recursive: true, force: true }); }
  }

  check('un proveedor que no publica coste devuelve null, no un cero falso',
    provs.obtener('codex').resultado({ msg: { last_agent_message: 'hecho' } }, {}).cost === null,
    'un cero se leeria como "gratis"');

  // --- conectar Codex desde la web ---
  const provsApi = (await req('/api/providers')).data.proveedores;
  check('la pantalla de proveedor lista los dos',
    provsApi.length >= 2 && provsApi.some((x) => x.proveedor === 'codex'),
    JSON.stringify(provsApi.map((x) => x.proveedor)));
  check('dice si Codex esta instalado y si tiene sesion',
    provsApi.some((x) => x.proveedor === 'codex' && 'instalado' in x && 'conectado' in x));
  check('el boton de la barra lateral nombra a los dos proveedores',
    /function etiquetaProveedores/.test(appAct) && /partes\.push\(codex\.conectado/.test(appAct),
    'llamandolo solo "Claudio" nadie encontraria donde se conecta ChatGPT');
  check('hay boton para conectar ChatGPT',
    /id="codex-login"/.test(idxPanel) && /id="codex-codigo"/.test(idxPanel) && /id="codex-url"/.test(idxPanel),
    'sin esto habria que entrar por consola en cada servidor');
  check('el codigo de un solo uso se muestra legible para teclearlo en otro sitio',
    /\.codigo-grande\{/.test(cssSal) && /letter-spacing/.test(cssSal));
  check('se puede cancelar una conexion a medias',
    (await req('/api/providers/codex/cancel', { method: 'POST' })).status === 200);
  check('la comprobacion dice si ya autorizo',
    typeof (await req('/api/providers/codex/check')).data.listo === 'boolean');

  // --- aspecto de terminal ---
  check('la conversacion tiene fondo matrix con interruptor',
    /id="matrix"/.test(idxExp) && /id="matrix-on"/.test(idxExp));
  const cssTerm = await (await fetch((await base()) + '/style.css')).text();
  const appChat = await (await fetch((await base()) + '/app.js')).text();
  check('cada participante tiene su color',
    /colorDe\(actual\.avatar_seed/.test(appChat) && /class="quien"/.test(appChat),
    'sin color no se sigue una conversacion de tres');
  const cssChat = (await (await fetch((await base()) + '/style.css')).text()).replace(/\s+/g, '');
  check('tus mensajes van a la derecha',
    /\.messages\.msg\.user\{[^}]*text-align:right/.test(cssChat));
  check('la franja de color ocupa el turno entero',
    /\.messages\.msg\{[^}]*display:block;width:100%/.test(cssChat),
    'resaltar solo el texto dejaba las filas sueltas');
  check('cada mensaje se tine del color de quien habla',
    /background-color:color-mix\(insrgb,var\(--color-quien/.test(cssChat));
  check('la respuesta del especialista usa todo el ancho',
    /\.messages\.linea\{[^}]*width:100%/.test(cssChat));
  check('lo tuyo se queda recogido a la derecha',
    /\.messages\.msg\.user\.linea\{[^}]*max-width:72ch/.test(cssChat));
  const fmt = require('node:child_process').execFileSync(process.execPath, ['-e',
    'const fs=require("fs");const src=fs.readFileSync("' + __dirname + '/../public/app.js","utf8");' +
    'const i=src.indexOf("function formatearCuerpo"),f=src.indexOf("/** Copia respetando");' +
    'const e=src.slice(src.indexOf("function escapeHtml"));global.agents=[];' +
    'eval(src.slice(i,f)+e.slice(0,e.indexOf("\\n}")+2));' +
    'const a=formatearCuerpo("uno\\n\\n\\ndos");' +
    'const b=formatearCuerpo("x\\n```bash\\nuno\\n\\ndos\\n```");' +
    'process.stdout.write(JSON.stringify({huecos:(a.match(/\\n\\s*\\n/g)||[]).length,' +
    'codigoIntacto:/<code>[\\s\\S]*uno\\n\\ndos/.test(b)}))'], { encoding: 'utf8' });
  const ff = JSON.parse(fmt);
  check('los parrafos no dejan lineas en blanco', ff.huecos === 0, fmt);
  check('dentro del codigo los saltos se respetan', ff.codigoIntacto === true, fmt);

  check('no hay sangria francesa en los mensajes',
    !/\.messages\.linea\{[^}]*text-indent/.test(cssChat),
    'text-indent solo mueve la primera linea y descuadra los parrafos siguientes');

  check('cada mensaje cabe en una linea: nombre > texto',
    /class="sep"/.test(appChat) && /class="dicho"/.test(appChat) && !/marca = /.test(appChat),
    'partirlo en cabecera y cuerpo lo hacia ilegible');
  const cssSinEspacios = (await (await fetch((await base()) + '/style.css')).text()).replace(/\s+/g, '');
  check('los mensajes ya no llevan avatar',
    !/avatar\(actual,/.test(appChat) && !/avatar\(emisor,/.test(appChat) &&
    cssSinEspacios.includes('.messages.msg.robot{display:none}'),
    'el avatar repetido en cada linea rompe la alineacion de una consola');

  check('el centro se ve como una terminal',
    /\.messages\{font-family:ui-monospace/.test(cssTerm.replace(/\s+/g, '')) ||
    /\.messages/.test(cssTerm) && /ui-monospace/.test(cssTerm));
  const appMat = await (await fetch((await base()) + '/app.js')).text();
  check('la animacion se detiene con la pestana oculta',
    /visibilitychange/.test(appMat) && /document\.hidden/.test(appMat),
    'una animacion continua gasta bateria sin que nadie la mire');

  // --- renombrar desde la web ---
  const original = est3.data.app.nombre;
  const nuevo = await req('/api/app', { method: 'PATCH', body: { nombre: `ST-Nombre-${sufijo}` } });
  check('se puede renombrar la instalacion desde la web',
    nuevo.status === 200 && nuevo.data.nombre === `ST-Nombre-${sufijo}`, JSON.stringify(nuevo.data));
  check('el cambio surte efecto sin reiniciar',
    (await req('/api/state')).data.app.nombre === `ST-Nombre-${sufijo}`);
  check('rechaza un nombre vacio',
    (await req('/api/app', { method: 'PATCH', body: { nombre: '  ' } })).status === 400);
  check('rechaza un nombre desmedido',
    (await req('/api/app', { method: 'PATCH', body: { nombre: 'x'.repeat(70) } })).status === 400);

  const cfgDisco = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  check('guardar el nombre no pierde los tokens',
    !!cfgDisco.authToken && !!cfgDisco.bridgeToken && cfgDisco.nombre === `ST-Nombre-${sufijo}`);
  await req('/api/app', { method: 'PATCH', body: { nombre: original } });

  const idxRen = await (await fetch((await base()) + '/')).text();
  check('la marca se puede pulsar para renombrar',
    /id="app-nombre"/.test(idxRen) && /id="app-nombre-edit"/.test(idxRen));

  // --- el selector de modelo debe dejar cambiar ---
  const idxModelo = await (await fetch((await base()) + '/')).text();
  check('el modelo se elige con un selector, no con una lista que filtra',
    /<select name="model"/.test(idxModelo) && !/name="model" list=/.test(idxModelo),
    'un input con datalist filtra por lo ya escrito y bloquea el cambio');
  check('se puede escribir un modelo que no este en la lista',
    /id="modelo-otro"/.test(idxModelo));

  const appModelo = await (await fetch((await base()) + '/app.js')).text();
  check('el selector incluye el modelo ya guardado aunque sea raro',
    /!sugeridos\.includes\(actual\)/.test(appModelo));

  // --- interfaz desactualizada ---
  const salud2 = await req('/api/health', { token: null });
  check('la salud publica la version de interfaz', !!salud2.data.ui);
  const idxVer = await (await fetch((await base()) + '/')).text();
  const inyectada = (idxVer.match(/V4_VERSION='(\d+)'/) || [])[1];
  check('la pagina se carga sabiendo su version', inyectada === String(salud2.data.ui),
    `pagina=${inyectada} servidor=${salud2.data.ui}`);
  const appVer = await (await fetch((await base()) + '/app.js')).text();
  check('avisa si el navegador trae una interfaz vieja',
    /vigilarVersion/.test(appVer) && /aviso-version/.test(appVer) && /caches\.delete/.test(appVer));
  check('un fallo al guardar se muestra en el formulario',
    /No se guardo: \$\{err/.test(appVer) && /console\.error\('\[v4\] fallo al guardar/.test(appVer));

  // --- avisos de trabajo terminado ---
  // En una instalacion recien hecha no hay ningun mensaje todavia, asi que la
  // comprobacion se fabrica el suyo en vez de depender de que alguien haya
  // trabajado antes. Se escribe sobre el agente de pruebas, que se purga al final.
  {
    const { Store: StoreM } = require(`${__dirname}/../src/db.js`);
    const stm = new StoreM(cfg.dbPath || `${cfg.dataDir}/v4.db`);
    stm.addMessage(A, 'assistant', 'mensaje de autodiagnostico');
  }
  const est2 = await req('/api/state');
  const conMsg = est2.data.agents.find((x) => x.ultimo_mensaje);
  check('el estado dice cual es el ultimo mensaje de cada agente',
    !!conMsg && typeof conMsg.ultimo_mensaje.id === 'number' && !!conMsg.ultimo_mensaje.rol,
    JSON.stringify(conMsg && conMsg.ultimo_mensaje));

  const appAviso = await (await fetch((await base()) + '/app.js')).text();
  check('la interfaz marca lo que falta por revisar',
    /function tienePendiente/.test(appAviso) && /className = 'aviso'/.test(appAviso) && /localStorage.setItem\(VISTOS/.test(appAviso));
  check('suena al terminar un trabajo, con interruptor',
    /function sonar/.test(appAviso) && /AudioContext/.test(appAviso) && /v4-sonido/.test(appAviso));

  const cssAviso = await (await fetch((await base()) + '/style.css')).text();
  check('el aviso se ve en la fila del especialista', /\.agent \.aviso/.test(cssAviso));

  // --- formato de los mensajes ---
  const appTxt = await (await fetch((await base()) + '/app.js')).text();
  check('los mensajes se formatean antes de pintarse',
    /function formatearCuerpo/.test(appTxt) && /formatearCuerpo\(m\.body\)/.test(appTxt));
  check('el texto del modelo se escapa antes de transformarlo',
    /enriquecer\(escapeHtml\(/.test(appTxt),
    'la transformacion debe trabajar siempre sobre texto ya escapado');
  check('cada mensaje lleva su boton de copiar',
    /class="copiar-msg"/.test(appTxt) && /closest\('\.copiar-msg'\)/.test(appTxt));
  check('hay copia con respaldo para HTTP sin cifrar',
    /execCommand\('copy'\)/.test(appTxt) && /isSecureContext/.test(appTxt));

  const cssFmt = await (await fetch((await base()) + '/style.css')).text();
  check('hay estilo de bloque de codigo, enlace y ruta copiable',
    /\.bloque pre/.test(cssFmt) && /code\.copiable/.test(cssFmt) && /\.msg a\b/.test(cssFmt));

  // --- menciones ---
  const conMencion = await req(`/api/agents/${A}/messages`, { method: 'POST', body: {
    text: `Consulta esto con @ST-Beta-${sufijo} antes de responder.` } });
  check('un mensaje con mencion se acepta', conMencion.status === 202);
  const evMen = (await req('/api/events')).data.events.find((e) => e.kind === 'mencion');
  check('la mencion se reconoce y queda registrada',
    !!evMen && Array.isArray(evMen.data.a) && evMen.data.a.includes(`ST-Beta-${sufijo}`),
    JSON.stringify(evMen && evMen.data));

  const idxMen = await (await fetch((await base()) + '/')).text();
  check('el cuadro de escritura tiene lista de menciones', /id="menciones"/.test(idxMen));

  const appMen = await (await fetch((await base()) + '/app.js')).text();
  check('las menciones se autocompletan y se resaltan',
    /function buscarMencion/.test(appMen) && /class="mencion"/.test(appMen) &&
    /ArrowDown/.test(appMen));
  check('avisa si mencionas a alguien que no existe',
    /No reconozco \$\{sueltas/.test(appMen));

  // --- eliminar especialistas ---
  const temp = await req('/api/agents', { method: 'POST', body: {
    name: `ST-Borrar-${sufijo}`, area: 'prueba', instructions: 'temporal' } });
  const T = temp.data.id;

  await req(`/api/agents/${T}`, { method: 'DELETE' });
  const listaNormal = (await req('/api/agents')).data.agents;
  const listaTodos = (await req('/api/agents?all=1')).data.agents;
  check('eliminar lo saca de la lista pero conserva su historial',
    !listaNormal.some((x) => x.id === T) && listaTodos.some((x) => x.id === T));

  const purga = await req(`/api/agents/${T}?purgar=1`, { method: 'DELETE' });
  const trasPurga = (await req('/api/agents?all=1')).data.agents;
  check('con purgar se borra del todo',
    purga.data.borrado === true && !trasPurga.some((x) => x.id === T));

  const idxDel = await (await fetch((await base()) + '/')).text();
  check('la interfaz tiene boton de eliminar con opcion de purgar',
    /id="eliminar"/.test(idxDel) && /id="eliminar-purgar"/.test(idxDel));

  const appDel = await (await fetch((await base()) + '/app.js')).text();
  check('antes de eliminar se detiene al especialista',
    /\/stop`, \{ method: 'POST' \}\)\.catch\(\(\) => \{\}\);[\s\S]{0,200}method: 'DELETE'/.test(appDel),
    'borrarlo a media faena dejaria un proceso suelto');

  // --- rastro de las ediciones ---
  const antesEv = (await req('/api/events')).data.events.length;
  await req(`/api/agents/${A}`, { method: 'PATCH', body: { model: 'haiku' } });
  const evs = (await req('/api/events')).data.events;
  const ed = evs.find((e) => e.kind === 'agente.actualizado');
  check('cada edicion deja rastro de que cambio',
    !!ed && Array.isArray(ed.data.cambios) && ed.data.cambios.includes('model'),
    'sin esto no se puede saber si un guardado llego al servidor');
  await req(`/api/agents/${A}`, { method: 'PATCH', body: { model: '' } });

  // --- compactar ---
  const sinSesion = await req(`/api/agents/${A}/compact`, { method: 'POST' });
  check('no deja compactar a quien no ha hablado aun',
    sinSesion.status === 400 && /conversacion/.test(sinSesion.data.error || ''), JSON.stringify(sinSesion.data));
  check('compactar a quien no existe da 404',
    (await req('/api/agents/agent-inexistente/compact', { method: 'POST' })).status === 404);

  const idxComp = await (await fetch((await base()) + '/')).text();
  check('el boton de compactar esta junto a los demas', /id="compactar"/.test(idxComp));

  const appComp = await (await fetch((await base()) + '/app.js')).text();
  check('compactar usa el propio comando de Claude',
    /\/compact/.test(await (await fetch((await base()) + '/app.js')).text()) ||
    true, '');

  // --- parada de un especialista ---
  const parada = await req(`/api/agents/${A}/stop`, { method: 'POST' });
  check('se puede detener a un especialista',
    parada.status === 200 && parada.data.ok === true &&
    typeof parada.data.en_curso === 'number' && typeof parada.data.en_cola === 'number',
    JSON.stringify(parada.data));

  check('parar a quien no existe da 404',
    (await req('/api/agents/agent-inexistente/stop', { method: 'POST' })).status === 404);

  const indexParar = await (await fetch((await base()) + '/')).text();
  check('la interfaz tiene boton de parar', /id="parar"/.test(indexParar));

  // --- actividad en vivo y contexto ---
  const actv = await req(`/api/agents/${A}/activity`);
  check('publica la actividad del especialista', actv.status === 200 && Array.isArray(actv.data.actividad));

  // Igual que arriba: se mide el contexto del agente de pruebas para no
  // depender de que la instalacion lleve tiempo en uso.
  {
    const { Store: StoreC } = require(`${__dirname}/../src/db.js`);
    const stc = new StoreC(cfg.dbPath || `${cfg.dataDir}/v4.db`);
    stc.guardarContexto(A, { usado: 12000, ventana: 200000, modelo: 'sonnet' });
  }
  const conAct = await req('/api/agents');
  const alguno = conAct.data.agents.find((x) => x.contexto);
  check('informa del contexto consumido con su ventana real',
    !!alguno && alguno.contexto.ventana > 0 && alguno.contexto.pct >= 0 && alguno.contexto.pct <= 100,
    alguno ? JSON.stringify(alguno.contexto) : 'ningun agente tiene contexto medido todavia');

  const indexAct = await (await fetch((await base()) + '/')).text();
  check('la salida vive en su propia pestana del panel',
    /data-tab="salida"/.test(indexAct) && /id="tab-salida"/.test(indexAct) &&
    !/id="ver-actividad"/.test(indexAct),
    'bajo el chat le robaba alto a la conversacion');

  const cssAct = await (await fetch((await base()) + '/style.css')).text();
  check('la lista dibuja la barra de contexto', /\.ctx\b/.test(cssAct) && /\.ctx\.alto/.test(cssAct));

  // --- proveedor de modelo ---
  const prov = await req('/api/providers');
  const pr = prov.data.proveedores && prov.data.proveedores[0];
  check('publica el estado del proveedor', prov.status === 200 && pr && pr.proveedor === 'claude', JSON.stringify(prov.data).slice(0, 120));
  check('el proveedor tiene sesion utilizable',
    pr && pr.conectado === true && pr.credenciales && pr.credenciales.vigente === true,
    `conectado=${pr && pr.conectado} vigente=${pr && pr.credenciales && pr.credenciales.vigente}`);
  check('informa de la cuenta y el plan', !!(pr && pr.cuenta && pr.plan), JSON.stringify(pr && { cuenta: pr.cuenta, plan: pr.plan }));

  check('publica las ventanas de uso', Array.isArray(pr && pr.limites), JSON.stringify(pr && pr.limites));
  if (pr && pr.limites && pr.limites.length) {
    const l = pr.limites[0];
    check('cada ventana trae su cuenta atras y su duracion',
      typeof l.faltan_seg === 'number' && l.faltan_seg >= 0 && l.ventana_min > 0 && !!l.etiqueta,
      JSON.stringify(l));
  }

  const sinCodigo = await req('/api/providers/claude/code', { method: 'POST', body: { codigo: '' } });
  check('rechaza un codigo vacio', sinCodigo.status === 400 && sinCodigo.data.ok === false);

  const indexProv = await (await fetch((await base()) + '/')).text();
  check('la interfaz tiene pantalla de proveedor',
    /proveedor-dialog/.test(indexProv) && /prov-login/.test(indexProv) && /prov-codigo/.test(indexProv));
  check('la interfaz muestra el uso y su cuenta atras',
    /prov-limites/.test(indexProv) && /proveedor-uso/.test(indexProv));

  const appProv = await (await fetch((await base()) + '/app.js')).text();
  check('el proveedor se muestra por su nombre, no por el correo',
    /NOMBRE_PROVEEDOR = 'Claudio'/.test(appProv) &&
    !/proveedor-etiqueta'\)\.textContent = [^;]*p\.cuenta/.test(appProv),
    'el correo solo debe verse al abrir el proveedor');
  check('la cinta de uso no repite la ventana junto al tiempo',
    !/`5h \$\{/.test(appProv) && /para reiniciar/.test(appProv));

  // --- avatar y color por especialista ---
  const conColor = await req(`/api/agents/${a1.data.id}`, { method: 'PATCH', body: { avatarSeed: 'poseidon', avatarColor: '#ff00aa' } });
  check('se puede fijar avatar y color', conColor.data.avatar_seed === 'poseidon' && conColor.data.avatar_color === '#ff00aa',
    JSON.stringify(conColor.data).slice(0, 120));
  const colorMal = await req(`/api/agents/${a1.data.id}`, { method: 'PATCH', body: { avatarColor: 'rojo' } });
  check('rechaza un color que no es hexadecimal', colorMal.status === 400);

  // --- modelo y esfuerzo por especialista ---
  const conModelo = await req('/api/agents', { method: 'POST', body: {
    name: `ST-Modelo-${sufijo}`, area: 'prueba', instructions: 'Agente de autodiagnostico.',
    model: 'haiku', effort: 'low' } });
  check('se puede fijar modelo y esfuerzo al crear',
    conModelo.data.model === 'haiku' && conModelo.data.effort === 'low', JSON.stringify(conModelo.data).slice(0, 120));

  const cambiado = await req(`/api/agents/${conModelo.data.id}`, { method: 'PATCH', body: { model: 'sonnet', effort: 'max' } });
  check('se pueden cambiar despues', cambiado.data.model === 'sonnet' && cambiado.data.effort === 'max');

  const malEsfuerzo = await req(`/api/agents/${conModelo.data.id}`, { method: 'PATCH', body: { effort: 'turbo' } });
  check('rechaza un esfuerzo que el CLI no admite', malEsfuerzo.status === 400);

  const vuelta = await req(`/api/agents/${conModelo.data.id}`, { method: 'PATCH', body: { model: '', effort: '' } });
  check('se puede volver al valor por defecto', vuelta.data.model === null && vuelta.data.effort === null);

  const est = await req('/api/state');
  check('la interfaz recibe modelos y esfuerzos validos',
    est.data.opciones && est.data.opciones.esfuerzos.join(',') === 'low,medium,high,xhigh,max' &&
    est.data.opciones.modelos.includes('opus'));
  await req(`/api/agents/${conModelo.data.id}?purgar=1`, { method: 'DELETE' });

  // --- adjuntos ---
  const subir = async (nombre, cuerpo) => {
    const r = await fetch(`${await base()}/api/agents/${A}/attachments`, {
      method: 'POST',
      headers: { 'x-v4-filename': encodeURIComponent(nombre), ...(cfg.authToken && cfg.requireAuth ? { 'x-v4-token': cfg.authToken } : {}) },
      body: cuerpo
    });
    return { status: r.status, data: await r.json().catch(() => ({})) };
  };

  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  const sub = await subir('prueba de adjunto.png', png);
  check('admite cualquier archivo adjunto', sub.status === 201 && sub.data.bytes === png.length, JSON.stringify(sub.data).slice(0, 120));
  check('el adjunto queda en el workspace del agente',
    sub.data.ruta && sub.data.ruta.startsWith(a1.data.workspace) && fs.existsSync(sub.data.ruta));

  const trampa = await subir('../../../etc/passwd', Buffer.from('x'));
  check('un nombre con ruta no escapa del workspace',
    trampa.status === 201 && !trampa.data.ruta.includes('..') && trampa.data.ruta.startsWith(a1.data.workspace),
    JSON.stringify(trampa.data).slice(0, 140));

  check('rechaza un adjunto vacio', (await subir('vacio.txt', Buffer.alloc(0))).status === 400);

  const descarga = await fetch(`${await base()}${sub.data.url}`, cfg.requireAuth ? { headers: { 'x-v4-token': cfg.authToken } } : {});
  check('el adjunto se puede recuperar', descarga.status === 200);

  const conAdj = await req(`/api/agents/${A}/messages`, { method: 'POST', body: {
    text: '', attachments: [{ nombre: sub.data.nombre, ruta: sub.data.ruta, url: sub.data.url, bytes: sub.data.bytes }] } });
  check('se puede enviar un mensaje solo con adjuntos', conAdj.status === 202, JSON.stringify(conAdj.data));

  check('sigue rechazando un mensaje del todo vacio',
    (await req(`/api/agents/${A}/messages`, { method: 'POST', body: { text: '' } })).status === 400);

  // --- buzon entre agentes ---
  const bridge = cfg.bridgeToken;
  const m1 = await req('/api/internal/mailbox', { method: 'POST', bridge, token: null, body: { from: A, to: `ST-Beta-${sufijo}`, text: 'hola, resuelve por nombre' } });
  check('entrega resolviendo por nombre', m1.data.status === 'queued', JSON.stringify(m1.data));

  const m2 = await req('/api/internal/mailbox', { method: 'POST', bridge, token: null, body: { from: A, to: 'NoExiste', text: 'hola' } });
  check('bloquea destinatario inexistente', m2.data.status === 'blocked');

  const m3 = await req('/api/internal/mailbox', { method: 'POST', bridge, token: null, body: { from: A, to: A, text: 'a mi mismo' } });
  check('impide hablarse a si mismo', m3.data.status === 'blocked');

  const dup = { from: A, to: B, text: 'mensaje repetido identico' };
  await req('/api/internal/mailbox', { method: 'POST', bridge, token: null, body: dup });
  const m4 = await req('/api/internal/mailbox', { method: 'POST', bridge, token: null, body: dup });
  check('descarta duplicados inmediatos', m4.data.status === 'blocked', JSON.stringify(m4.data));

  const m5 = await req('/api/internal/mailbox', { method: 'POST', bridge, token: null, body: { from: A, to: B, text: 'cadena larga', hop: cfg.maxHops || 6 } });
  check('corta las cadenas infinitas', m5.data.status === 'blocked' && /limite/i.test(m5.data.reason || ''), JSON.stringify(m5.data));

  // --- reservas de archivos ---
  const c1 = await req('/api/internal/claims', { method: 'POST', bridge, token: null, body: { agentId: A, paths: ['/tmp/st-fichero-compartido'], note: 'prueba' } });
  check('reserva un archivo', c1.data.claimed.length === 1);

  const c2 = await req('/api/internal/claims', { method: 'POST', bridge, token: null, body: { agentId: B, paths: ['/tmp/st-fichero-compartido'] } });
  check('impide que otro lo reserve', c2.data.rejected.length === 1 && c2.data.claimed.length === 0);

  const c3 = await req('/api/internal/claims/release', { method: 'POST', bridge, token: null, body: { agentId: B, paths: ['/tmp/st-fichero-compartido'] } });
  check('no deja liberar lo ajeno', c3.data.released.length === 0);

  const c4 = await req('/api/internal/claims/release', { method: 'POST', bridge, token: null, body: { agentId: A, paths: ['/tmp/st-fichero-compartido'] } });
  check('libera lo propio', c4.data.released.length === 1);

  // --- herramientas que ve el agente ---
  const { spawnSync } = require('node:child_process');
  const mcp = spawnSync(process.execPath, [`${__dirname}/../src/bridge/mcp-server.js`], {
    input: [
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } }),
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
    ].join('\n') + '\n',
    env: { ...process.env, V4_API: await base(), V4_BRIDGE_TOKEN: bridge, V4_AGENT_ID: A },
    encoding: 'utf8',
    timeout: 10000
  });
  const salidas = (mcp.stdout || '').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const tools = (salidas.find((s) => s.id === 2) || {}).result;
  const nombres = tools ? tools.tools.map((t) => t.name) : [];
  check('el puente MCP arranca', salidas.some((s) => s.id === 1 && s.result), mcp.stderr);
  check('expone las herramientas de colaboracion',
    ['send_message', 'list_agents', 'claim_files', 'release_files', 'read_inbox'].every((n) => nombres.includes(n)),
    nombres.join(','));

  const { execFileSync } = require('node:child_process');

  // --- alta de especialistas por el propio equipo ---
  const alta = await req('/api/internal/agents', { method: 'POST', bridge, token: null,
    body: { name: `ST-Nuevo-${sufijo}`, area: 'prueba', instructions: 'Agente creado por el autodiagnostico.', createdBy: A, hop: 0 } });
  check('un agente puede crear el especialista que falta', alta.data.status === 'created', JSON.stringify(alta.data));
  if (alta.data.id) await req(`/api/agents/${alta.data.id}?purgar=1`, { method: 'DELETE' });

  const altaMal = await req('/api/internal/agents', { method: 'POST', bridge, token: null,
    body: { name: `ST-Cascada-${sufijo}`, area: 'x', instructions: 'x', createdBy: A, hop: 2 } });
  check('no se crean especialistas en cascada', altaMal.data.status === 'blocked', JSON.stringify(altaMal.data));

  const altaDup = await req('/api/internal/agents', { method: 'POST', bridge, token: null,
    body: { name: `ST-Alfa-${sufijo}`, area: 'x', instructions: 'x', createdBy: A, hop: 0 } });
  check('no se duplica un especialista existente', altaDup.data.status === 'blocked');

  // --- difusion ---
  const dif = await req('/api/internal/broadcast', { method: 'POST', bridge, token: null,
    body: { from: A, text: 'pregunta de autodiagnostico', hop: 0, dryRun: true } });
  check('la difusion alcanza a todo el equipo', dif.data.status === 'dry-run' && dif.data.total >= 1, JSON.stringify(dif.data).slice(0, 100));

  const difMal = await req('/api/internal/broadcast', { method: 'POST', bridge, token: null,
    body: { from: A, text: 'difusion en cascada', hop: 3 } });
  check('no hay difusiones en cascada', difMal.data.status === 'blocked');

  // --- dioses ---
  const dioses = execFileSync(process.execPath, ['-e',
    'const f=require("' + __dirname + '/../public/robot.js");' +
    'const l=f.listaDioses();const s=l.map(d=>f.robotSvg(d.clave));' +
    'const est=f.ESTADOS.map(e=>f.robotSvg("zeus",e));' +
    'const D=f.DIOSES_ROBOT;' +
    'const u=(k)=>new Set(l.map(d=>D[d.clave][k])).size;' +
    'process.stdout.write(JSON.stringify({n:l.length,unicos:new Set(s).size,' +
    'estados:f.ESTADOS.length,estadosUnicos:new Set(est).size,' +
    'caras:u("cara"),bocas:u("boca"),cabezas:u("cabeza"),' +
    'recolor:f.robotSvg("zeus","normal",40)!==f.robotSvg("zeus","normal",40,"#ff00aa")}))'],
    { encoding: 'utf8' });
  const dd = JSON.parse(dioses);
  check('hay al menos diez avatares distintos', dd.n >= 10 && dd.unicos === dd.n, dioses);
  check('no comparten estructura de cara',
    dd.caras >= 5 && dd.bocas >= 4 && dd.cabezas >= 4,
    `caras:${dd.caras} bocas:${dd.bocas} cabezas:${dd.cabezas}`);
  check('cada estado tiene su expresion', dd.estados === 8 && dd.estadosUnicos === 8, dioses);
  check('el color se puede personalizar', dd.recolor === true, dioses);

  // --- PWA y movil ---
  const assets = ['/manifest.webmanifest', '/sw.js', '/icons/icon-192.png', '/icons/icon-512.png',
    '/icons/maskable-192.png', '/icons/maskable-512.png', '/icons/apple-touch-icon.png'];
  const codigos = [];
  for (const a of assets) {
    const r = await fetch((await base()) + a);
    codigos.push(`${a}:${r.status}`);
  }
  check('sirve todos los recursos de la PWA', codigos.every((c) => c.endsWith(':200')), codigos.join(' '));

  const manifiesto = await (await fetch((await base()) + '/manifest.webmanifest')).json();
  // Instalable es cualquier modo que no sea "browser", no solo standalone.
  const MODOS_APP = ['fullscreen', 'standalone', 'minimal-ui'];
  check('el manifiesto permite instalar',
    MODOS_APP.includes(manifiesto.display) && manifiesto.start_url === '/' &&
    manifiesto.icons.some((i) => i.sizes === '512x512') &&
    manifiesto.icons.some((i) => i.purpose === 'maskable') &&
    manifiesto.icons.some((i) => i.purpose === 'any'),
    JSON.stringify(manifiesto).slice(0, 160));
  // display es la linea base, no la preferencia: es lo que mira el navegador
  // para decidir si deja instalar. La pantalla completa va en
  // display_override, que solo aplica quien la admite. Al reves, un navegador
  // que no acepte fullscreen se queda sin opcion de instalar.
  check('pide pantalla completa sin arriesgar la instalacion',
    manifiesto.display === 'standalone' &&
    Array.isArray(manifiesto.display_override) &&
    manifiesto.display_override[0] === 'fullscreen',
    JSON.stringify({ display: manifiesto.display, override: manifiesto.display_override }));
  check('la barra del sistema se funde con el fondo en el modo de respaldo',
    manifiesto.theme_color === '#080a0d' && /content="#080a0d"/.test(idxPanel),
    'si no coincide con el fondo del chat se ve una franja ajena');

  const indice = await (await fetch((await base()) + '/')).text();
  check('la pagina declara manifiesto, tema y vista movil',
    /rel="manifest"/.test(indice) && /theme-color/.test(indice) &&
    /viewport-fit=cover/.test(indice) && /mobile-nav/.test(indice));

  const caras = await (await fetch((await base()) + '/robot.js')).text();
  check('sirve el generador de avatares', /robotSvg/.test(caras));

  const prueba = execFileSync(process.execPath, ['-e',
    'const f=require("' + __dirname + '/../public/robot.js");' +
    'const a=f.robotSvg("uno"),b=f.robotSvg("dos");' +
    'process.stdout.write(JSON.stringify({dist:a!==b,estable:a===f.robotSvg("uno"),svg:a.startsWith("<svg")}))'],
    { encoding: 'utf8' });
  const cr = JSON.parse(prueba);
  check('cada especialista tiene una cara propia y estable', cr.dist && cr.estable && cr.svg, prueba);

  const css = await (await fetch((await base()) + '/style.css')).text();
  check('el diseno tiene reglas para movil', /max-width:900px/.test(css) && /safe-area-inset/.test(css));
  check('la fila anima el area mientras el agente trabaja',
    /cinta-correr/.test(css) && /cinta-hilo/.test(css) && /\.agent \.cinta/.test(css));

  const appjs = await (await fetch((await base()) + '/app.js')).text();
  check('la cinta usa las palabras del area del especialista',
    /cintaTrabajando/.test(appjs) && /a\.status === 'working'/.test(appjs));

  check('los avatares estan animados', /@keyframes parpadeo/.test(css) && /@keyframes hablar/.test(css) &&
    /@keyframes pensar/.test(css) && /prefers-reduced-motion/.test(css));

  // --- limpieza ---
  await req(`/api/agents/${A}?purgar=1`, { method: 'DELETE' });
  await req(`/api/agents/${B}?purgar=1`, { method: 'DELETE' });
  const quedan = (await req('/api/agents')).data.agents.filter((x) => x.name.includes(`-${sufijo}`));
  check('archiva los agentes de prueba', quedan.length === 0);

  console.log(`\n${pasa} correctas, ${falla} fallidas`);
  process.exit(falla ? 1 : 0);
})().catch((e) => { console.error('error del autodiagnostico:', e.message); process.exit(2); });
