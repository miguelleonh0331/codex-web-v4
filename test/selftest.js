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
  await req(`/api/agents/${conModelo.data.id}`, { method: 'DELETE' });

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
  if (alta.data.id) await req(`/api/agents/${alta.data.id}`, { method: 'DELETE' });

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
    'process.stdout.write(JSON.stringify({n:l.length,unicos:new Set(s).size,' +
    'estados:f.ESTADOS.length,estadosUnicos:new Set(est).size,' +
    'recolor:f.robotSvg("zeus","normal",40)!==f.robotSvg("zeus","normal",40,"#ff00aa")}))'],
    { encoding: 'utf8' });
  const dd = JSON.parse(dioses);
  check('hay al menos diez avatares distintos', dd.n >= 10 && dd.unicos === dd.n, dioses);
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
  check('los avatares estan animados', /@keyframes parpadeo/.test(css) && /@keyframes hablar/.test(css) &&
    /@keyframes pensar/.test(css) && /prefers-reduced-motion/.test(css));

  // --- limpieza ---
  await req(`/api/agents/${A}`, { method: 'DELETE' });
  await req(`/api/agents/${B}`, { method: 'DELETE' });
  const quedan = (await req('/api/agents')).data.agents.filter((x) => x.name.includes(`-${sufijo}`));
  check('archiva los agentes de prueba', quedan.length === 0);

  console.log(`\n${pasa} correctas, ${falla} fallidas`);
  process.exit(falla ? 1 : 0);
})().catch((e) => { console.error('error del autodiagnostico:', e.message); process.exit(2); });
