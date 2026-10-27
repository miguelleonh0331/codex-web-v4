'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');

const { load } = require('./config');
const { Store, uid } = require('./db');
const { Orchestrator } = require('./orchestrator');

const cfg = load();
const store = new Store(cfg.dbPath);
const orq = new Orchestrator(cfg, store);

const PUBLIC_DIR = path.join(cfg.appDir, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

// ---------------------------------------------------------------- utilidades

function json(res, code, body) {
  const payload = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 2_000_000) { reject(new Error('cuerpo demasiado grande')); req.destroy(); }
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('JSON invalido')); }
    });
    req.on('error', reject);
  });
}

function agentPublic(a) {
  return {
    id: a.id, name: a.name, area: a.area, instructions: a.instructions, model: a.model,
    status: a.status, archived: !!a.archived, workspace: a.workspace,
    created_at: a.created_at, updated_at: a.updated_at,
    has_session: !!a.session_id
  };
}

function nameOf(id) {
  const a = store.getAgent(id);
  return a ? a.name : (id || 'desconocido');
}

function authOk(req, url) {
  const header = req.headers['x-v4-token'];
  const query = url.searchParams.get('token');
  const cookie = (req.headers.cookie || '').split(';').map((s) => s.trim()).find((s) => s.startsWith('v4token='));
  const cookieVal = cookie ? decodeURIComponent(cookie.slice('v4token='.length)) : null;
  return [header, query, cookieVal].includes(cfg.authToken);
}

function bridgeOk(req) {
  return req.headers['x-v4-bridge-token'] === cfg.bridgeToken;
}

// ---------------------------------------------------------------- agentes

function createAgent(body) {
  const name = String(body.name || '').trim();
  if (!name) throw new Error('El nombre es obligatorio.');
  if (store.getAgentByName(name)) throw new Error(`Ya existe un especialista llamado "${name}".`);
  const instructions = String(body.instructions || '').trim();
  if (!instructions) throw new Error('Las instrucciones son obligatorias: definen su responsabilidad y sus limites.');

  const id = uid('agent');
  const base = path.join(cfg.agentsDir, id);
  const home = path.join(base, 'home');
  const workspace = body.workspace ? String(body.workspace) : path.join(base, 'workspace');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });

  const agent = store.createAgent({
    id, name, area: body.area || null, instructions,
    model: body.model || null, home, workspace
  });

  if (body.initialMessage) {
    store.addMessage(id, 'user', String(body.initialMessage));
    store.enqueueTurn({ agentId: id, prompt: String(body.initialMessage), origin: 'user' });
  }
  return agent;
}

// ---------------------------------------------------------------- correo interno

function queueMail({ from, to, text, chainId, hop }) {
  const fromAgent = store.resolveAgent(from);
  const toAgent = store.resolveAgent(to);
  const body = String(text || '').trim();

  if (!body) return { status: 'blocked', reason: 'mensaje vacio' };
  if (!toAgent) {
    const nombres = store.listAgents().map((a) => a.name).join(', ');
    return { status: 'blocked', reason: `no existe el especialista "${to}". Disponibles: ${nombres || 'ninguno'}` };
  }
  if (fromAgent && toAgent.id === fromAgent.id) return { status: 'blocked', reason: 'no puedes enviarte mensajes a ti mismo' };

  const hopNum = Number(hop || 0);
  if (hopNum >= cfg.maxHops) {
    store.blockMail({
      fromAgent: fromAgent ? fromAgent.id : 'usuario', toAgent: toAgent.id, body,
      chainId: chainId || uid('chain'), hop: hopNum,
      reason: `limite de ${cfg.maxHops} saltos alcanzado en esta cadena`
    });
    return { status: 'blocked', reason: `se alcanzo el limite de ${cfg.maxHops} mensajes encadenados; cierra la tarea y responde al usuario` };
  }

  if (fromAgent) {
    const dup = store.recentMailFrom(fromAgent.id, toAgent.id, body, cfg.dedupeWindowMs);
    if (dup) return { status: 'blocked', reason: 'mensaje identico ya enviado hace instantes; no lo repitas' };
  }

  const id = store.queueMail({
    fromAgent: fromAgent ? fromAgent.id : 'usuario',
    toAgent: toAgent.id,
    body,
    chainId: chainId || uid('chain'),
    hop: hopNum
  });
  return { status: 'queued', mailbox_id: id, to_name: toAgent.name, to_id: toAgent.id };
}

// ---------------------------------------------------------------- rutas

