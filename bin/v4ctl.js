#!/usr/bin/env node
'use strict';
/**
 * v4ctl - control de codex-web-v4 desde la terminal.
 *
 *   v4ctl agents                        lista los especialistas
 *   v4ctl create <nombre> <area> <archivo-instrucciones>
 *   v4ctl say <agente> <texto>          envia una tarea y espera el turno
 *   v4ctl tell <de> <a> <texto>         inyecta un mensaje entre agentes
 *   v4ctl chat <agente> [n]             muestra la conversacion
 *   v4ctl mailbox [n]                   correo entre agentes
 *   v4ctl turns [n]                     ultimos turnos
 *   v4ctl claims                        archivos reservados
 *   v4ctl wait                          espera a que no quede trabajo
 *   v4ctl health
 */
const fs = require('node:fs');

const CONFIG_PATH = process.env.V4_CONFIG || '/etc/codex-web-v4/config.json';
let cfg;
try { cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); }
catch (e) { console.error(`No se pudo leer ${CONFIG_PATH}: ${e.message}`); process.exit(1); }

const PORT = cfg.port || 3212;
const CANDIDATOS = process.env.V4_HOST
  ? [process.env.V4_HOST]
  : [...new Set([...(cfg.bindHosts || []), '127.0.0.1'])].map((h) => (h === '0.0.0.0' || h === '::' ? '127.0.0.1' : h));

let BASE = null;
// Un bindHost puede no estar escuchando (puerto robado, interfaz caida): probamos cual responde.
async function base() {
  if (BASE) return BASE;
  for (const h of CANDIDATOS) {
    try {
      const r = await fetch(`http://${h}:${PORT}/api/health`, { signal: AbortSignal.timeout(2500) });
      if (r.ok) { BASE = `http://${h}:${PORT}`; return BASE; }
    } catch { /* probamos el siguiente */ }
  }
  throw new Error(`El servicio no responde en ${CANDIDATOS.map((h) => `${h}:${PORT}`).join(', ')}`);
}

async function api(path, options = {}) {
  const res = await fetch((await base()) + path, {
    ...options,
    headers: { 'content-type': 'application/json', 'x-v4-token': cfg.authToken, ...(options.headers || {}) }
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function resolve(ref) {
  const { agents } = await api('/api/agents');
  const a = agents.find((x) => x.id === ref || x.name.toLowerCase() === String(ref).toLowerCase());
  if (!a) throw new Error(`No existe el especialista "${ref}". Hay: ${agents.map((x) => x.name).join(', ') || 'ninguno'}`);
  return a;
}

async function waitIdle(timeoutMs = 1_200_000) {
  const t0 = Date.now();
  await sleep(1500);
  while (Date.now() - t0 < timeoutMs) {
    const s = await api('/api/state');
    if (s.running === 0 && s.pending === 0) return true;
    await sleep(3000);
  }
  return false;
}

const cmds = {
  async health() { console.log(JSON.stringify(await api('/api/health'), null, 2)); },

  async agents() {
    const { agents } = await api('/api/agents');
    if (!agents.length) return console.log('Sin especialistas.');
    for (const a of agents) {
      console.log(`${a.status === 'working' ? '▶' : '·'} ${a.name.padEnd(18)} ${String(a.area || '').padEnd(34)} ${a.id}`);
    }
  },

  async create(name, area, fileOrText) {
    let instructions = fileOrText;
    if (fileOrText && fs.existsSync(fileOrText)) instructions = fs.readFileSync(fileOrText, 'utf8');
    const a = await api('/api/agents', { method: 'POST', body: JSON.stringify({ name, area, instructions }) });
    console.log(`Creado ${a.name} (${a.id})`);
  },

  async say(ref, ...rest) {
    const a = await resolve(ref);
    const text = rest.join(' ');
    await api(`/api/agents/${a.id}/messages`, { method: 'POST', body: JSON.stringify({ text }) });
    console.log(`Enviado a ${a.name}. Esperando…`);
    await waitIdle();
    await cmds.chat(a.id, '1');
  },

  async tell(from, to, ...rest) {
    const f = await resolve(from);
    const t = await resolve(to);
    const out = await api('/api/internal/mailbox', {
      method: 'POST',
      headers: { 'x-v4-bridge-token': cfg.bridgeToken },
      body: JSON.stringify({ from: f.id, to: t.id, text: rest.join(' '), hop: 0 })
    });
    console.log(JSON.stringify(out));
  },

  async chat(ref, n = '20') {
    const a = await resolve(ref);
    const { messages } = await api(`/api/agents/${a.id}/messages`);
    for (const m of messages.slice(-Number(n))) {
      const who = m.role === 'peer' ? `peer:${(m.meta && m.meta.from) || '?'}` : m.role;
      console.log(`\n── ${who} · ${new Date(m.created_at).toLocaleString()}\n${m.body}`);
    }
  },

  async mailbox(n = '20') {
    const { mailbox } = await api(`/api/mailbox?limit=${n}`);
    for (const m of mailbox.reverse()) {
      console.log(`[${m.status}] ${m.from_name} → ${m.to_name} (hop ${m.hop})${m.reason ? ` · ${m.reason}` : ''}`);
      console.log(`   ${m.body.slice(0, 160).replace(/\n/g, ' ')}`);
    }
  },

  async turns(n = '20') {
    const { turns } = await api(`/api/turns?limit=${n}`);
    for (const t of turns.reverse()) {
      console.log(`#${t.id} ${String(t.agent_name).padEnd(16)} ${t.origin.padEnd(5)} ${t.status.padEnd(7)} hop=${t.hop} ${t.cost_usd ? `$${t.cost_usd.toFixed(4)}` : ''}`);
      if (t.error) console.log(`   error: ${t.error}`);
    }
  },

  async claims() {
    const { claims } = await api('/api/claims');
    if (!claims.length) return console.log('Nada reservado.');
    for (const c of claims) console.log(`${c.agent_name.padEnd(16)} ${c.path}${c.note ? ` · ${c.note}` : ''}`);
  },

  async wait() { console.log(await waitIdle() ? 'Sin trabajo pendiente.' : 'Se agoto la espera.'); }
};

(async () => {
  const [cmd, ...args] = process.argv.slice(2);
  if (!cmd || !cmds[cmd]) {
    console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(3, 17).join('\n').replace(/^ \* ?/gm, ''));
    process.exit(cmd ? 1 : 0);
  }
  try { await cmds[cmd](...args); }
  catch (e) { console.error(`Error: ${e.message}`); process.exit(1); }
})();
