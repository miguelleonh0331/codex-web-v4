'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');

const { load } = require('./config');
const { Store, uid } = require('./db');
const { Orchestrator } = require('./orchestrator');
const sesion = require('./session');
const auth = require('./auth');

const cfg = load();
const store = new Store(cfg.dbPath);
const orq = new Orchestrator(cfg, store);

const PUBLIC_DIR = path.join(cfg.appDir, 'public');
// Valores que admite el CLI de Claude Code: un valor invalido tumbaria el turno entero.
const ESFUERZOS = ['low', 'medium', 'high', 'xhigh', 'max'];
const MODELOS_SUGERIDOS = ['haiku', 'sonnet', 'opus', 'opusplan', 'fable'];
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

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
    effort: a.effort || null,
    avatar_seed: a.avatar_seed || a.id,
    avatar_color: a.avatar_color || null,
    created_at: a.created_at, updated_at: a.updated_at,
    has_session: !!a.session_id
  };
}

function nameOf(id) {
  const a = store.getAgent(id);
  return a ? a.name : (id || 'desconocido');
}

function authOk(req, url) {
  if (!cfg.requireAuth) return true;
  const header = req.headers['x-v4-token'];
  const query = url.searchParams.get('token');
  const cookie = (req.headers.cookie || '').split(';').map((s) => s.trim()).find((s) => s.startsWith('v4token='));
  const cookieVal = cookie ? decodeURIComponent(cookie.slice('v4token='.length)) : null;
  return [header, query, cookieVal].includes(cfg.authToken);
}

function bridgeOk(req) {
  return req.headers['x-v4-bridge-token'] === cfg.bridgeToken;
}

// ---------------------------------------------------------------- adjuntos

/**
 * Se admite cualquier tipo de archivo, pero NUNCA el nombre tal cual viene del
 * navegador: se le quita la ruta y se dejan solo caracteres inofensivos, para
 * que un nombre como "../../etc/passwd" no pueda escribir fuera del workspace.
 */
function nombreSeguro(bruto) {
  const base = path.basename(String(bruto || 'archivo')).replace(/[\x00-\x1f]/g, '');
  const limpio = base.replace(/[^\w.\- ]+/g, '_').replace(/^\.+/, '').trim();
  return (limpio || 'archivo').slice(0, 120);
}

function leerBinario(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const trozos = [];
    let total = 0;
    req.on('data', (c) => {
      total += c.length;
      if (total > maxBytes) { reject(new Error(`el archivo supera ${Math.round(maxBytes / 1048576)} MB`)); req.destroy(); return; }
      trozos.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(trozos)));
    req.on('error', reject);
  });
}