async function api(req, res, url) {
  const p = url.pathname;
  const m = req.method;

  // --- salud: sin autenticacion, para el instalador y el systemd ---
  if (p === '/api/health') {
    return json(res, 200, {
      ok: true, version: '1.0.0', agents: store.listAgents().length,
      running: orq.busy, claude: !!cfg.claudeBin, port: cfg.port
    });
  }

  // --- endpoints internos del puente MCP ---
  if (p.startsWith('/api/internal/')) {
    if (!bridgeOk(req)) return json(res, 401, { error: 'token interno invalido' });

    if (p === '/api/internal/agents' && m === 'GET') {
      return json(res, 200, { agents: store.listAgents().map(agentPublic) });
    }

    let mm = p.match(/^\/api\/internal\/agents\/([^/]+)$/);
    if (mm && m === 'GET') {
      const a = store.getAgent(decodeURIComponent(mm[1]));
      return a ? json(res, 200, agentPublic(a)) : json(res, 404, { error: 'agente no encontrado' });
    }

    mm = p.match(/^\/api\/internal\/agents\/([^/]+)\/inbox$/);
    if (mm && m === 'GET') {
      const id = decodeURIComponent(mm[1]);
      const limit = Number(url.searchParams.get('limit') || 20);
      const messages = store.inboxFor(id, limit).map((x) => ({ ...x, from_name: nameOf(x.from_agent) }));
      return json(res, 200, { messages });
    }

    if (p === '/api/internal/mailbox' && m === 'POST') {
      const body = await readBody(req);
      return json(res, 200, queueMail(body));
    }

    if (p === '/api/internal/claims' && m === 'GET') {
      return json(res, 200, { claims: store.listClaims().map((c) => ({ ...c, agent_name: nameOf(c.agent_id) })) });
    }

    if (p === '/api/internal/claims' && m === 'POST') {
      const body = await readBody(req);
      const out = store.claim(body.paths || [], body.agentId, body.note);
      out.rejected = out.rejected.map((r) => ({ ...r, agent_name: nameOf(r.agent_id) }));
      return json(res, 200, out);
    }

    if (p === '/api/internal/claims/release' && m === 'POST') {
      const body = await readBody(req);
      return json(res, 200, { released: store.release(body.paths || [], body.agentId) });
    }

    return json(res, 404, { error: 'endpoint interno desconocido' });
  }

  // --- a partir de aqui, API de usuario ---
  if (!authOk(req, url)) return json(res, 401, { error: 'token invalido' });

  if (p === '/api/state' && m === 'GET') {
    return json(res, 200, {
      agents: store.listAgents().map(agentPublic),
      claims: store.listClaims().map((c) => ({ ...c, agent_name: nameOf(c.agent_id) })),
      running: orq.busy,
      pending: store.nextPendingTurns(100).length,
      project: cfg.project
    });
  }

  if (p === '/api/agents' && m === 'GET') {
    return json(res, 200, { agents: store.listAgents(url.searchParams.get('all') === '1').map(agentPublic) });
  }

  if (p === '/api/agents' && m === 'POST') {
    const body = await readBody(req);
    try { return json(res, 201, agentPublic(createAgent(body))); }
    catch (e) { return json(res, 400, { error: e.message }); }
  }

  let mm = p.match(/^\/api\/agents\/([^/]+)$/);
  if (mm) {
    const id = decodeURIComponent(mm[1]);
    const a = store.getAgent(id);
    if (!a) return json(res, 404, { error: 'agente no encontrado' });

    if (m === 'GET') return json(res, 200, agentPublic(a));

    if (m === 'PATCH') {
      const body = await readBody(req);
      if (body.name && body.name !== a.name && store.getAgentByName(body.name)) {
        return json(res, 400, { error: 'ya existe otro especialista con ese nombre' });
      }
      return json(res, 200, agentPublic(store.updateAgent(id, body)));
    }

    if (m === 'DELETE') {
      store.updateAgent(id, { archived: 1 });
      store.releaseAllFor(id);
      store.event('agent.archived', id, {});
      return json(res, 200, { ok: true });
    }
  }

  mm = p.match(/^\/api\/agents\/([^/]+)\/messages$/);
  if (mm) {
    const id = decodeURIComponent(mm[1]);
    const a = store.getAgent(id);
    if (!a) return json(res, 404, { error: 'agente no encontrado' });

    if (m === 'GET') {
      const msgs = store.listMessages(id).map((x) => ({
        ...x,
        meta: x.meta ? JSON.parse(x.meta) : null
      }));
      return json(res, 200, { messages: msgs, status: a.status });
    }

    if (m === 'POST') {
      const body = await readBody(req);
      const text = String(body.text || '').trim();
      if (!text) return json(res, 400, { error: 'mensaje vacio' });
      store.addMessage(id, 'user', text);
      const turnId = store.enqueueTurn({ agentId: id, prompt: text, origin: 'user', chainId: uid('chain'), hop: 0 });
      return json(res, 202, { ok: true, turn_id: turnId });
    }
  }

  mm = p.match(/^\/api\/agents\/([^/]+)\/reset$/);
  if (mm && m === 'POST') {
    const id = decodeURIComponent(mm[1]);
    store.updateAgent(id, { session_id: null });
    store.event('session.reset', id, { motivo: 'peticion del usuario' });
    return json(res, 200, { ok: true });
  }

  if (p === '/api/mailbox' && m === 'GET') {
    const rows = store.listMailbox(Number(url.searchParams.get('limit') || 100)).map((x) => ({
      ...x, from_name: nameOf(x.from_agent), to_name: nameOf(x.to_agent)
    }));
    return json(res, 200, { mailbox: rows });
  }

  if (p === '/api/turns' && m === 'GET') {
    return json(res, 200, {
      turns: store.listTurns(Number(url.searchParams.get('limit') || 50))
        .map((t) => ({ ...t, agent_name: nameOf(t.agent_id) }))
    });
  }

  if (p === '/api/events' && m === 'GET') {
    const since = Number(url.searchParams.get('since') || 0);
    return json(res, 200, {
      events: store.listEvents(since, 100).map((e) => ({ ...e, agent_name: nameOf(e.agent_id), data: e.data ? JSON.parse(e.data) : null }))
    });
  }

  if (p === '/api/claims' && m === 'GET') {
    return json(res, 200, { claims: store.listClaims().map((c) => ({ ...c, agent_name: nameOf(c.agent_id) })) });
  }

  if (p === '/api/claims/release' && m === 'POST') {
    const body = await readBody(req);
    const agent = store.resolveAgent(body.agentId);
    if (!agent) return json(res, 404, { error: 'agente no encontrado' });
    return json(res, 200, { released: store.release(body.paths || [], agent.id) });
  }

  return json(res, 404, { error: 'ruta no encontrada' });
}

