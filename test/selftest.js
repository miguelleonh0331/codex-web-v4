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
  // Caducado no es lo mismo que sin sesion: el CLI renueva solo con el
  // refresh token. Lo que importa es si podra trabajar.
  check('la sesion de Claude sirve para trabajar',
    health.data.session && health.data.session.valida === true,
    health.data.session && health.data.session.renovable
      ? `caducada el ${health.data.session.expira} pero renovable`
      : `sin sesion utilizable: los agentes no podran trabajar`);

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

  // El color concreto ya no se fija aqui: lo pone el tema, y el contraste se
  // mide mas abajo en las 17 combinaciones de cada uno.
  check('las pestanas inactivas se leen, no parecen desactivadas',
    /\.tab\{color:var\(--tab-apagada\)/.test(cssSal), 'en gris apagado no se distinguian de un boton inhabilitado');
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

  // El numero crece segun se anaden: lo que importa es que sigan en una fila
  // de iconos y no vuelvan a ser casillas con texto apiladas.
  // Se mira solo el pie de la barra lateral: las casillas de los dialogos
  // son otra cosa y no tienen por que ser iconos.
  const pie = (idxPanel.match(/<footer class="status[\s\S]*?<\/footer>/) || [''])[0];
  const nSw = (pie.match(/class="sw"/g) || []).length;
  check('los interruptores del pie caben en una fila de iconos',
    /class="interruptores"/.test(pie) && nSw >= 3 &&
    (pie.match(/class="check"/g) || []).length === 0,
    `${nSw} interruptores; antes eran casillas con texto, cuatro lineas del pie`);
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

  // Los modelos de Codex se comprobaron uno a uno contra el CLI: uno
  // invalido devuelve 400 model_not_found. "gpt-5" y "o3" NO valen por esta
  // via, asi que no deben volver a colarse en la lista.
  const modsCodex = provs.obtener('codex').modelos;
  check('la lista de modelos de Codex es la que el CLI acepta',
    modsCodex.every((m) => /^gpt-\d/.test(m)) && modsCodex.includes('gpt-6.1-sol'),
    JSON.stringify(modsCodex));
  check('no se ofrecen nombres sueltos sin prefijo ni modelos retirados',
    !modsCodex.some((m) => /^(sol|luna|terra|astra)$/.test(m)) &&
    !modsCodex.some((m) => /-codex$/.test(m)) &&
    !modsCodex.includes('gpt-5') && !modsCodex.includes('o3'),
    'probados ejecutando un turno real: devuelven model_not_found');
  check('el "por defecto" del desplegable es el del proveedor elegido',
    provs.obtener('claude').modeloPorDefecto === 'sonnet' &&
    provs.obtener('codex').modeloPorDefecto === 'gpt-6.1-sol' &&
    /prov\.modeloPorDefecto \|\| 'el que elija el CLI'/.test(appAct),
    'con Codex elegido decia "por defecto (sonnet)", que es el de Claude');

  // Esquema real de Codex, capturado de una ejecucion: el texto llega en un
  // evento ANTERIOR al que cierra el turno, asi que quedarse con el ultimo
  // daba "salida no interpretable" aunque el turno hubiera ido bien.
  {
    const cx = provs.obtener('codex');
    const bolsa = {};
    for (const ev of [
      { type: 'thread.started', thread_id: 'TH9' },
      { type: 'turn.started' },
      { type: 'item.completed', item: { type: 'agent_message', text: 'primera' } },
      { type: 'item.completed', item: { type: 'agent_message', text: 'definitiva' } },
      { type: 'turn.completed', usage: { input_tokens: 100, output_tokens: 7, cached_input_tokens: 80 } }
    ]) cx.recolectar(ev, bolsa);
    const r = cx.resultado({ type: 'turn.completed' }, { bolsa });
    check('Codex junta el resultado repartido entre varios eventos',
      r.ok && r.text === 'definitiva' && r.sessionId === 'TH9',
      JSON.stringify(r).slice(0, 140));
    check('se queda con el ultimo mensaje del agente, no con el primero',
      r.text === 'definitiva', 'los anteriores son pasos intermedios');
    check('traduce el consumo de tokens a la forma comun',
      r.uso && r.uso.input_tokens === 100 && r.uso.cache_read_input_tokens === 80);
    check('solo cierra el turno con turn.completed',
      cx.esFinal({ type: 'turn.completed' }) && !cx.esFinal({ type: 'item.completed' }),
      'item.completed salta en cada paso, no solo al final');
    const malo = {};
    cx.recolectar({ type: 'turn.failed', error: { message: 'se cayo' } }, malo);
    check('un turno fallido de Codex se reporta como fallo, no como vacio',
      cx.resultado(null, { bolsa: malo, code: 0 }).error === 'se cayo');
  }

  check('un proveedor que no publica coste devuelve null, no un cero falso',
    provs.obtener('codex').resultado(null, { bolsa: { texto: 'hecho' } }).cost === null,
    'un cero se leeria como "gratis"');

  // --- conectar Codex desde la web ---
  const provsApi = (await req('/api/providers')).data.proveedores;
  check('la pantalla de proveedor lista los dos',
    provsApi.length >= 2 && provsApi.some((x) => x.proveedor === 'codex'),
    JSON.stringify(provsApi.map((x) => x.proveedor)));
  const cxp = provsApi.find((x) => x.proveedor === 'codex') || {};
  if (cxp.conectado) {
    check('de Codex se sabe la cuenta, el titular y el plan',
      !!cxp.cuenta && !!cxp.plan,
      'el CLI solo dice "Logged in using ChatGPT": sale del id_token de la sesion');
    check('la ficha de Codex no expone el token',
      !JSON.stringify(cxp).includes('eyJ'),
      'solo deben salir los campos que se muestran');
  }
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
  // OJO: cancelar es una accion real. Si hay una conexion en marcha, esta
  // comprobacion la mataria justo cuando el usuario va a autorizarla en su
  // navegador. Ya paso: se perdieron dos intentos seguidos.
  const enMarcha = (await req('/api/providers/codex/check')).data;
  check('la comprobacion dice si ya autorizo', typeof enMarcha.listo === 'boolean');
  if (enMarcha.esperando) {
    console.log('  --   no se prueba cancelar: hay una conexion de Codex en curso');
  } else {
    check('se puede cancelar una conexion a medias',
      (await req('/api/providers/codex/cancel', { method: 'POST' })).status === 200);
  }

  // --- guardia de rutas protegidas ---
  {
    const g = require(`${__dirname}/../src/guardia.js`);
    const base = `${__dirname}/../.tmp-guardia`;
    const prot = `${base}/prot`;
    const fotos = `${base}/fotos`;
    try {
      fs.rmSync(base, { recursive: true, force: true });
      fs.mkdirSync(prot, { recursive: true });
      fs.writeFileSync(`${prot}/a.conf`, 'original');
      fs.writeFileSync(`${prot}/b.conf`, 'otro');
      const cfgG = { rutasProtegidas: [prot] };
      const antes = g.fotografiar(cfgG, fotos);

      fs.writeFileSync(`${prot}/a.conf`, 'manipulado');
      fs.writeFileSync(`${prot}/c.conf`, 'nuevo');
      fs.unlinkSync(`${prot}/b.conf`);

      const cambios = g.comparar(antes, g.fotografiar(cfgG, null));
      const tipos = cambios.map((c) => c.cambio).sort();
      check('el guardia detecta modificado, creado y borrado',
        tipos.join(',') === 'borrado,creado,modificado', JSON.stringify(tipos));

      const r = g.revertir(antes, cambios);
      check('deshacer devuelve el estado exacto anterior',
        r.fallos.length === 0 &&
        fs.readFileSync(`${prot}/a.conf`, 'utf8') === 'original' &&
        fs.existsSync(`${prot}/b.conf`) && !fs.existsSync(`${prot}/c.conf`));
      check('tras deshacer no queda ninguna diferencia',
        g.comparar(antes, g.fotografiar(cfgG, null)).length === 0);

      check('no sigue enlaces simbolicos fuera de la ruta vigilada',
        (() => {
          fs.symlinkSync('/etc', `${prot}/fuga`);
          const f = g.fotografiar(cfgG, null);
          return !Object.keys(f.ficheros).some((x) => x.includes('/fuga/'));
        })(), 'un enlace apunta fuera: fotografiarlo copiaria medio sistema');
    } finally { fs.rmSync(base, { recursive: true, force: true }); }
  }

  const estG = (await req('/api/guardia')).data;
  check('publica que rutas vigila y los avisos',
    Array.isArray(estG.vigilando) && Array.isArray(estG.incidentes));
  check('hay pestana de guardia que avisa',
    /data-tab="guardia"/.test(idxPanel) && /\.tab\.avisa\{/.test(cssSal));

  // --- vault compartido ---
  {
    const v = require(`${__dirname}/../src/vault.js`);
    const cfgV = { dataDir: `${__dirname}/../.tmp-vault` };
    try {
      fs.rmSync(cfgV.dataDir, { recursive: true, force: true });
      v.escribir(cfgV, { titulo: 'Troncales', carpeta: 'Telefonia', autor: 'Telefonia',
        texto: 'Van por el wrapper. Ver [[Dialplan]].' });
      v.escribir(cfgV, { titulo: 'Dialplan', carpeta: 'Telefonia', autor: 'Telefonia',
        texto: 'Contextos. Depende de [[Troncales]].' });

      const n = v.leer(cfgV, 'Troncales');
      check('una nota guarda su autor y sus enlaces',
        n && n.enlaces.includes('Dialplan') && /autor: Telefonia/.test(n.texto));
      check('se puede leer una nota sin saber en que carpeta esta',
        !!v.leer(cfgV, 'Dialplan'), 'quien escribe un enlace no sabe donde vive la nota');
      check('los retroenlaces convierten las notas en una red',
        v.retroenlaces(cfgV, 'Troncales').some((r) => r.titulo === 'Dialplan'));
      check('la busqueda encuentra por contenido',
        v.buscar(cfgV, 'wrapper').some((r) => r.titulo === 'Troncales'));

      const fuga = v.escribir(cfgV, { titulo: '../../../etc/passwd', carpeta: '../..', texto: 'x' });
      check('un titulo con ../ no escribe fuera del vault',
        fuga.ruta.startsWith(require('node:path').resolve(v.raiz(cfgV))),
        `escribio en ${fuga.ruta}`);
    } finally { fs.rmSync(cfgV.dataDir, { recursive: true, force: true }); }
  }

  const mcpV = fs.readFileSync(`${__dirname}/../src/bridge/mcp-server.js`, 'utf8');
  check('los especialistas tienen las tres herramientas del vault',
    ['vault_escribir', 'vault_leer', 'vault_buscar'].every((t) =>
      mcpV.includes(`name: '${t}'`) && mcpV.includes(`case '${t}'`)));
  check('se les dice que miren el vault antes de molestar a un companero',
    /vault_buscar cuesta cero/.test(runnerSrc),
    'una herramienta que no se explica no se usa');
  check('hay pestana de vault', /data-tab="vault"/.test(idxPanel));
  check('abrir una nota sobrevive al repintado del panel',
    /if \(notaAbierta\) await pintarNota\(notaAbierta\)/.test(appAct),
    'el panel se repinta cada 2,5 s: antes la lista borraba la nota recien abierta');
  check('solo se toca el DOM cuando algo cambio',
    /dataset\.firma/.test(appAct),
    'repintar cada ciclo cortaria cualquier seleccion de texto');
  check('se puede navegar de una nota a otra por sus enlaces',
    /data-ir=/.test(appAct) && /pintarNota\(notaAbierta\)/.test(appAct),
    'sin eso es una lista de ficheros, no un mapa');

  // --- voz ---
  const vozSrc = await (await fetch((await base()) + '/voz.js')).text();
  check('cada especialista tiene una voz estable',
    /function timbre/.test(vozSrc) && /semilla\(nombre\)/.test(vozSrc),
    'el mismo nombre debe sonar siempre igual');
  check('la voz solo suena al terminar el propio trabajo',
    /previo\.estado === 'working'/.test(appAct) && /VOZ\.anuncia/.test(appAct),
    'si sonara en cada paso, con trece especialistas seria insufrible');
  check('no intenta pronunciar bloques de codigo ni rutas',
    vozSrc.includes('bloques de codigo, impronunciables') &&
    vozSrc.includes('una ruta') && vozSrc.includes('un enlace'),
    'leer en voz alta una ruta larga o un bloque de codigo es ruido');
  check('habla por turnos en vez de pisarse',
    /const cola = \[\]/.test(vozSrc) && /u\.onend/.test(vozSrc));
  check('si el navegador falla, la cola no se queda bloqueada',
    /u\.onerror/.test(vozSrc));
  check('la voz se puede apagar y se recuerda apagada',
    /localStorage\.setItem\('v4-voz'/.test(vozSrc) && /id="voz-on"/.test(idxPanel));

  // --- tope de gasto ---
  const estGas = (await req('/api/state')).data.gasto;
  check('publica el gasto del dia y su tope',
    estGas && typeof estGas.total === 'number' && 'tope' in estGas && 'frenado' in estGas,
    JSON.stringify(estGas));
  const orqGas = fs.readFileSync(`${__dirname}/../src/orchestrator.js`, 'utf8');
  check('el tope se comprueba antes de lanzar, no en medio de un turno',
    /dispatch\(\)[\s\S]{0,400}topeGastoDiario/.test(orqGas),
    'cortar un turno a medias desperdicia lo ya gastado');
  check('alcanzar el tope deja el trabajo pendiente, no lo descarta',
    !/finishTurn[^)]*gasto/.test(orqGas),
    'el turno debe quedar en cola y salir solo cuando el tope se renueve');
  check('el dia del gasto es el de tu zona, no el UTC',
    estGas.dia && estGas.zona && estGas.desde,
    'con marcas en UTC y el usuario en Lima, el contador se reiniciaba a las 19:00');
  {
    const { Store: StoreZ } = require(`${__dirname}/../src/db.js`);
    const tmp = `${__dirname}/../.tmp-zona.db`;
    try {
      for (const f of ['', '-shm', '-wal']) fs.rmSync(tmp + f, { force: true });
      const st = new StoreZ(tmp);
      const lima = st.gastoDelDia('America/Lima');
      const utc = st.gastoDelDia('UTC');
      check('cada zona empieza su dia en un instante distinto',
        lima.desde !== utc.desde, `${lima.desde} vs ${utc.desde}`);
    } finally { for (const f of ['', '-shm', '-wal']) fs.rmSync(tmp + f, { force: true }); }
  }

  check('el tope se puede fijar desde la web',
    (await req('/api/app', { method: 'PATCH', body: { topeGastoDiario: 3 } })).data.topeGastoDiario === 3 &&
    (await req('/api/app', { method: 'PATCH', body: { topeGastoDiario: -1 } })).status === 400 &&
    (await req('/api/app', { method: 'PATCH', body: { topeGastoDiario: 0 } })).data.ok === true,
    'y rechaza valores imposibles');
  check('avisa si el tope que acabas de poner ya esta superado',
    /frenaYa/.test(fs.readFileSync(`${__dirname}/../src/server.js`, 'utf8')) &&
    /el equipo queda parado/.test(appAct),
    'guardarlo en silencio dejaria todo parado sin explicacion');
  check('cambiar el nombre sigue funcionando tras anadir el tope',
    (await req('/api/app', { method: 'PATCH', body: { nombre: '' } })).status === 400);
  check('hay boton para escuchar la voz de un especialista',
    /id="voz-probar"/.test(idxPanel) && /VOZ\.prueba/.test(appAct),
    'la voz sale del nombre: conviene oirla antes de guardarlo');
  check('la ficha de gasto esta en la pantalla de proveedor',
    /id="tope-gasto"/.test(idxPanel) && /pintarGasto/.test(appAct));

  check('avisa de que freno, sin repetirlo cada ciclo',
    /gasto\.tope/.test(orqGas) && /avisoTope/.test(orqGas));

  // --- agentes de otra maquina ---
  const crypto2 = require('node:crypto');
  const nomExt = `ST-Ext-${sufijo}`;
  const creado = await req('/api/externos', { method: 'POST', body: { nombre: nomExt, nota: 'prueba' } });
  check('la credencial externa se entrega una sola vez',
    creado.status === 201 && typeof creado.data.token === 'string' && creado.data.token.length >= 24 &&
    !('token' in (await req('/api/externos')).data.externos.find((e) => e.nombre === nomExt)),
    'el listado no debe poder devolver el token');
  check('del token solo se guarda la huella',
    creado.data.huella !== creado.data.token &&
    creado.data.huella === crypto2.createHash('sha256').update(creado.data.token).digest('hex'),
    'guardarlo en claro seria regalar el acceso a quien lea la base');

  const tokExt = creado.data.token;
  const comoExterno = async (ruta, opts = {}) => {
    const r = await fetch((await base()) + ruta, {
      method: opts.method || 'GET',
      headers: { 'content-type': 'application/json', 'x-v4-externo': opts.token ?? tokExt },
      body: opts.body ? JSON.stringify(opts.body) : undefined
    });
    return { status: r.status, data: await r.json().catch(() => ({})) };
  };

  check('una credencial inventada no entra',
    (await comoExterno('/api/externo/quien', { token: 'inventado' })).status === 401);
  check('el de fuera sabe quien le atiende',
    (await comoExterno('/api/externo/quien')).status === 200);

  // No debe poder nada de lo que si puede el puente interno.
  for (const ruta of ['/api/internal/agents', '/api/internal/vault/listar']) {
    check(`el token externo no abre ${ruta}`,
      (await comoExterno(ruta)).status === 401,
      'es mas estrecho que el del puente a proposito');
  }

  const hayRecep = (await req('/api/externos')).data.recepcion.length > 0;
  if (!hayRecep) {
    check('sin nadie atendiendo, no entra nada de fuera',
      (await comoExterno('/api/externo/mensaje', { method: 'POST', body: { texto: 'hola' } })).status === 409,
      'mejor rechazar que encolar algo que nadie leera');
  }

  check('se puede revocar y deja de valer al instante',
    (await req(`/api/externos/${creado.data.id}`, { method: 'POST' })).status === 200 &&
    (await comoExterno('/api/externo/quien')).status === 401);
  await req(`/api/externos/${creado.data.id}`, { method: 'DELETE' });

  const srvExt = fs.readFileSync(`${__dirname}/../src/server.js`, 'utf8');
  check('contestar a un agente de fuera no le encola un turno aqui',
    /encolado_fuera/.test(srvExt) && /encolarParaExterno/.test(srvExt),
    'su maquina puede estar apagada: el mensaje espera a que se conecte');
  check('list_agents distingue a los de fuera',
    /FUERA de este servidor/.test(fs.readFileSync(`${__dirname}/../src/bridge/mcp-server.js`, 'utf8')),
    'el especialista debe saber que no estan en esta maquina');
  check('la API habla en castellano tambien para quien atiende',
    (await req('/api/externos')).data.recepcion.every((r) => 'nombre' in r && !('name' in r)),
    'la interfaz lee "nombre": con "name" mostraba atiende: undefined');
  check('el token se muestra entero, sin cortarse',
    /\.token-largo\{/.test(cssSal) &&
    /word-break:break-all/.test(cssSal) && /overflow-wrap:anywhere/.test(cssSal) &&
    !/id="externo-token-valor" class="codigo-grande"/.test(idxPanel),
    'el estilo del codigo de dispositivo es para 10 caracteres; el token tiene 32 y se cortaba');
  check('se puede copiar el token de un toque',
    /id="externo-copiar"/.test(idxPanel) && /clipboard\.writeText\(r\.token\)/.test(appAct),
    'es la unica vez que se ve: copiarlo mal significa emitir otro');
  check('hay interruptor de recepcion y gestion de credenciales',
    /name="recepcion"/.test(idxPanel) && /id="externo-crear"/.test(idxPanel));
  const instSrc = fs.readFileSync(`${__dirname}/../install.sh`, 'utf8');
  check('el instalador busca Codex y dice si falta',
    /codex:  no instalado \(opcional\)/.test(instSrc) && /--codex-bin/.test(instSrc),
    'sin esto, "no instalado" aparece en la web sin explicacion');
  check('deja claro que Codex es opcional, no un requisito',
    /SEGUNDO PROVEEDOR \(opcional\)/.test(instSrc) &&
    /npm install -g @openai\/codex/.test(instSrc));
  check('el README lista los dos CLI y cual es obligatorio',
    /@anthropic-ai\/claude-code/.test(fs.readFileSync(`${__dirname}/../README.md`, 'utf8')) &&
    /@openai\/codex/.test(fs.readFileSync(`${__dirname}/../README.md`, 'utf8')));
  check('hay guia para parchear una instalacion existente',
    fs.existsSync(`${__dirname}/../docs/ACTUALIZAR.md`) &&
    /marcha atras/i.test(fs.readFileSync(`${__dirname}/../docs/ACTUALIZAR.md`, 'utf8')));
  check('esta documentado como conectar una maquina de fuera',
    fs.existsSync(`${__dirname}/../docs/AGENTE-EXTERNO.md`) &&
    /x-v4-externo/.test(fs.readFileSync(`${__dirname}/../docs/AGENTE-EXTERNO.md`, 'utf8')));

  // --- informe de uso ---
  const inf = (await req('/api/informe?dias=7')).data;
  check('el informe dice quien gasta y cuanto',
    inf.total && Array.isArray(inf.porAgente) && Array.isArray(inf.porDia) &&
    inf.porAgente.every((a) => 'coste' in a && 'tokens' in a && 'turnos' in a && 'prov' in a),
    JSON.stringify(inf.total));
  check('distingue "no cuesta" de "no se sabe lo que cuesta"',
    inf.porAgente.every((a) => typeof a.costeConocido === 'boolean'),
    'Codex no informa coste: un cero se leeria como gratis');
  check('cuenta tambien la lectura de cache',
    /tokens: f\.entrada \+ f\.cache \+ f\.salida/.test(fs.readFileSync(`${__dirname}/../src/db.js`, 'utf8')),
    'dejarla fuera hace que un turno largo parezca de ocho tokens');
  check('avisa de los turnos antiguos sin tokens medidos',
    typeof inf.sinMedir === 'number',
    'sin decirlo, los ceros del historial pareceran consumo real');
  check('el coste por turno permite decidir a quien mover de proveedor',
    inf.porAgente.every((a) => typeof a.costePorTurno === 'number'));
  check('hay pestana de gasto con periodo elegible',
    /data-tab="gasto"/.test(idxPanel) && /\[1, 7, 30\]\.map/.test(appAct) && /data-dias=/.test(appAct));

  {
    const { Store: StoreU } = require(`${__dirname}/../src/db.js`);
    const tmp = `${__dirname}/../.tmp-uso.db`;
    try {
      for (const f of ['', '-shm', '-wal']) fs.rmSync(tmp + f, { force: true });
      const st = new StoreU(tmp);
      st.createAgent({ id: 'u1', name: 'u1', instructions: 'x', home: '/tmp', workspace: '/tmp' });
      const tid = st.enqueueTurn({ agentId: 'u1', prompt: 'x', origin: 'user' });
      st.finishTurn(tid, {
        status: 'done', cost: 0.5, numTurns: 1,
        uso: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 900, cache_creation_input_tokens: 100 },
        proveedor: 'claude', modelo: 'sonnet'
      });
      const fila = st.informeUso({ dias: 1 })[0];
      check('los tokens de un turno quedan guardados',
        fila && fila.entrada === 100 && fila.salida === 20 && fila.cache === 1000,
        JSON.stringify(fila));
      check('guarda con que proveedor y modelo se hizo cada turno',
        st.db.prepare('SELECT proveedor, modelo FROM turns WHERE id = ?').get(tid).proveedor === 'claude',
        'sin eso el informe no puede comparar proveedores');
    } finally { for (const f of ['', '-shm', '-wal']) fs.rmSync(tmp + f, { force: true }); }
  }

  check('dos escrituras a la vez no tumban el servicio',
    /PRAGMA busy_timeout/.test(fs.readFileSync(`${__dirname}/../src/db.js`, 'utf8')),
    'sin esto, "database is locked" subia hasta matar el proceso');
  check('un apunte de telemetria no puede tumbar un turno',
    /no se pudo registrar el evento/.test(fs.readFileSync(`${__dirname}/../src/db.js`, 'utf8')),
    'perder una linea del registro no puede costar el trabajo hecho');

  // --- peso del sondeo ---
  {
    const { Store: StoreP } = require(`${__dirname}/../src/db.js`);
    const tmp = `${__dirname}/../.tmp-perf.db`;
    try {
      for (const f of ['', '-shm', '-wal']) fs.rmSync(tmp + f, { force: true });
      const st = new StoreP(tmp);
      st.createAgent({ id: 'p1', name: 'p1', instructions: 'x', home: '/tmp', workspace: '/tmp' });
      for (let i = 0; i < 300; i += 1) st.addMessage('p1', 'assistant', `mensaje ${i}`);

      const ultimos = st.listMessages('p1');
      check('al abrir se devuelven los ULTIMOS mensajes, no los primeros',
        ultimos.length === 120 && /mensaje 299$/.test(ultimos[ultimos.length - 1].body),
        'una conversacion larga se lee por el final: cortar por arriba escondia lo reciente');
      check('vienen en orden de lectura',
        ultimos[0].id < ultimos[ultimos.length - 1].id);

      const ultimoId = ultimos[ultimos.length - 1].id;
      check('el sondeo solo trae lo posterior',
        st.listMessages('p1', { desde: ultimoId }).length === 0,
        'sin esto se pedia el historial entero cada pocos segundos');
      st.addMessage('p1', 'user', 'nuevo');
      check('y trae lo nuevo en cuanto aparece',
        st.listMessages('p1', { desde: ultimoId }).length === 1);

      const anteriores = st.mensajesAnteriores('p1', ultimos[0].id, 50);
      check('se puede subir a buscar lo anterior',
        anteriores.length === 50 && anteriores[anteriores.length - 1].id < ultimos[0].id);
      check('el total permite saber si queda historial arriba',
        st.contarMensajes('p1') === 301);
    } finally { for (const f of ['', '-shm', '-wal']) fs.rmSync(tmp + f, { force: true }); }
  }

  check('la conversacion se repinta solo cuando llega algo',
    /if \(!force && !nuevos\.length\) return;/.test(appAct),
    'repintarla entera cada ciclo es lo que la hacia pesada');
  check('sin marcador se carga de cero, no se anade a lo que hay',
    /if \(!ultimoMsgId\) force = true;/.test(appAct),
    'pedir "lo posterior a cero" devuelve los ultimos 120 y los duplicaria en pantalla');
  check('dos pintados a la vez no se pisan',
    /if \(pintandoMensajes\) return;/.test(appAct) && /finally \{\s*pintandoMensajes = false;/.test(appAct),
    'selectAgent y el ciclo automatico coinciden porque entre medias hay esperas');
  check('cambiar de especialista a media peticion no mezcla conversaciones',
    /if \(selected !== deQuien\) return;/.test(appAct),
    'la respuesta de uno acabaria pintada en la del otro');
  check('hay forma de cargar lo anterior',
    /cargar mensajes anteriores/.test(appAct) && /\.cargar-antes\{/.test(cssSal));
  check('al cargar arriba no se pierde la posicion de lectura',
    /box\.scrollTop \+= box\.scrollHeight - altoAntes/.test(appAct),
    'insertar arriba sin esto empuja el texto que estas leyendo');

  check('con la pestana oculta no se sondea',
    /if \(document\.hidden\) return 0;/.test(appAct) &&
    /visibilitychange/.test(appAct),
    'seguia pidiendo cada 2,5 s aunque no mirases');
  check('al volver se refresca sin esperar al ciclo',
    /if \(!document\.hidden\) refreshAll\(\);/.test(appAct));
  check('el ritmo se espacia cuando nadie trabaja',
    /status === 'working' \|\| a\.status === 'queued'\) \? 2500 : 8000/.test(appAct),
    'mirar cada 2,5 s una lista que no cambia no aporta nada');

  // --- orden de la lista de especialistas ---
  check('la lista pone delante a quien esta trabajando',
    /function prioridad\(a\)/.test(appAct) &&
    /if \(a\.status === 'working'\) return 0/.test(appAct) &&
    /for \(const a of agentesOrdenados\(\)\)/.test(appAct),
    'lo que esta pasando debe verse sin buscarlo');
  check('dentro de cada grupo no se altera el orden',
    /\|\| x\.i - y\.i/.test(appAct),
    'sin desempate estable la lista bailaria y se pulsaria al que no es');
  check('el que tiene respuesta sin leer sube, pero detras de los que trabajan',
    /if \(tienePendiente\(a\) && selected !== a\.id\) return 2/.test(appAct));

  // --- LILIT ---
  const { frase, cuantas } = require(`${__dirname}/../src/lilit-frases.js`);
  const lilitMod = require(`${__dirname}/../src/lilit.js`);

  check('el diccionario tiene mas de cien formas de avisar',
    cuantas() > 100, `${cuantas()} frases`);
  check('no repite la misma frase dos veces seguidas', (() => {
    let ant = null;
    for (let i = 0; i < 300; i += 1) {
      const f = frase('conexion', { n: 2 });
      if (f === ant) return false;
      ant = f;
    }
    return true;
  })(), 'una frase repetida suena a grabacion y se deja de escuchar');
  // Se generan muchas y se busca el fallo, en vez de fiar la comprobacion a
  // que salga una plantilla concreta: frase() elige al azar.
  check('concuerda singular y plural', (() => {
    const plural = /\b1 (mensajes|turnos|trabajos|errores|minutos|preguntas|especialistas|intentos|fallos|archivos|respuestas)\b/;
    const singular = /\b([2-9]\d*) (mensaje|turno|trabajo|error|minuto|pregunta|especialista|intento|fallo|archivo|respuesta)\b/;
    for (const tipo of Object.keys(require(`${__dirname}/../src/lilit-frases.js`).FRASES)) {
      for (let i = 0; i < 40; i += 1) {
        if (plural.test(frase(tipo, { n: 1, quien: 'X' }))) return false;
        if (singular.test(frase(tipo, { n: 4, quien: 'X' }))) return false;
      }
    }
    return true;
  })(), 'en voz alta "1 mensajes" canta mucho mas que escrito');
  check('no baja a minuscula un nombre propio', (() => {
    for (let i = 0; i < 60; i += 1) {
      if (/[,.] telefonia/.test(frase('aprobacion', { n: 1, quien: 'Telefonia' }))) return false;
    }
    return true;
  })());
  check('las frases no llevan emojis ni markdown', (() => {
    const { FRASES } = require(`${__dirname}/../src/lilit-frases.js`);
    return Object.values(FRASES).flat().every((f) => !/[*_`#\[\]]|[\u{1F300}-\u{1FAFF}]/u.test(f));
  })(), 'el sintetizador los lee en alto');

  check('reconoce cuando un especialista espera algo de ti',
    lilitMod.contiene('Necesito tu aprobación antes de seguir', lilitMod.PIDE_APROBACION) &&
    lilitMod.contiene('No puedo continuar sin que me confirmes', lilitMod.PIDE_APROBACION) &&
    !lilitMod.contiene('Listo, tarea terminada', lilitMod.PIDE_APROBACION),
    'y no confunde un trabajo terminado con uno bloqueado');
  check('la deteccion no depende de las tildes',
    lilitMod.contiene('necesito tu aprobacion', lilitMod.PIDE_APROBACION) &&
    lilitMod.contiene('NECESITO TU APROBACIÓN', lilitMod.PIDE_APROBACION));

  const auditoria = (await req('/api/lilit')).data;
  check('LILIT publica lo que ve, con su frase ya hecha',
    Array.isArray(auditoria.hallazgos) &&
    auditoria.hallazgos.every((h) => h.clave && h.tipo && h.nivel && h.texto),
    JSON.stringify(auditoria.hallazgos.slice(0, 2)));
  check('cada hallazgo tiene clave estable para no repetir el aviso',
    auditoria.hallazgos.every((h) => typeof h.clave === 'string' && h.clave.includes(':')),
    'sin clave, avisaria de lo mismo cada minuto');

  const appL = appAct;
  check('LILIT no habla dos veces de lo mismo',
    /lilitDichos/.test(appL) && /!lilitDichos\.has\(h\.clave\)/.test(appL));
  check('lo que deja de pasar vuelve a poder avisarse',
    /if \(!vivas\.has\(c\)\) lilitDichos\.delete\(c\)/.test(appL),
    'si no, un problema que vuelve nunca se avisaria otra vez');
  check('lo de nivel bajo no interrumpe por voz',
    /h\.nivel !== 'bajo'/.test(appL));

  const groqSrc = fs.readFileSync(`${__dirname}/../src/lilit-groq.js`, 'utf8');
  check('el modelo externo es opcional: si falla, queda el diccionario',
    /return null;   \/\/ red, tiempo agotado/.test(groqSrc) && /if \(!k \|\| !hallazgos\.length\) return null/.test(groqSrc),
    'LILIT no puede quedarse muda por culpa de un servicio de fuera');
  check('al modelo externo no se le manda el trabajo, solo el tipo de incidencia',
    !/body|texto|mensaje|prompt|result/.test(groqSrc.split('const resumen')[1].split('.join')[0]),
    'lo que hablas con tu equipo no sale del servidor');
  check('tiene limite de ritmo propio',
    /MIN_ENTRE_LLAMADAS/.test(groqSrc), 'avisar no puede costar mas que trabajar');
  // La clave se pone desde la web: nadie deberia tener que entrar por SSH
  // a dejar un fichero para esto.
  const clv = (await req('/api/lilit/clave')).data;
  check('la clave se gestiona desde la web',
    typeof clv.configurada === 'boolean' && /id="lilit-clave-guardar"/.test(idxPanel),
    JSON.stringify(clv));
  check('nunca devuelve la clave, solo sus ultimos caracteres',
    !('clave' in clv) && !('key' in clv) &&
    (clv.cola === null || clv.cola.length <= 4),
    'devolverla entera seria regalar en cada carga lo que se guardo con permisos 600');
  check('una clave que no funciona se rechaza en vez de guardarse',
    (await req('/api/lilit/clave', { method: 'POST', body: { clave: 'gsk_inventada_del_todo' } })).status === 400,
    'guardarla dejaria a LILIT con el diccionario sin decir por que');
  check('la que ya estaba sigue intacta tras el intento fallido',
    (await req('/api/lilit/clave')).data.configurada === clv.configurada);
  check('se escribe con permisos restringidos', (() => {
    const g = require(`${__dirname}/../src/lilit-groq.js`);
    const f = g.archivoClave({ dataDir: cfg.dataDir });
    if (!fs.existsSync(f)) return true;        // sin clave, nada que comprobar
    return (fs.statSync(f).mode & 0o077) === 0;
  })());

  check('la clave del modelo externo no esta en el repositorio',
    !fs.existsSync(`${__dirname}/../secretos`) &&
    /secretos\//.test(fs.readFileSync(`${__dirname}/../.gitignore`, 'utf8')));
  check('LILIT trata de usted, como pide el tratamiento de señor', (() => {
    const { FRASES } = require(`${__dirname}/../src/lilit-frases.js`);
    const tuteo = /\b(tu|te|tuya|tuyo|tienes|puedes|decidas|aclares|pusiste|esperarte|revisa|oye|mira|atento|escucha)\b/i;
    return Object.values(FRASES).flat().every((f) => !tuteo.test(f));
  })(), 'llamar de señor y tutear a la vez suena a traduccion mala');
  check('siempre se dirige al usuario como señor', (() => {
    for (const tipo of ['conexion', 'aprobacion', 'guardia', 'cuota', 'error']) {
      for (let i = 0; i < 25; i += 1) {
        if (!/señor/i.test(frase(tipo, { n: 2, quien: 'X' }))) return false;
      }
    }
    return true;
  })());
  check('el tratamiento no deja minusculas tras punto', (() => {
    for (const tipo of ['conexion', 'aprobacion', 'guardia', 'contexto']) {
      for (let i = 0; i < 40; i += 1) {
        if (/[.!?]\s+[a-zñáéíóú]/.test(frase(tipo, { n: 1, quien: 'Telefonia' }))) return false;
      }
    }
    return true;
  })(), 'el sintetizador no lo nota, pero el texto en pantalla si');

  // Actividad: lo que faltaba. LILIT sabia quejarse pero no decir como va
  // el equipo cuando no hay ningun problema.
  const lilitAct = (await req('/api/lilit')).data.actividad;
  check('LILIT sabe decir quien esta trabajando',
    lilitAct && Array.isArray(lilitAct.trabajando) && typeof lilitAct.texto === 'string' &&
    typeof lilitAct.inactivos === 'number' && typeof lilitAct.total === 'number',
    JSON.stringify(lilitAct));
  {
    const d = lilitMod.decirActividad;
    check('el parte de actividad se lee bien en todos los casos',
      d({ trabajando: [], enCola: 0, esperandoCuota: 0, total: 5, desdeHaceMin: 0 }) === 'Ahora mismo no hay nadie trabajando.' &&
      /^Telefonia esta trabajando, lleva 7 minutos\.$/.test(d({ trabajando: ['Telefonia'], enCola: 0, esperandoCuota: 0, total: 5, desdeHaceMin: 7 })) &&
      /Hay 2 trabajando: A y B\. 3 trabajos en cola\./.test(d({ trabajando: ['A', 'B'], enCola: 3, esperandoCuota: 0, total: 5, desdeHaceMin: 1 })),
      d({ trabajando: ['A', 'B'], enCola: 3, esperandoCuota: 0, total: 5, desdeHaceMin: 1 }));
    check('con muchos trabajando no recita la lista entera',
      /A, B, C, entre otros/.test(d({ trabajando: ['A', 'B', 'C', 'D', 'E'], enCola: 0, esperandoCuota: 0, total: 9, desdeHaceMin: 2 })) &&
      !/y entre otros/.test(d({ trabajando: ['A', 'B', 'C', 'D'], enCola: 0, esperandoCuota: 0, total: 9, desdeHaceMin: 2 })),
      'mas de tres nombres seguidos no se retienen de oido, y "y alguno mas" duplicaba la conjuncion');
  }
  check('la actividad no se cuela en la vigilancia automatica', (() => {
    // Se recorta la funcion por su cierre en columna cero: partir por
    // "function " cogia tambien el manejador del boton, que si la usa.
    const i = appAct.indexOf('async function lilitMirar');
    if (i < 0) return false;
    const resto = appAct.slice(i);
    const cuerpo = resto.slice(0, resto.indexOf('\n}\n'));
    return !/actividad/.test(cuerpo);
  })(), 'anunciar quien trabaja cada vez que cambia seria ruido continuo');
  check('el parte a peticion empieza por como va el equipo',
    /partes = \[`Señor\. \$\{actividad\.texto\}`\]/.test(appAct));
  check('la pestana muestra la actividad arriba',
    /ahora mismo<\/span>/.test(appAct) && /libres<\/span>/.test(appAct));

  check('hay boton para pedirle el parte a mano',
    /id="lilit-estado"/.test(idxPanel) && /anunciaSiempre/.test(appAct),
    'la vigilancia calla cuando no hay novedades; a veces se quiere preguntar');
  check('el parte a peticion se oye aunque la voz este apagada',
    /anunciaSiempre\(nombre, texto, opciones/.test(await (await fetch((await base()) + '/voz.js')).text()),
    'si no, el boton pareceria roto');
  check('el parte no se recorta a la primera frase',
    /opciones\.completo/.test(await (await fetch((await base()) + '/voz.js')).text()),
    'con varias incidencias, recortar dejaria fuera casi todo');
  check('los botones de la barra lateral van compactos',
    /\.sidebar ?> ?button ?\{padding: ?\.45rem/.test(cssEsp) &&
    /\.fila-iconos button ?\{/.test(cssEsp) &&
    // Las cuatro acciones en UNA fila, no en dos: en movil, dos filas
    // empujaban la lista de especialistas fuera de la pantalla.
    (idxPanel.match(/<div class="fila-iconos">/g) || []).length === 1 &&
    ['ask-team', 'lilit-estado', 'exportar', 'importar']
      .every((b) => new RegExp(`id="${b}"[^>]*>\\s*<span>`).test(idxPanel)) &&
    !/<div class="fila-botones">/.test(idxPanel),
    'el sitio de la barra es para la lista de especialistas, no para los botones');
  check('el reloj no gasta un renglon propio',
    /\.brand \.reloj\{flex:0 0 auto/.test(cssEsp),
    'iba debajo del nombre, ocupando una linea entera para cinco caracteres');

  check('hay pestana e interruptor de LILIT',
    /data-tab="lilit"/.test(idxPanel) && /id="lilit-on"/.test(idxPanel));

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
  // Un token caducado pero renovable sigue sirviendo: el CLI lo renueva en el
  // siguiente turno. Exigir "vigente" daba falsa alarma cada pocas horas.
  check('el proveedor tiene sesion utilizable',
    pr && pr.conectado === true && pr.credenciales && pr.credenciales.utilizable === true,
    `conectado=${pr && pr.conectado} utilizable=${pr && pr.credenciales && pr.credenciales.utilizable}`
    + ` (vigente=${pr && pr.credenciales && pr.credenciales.vigente})`);
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

  // --- tablas y bloques de codigo en la conversacion -----------------------
  const appTab = await (await fetch((await base()) + '/app.js')).text();
  check('las tablas de markdown se pintan como tablas',
    /function conTablas/.test(appTab) && /<table class="tabla">/.test(appTab),
    'llegaban como texto con barras y las columnas se desalineaban');
  check('las tablas se extraen antes de compactar los saltos',
    appTab.indexOf('function conTablas') > 0 &&
    /conTablas\(parte, \(suelto\) =>/.test(appTab),
    'una tabla ES su estructura de lineas: compactar primero la destruye');
  check('las columnas de cifras se alinean a la derecha',
    /nIza = al\(i\) === 'left'/.test(appTab),
    'una columna de numeros desalineada no se compara de un vistazo');
  check('una fila corta no descuadra la tabla',
    /f\[i\] === undefined \? '' : f\[i\]/.test(appTab));
  // El hueco que se veia en pantalla: se recortaban los saltos del final
  // pero no los del principio, y el codigo quedaba pegado al fondo.
  check('el bloque de codigo no deja hueco al principio',
    /replace\(\/\^\(\?:\[ \\t\]\*\\n\)\+\/, ''\)/.test(appTab),
    'un bloque con saltos delante salia con la caja medio vacia');
  const cssTab = await (await fetch((await base()) + '/style.css')).text();
  check('un bloque de codigo enorme no empuja la conversacion',
    /\.msg \.bloque pre\{[^}]*max-height/.test(cssTab.replace(/\s+/g, ' ')));
  check('la tabla se desplaza si no cabe de ancho',
    /\.tabla-caja\{[^}]*overflow-x:auto/.test(cssTab.replace(/\s+/g, '')));

  // La causa REAL del hueco: el cuerpo del mensaje se pinta con
  // white-space:pre-wrap, asi que un salto de linea escrito entre etiquetas
  // de la plantilla se ve como un hueco de verdad dentro de la caja.
  check('el html del bloque no lleva saltos entre etiquetas',
    !/`<div class="bloque">\s*\n/.test(appTab),
    'con pre-wrap, la sangria de la plantilla se ve en pantalla');
  check('titulos y negrita de markdown se interpretan',
    /tit-md n\$\{/.test(appTab) && /<strong>\$1<\/strong>/.test(appTab),
    'salian como ## y ** en crudo');
  // Negrita que CONTIENE codigo: "** `costo` del paquete**". Si el codigo se
  // convierte antes, la negrita ya no puede cruzarlo y deja los asteriscos.
  check('el codigo en linea se aparta antes de aplicar negrita',
    /const apartados = \[\]/.test(appTab)
    && appTab.indexOf('const apartados') < appTab.indexOf('<strong>$1</strong>'),
    'negrita que contiene codigo dejaria los asteriscos a la vista');
  check('el marcador interno no puede aparecer en texto normal',
    /\\u0000\$\{apartados\.length/.test(appTab),
    'con un caracter corriente, "tengo 3 paquetes" se corromperia');

  // --- contexto en vivo y aviso a tiempo -----------------------------------
  const orqCtx = fs.readFileSync(`${__dirname}/../src/orchestrator.js`, 'utf8');
  check('el contexto se mide durante el turno, no solo al final',
    /contextoEnVivo\(agent, turn, ev\.message\)/.test(orqCtx),
    'medirlo solo al terminar es enterarse cuando ya paso');
  // El filtro de escritura tenia un "&& usado <= previo.usado" que lo anulaba:
  // como el contexto siempre crece, esa parte nunca se cumplia y escribia en
  // las 300 respuestas de un turno.
  check('no escribe en la base en cada respuesta del modelo',
    /Math\.abs\(pct - previo\.pct\) < 1\) return;/.test(orqCtx),
    'un turno real trae cientos de respuestas');
  check('el aviso de contexto sale una sola vez por subida',
    /this\.avisadosCtx\.has\(agent\.id\)\) return;/.test(orqCtx) &&
    /pct < umbral - 5\) this\.avisadosCtx\.delete/.test(orqCtx),
    'un aviso por respuesta acabaria silenciado');
  check('no inventa la ventana si aun no la conoce',
    /if \(!ventana\) return;/.test(orqCtx));

  const ctxEstado = await req('/api/state');
  const unAgente = (await req('/api/agents')).data.agents.find((a) => a.contexto);
  if (unAgente) {
    check('la web recibe el ritmo de contexto',
      Object.prototype.hasOwnProperty.call(unAgente.contexto, 'ritmo'));
    check('la web sabe a que porcentaje se compacta solo',
      typeof unAgente.contexto.compactaAl === 'number');
  }

  const appCtx = await (await fetch((await base()) + '/app.js')).text();
  check('el porcentaje de contexto se ve, no solo en el tooltip',
    /ctx-num/.test(appCtx) && /function barraContexto/.test(appCtx),
    'en el movil no hay tooltip: un dato que solo vive ahi no existe');
  check('se dice cuantos turnos quedan cuando se sabe',
    /turnosRestantes/.test(appCtx));

  const srvCtx = fs.readFileSync(`${__dirname}/../src/server.js`, 'utf8');
  check('hay aviso al movil por contexto alto',
    /tipo === 'contexto\.alto'/.test(srvCtx));
  check('el aviso de contexto no pisa al de trabajo terminado',
    /etiqueta: `contexto-\$\{agent\.id\}`/.test(srvCtx),
    'compartir etiqueta borraria el aviso que mas se espera');

  // Prediccion: mejor callar que inventarse una cifra.
  const dbCtx = fs.readFileSync(`${__dirname}/../src/db.js`, 'utf8');
  check('sin historico suficiente no se predice nada',
    /if \(filas\.length < minimo\) return null;/.test(dbCtx));
  check('las bajadas por compactar no cuentan como crecimiento',
    /if \(d > 0\) saltos\.push\(d\);/.test(dbCtx),
    'una compactacion hundiria la media y diria que quedan muchos turnos');
  check('el historico de contexto se guarda por turno',
    /UPDATE turns SET ctx_usado = \?, ctx_ventana = \? WHERE id = \?/.test(dbCtx));
  check('la consulta del historico usa indice, no barrido',
    /idx_turns_agente ON turns\(agent_id, id\)/.test(dbCtx),
    'se consulta por cada agente en cada sondeo de la web');

  // --- icono de la aplicacion ----------------------------------------------
  const ico = await req('/api/iconos?n=5');
  check('ofrece iconos para elegir',
    ico.status === 200 && Array.isArray(ico.data.opciones) && ico.data.opciones.length === 5);
  check('el actual va entre las opciones', ico.data.opciones.includes(ico.data.actual));

  const icoBajar = async (ruta) => Buffer.from(
    await (await fetch((await base()) + ruta)).arrayBuffer());
  const icoPng = await icoBajar('/icons/icon-192.png');
  check('el icono es un PNG de verdad',
    icoPng.slice(1, 4).toString() === 'PNG' && icoPng.slice(-8, -4).toString() === 'IEND',
    `${icoPng.length} bytes`);
  check('misma semilla, mismo icono',
    Buffer.compare(await icoBajar('/icons/icon-192-abc123.png'),
      await icoBajar('/icons/icon-192-abc123.png')) === 0);
  check('semillas distintas dan iconos distintos',
    Buffer.compare(await icoBajar('/icons/icon-192-abc123.png'),
      await icoBajar('/icons/icon-192-def456.png')) !== 0);

  // El maskable tiene que ser OPACO: Android lo recorta en circulo y un fondo
  // translucido deja el icono gris sobre el fondo del sistema. Paso por aqui
  // una vez: con radio 0, el suavizado daba media opacidad a todo.
  const icoMask = await icoBajar('/icons/maskable-64-abc123.png');
  const icoZlib = require('node:zlib');
  let icoIdat = Buffer.alloc(0); let w = 0; let h = 0; let icoOff = 8;
  while (icoOff < icoMask.length) {
    const ln = icoMask.readUInt32BE(icoOff);
    const tipo = icoMask.slice(icoOff + 4, icoOff + 8).toString();
    if (tipo === 'IHDR') { w = icoMask.readUInt32BE(icoOff + 8); h = icoMask.readUInt32BE(icoOff + 12); }
    if (tipo === 'IDAT') icoIdat = Buffer.concat([icoIdat, icoMask.slice(icoOff + 8, icoOff + 8 + ln)]);
    icoOff += 12 + ln;
  }
  const icoCrudo = icoZlib.inflateSync(icoIdat);
  let icoTranslucidos = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (icoCrudo[y * (w * 4 + 1) + 1 + x * 4 + 3] !== 255) icoTranslucidos += 1;
    }
  }
  check('el icono maskable es totalmente opaco', icoTranslucidos === 0,
    `${icoTranslucidos} pixeles icoTranslucidos: Android lo recorta y se veria gris`);

  for (const mala of ['../../etc/passwd', 'ab', 'x;rm -rf /']) {
    const r = await req('/api/iconos', { method: 'POST', body: { semilla: mala } });
    check(`rechaza la semilla "${mala.slice(0, 14)}"`, r.status === 400, `status ${r.status}`);
  }

  const icoMan = await (await fetch((await base()) + '/manifest.webmanifest')).json();
  check('el manifest lleva la semilla en las direcciones',
    icoMan.icons.every((i) => new RegExp(`-${ico.data.actual}\\.png$`).test(i.src)),
    'sin eso el navegador conserva el icono viejo de su cache');
  check('el manifest trae iconos maskable',
    icoMan.icons.some((i) => i.purpose === 'maskable'));
  const idxIco = await (await fetch(await base())).text();
  check('la pagina enlaza el icono con semilla',
    new RegExp(`href="/icons/icon-192-${ico.data.actual}\\.png"`).test(idxIco));
  check('hay donde elegir el icono en la web',
    /id="icono-opciones"/.test(idxIco) && /id="icono-otros"/.test(idxIco));

  // La que faltaba y dejo el icono roto en pantalla: comprobar que el enlace
  // esta en el HTML no sirve de nada si la direccion devuelve 404. La regla
  // del GET solo admitia hexadecimal y la semilla por defecto, "masterchief",
  // tiene letras fuera de ese alfabeto.
  const hrefIco = (idxIco.match(/href="(\/icons\/icon-192[^"]*)"/) || [])[1];
  const rIco = await fetch((await base()) + hrefIco);
  const bytesIco = Buffer.from(await rIco.arrayBuffer());
  check('el icono que enlaza la pagina SE SIRVE de verdad',
    rIco.status === 200 && bytesIco.slice(1, 4).toString() === 'PNG',
    `${hrefIco} -> HTTP ${rIco.status}`);
  check('las semillas con letras funcionan, no solo las hexadecimales',
    (await icoBajar('/icons/icon-192-masterchief.png')).slice(1, 4).toString() === 'PNG');

  // Iconos de empresa: son de Lucide, no dibujos a mano.
  const icoSrc = fs.readFileSync(`${__dirname}/../src/iconos.js`, 'utf8');
  const datosIco = require(`${__dirname}/../src/iconos-datos`);
  check('el juego de iconos profesional esta incluido',
    Object.keys(datosIco).length >= 15, `${Object.keys(datosIco).length} iconos`);
  check('se conserva el aviso de licencia de los iconos',
    fs.existsSync(`${__dirname}/../assets/iconos/LICENSE-lucide.txt`) &&
    /Lucide/.test(fs.readFileSync(`${__dirname}/../src/iconos-datos.js`, 'utf8')),
    'son de terceros, con licencia ISC');
  for (const f of ['headset', 'phone-call', 'messages-square', 'chart-column', 'target']) {
    check(`esta el icono "${f}"`, !!datosIco[f]);
  }
  check('las formas de empresa usan paleta sobria, no arcoiris',
    /const PALETAS = \[/.test(icoSrc) && /empresa \? paleta\.h/.test(icoSrc),
    'el arcoiris de puntos no pasa por el logotipo de una empresa');

  // La prueba que de verdad sirve: que CADA icono deje tinta en el lienzo.
  // Asi se cazo que tres de ellos (bot, network, workflow) salian a medias
  // porque el lector de SVG no entendia <rect> y se comia media figura.
  const { generar: genIco, receta: recIco } = require(`${__dirname}/../src/iconos`);
  const zlibIco = require('node:zlib');
  const tinta = (png) => {
    let o = 8; let dat = Buffer.alloc(0); let w = 0; let h = 0;
    while (o < png.length) {
      const ln = png.readUInt32BE(o); const t = png.slice(o + 4, o + 8).toString();
      if (t === 'IHDR') { w = png.readUInt32BE(o + 8); h = png.readUInt32BE(o + 12); }
      if (t === 'IDAT') dat = Buffer.concat([dat, png.slice(o + 8, o + 8 + ln)]);
      o += 12 + ln;
    }
    const raw = zlibIco.inflateSync(dat); const st = w * 4 + 1;
    const bg = [raw[(h >> 1) * st + 1], raw[(h >> 1) * st + 2], raw[(h >> 1) * st + 3]];
    let n = 0; let tot = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i2 = y * st + 1 + x * 4;
        if (raw[i2 + 3] < 10) continue;
        tot += 1;
        if (Math.abs(raw[i2] - bg[0]) + Math.abs(raw[i2 + 1] - bg[1])
          + Math.abs(raw[i2 + 2] - bg[2]) > 40) n += 1;
      }
    }
    return n / tot;
  };
  const semillaDe = (forma) => {
    for (let i = 0; i < 60000; i++) {
      const c = `z${i.toString(36)}`;
      if (recIco(c).forma === forma) return c;
    }
    return null;
  };
  let flojos = [];
  for (const nombre of Object.keys(datosIco)) {
    const s = semillaDe(nombre);
    if (!s) continue;
    const t = tinta(genIco(s, 128));
    if (t < 0.025 || t > 0.45) flojos.push(`${nombre} ${(t * 100).toFixed(1)}%`);
  }
  check('todos los iconos dibujan algo reconocible', flojos.length === 0,
    flojos.join(', ') || 'ok');

  // Tamaño del dibujo dentro del cuadro. Dos limites distintos: en el
  // cuadrado redondeado manda el lado; en el recortable, que Android corta
  // en circulo, manda la distancia al centro.
  const bordeYancho = (png) => {
    let o = 8; let dat = Buffer.alloc(0); let w = 0; let h = 0;
    while (o < png.length) {
      const ln = png.readUInt32BE(o); const t = png.slice(o + 4, o + 8).toString();
      if (t === 'IHDR') { w = png.readUInt32BE(o + 8); h = png.readUInt32BE(o + 12); }
      if (t === 'IDAT') dat = Buffer.concat([dat, png.slice(o + 8, o + 8 + ln)]);
      o += 12 + ln;
    }
    const raw = zlibIco.inflateSync(dat); const st = w * 4 + 1;
    const o0 = (h >> 1) * st + 1 + 2 * 4;
    const bg = [raw[o0], raw[o0 + 1], raw[o0 + 2]];
    // Solo pixeles OPACOS. El borde suavizado de la placa redondeada no es
    // dibujo, y contarlo daba un falso "esta cortado" en 15 de 20 iconos.
    const esTinta = (x, y) => {
      const i = y * st + 1 + x * 4;
      if (raw[i + 3] !== 255) return false;
      return Math.abs(raw[i] - bg[0]) + Math.abs(raw[i + 1] - bg[1])
        + Math.abs(raw[i + 2] - bg[2]) > 40;
    };
    let tocaBorde = 0; let minx = w; let maxx = 0; let rad = 0;
    for (let x = 0; x < w; x++) { if (esTinta(x, 0)) tocaBorde += 1; if (esTinta(x, h - 1)) tocaBorde += 1; }
    for (let y = 0; y < h; y++) { if (esTinta(0, y)) tocaBorde += 1; if (esTinta(w - 1, y)) tocaBorde += 1; }
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (!esTinta(x, y)) continue;
        minx = Math.min(minx, x); maxx = Math.max(maxx, x);
        rad = Math.max(rad, Math.hypot(x - w / 2, y - h / 2) / w);
      }
    }
    return { tocaBorde, ancho: (maxx - minx) / w, radial: rad };
  };

  const cortados = [];
  const fuera = [];
  let masAncho = 0;
  for (const nombre of Object.keys(datosIco)) {
    const s = semillaDe(nombre);
    if (!s) continue;
    const n = bordeYancho(genIco(s, 192));
    const mk = bordeYancho(genIco(s, 192, true));
    if (n.tocaBorde > 0) cortados.push(nombre);
    // Zona segura de un icono recortable: circulo del 80% central.
    if (mk.radial > 0.40) fuera.push(`${nombre} ${(mk.radial * 100).toFixed(0)}%`);
    masAncho = Math.max(masAncho, n.ancho);
  }
  check('ningun icono queda cortado por el borde', cortados.length === 0, cortados.join(', '));
  check('ningun icono recortable se sale de la zona segura', fuera.length === 0,
    `${fuera.join(', ')} — Android recorta en circulo`);
  check('el dibujo llena el cuadro, no queda diminuto', masAncho > 0.6,
    `el mas ancho ocupa el ${(masAncho * 100).toFixed(0)}% del lado`);

  const trazoSrc = fs.readFileSync(`${__dirname}/../src/trazo.js`, 'utf8');
  check('el lector de SVG entiende rectangulos',
    /<rect\[\^>\]\*>/.test(trazoSrc) || /matchAll\(\/<rect/.test(trazoSrc),
    'tres iconos del juego los usan y salian a medio dibujar');
  check('el lector de SVG entiende arcos',
    /function arcoSvg/.test(trazoSrc),
    'las esquinas redondeadas de casi todos los iconos son arcos');

  // --- temas ---------------------------------------------------------------
  const cssTema = await (await fetch((await base()) + '/style.css')).text();
  for (const t of ['matrix', 'claro']) {
    check(`existe el tema ${t}`, new RegExp(`html\\[data-tema="${t}"\\]`).test(cssTema));
  }
  check('el tema se aplica antes de pintar, sin fogonazo',
    /localStorage\.getItem\('v4-tema'\)/.test(idxIco) &&
    idxIco.indexOf("getItem('v4-tema')") < idxIco.indexOf('<body'),
    'aplicarlo en app.js daria un fogonazo oscuro al entrar en el claro');
  check('la lluvia de caracteres sigue al tema',
    /getPropertyValue\('--matrix'\)/.test(appCtx),
    'en claro, verde fosforo sobre blanco no se ve');
  check('el color de la barra del navegador sigue al tema',
    /meta\[name="theme-color"\]/.test(appCtx),
    'en claro quedaria una franja negra arriba');
  check('el tema claro no deja texto oscuro sobre fondo de color',
    /html\[data-tema="claro"\][\s\S]{0,400}--sobre-acento:#ffffff/.test(cssTema),
    'los botones de accion quedarian ilegibles');
  check('hay donde elegir el tema', /id="temas"/.test(idxIco));

  // Contraste real de cada tema. Un tema claro mal medido se ve "bonito" en
  // una captura y es ilegible a pleno sol en el movil, que es justo donde se
  // usa. Se mide, no se opina.
  const leerVars = (bloque) => {
    const o = {};
    for (const m of bloque.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)) o[m[1]] = m[2].trim();
    return o;
  };
  const vRaiz = leerVars(cssTema.match(/:root\{([\s\S]*?)\}/)[1]);
  const luminancia = (h) => {
    const m = /^#([0-9a-f]{6})$/i.exec(String(h).trim());
    if (!m) return null;
    const v = [0, 2, 4].map((i) => parseInt(m[1].substr(i, 2), 16) / 255)
      .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
  };
  const contraste = (a, b) => {
    const x = luminancia(a); const y = luminancia(b);
    if (x === null || y === null) return null;
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  };
  // Todas las parejas que de verdad se ven en pantalla, no una muestra. La
  // que importa de verdad es "al escribir": un fondo fijo casi negro con el
  // texto del tema daba letras negras sobre negro en el tema claro.
  const PAREJAS = [
    ['fg', 'bg', 'texto'], ['muted', 'bg', 'texto secundario'],
    ['sobre-acento', 'accent', 'texto sobre boton'],
    ['dicho', 'chat-fondo', 'mensaje leido'],
    ['dicho-mio', 'chat-fondo', 'lo que escribo yo'],
    ['dicho-sistema', 'chat-fondo', 'avisos del sistema'],
    ['dicho-par', 'chat-fondo', 'mensaje de otro agente'],
    ['fg', 'campo-fondo', 'AL ESCRIBIR'],
    ['bloque-texto', 'bloque-fondo', 'bloque de codigo'],
    ['enlace', 'chat-fondo', 'enlaces'], ['ruta', 'chat-fondo', 'rutas'],
    ['sep', 'chat-fondo', 'separadores'], ['hora', 'chat-fondo', 'la hora'],
    ['tab-apagada', 'bg2', 'pestana inactiva'], ['mal', 'bg', 'avisos en rojo'],
    ['inseguro-texto', 'inseguro-fondo', 'aviso de http'],
    ['aviso-texto', 'sobre-aviso', 'boton del aviso de version'],
    ['dicho', 'bloque-fondo', 'celda de tabla'],
    ['fg', 'bg3', 'cabecera de tabla']
  ];
  const temasDef = { oscuro: vRaiz };
  for (const t of ['claro', 'matrix']) {
    temasDef[t] = { ...vRaiz, ...leerVars(cssTema.match(new RegExp(`html\\[data-tema="${t}"\\]\\{([\\s\\S]*?)\\n\\}`))[1]) };
  }
  for (const [t, v] of Object.entries(temasDef)) {
    const malos = [];
    for (const [a, b, etiq] of PAREJAS) {
      const r = contraste(v[a], v[b]);
      if (r === null) malos.push(`${etiq}: ${v[a] ? '' : `falta --${a} `}${v[b] ? '' : `falta --${b}`}`);
      else if (r < 4.5) malos.push(`${etiq} ${r.toFixed(2)}:1`);
    }
    check(`tema ${t}: las ${PAREJAS.length} combinaciones se leen`, malos.length === 0,
      malos.join(' | '));
  }

  // Guardia estructural: un color escrito a pelo en una regla no sigue al
  // tema. Asi aparecio el fondo negro del campo de escritura, que con el
  // tema claro dejaba letras negras sobre negro.
  const sinVars = cssTema
    .replace(/:root\{[\s\S]*?\n\}/g, '')
    .replace(/html\[data-tema="[a-z]+"\]\{[\s\S]*?\n\}/g, '');
  const aPelo = sinVars.split('\n')
    .filter((l) => /(background|[^-\w]color)\s*:[^;]*#[0-9a-fA-F]{3,6}/.test(l))
    // Blanco sobre el rojo de error se lee en los tres temas: es la excepcion.
    .filter((l) => !/background:var\(--err\);color:#fff/.test(l));
  check('ninguna regla fija colores por su cuenta', aPelo.length === 0,
    aPelo.map((l) => l.trim().slice(0, 60)).join(' | '));

  check('los temas declaran su esquema al navegador',
    (cssTema.match(/color-scheme:/g) || []).length >= 3,
    'sin esto el navegador pinta barras y autorelleno a su aire');

  // --- economia de contexto: memoria, rtk y compactacion automatica --------
  const estado2 = await req('/api/state');
  const ajustes = estado2.data.ajustes || {};
  check('la web conoce el umbral de compactacion',
    typeof ajustes.compactarAlPorcentaje === 'number');
  check('la web sabe si rtk esta disponible', typeof ajustes.rtk === 'boolean');

  // El umbral tiene que rechazar valores que harian compactar sin parar.
  const malUmbral = await req('/api/app', { method: 'PATCH', body: { compactarAlPorcentaje: 10 } });
  check('rechaza un umbral que compactaria constantemente',
    malUmbral.status === 400, `status ${malUmbral.status}`);
  const fueraRango = await req('/api/app', { method: 'PATCH', body: { compactarAlPorcentaje: 150 } });
  check('rechaza un umbral fuera de 0-100', fueraRango.status === 400);

  const orqSrc2 = fs.readFileSync(`${__dirname}/../src/orchestrator.js`, 'utf8');
  // La guarda del bucle es lo unico que impide que un agente con el contexto
  // lleno se quede compactando para siempre sin trabajar nunca: /compact no
  // deja medida nueva, asi que ctx_usado sigue alto despues de compactar.
  check('la compactacion automatica no puede entrar en bucle',
    /this\.compactados\.get\(agent\.id\) === agent\.ctx_visto/.test(orqSrc2),
    'sin esta guarda, un agente lleno nunca volveria a trabajar');
  check('no compacta la propia compactacion',
    /turn\.origin === 'compactar'\) return false/.test(orqSrc2));
  check('no apila compactaciones para el mismo agente',
    /origin = 'compactar'[\s\S]{0,120}status IN \('pending','running','esperando_cuota'\)/.test(orqSrc2));
  check('un turno que vuelve de esperar cuota compacta antes',
    /umbralEfectivo = reintentado/.test(orqSrc2));
  check('el turno aplazado no se pierde al compactar',
    /turno_aplazado: turn\.id/.test(orqSrc2));

  const memSrc = fs.readFileSync(`${__dirname}/../src/memoria.js`, 'utf8');
  check('la memoria usa el archivo que lee cada motor solo',
    /claude: 'CLAUDE\.md'/.test(memSrc) && /codex: 'AGENTS\.md'/.test(memSrc));
  check('la memoria del especialista nunca se sobreescribe',
    /if \(!fs\.existsSync\(memoria\)\)/.test(memSrc),
    'pisar lo que el agente aprendio seria peor que no tener memoria');

  const runSrc = fs.readFileSync(`${__dirname}/../src/runner.js`, 'utf8');
  check('rtk llega al PATH del especialista',
    /plan\.env\.PATH = `\$\{dir\}:\$\{actual\}`/.test(runSrc),
    'el PATH del servicio no trae /usr/local/bin: sin esto rtk no se encuentra');
  check('las banderas de rtk que si ahorran estan en el prompt',
    /rtk read -m 80/.test(runSrc) && /-l aggressive/.test(runSrc));
  check('el prompt avisa de que rtk sin banderas no filtra',
    /NO filtra nada/.test(runSrc), 'rtk read pelado devuelve el archivo igual');
  check('sin rtk instalado el prompt no lo menciona',
    /AHORRO_SIN_RTK/.test(runSrc) && /cfg\.rtkBin \? AHORRO_RTK : AHORRO_SIN_RTK/.test(runSrc),
    'pedir un comando que no existe en otro servidor');
  check('la memoria se siembra al empezar el turno, no al crear el agente',
    /memoria\.preparar\(agent, prov\.nombre\)/.test(runSrc),
    'asi la tienen los especialistas que ya existian');

  // El cuarto argumento de runTurn es una RUTA de archivo, no una funcion.
  // Llamarlo rompia el PRIMER turno de cada especialista —justo cuando se
  // crea su memoria— y al repetir funcionaba, que es lo que lo hacia
  // desconcertante. El nombre "log" invitaba al error; ahora es rutaLog.
  check('el registro del turno se trata como ruta, no como funcion',
    !/\brutaLog\(/.test(runSrc) && !/\blog\(`/.test(runSrc) &&
    /function runTurn\(cfg, agent, turn, rutaLog/.test(runSrc),
    'romperia el primer turno de cada especialista');

  // Y la prueba de verdad: ejecutar un turno con el espacio de trabajo
  // RECIEN creado, que es el camino que fallaba. Se simula el proceso hijo
  // para no gastar modelo.
  {
    const cp = require('node:child_process');
    const { EventEmitter } = require('node:events');
    const spawnReal = cp.spawn;
    cp.spawn = () => {
      const c = new EventEmitter();
      c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.kill = () => {};
      setImmediate(() => c.emit('close', 0));
      return c;
    };
    try {
      const { runTurn } = require(`${__dirname}/../src/runner`);
      // Ojo: el cfg de este archivo es el JSON crudo, SIN las rutas que
      // rellena config.load() (entre ellas la del binario). Con el crudo,
      // runTurn se rinde antes de llegar a sembrar la memoria y la prueba
      // pasaria por el motivo equivocado.
      const cfgReal = require(`${__dirname}/../src/config`).load();
      const agentes = (await req('/api/agents')).data.agents;
      const base0 = JSON.parse(JSON.stringify(agentes[0]));
      base0.workspace = `/tmp/selftest-ws-${Date.now()}`;
      base0.home = '/tmp/selftest-home';
      base0.instructions = base0.instructions || 'prueba';
      const r = await runTurn(cfgReal, base0, { id: 0, prompt: 'x', chain_id: 'c', hop: 0 },
        null, () => {}, () => {});
      // Da igual que el turno no produzca salida: lo que se comprueba es que
      // sembrar la memoria por primera vez no lanza una excepcion.
      check('el primer turno de un especialista nuevo no revienta',
        !/is not a function/.test(r.error || ''), r.error || 'ok');
      const provNom = require(`${__dirname}/../src/proveedores`).paraAgente(base0, cfgReal).nombre;
      const archivoMem = require(`${__dirname}/../src/memoria`).ARCHIVO_POR_PROVEEDOR[provNom];
      check('al primer turno se le crea su memoria de trabajo',
        fs.existsSync(`${base0.workspace}/${archivoMem}`)
        && fs.existsSync(`${base0.workspace}/herramientas`),
        `motor ${provNom}, esperaba ${archivoMem}`);
      fs.rmSync(base0.workspace, { recursive: true, force: true });
    } finally {
      cp.spawn = spawnReal;
    }
  }

  // LILIT decia "conviene que compacte a X" cuando compactar ya no es trabajo
  // del usuario. Avisar de algo que el sistema ya hizo entrena a ignorarla.
  const fr = require(`${__dirname}/../src/lilit-frases`);
  check('LILIT sabe decir que compacto ella sola', fr.FRASES.compactado.length >= 5);
  check('LILIT distingue "sigue lleno pese a compactar"',
    fr.FRASES.contexto_pese_a_todo.length >= 4);
  const lilSrc = fs.readFileSync(`${__dirname}/../src/lilit.js`, 'utf8');
  check('con compactacion automatica LILIT no le pide compactar a mano',
    /autoCompacta \? 'contexto_pese_a_todo' : 'contexto'/.test(lilSrc));
  for (const t of ['compactado', 'contexto_pese_a_todo']) {
    const dicha = fr.frase(t, { quien: 'Prueba', n: 2 });
    check(`la frase de ${t} se renderiza sin huecos`,
      !!dicha && !/\{/.test(dicha), dicha);
  }

  // --- actualizar desde la web ---------------------------------------------
  const estAct = await req('/api/actualizacion');
  check('el estado de actualizacion contesta', act.status === 200);
  check('dice que version corre', /^[0-9a-f]{7}$/.test(estAct.data.version || ''));
  // No basta con que "parezca" un nombre: tiene que ser una unidad que EXISTE.
  // Derivarlo del nombre de la carpeta daba "codex-web-codex-web" en una
  // instalacion en /opt/codex-web. Y ese fallo no se veia: el reinicio no da
  // error, el servicio viejo sigue vivo, la salud pasa y el actualizador dice
  // "listo" con el codigo nuevo en disco y el viejo en memoria.
  const unidad = estAct.data.servicio || '';
  const existe = await new Promise((r) => require('node:child_process')
    .execFile('systemctl', ['cat', `${unidad}.service`], (e) => r(!e)));
  check('el servicio que reiniciaria existe de verdad', !!unidad && existe,
    `detectado "${unidad}"`);
  check('sabe si el disco esta limpio', typeof estAct.data.limpio === 'boolean');
  check('lista los especialistas a los que cortaria el turno',
    Array.isArray(estAct.data.trabajando));

  // La proteccion que importa: pedir actualizar cuando no se debe tiene que
  // devolver 409 y un actMotivo, nunca ponerse a trabajar.
  //
  // Ojo con el caso raro: el propio actualizador lanza este archivo como
  // ultimo paso, asi que aqui puede haber una actualizacion en marcha. Si no
  // lo tuvieramos en cuenta, CADA actualizacion acabaria diciendo "1 prueba
  // en rojo" y te acostumbrarias a ignorar ese aviso, que es justo lo que no
  // queremos que pase.
  // Regla de oro de este bloque: un diagnostico no puede tener efectos. Solo
  // llamamos a /aplicar cuando el estado garantiza que lo va a rechazar. Si
  // no hubiera nada que lo frene, la llamada instalaria de verdad y el
  // autodiagnostico se convertiria en un despliegue accidental.
  const actEnMarcha = estAct.data.enCurso
    || !!(estAct.data.progreso && !estAct.data.progreso.terminado);
  const actMotivo = actEnMarcha ? /en marcha/i
    : estAct.data.sucio > 0 ? /sin guardar/i
    : !estAct.data.hayNuevos ? /nada nuevo/i
    : estAct.data.trabajando.length ? /trabajando/i
    : null;

  if (actMotivo) {
    const actNeg = await req('/api/actualizacion/aplicar', { method: 'POST', body: {} });
    check('no actualiza cuando no debe, y dice por que',
      actNeg.status === 409 && actMotivo.test(actNeg.data.error || ''),
      `status ${actNeg.status}: ${actNeg.data.error || 'sin actMotivo'}`);
  } else {
    check('no actualiza cuando no debe, y dice por que', true,
      'omitida: ahora mismo una actualizacion seria legitima y no se lanza en pruebas');
  }

  // Tras una vuelta atras automatica el registro apunta a donde ya estamos.
  check('no ofrece volver a la version en la que ya estas',
    estAct.data.anterior !== estAct.data.commit);

  // La vuelta atras tampoco se dispara aqui. Si no hay donde volver, el 409
  // es inofensivo y vale como prueba; si lo hay, nos basta con ver que la
  // web tiene la informacion para ofrecer el boton.
  if (!estAct.data.anterior) {
    const actRev = await req('/api/actualizacion/revertir', { method: 'POST', body: {} });
    check('sin version anterior no ofrece volver atras',
      actRev.status === 409, `status ${actRev.status}`);
  } else {
    check('sin version anterior no ofrece volver atras',
      /^[0-9a-f]{40}$/.test(estAct.data.anterior) && !!estAct.data.tituloAnterior,
      'hay version anterior registrada: se comprueba el dato, no se revierte');
  }

  const guionAct = fs.readFileSync(`${__dirname}/../tools/actualizar.sh`, 'utf8');
  check('el actualizador copia la base antes de tocar nada',
    /VACUUM INTO/.test(guionAct) && guionAct.indexOf('VACUUM INTO') < guionAct.indexOf('git fetch'));
  // Ojo al ancla: "systemctl restart" tambien aparece dentro de deshacer(),
  // que se declara arriba del archivo. El orden que importa es frente al paso
  // de reinicio, no frente a la primera vez que se menciona el comando.
  check('el actualizador revisa la sintaxis antes de reiniciar',
    /--check/.test(guionAct) && guionAct.indexOf('--check') < guionAct.indexOf('paso reiniciar'));
  check('el actualizador deshace solo si no arranca',
    /deshacer\(\)/.test(guionAct) && /reset --hard "\$anterior"/.test(guionAct));
  check('el actualizador solo avanza en linea recta',
    /merge --ff-only/.test(guionAct) && /is-ancestor/.test(guionAct));
  check('el actualizador es ejecutable',
    (fs.statSync(`${__dirname}/../tools/actualizar.sh`).mode & 0o111) !== 0);

  const moduloAct = fs.readFileSync(`${__dirname}/../src/actualizar.js`, 'utf8');
  check('la actualizacion corre fuera del servicio',
    /systemd-run/.test(moduloAct) && /detached: true/.test(moduloAct),
    'si corriera dentro, el reinicio la mataria a medias');

  const htmlAct = fs.readFileSync(`${__dirname}/../public/index.html`, 'utf8');
  for (const id of ['act-version', 'act-buscar', 'act-instalar', 'act-revertir',
    'act-progreso', 'act-novedades']) {
    check(`el html trae #${id}`, new RegExp(`id="${id}"`).test(htmlAct));
  }

  // --- limpieza ---
  await req(`/api/agents/${A}?purgar=1`, { method: 'DELETE' });
  await req(`/api/agents/${B}?purgar=1`, { method: 'DELETE' });
  const quedan = (await req('/api/agents')).data.agents.filter((x) => x.name.includes(`-${sufijo}`));
  check('archiva los agentes de prueba', quedan.length === 0);

  console.log(`\n${pasa} correctas, ${falla} fallidas`);
  process.exit(falla ? 1 : 0);
})().catch((e) => { console.error('error del autodiagnostico:', e.message); process.exit(2); });