function dirAdjuntos(agent) {
  const dir = path.join(agent.workspace, 'adjuntos');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
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

  if (body.effort && !ESFUERZOS.includes(body.effort)) {
    throw new Error(`Esfuerzo invalido "${body.effort}". Admitidos: ${ESFUERZOS.join(', ')}.`);
  }

  const agent = store.createAgent({
    id, name, area: body.area || null, instructions,
    model: body.model || null, effort: body.effort || null, home, workspace,
    avatarSeed: body.avatarSeed || id
  });
  if (body.avatarColor) store.updateAgent(agent.id, { avatar_color: String(body.avatarColor) });

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

/**
 * Difusion: la misma pregunta a todo el equipo.
 * Solo se admite en el salto 0 (peticion directa del usuario o primer movimiento de
 * un especialista). Asi una difusion no puede provocar otra en cascada.
 */
function broadcast({ from, text, chainId, hop, dryRun }) {
  const cuerpo = String(text || '').trim();
  if (!cuerpo) return { status: 'blocked', reason: 'mensaje vacio' };

  const emisor = from ? store.resolveAgent(from) : null;
  if (from && !emisor) return { status: 'blocked', reason: `no existe el emisor "${from}"` };

  if (Number(hop || 0) > 0) {
    return {
      status: 'blocked',
      reason: 'ask_team solo puede usarse al atender una peticion directa, nunca dentro de una conversacion entre agentes'
    };
  }

  const destinos = store.listAgents().filter((a) => !emisor || a.id !== emisor.id);
  if (!destinos.length) return { status: 'blocked', reason: 'no hay otros especialistas a quienes preguntar' };

  const cadena = chainId || uid('chain');

  // Ensayo: sirve al autodiagnostico para comprobar el camino sin despertar a nadie.
  if (dryRun) {
    return { status: 'dry-run', chain_id: cadena, total: destinos.length,
             enviados: destinos.map((d) => ({ to_id: d.id, to_name: d.name })) };
  }

  const enviados = [];
  for (const d of destinos) {
    const id = store.queueMail({
      fromAgent: emisor ? emisor.id : 'usuario',
      toAgent: d.id,
      body: cuerpo,
      chainId: cadena,
      hop: Number(hop || 0)
    });
    enviados.push({ mailbox_id: id, to_id: d.id, to_name: d.name });
  }
  store.event('broadcast', emisor ? emisor.id : null, { chain_id: cadena, destinos: enviados.length });
  return { status: 'queued', chain_id: cadena, enviados, total: enviados.length };
}

// ---------------------------------------------------------------- rutas

async function api(req, res, url) {
  const p = url.pathname;
  const m = req.method;

  // --- salud: sin autenticacion, para el instalador y el systemd ---
  if (p === '/api/health') {
    return json(res, 200, {
      ok: true, version: '1.0.0', agents: store.listAgents().length,
      running: orq.busy, claude: !!cfg.claudeBin, port: cfg.port,
      auth: !!cfg.requireAuth,
      session: (() => { const e = sesion.estado(sesion.archivoSesion(cfg)); return { valida: e.vigente, expira: e.expiraIso }; })()
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

    if (p === '/api/internal/agents' && m === 'POST') {
      const body = await readBody(req);

      if (Number(body.hop || 0) > 0) {
        return json(res, 200, {
          status: 'blocked',
          reason: 'solo se puede crear un especialista al atender una peticion directa, no dentro de una conversacion entre agentes'
        });
      }
      const total = store.listAgents().length;
      if (total >= cfg.maxAgents) {
        return json(res, 200, { status: 'blocked', reason: `ya hay ${total} especialistas y el tope configurado es ${cfg.maxAgents}` });
      }
      try {
        const nuevo = createAgent({ ...body, avatarSeed: body.avatarSeed || null });
        store.event('agent.created.by-agent', nuevo.id, { por: body.createdBy || null, nombre: nuevo.name });
        return json(res, 200, { status: 'created', id: nuevo.id, name: nuevo.name });
      } catch (e) {
        return json(res, 200, { status: 'blocked', reason: e.message });
      }
    }

    if (p === '/api/internal/broadcast' && m === 'POST') {
      const body = await readBody(req);
      return json(res, 200, broadcast(body));
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
      project: cfg.project,
      opciones: { modelos: MODELOS_SUGERIDOS, esfuerzos: ESFUERZOS, modeloPorDefecto: cfg.model, esfuerzoPorDefecto: cfg.effort }
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
      if (body.avatarSeed) body.avatar_seed = body.avatarSeed;
      if (body.avatarColor !== undefined) {
        const c = String(body.avatarColor || '').trim();
        if (c && !/^#[0-9a-f]{6}$/i.test(c)) return json(res, 400, { error: 'color invalido: usa formato #rrggbb' });
        body.avatar_color = c || null;
      }
      if (body.effort !== undefined && body.effort !== null && body.effort !== '' && !ESFUERZOS.includes(body.effort)) {
        return json(res, 400, { error: `Esfuerzo invalido "${body.effort}". Admitidos: ${ESFUERZOS.join(', ')}.` });
      }
      if (body.effort === '') body.effort = null;
      if (body.model === '') body.model = null;
      return json(res, 200, agentPublic(store.updateAgent(id, body)));
    }

    if (m === 'DELETE') {
      store.updateAgent(id, { archived: 1 });
      store.releaseAllFor(id);
      store.event('agent.archived', id, {});
      return json(res, 200, { ok: true });
    }
  }

  mm = p.match(/^\/api\/agents\/([^/]+)\/attachments$/);
  if (mm && m === 'POST') {
    const a = store.getAgent(decodeURIComponent(mm[1]));
    if (!a) return json(res, 404, { error: 'agente no encontrado' });

    const nombre = nombreSeguro(decodeURIComponent(req.headers['x-v4-filename'] || 'archivo'));
    let datos;
    try {
      datos = await leerBinario(req, (cfg.maxUploadMb || 50) * 1048576);
    } catch (e) {
      return json(res, 413, { error: e.message });
    }
    if (!datos.length) return json(res, 400, { error: 'archivo vacio' });

    const dir = dirAdjuntos(a);
    const sello = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    let final = `${sello}-${nombre}`;
    let n = 1;
    while (fs.existsSync(path.join(dir, final))) final = `${sello}-${n++}-${nombre}`;

    const destino = path.join(dir, final);
    fs.writeFileSync(destino, datos, { mode: 0o640 });
    store.event('adjunto', a.id, { archivo: final, bytes: datos.length });

    return json(res, 201, {
      nombre: final, ruta: destino, bytes: datos.length,
      url: `/api/agents/${a.id}/attachments/${encodeURIComponent(final)}`
    });
  }

  mm = p.match(/^\/api\/agents\/([^/]+)\/attachments\/(.+)$/);
  if (mm && m === 'GET') {
    const a = store.getAgent(decodeURIComponent(mm[1]));
    if (!a) return json(res, 404, { error: 'agente no encontrado' });
    const dir = dirAdjuntos(a);
    const archivo = path.join(dir, nombreSeguro(decodeURIComponent(mm[2])));
    if (!archivo.startsWith(dir) || !fs.existsSync(archivo)) return json(res, 404, { error: 'archivo no encontrado' });

    const ext = path.extname(archivo).toLowerCase();
    const tipo = MIME[ext] || (/(jpg|jpeg)/.test(ext) ? 'image/jpeg' : /webp/.test(ext) ? 'image/webp' : /gif/.test(ext) ? 'image/gif' : 'application/octet-stream');
    res.writeHead(200, { 'content-type': tipo, 'cache-control': 'private, max-age=3600' });
    return fs.createReadStream(archivo).pipe(res);
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
      const adjuntos = Array.isArray(body.attachments) ? body.attachments.slice(0, 20) : [];
      if (!text && !adjuntos.length) return json(res, 400, { error: 'mensaje vacio' });

      store.addMessage(id, 'user', text || '(archivos adjuntos)', adjuntos.length ? { attachments: adjuntos } : null);

      // Al agente se le pasa la RUTA real: asi abre el archivo con su propia
      // herramienta de lectura en vez de recibir una copia en el texto.
      const prompt = adjuntos.length
        ? `${text || 'Revisa los archivos adjuntos.'}\n\nArchivos adjuntos (abrelos con tu herramienta de lectura):\n` +
          adjuntos.map((f) => `- ${f.ruta}`).join('\n')
        : text;

      const turnId = store.enqueueTurn({ agentId: id, prompt, origin: 'user', chainId: uid('chain'), hop: 0 });
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

  // --- proveedores de modelo ---
  if (p === '/api/providers' && m === 'GET') {
    const VENTANAS = { five_hour: 300, seven_day: 10080, seven_day_opus: 10080, seven_day_sonnet: 10080, seven_day_overage_included: 10080 };
    const ahora = Math.floor(Date.now() / 1000);
    const limites = store.listarLimites().map((l) => ({
      tipo: l.tipo,
      etiqueta: l.tipo === 'five_hour' ? '5 horas' : l.tipo.startsWith('seven_day') ? '7 dias' : l.tipo,
      ventana_min: VENTANAS[l.tipo] || null,
      usado_pct: l.utilizacion === null ? null : Math.round(l.utilizacion * 100),
      reinicia_en: l.reinicia_en,
      faltan_seg: l.reinicia_en ? Math.max(0, l.reinicia_en - ahora) : null,
      estado: l.estado,
      sobreuso: !!l.sobreuso,
      visto_en: l.visto_en
    }));
    return json(res, 200, { proveedores: [{ ...(await auth.estado(cfg)), limites }] });
  }

  if (p === '/api/providers/claude/login' && m === 'POST') {
    const body = await readBody(req);
    try {
      return json(res, 200, await auth.iniciarLogin(cfg, { consola: !!body.consola }));
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
  }

  if (p === '/api/providers/claude/code' && m === 'POST') {
    const body = await readBody(req);
    const out = await auth.enviarCodigo(cfg, body.codigo);
    store.event(out.ok ? 'proveedor.conectado' : 'proveedor.fallo', null, { cuenta: out.cuenta || null, error: out.error || null });
    return json(res, out.ok ? 200 : 400, out);
  }

  if (p === '/api/providers/claude/cancel' && m === 'POST') {
    auth.cancelar('cancelado por el usuario');
    return json(res, 200, { ok: true });
  }

  if (p === '/api/providers/claude/logout' && m === 'POST') {
    const out = await auth.cerrarSesion(cfg);
    store.event('proveedor.desconectado', null, out);
    return json(res, out.ok ? 200 : 400, out);
  }

  if (p === '/api/broadcast' && m === 'POST') {
    const body = await readBody(req);
    const text = String(body.text || '').trim();
    if (!text) return json(res, 400, { error: 'mensaje vacio' });

    // Difusion del usuario: entra en la conversacion de cada especialista como
    // una peticion suya, para que cada uno responda en su propio hilo.
    const cadena = uid('chain');
    const destinos = store.listAgents();
    if (!destinos.length) return json(res, 400, { error: 'no hay especialistas' });

    const prompt = [
      '[PREGUNTA A TODO EL EQUIPO]',
      '',
      text,
      '',
      'Responde solo desde tu area y se breve. Si no te afecta, dilo en una linea.',
      'No reenvies esta pregunta a nadie: ya la han recibido todos. Al terminar, detente.'
    ].join('\n');

    for (const d of destinos) {
      store.addMessage(d.id, 'user', `[a todo el equipo] ${text}`);
      store.enqueueTurn({ agentId: d.id, prompt, origin: 'broadcast', chainId: cadena, hop: 0 });
    }
    store.event('broadcast', null, { chain_id: cadena, destinos: destinos.length, de: 'usuario' });
    return json(res, 202, { ok: true, chain_id: cadena, total: destinos.length });
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

// Huella de los recursos: fuerza al navegador a descargar la version nueva
// aunque tenga la anterior cacheada.
function assetVersion() {
  try {
    const partes = ['app.js', 'style.css', 'faces.js']
      .map((f) => fs.statSync(path.join(PUBLIC_DIR, f)).mtimeMs);
    return String(Math.round(partes.reduce((a, b) => a + b, 0)));
  } catch { return '1'; }
}

function renderIndex() {
  let html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
  const v = assetVersion();
  for (const recurso of ['/app.js', '/style.css', '/faces.js']) {
    html = html.replace(`"${recurso}"`, `"${recurso}?v=${v}"`);
  }

  if (!cfg.requireAuth) {
    // Sin token no hay pantalla de acceso: se elimina del documento servido.
    html = html.replace(/<div id="login"[\s\S]*?<\/div>\s*(?=<div id="app")/, '');
    html = html.replace('<div id="app" hidden>', '<div id="app">');
  }
  return html;
}

function serveStatic(req, res, url) {
  if (url.pathname === '/' || url.pathname === '/index.html') {
    const html = renderIndex();
    res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-store, must-revalidate' });
    return res.end(html);
  }

  let rel = url.pathname;
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('prohibido'); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('no encontrado'); }
    const ext = path.extname(file);
    const cabeceras = {
      'content-type': MIME[ext] || 'application/octet-stream',
      // Los iconos si pueden cachearse; el resto manda siempre la red.
      'cache-control': ext === '.png' ? 'public, max-age=86400' : 'no-store'
    };
    // Permite que el service worker controle toda la aplicacion.
    if (path.basename(file) === 'sw.js') cabeceras['service-worker-allowed'] = '/';
    res.writeHead(200, cabeceras);
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