function serveStatic(req, res, url) {
  let rel = url.pathname === '/' ? '/index.html' : url.pathname;
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('prohibido'); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('no encontrado'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(data);
  });
}

function handler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname.startsWith('/api/')) {
    api(req, res, url).catch((err) => json(res, 500, { error: err.message }));
    return;
  }
  serveStatic(req, res, url);
}

const server = http.createServer(handler);

const hosts = cfg.bindHosts.length ? cfg.bindHosts : ['127.0.0.1'];
const servers = [];

/**
 * En este host ip_local_port_range abarca todo el espacio de puertos, asi que una
 * conexion saliente puede ocupar temporalmente el nuestro. Reintentamos antes de rendirnos.
 */
function listenWithRetry(host, intento = 1) {
  const s = host === hosts[0] ? server : http.createServer(handler);
  servers.push(s);

  s.once('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      servers.pop();
      const otroVivo = servers.some((x) => x.listening);
      // Si ya servimos por otra interfaz, seguimos reintentando esta en segundo plano:
      // el ocupante puede soltar el puerto en cualquier momento.
      if (!otroVivo && intento > 30) {
        console.error(`[v4] ${host}:${cfg.port} sigue ocupado tras ${intento} intentos y no hay ninguna otra interfaz sirviendo`);
        return process.exit(1);
      }
      const espera = Math.min(1000 * intento, 60000);
      if (intento <= 5 || intento % 10 === 0) {
        console.warn(`[v4] ${host}:${cfg.port} ocupado (intento ${intento}), reintento en ${Math.round(espera / 1000)}s`);
      }
      setTimeout(() => listenWithRetry(host, intento + 1), espera).unref();
      return;
    }
    console.error(`[v4] no se pudo escuchar en ${host}:${cfg.port}: ${err.message}`);
    if (!servers.some((x) => x.listening)) process.exit(1);
  });

  s.listen(cfg.port, host, () => {
    console.log(`[v4] escuchando en http://${host}:${cfg.port}`);
    // El puente MCP de los agentes necesita una URL que de verdad este escuchando.
    if (!cfg.apiUrl) {
      const h = (host === '0.0.0.0' || host === '::') ? '127.0.0.1' : host;
      cfg.apiUrl = `http://${h}:${cfg.port}`;
      console.log(`[v4] API para los agentes: ${cfg.apiUrl}`);
    }
  });
}

for (const host of hosts) listenWithRetry(host);

console.log(`[v4] datos: ${cfg.dataDir}`);
console.log(`[v4] sesion compartida: ${cfg.sessionDir}`);
console.log(`[v4] claude: ${cfg.claudeBin || 'NO ENCONTRADO'}`);

orq.start();

function shutdown(sig) {
  console.log(`[v4] ${sig}: cerrando`);
  orq.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
