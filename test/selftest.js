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

  // --- limpieza ---
  await req(`/api/agents/${A}`, { method: 'DELETE' });
  await req(`/api/agents/${B}`, { method: 'DELETE' });
  const quedan = (await req('/api/agents')).data.agents.filter((x) => x.name.includes(`-${sufijo}`));
  check('archiva los agentes de prueba', quedan.length === 0);

  console.log(`\n${pasa} correctas, ${falla} fallidas`);
  process.exit(falla ? 1 : 0);
})().catch((e) => { console.error('error del autodiagnostico:', e.message); process.exit(2); });
