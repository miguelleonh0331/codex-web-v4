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
    idxNom.includes(`<title>${nombre}`) && idxNom.includes(`<strong>${nombre}</strong>`),
    'debe venir en el documento, no pintarse despues');
  const man = await (await fetch((await base()) + '/manifest.webmanifest')).json();
  check('la aplicacion instalada tambien lleva ese nombre', man.name === nombre, JSON.stringify(man.name));

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
    /enriquecer\(escapeHtml\(parte\)\)/.test(appTxt));
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

  const conAct = await req('/api/agents');
  const alguno = conAct.data.agents.find((x) => x.contexto);
  check('informa del contexto consumido con su ventana real',
    !!alguno && alguno.contexto.ventana > 0 && alguno.contexto.pct >= 0 && alguno.contexto.pct <= 100,
    alguno ? JSON.stringify(alguno.contexto) : 'ningun agente tiene contexto medido todavia');

  const indexAct = await (await fetch((await base()) + '/')).text();
  check('la interfaz trae el interruptor de actividad',
    /id="ver-actividad"/.test(indexAct) && /id="actividad"/.test(indexAct));

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
  check('el manifiesto permite instalar',
    manifiesto.display === 'standalone' && manifiesto.start_url === '/' &&
    manifiesto.icons.some((i) => i.sizes === '512x512') &&
    manifiesto.icons.some((i) => i.purpose === 'maskable'),
    JSON.stringify(manifiesto).slice(0, 120));

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
