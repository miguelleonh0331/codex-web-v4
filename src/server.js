'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');

const { load, guardar } = require('./config');
const { Store, uid } = require('./db');
const { Orchestrator } = require('./orchestrator');
const sesion = require('./session');
const auth = require('./auth');
const authCodex = require('./auth-codex');
const push = require('./push');
const proveedores = require('./proveedores');
const guardia = require('./guardia');
const vault = require('./vault');
const crypto = require('node:crypto');

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
    contexto: a.ctx_ventana ? {
      usado: a.ctx_usado || 0,
      ventana: a.ctx_ventana,
      pct: Math.min(100, Math.round(((a.ctx_usado || 0) / a.ctx_ventana) * 100)),
      modelo: a.ctx_modelo || null,
      visto: a.ctx_visto || null
    } : null,
    created_at: a.created_at, updated_at: a.updated_at,
    has_session: !!a.session_id,
    tiene_notas: !!(a.notas && a.notas.trim()),
    proveedor: a.proveedor || cfg.proveedor || 'claude',
    recepcion: !!a.recepcion
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

// -------------------------------------------------------------- direccion

/**
 * Averigua por que direccion HTTPS se llega a esta instalacion.
 *
 * Importa porque el navegador solo instala la aplicacion y entrega
 * notificaciones desde un origen seguro. La IP siempre esta a mano y
 * siempre falla para eso, asi que el sistema tiene que saber decir su
 * propia direccion buena en vez de que haya que deducirla.
 *
 * Se consulta a Tailscale, que es quien emite el certificado. Si no esta,
 * se devuelve null y la interfaz lo dice en vez de inventarse una URL.
 */
let cacheAcceso = { valor: null, cuando: 0 };

function urlSegura() {
  // Se cachea un minuto: esto se consulta en cada /api/state.
  if (Date.now() - cacheAcceso.cuando < 60000) return cacheAcceso.valor;
  cacheAcceso = { valor: null, cuando: Date.now() };
  try {
    const { execFileSync } = require('node:child_process');
    const crudo = execFileSync('tailscale', ['serve', 'status', '--json'],
      { timeout: 3000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const d = JSON.parse(crudo);
    const mio = `http://127.0.0.1:${cfg.port}`;
    for (const [hostPuerto, conf] of Object.entries(d.Web || {})) {
      for (const h of Object.values(conf.Handlers || {})) {
        if (h.Proxy === mio || h.Proxy === `http://localhost:${cfg.port}`) {
          cacheAcceso.valor = `https://${hostPuerto}/`;
          return cacheAcceso.valor;
        }
      }
    }
  } catch { /* sin tailscale, o sin serve configurado */ }
  return null;
}

// ------------------------------------------------------------ notificaciones

const clavesPush = push.cargarClaves(cfg.dataDir);

/**
 * Avisa a los dispositivos suscritos.
 *
 * Las suscripciones caducadas se borran en el momento: el navegador las
 * invalida al desinstalar la aplicacion o al revocar el permiso, y
 * reintentarlas solo gasta tiempo en cada aviso posterior.
 */
async function avisar(carga) {
  const subs = store.suscripciones();
  if (!subs.length) return { enviados: 0 };
  let enviados = 0;
  for (const sub of subs) {
    const r = await push.enviarUno(sub, carga, clavesPush, `mailto:v4@${cfg.nombre || 'local'}`);
    if (r.ok) enviados += 1;
    else if (r.caducada) store.borrarSuscripcion(sub.endpoint);
  }
  return { enviados, total: subs.length };
}

// Un unico sitio donde se decide que merece molestar al usuario.
orq.alAvisar = async (tipo, agent, extra = {}) => {
  const sinRevisar = store.listAgents().filter((a) => a.status === 'idle').length;
  if (tipo === 'turn.done') {
    await avisar({
      titulo: extra.retomado ? `${agent.name} retomo y termino` : `${agent.name} termino`,
      cuerpo: (extra.texto || '').slice(0, 160) || 'Tiene una respuesta lista para revisar.',
      agente: agent.id, insignia: extra.sinRevisar ?? sinRevisar, etiqueta: `agente-${agent.id}`
    });
  } else if (tipo === 'guardia') {
    const n = (extra.cambios || []).length;
    await avisar({
      titulo: `${agent.name} toco ${n} ${n === 1 ? 'archivo protegido' : 'archivos protegidos'}`,
      cuerpo: (extra.cambios || []).slice(0, 3).map((c) => `${c.cambio}: ${c.ruta}`).join(' · '),
      agente: agent.id, insignia: sinRevisar, etiqueta: 'guardia', urgente: true
    });
  } else if (tipo === 'turn.error') {
    await avisar({
      titulo: `${agent.name} fallo`,
      cuerpo: (extra.error || 'Error en el turno').slice(0, 160),
      agente: agent.id, insignia: extra.sinRevisar ?? sinRevisar,
      etiqueta: `agente-${agent.id}`, urgente: true
    });
  }
};

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
  if (body.proveedor) store.updateAgent(agent.id, { proveedor: String(body.proveedor) });
  // Se relee: la respuesta se construia con el objeto anterior y decia
  // "claude" en un agente que acababa de quedar asignado a Codex.
  Object.assign(agent, store.getAgent(agent.id));

  if (body.initialMessage) {
    store.addMessage(id, 'user', String(body.initialMessage));
    store.enqueueTurn({ agentId: id, prompt: String(body.initialMessage), origin: 'user' });
  }
  return agent;
}

/**
 * Menciones del tipo "@Consultas" en un mensaje del usuario.
 * Se comparan contra los nombres reales, de mas largo a mas corto, para que
 * "Base de Datos" gane sobre cualquier trozo suyo. Lo que no case con un
 * especialista se ignora: puede ser un correo o una ruta.
 */
function mencionados(texto, exceptoId) {
  const t = String(texto || '');
  const nombres = store.listAgents()
    .filter((a) => a.id !== exceptoId)
    .sort((a, b) => b.name.length - a.name.length);
  const vistos = [];
  for (const a of nombres) {
    const escapado = a.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`@${escapado}\\b`, 'i').test(t) && !vistos.some((v) => v.id === a.id)) {
      vistos.push(a);
    }
  }
  return vistos;
}

// ---------------------------------------------------------------- correo interno

function queueMail({ from, to, text, chainId, hop }) {
  const fromAgent = store.resolveAgent(from);
  const toAgent = store.resolveAgent(to);
  const body = String(text || '').trim();

  if (!body) return { status: 'blocked', reason: 'mensaje vacio' };

  // El destinatario puede estar FUERA de este servidor. No se le encola un
  // turno —no se ejecuta aqui— sino que se le deja el mensaje para cuando
  // pase a recogerlo. Asi funciona aunque su maquina este apagada.
  if (!toAgent) {
    const ext = store.externoPorNombre(String(to || '').trim());
    if (ext && ext.activo) {
      store.encolarParaExterno(ext.id, fromAgent ? fromAgent.id : null, body);
      store.event('externo.respuesta', fromAgent ? fromAgent.id : null, { para: ext.nombre });
      return { status: 'encolado_fuera', reason: `${ext.nombre} lo recogera cuando se conecte` };
    }
  }
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
  if (p === '/api/push/clave') {
    return json(res, 200, { clave: clavesPush.publica });
  }

  if (p === '/api/push/suscribir' && req.method === 'POST') {
    const b = await readBody(req);
    const endpoint = String(b.endpoint || '');
    const p256dh = b.keys && b.keys.p256dh;
    const authK = b.keys && b.keys.auth;
    if (!/^https:\/\//.test(endpoint) || !p256dh || !authK) {
      return json(res, 400, { error: 'suscripcion incompleta' });
    }
    store.guardarSuscripcion({ endpoint, p256dh, auth: authK });
    return json(res, 201, { ok: true, suscripciones: store.suscripciones().length });
  }

  if (p === '/api/push/baja' && req.method === 'POST') {
    const b = await readBody(req);
    if (b.endpoint) store.borrarSuscripcion(String(b.endpoint));
    return json(res, 200, { ok: true, suscripciones: store.suscripciones().length });
  }

  if (p === '/api/push/probar' && req.method === 'POST') {
    const r = await avisar({
      titulo: cfg.nombre || 'codex-web-v4',
      cuerpo: 'Aviso de prueba: las notificaciones funcionan.',
      etiqueta: 'prueba'
    });
    return json(res, 200, r);
  }

  if (p === '/api/health') {
    return json(res, 200, {
      ok: true, version: '1.0.0', agents: store.listAgents().length,
      running: orq.busy, claude: !!cfg.claudeBin, port: cfg.port,
      auth: !!cfg.requireAuth,
      ui: assetVersion(),
      session: (() => {
        const e = sesion.estado(sesion.archivoSesion(cfg));
        // valida = podra trabajar. Un token caducado pero renovable lo es:
        // el CLI lo renueva solo en el siguiente turno.
        return { valida: e.utilizable, vigente: e.vigente, renovable: e.renovable, expira: e.expiraIso };
      })()
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

    // Un especialista buscando en su propia conversacion. El id va en la ruta
    // y se usa tal cual: no puede pedir el historial de otro.
    mm = p.match(/^\/api\/internal\/agents\/([^/]+)\/historial$/);
    if (mm && m === 'GET') {
      const id = decodeURIComponent(mm[1]);
      if (!store.getAgent(id)) return json(res, 404, { error: 'agente no encontrado' });
      const q = url.searchParams.get('q') || '';
      const limite = Math.min(20, Math.max(1, Number(url.searchParams.get('limite') || 8)));
      return json(res, 200, { resultados: store.buscarEnHistorial(id, q, { limite }) });
    }

    // Vault compartido: lo que el equipo sabe, en Markdown enlazado.
    if (p === '/api/internal/vault/listar' && m === 'GET') {
      return json(res, 200, { notas: vault.listar(cfg) });
    }

    if (p === '/api/internal/vault/leer' && m === 'GET') {
      const n = vault.leer(cfg, url.searchParams.get('titulo'), url.searchParams.get('carpeta'));
      if (!n) return json(res, 404, { error: 'no existe esa nota' });
      return json(res, 200, { ...n, retroenlaces: vault.retroenlaces(cfg, n.titulo) });
    }

    if (p === '/api/internal/vault/buscar' && m === 'GET') {
      return json(res, 200, {
        resultados: vault.buscar(cfg, url.searchParams.get('q'),
          Math.min(20, Number(url.searchParams.get('limite') || 10)))
      });
    }

    if (p === '/api/internal/vault/escribir' && m === 'POST') {
      const b = await readBody(req);
      try {
        const out = vault.escribir(cfg, {
          titulo: b.titulo, texto: b.texto, carpeta: b.carpeta, autor: nameOf(b.agentId)
        });
        store.event('vault.escrito', b.agentId || null, { titulo: out.titulo, carpeta: out.carpeta });
        return json(res, 200, out);
      } catch (e) {
        return json(res, 400, { error: e.message });
      }
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

  // --- llevarse el equipo a otro servidor ---
  if (p === '/api/export' && m === 'GET') {
    return json(res, 200, {
      version: 1,
      exportado_en: new Date().toISOString(),
      instalacion: cfg.nombre || 'codex-web-v4',
      // Se guarda la ruta de origen para poder avisar si en destino es otra.
      proyecto: { nombre: cfg.project.name || null, ruta: cfg.project.path || null },
      especialistas: store.listAgents().map((a) => ({
        name: a.name,
        area: a.area,
        instructions: a.instructions,
        model: a.model,
        effort: a.effort,
        avatarSeed: a.avatar_seed || null,
        avatarColor: a.avatar_color || null
      }))
    });
  }

  if (p === '/api/import' && m === 'POST') {
    const body = await readBody(req);
    const lista = Array.isArray(body.especialistas) ? body.especialistas : null;
    if (!lista) return json(res, 400, { error: 'el archivo no contiene una lista de especialistas' });

    const modo = body.modo === 'actualizar' ? 'actualizar' : 'saltar';
    const ensayo = body.dryRun !== false && body.dryRun !== undefined ? !!body.dryRun : false;

    const nuevos = [], existentes = [], invalidos = [];
    for (const e of lista) {
      const nombre = String(e && e.name || '').trim();
      if (!nombre || !String(e.instructions || '').trim()) { invalidos.push(nombre || '(sin nombre)'); continue; }
      (store.getAgentByName(nombre) ? existentes : nuevos).push(e);
    }

    // Por defecto solo se informa: tocar el equipo sin que lo confirmes seria
    // una sorpresa desagradable.
    if (ensayo) {
      return json(res, 200, {
        ensayo: true, modo,
        nuevos: nuevos.map((x) => x.name),
        existentes: existentes.map((x) => x.name),
        invalidos,
        proyecto_origen: body.proyecto || null,
        proyecto_actual: { nombre: cfg.project.name || null, ruta: cfg.project.path || null }
      });
    }

    const creados = [], actualizados = [], saltados = [];
    for (const e of nuevos) {
      try { creados.push(createAgent(e).name); } catch (err) { invalidos.push(`${e.name}: ${err.message}`); }
    }
    for (const e of existentes) {
      if (modo !== 'actualizar') { saltados.push(e.name); continue; }
      const actual = store.getAgentByName(e.name);
      store.updateAgent(actual.id, {
        area: e.area || null, instructions: e.instructions,
        model: e.model || null, effort: e.effort || null,
        avatar_seed: e.avatarSeed || actual.avatar_seed,
        avatar_color: e.avatarColor || null
      });
      actualizados.push(e.name);
    }
    store.event('equipo.importado', null, { creados: creados.length, actualizados: actualizados.length, saltados: saltados.length });
    return json(res, 200, { ok: true, creados, actualizados, saltados, invalidos });
  }

  if (p === '/api/app' && m === 'PATCH') {
    const body = await readBody(req);
    const cambios = {};

    if (body.nombre !== undefined) {
      const nombre = String(body.nombre || '').trim();
      if (!nombre) return json(res, 400, { error: 'el nombre no puede estar vacio' });
      if (nombre.length > 60) return json(res, 400, { error: 'el nombre no puede pasar de 60 caracteres' });
      cambios.nombre = nombre;
    }

    if (body.topeGastoDiario !== undefined) {
      const t = Number(body.topeGastoDiario);
      if (!Number.isFinite(t) || t < 0) return json(res, 400, { error: 'el tope debe ser un numero de 0 en adelante' });
      // Se avisa si ya se paso: guardarlo sin decirlo dejaria el equipo
      // parado sin explicacion.
      cambios.topeGastoDiario = t;
    }

    if (!Object.keys(cambios).length) return json(res, 400, { error: 'nada que cambiar' });

    try {
      guardar(cambios);
      Object.assign(cfg, cambios);   // surte efecto sin reiniciar el servicio
      store.event('app.ajustada', null, cambios);
      const gasto = store.gastoDelDia(cfg.zonaHoraria);
      return json(res, 200, {
        ok: true,
        ...cambios,
        gasto: gasto.total,
        frenaYa: cambios.topeGastoDiario > 0 && gasto.total >= cambios.topeGastoDiario
      });
    } catch (e) {
      return json(res, 500, { error: `no se pudo guardar: ${e.message}` });
    }
  }

  if (p === '/api/state' && m === 'GET') {
    const ultimos = new Map(store.ultimosMensajes().map((u) => [u.agent_id, u]));
    return json(res, 200, {
      agents: store.listAgents().map((a) => {
        const u = ultimos.get(a.id);
        return {
          ...agentPublic(a),
          // El resumen va recortado: lo usa la voz para anunciar el final, y
          // no tiene sentido enviar la respuesta entera en cada sondeo.
          ultimo_mensaje: u
            ? { id: u.id, rol: u.role, en: u.created_at, resumen: String(u.body || '').slice(0, 220) }
            : null
        };
      }),
      claims: store.listClaims().map((c) => ({ ...c, agent_name: nameOf(c.agent_id) })),
      running: orq.busy,
      pending: store.nextPendingTurns(100).length,
      project: cfg.project,
      proveedores: proveedores.disponibles(cfg),
      app: {
        nombre: cfg.nombre || 'codex-web-v4',
        acceso: urlSegura(),
        // El reinicio de cuota llega en hora de Lima: el reloj se muestra en
        // la misma zona o habria que hacer la cuenta mentalmente.
        zona: cfg.zonaHoraria || 'America/Lima',
        ahora: new Date().toISOString()
      },
      gasto: (() => {
        const g = store.gastoDelDia(cfg.zonaHoraria);
        const tope = Number(cfg.topeGastoDiario) || 0;
        return { ...g, tope, frenado: tope > 0 && g.total >= tope };
      })(),
      guardia: store.incidentes(10).filter((i) => !i.visto)
        .map((i) => ({ id: i.id, nombre: nameOf(i.agent_id), n: i.cambios.length, cuando: i.created_at })),
      esperando: store.turnosEnEspera().map((t) => ({
        agente: t.agent_id,
        nombre: nameOf(t.agent_id),
        proximo: t.proximo_intento,
        reintentos: t.reintentos || 0,
        desde: t.espera_desde
      })),
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
      if (body.effort !== undefined && body.effort !== null && body.effort !== '' && !ESFUERZOS.includes(body.effort)) {
        return json(res, 400, { error: `Esfuerzo invalido "${body.effort}". Admitidos: ${ESFUERZOS.join(', ')}.` });
      }

      // Se arma un objeto explicito en vez de pasar el cuerpo del usuario a la
      // base de datos: lo que llega del navegador no decide que columnas se
      // escriben. Antes se traducia avatarSeed a avatar_seed pero se dejaba
      // tambien la clave original, que se perdia en silencio por el camino.
      const cambios = {};
      if (body.name !== undefined) cambios.name = body.name;
      if (body.area !== undefined) cambios.area = body.area;
      if (body.instructions !== undefined) cambios.instructions = body.instructions;
      if (body.model !== undefined) cambios.model = body.model === '' ? null : body.model;
      if (body.effort !== undefined) cambios.effort = body.effort === '' ? null : body.effort;
      if (body.proveedor !== undefined) {
        const nom = String(body.proveedor || '').toLowerCase();
        if (nom && !proveedores.PROVEEDORES[nom]) {
          return json(res, 400, { error: `proveedor desconocido "${nom}"` });
        }
        cambios.proveedor = nom || null;
      }
      if (body.recepcion !== undefined) cambios.recepcion = body.recepcion ? 1 : 0;
      if (body.avatarSeed) cambios.avatar_seed = String(body.avatarSeed);
      if (body.avatarColor !== undefined) {
        const c = String(body.avatarColor || '').trim();
        if (c && !/^#[0-9a-f]{6}$/i.test(c)) return json(res, 400, { error: 'color invalido: usa formato #rrggbb' });
        cambios.avatar_color = c || null;
      }

      const antes = { model: a.model, effort: a.effort, area: a.area, name: a.name };
      const actualizado = store.updateAgent(id, cambios);
      const camposCambiados = Object.keys(antes).filter((k) => antes[k] !== actualizado[k]);
      if (camposCambiados.length) {
        store.event('agente.actualizado', id, {
          cambios: camposCambiados,
          antes: Object.fromEntries(camposCambiados.map((k) => [k, antes[k]])),
          ahora: Object.fromEntries(camposCambiados.map((k) => [k, actualizado[k]]))
        });
      }
      return json(res, 200, agentPublic(actualizado));
    }

    if (m === 'DELETE') {
      store.releaseAllFor(id);
      if (url.searchParams.get('purgar') === '1') {
        store.borrarAgente(id);
        return json(res, 200, { ok: true, borrado: true });
      }
      store.updateAgent(id, { archived: 1 });
      store.event('agent.archived', id, {});
      return json(res, 200, { ok: true });
    }
  }

  // Notas privadas del usuario sobre un especialista. NO se envian nunca al
  // modelo: no entran en el prompt, ni en las instrucciones, ni en el
  // contexto del turno. Son una libreta al margen de la conversacion.
  mm = p.match(/^\/api\/agents\/([^/]+)\/notas$/);
  if (mm) {
    const a = store.getAgent(mm[1]);
    if (!a) return json(res, 404, { error: 'no existe' });
    if (m === 'GET') return json(res, 200, { notas: a.notas || '' });
    if (m === 'PUT') {
      const b = await readBody(req);
      const texto = String(b.notas || '').slice(0, 20000);
      store.updateAgent(a.id, { notas: texto });
      return json(res, 200, { ok: true, tiene_notas: !!texto.trim() });
    }
    return json(res, 405, { error: 'metodo no admitido' });
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
      let prompt = adjuntos.length
        ? `${text || 'Revisa los archivos adjuntos.'}\n\nArchivos adjuntos (abrelos con tu herramienta de lectura):\n` +
          adjuntos.map((f) => `- ${f.ruta}`).join('\n')
        : text;

      // Una mencion deja de ser una sugerencia: se convierte en instruccion.
      const menciones = mencionados(text, id);
      if (menciones.length) {
        prompt += `\n\nEl usuario ha mencionado a ${menciones.map((x) => `"${x.name}"`).join(', ')}. ` +
          'Consultales con mcp__v4__send_message antes de responder, enviandole a cada uno su parte concreta. ' +
          'No supongas lo que diran: espera su respuesta, que te llegara como un mensaje nuevo.';
        store.event('mencion', id, { a: menciones.map((x) => x.name) });
      }

      const turnId = store.enqueueTurn({ agentId: id, prompt, origin: 'user', chainId: uid('chain'), hop: 0 });
      return json(res, 202, { ok: true, turn_id: turnId });
    }
  }

  mm = p.match(/^\/api\/agents\/([^/]+)\/stop$/);
  if (mm && m === 'POST') {
    const id = decodeURIComponent(mm[1]);
    const a = store.getAgent(id);
    if (!a) return json(res, 404, { error: 'agente no encontrado' });
    return json(res, 200, { ok: true, ...orq.detener(id) });
  }

  mm = p.match(/^\/api\/agents\/([^/]+)\/activity$/);
  if (mm && m === 'GET') {
    const id = decodeURIComponent(mm[1]);
    if (!store.getAgent(id)) return json(res, 404, { error: 'agente no encontrado' });
    const desde = Number(url.searchParams.get('desde') || 0);
    return json(res, 200, { actividad: store.listarActividad(id, desde) });
  }

  mm = p.match(/^\/api\/agents\/([^/]+)\/compact$/);
  if (mm && m === 'POST') {
    const id = decodeURIComponent(mm[1]);
    const a = store.getAgent(id);
    if (!a) return json(res, 404, { error: 'agente no encontrado' });
    if (!a.session_id) return json(res, 400, { error: 'este especialista todavia no tiene conversacion que compactar' });

    // Se encola como un turno normal: respeta la concurrencia y deja rastro.
    const turnId = store.enqueueTurn({ agentId: id, prompt: '/compact', origin: 'compactar', chainId: uid('chain'), hop: 0 });
    return json(res, 202, { ok: true, turn_id: turnId });
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
    return json(res, 200, {
      proveedores: [
        { ...(await auth.estado(cfg)), limites },
        await authCodex.estado(cfg)
      ]
    });
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

  // Codex se conecta por codigo de dispositivo: se entrega enlace y codigo, y
  // el propio CLI termina solo cuando el usuario autoriza. No hay nada que
  // pegar de vuelta, solo que preguntar si ya esta.
  if (p === '/api/providers/codex/login' && m === 'POST') {
    const out = await authCodex.iniciar(cfg);
    return json(res, out.error ? 400 : 200, out);
  }

  if (p === '/api/providers/codex/check' && m === 'GET') {
    const out = await authCodex.comprobar(cfg);
    if (out.listo) store.event('proveedor.conectado', null, { proveedor: 'codex', cuenta: out.cuenta || null });
    return json(res, 200, out);
  }

  if (p === '/api/providers/codex/cancel' && m === 'POST') {
    return json(res, 200, authCodex.cancelar('cancelado por el usuario'));
  }

  if (p === '/api/providers/codex/logout' && m === 'POST') {
    const out = await authCodex.cerrarSesion(cfg);
    store.event('proveedor.desconectado', null, { proveedor: 'codex', ...out });
    return json(res, out.ok ? 200 : 400, out);
  }

  // Rutas protegidas: que se toco y como deshacerlo.
  if (p === '/api/vault' && m === 'GET') {
    const q = url.searchParams.get('q');
    const t = url.searchParams.get('titulo');
    if (t) {
      const n = vault.leer(cfg, t, url.searchParams.get('carpeta'));
      return n
        ? json(res, 200, { ...n, retroenlaces: vault.retroenlaces(cfg, n.titulo) })
        : json(res, 404, { error: 'no existe esa nota' });
    }
    if (q) return json(res, 200, { resultados: vault.buscar(cfg, q, 20) });
    return json(res, 200, { raiz: vault.raiz(cfg), notas: vault.listar(cfg) });
  }

  // ------------------------------------------------- agentes de fuera
  //
  // Credencial propia y estrecha: con ella solo se puede escribir a quien
  // atiende la puerta y recoger lo que le contesten. El token del puente
  // interno abre demasiado para darselo a una maquina de escritorio.

  function externoDePeticion(req) {
    const t = req.headers['x-v4-externo'];
    if (!t) return null;
    const h = crypto.createHash('sha256').update(String(t)).digest('hex');
    return store.externoPorHuella(h);
  }

  if (p === '/api/externos' && m === 'GET') {
    return json(res, 200, {
      externos: store.listarExternos().map((e) => ({ ...e, pendientes: store.pendientesExterno(e.id) })),
      // "nombre" y no "name": el resto de esta API usa castellano y la
      // interfaz lo leia asi, con lo que mostraba "atiende: undefined".
      recepcion: store.recepcionistas().map((a) => ({ id: a.id, nombre: a.name }))
    });
  }

  if (p === '/api/externos' && m === 'POST') {
    const b = await readBody(req);
    const nombre = String(b.nombre || '').trim();
    if (!nombre) return json(res, 400, { error: 'ponle un nombre: lo veras en la conversacion' });
    if (store.externoPorNombre(nombre)) return json(res, 400, { error: 'ya existe uno con ese nombre' });
    // El token se ensena UNA vez: solo se guarda su huella.
    const token = crypto.randomBytes(24).toString('base64url');
    const huella = crypto.createHash('sha256').update(token).digest('hex');
    const ext = store.crearExterno({ id: uid('ext'), nombre, huella, nota: b.nota });
    store.event('externo.creado', null, { nombre });
    return json(res, 201, { ...ext, token, aviso: 'guarda este token: no se vuelve a mostrar' });
  }

  let mx = p.match(/^\/api\/externos\/([^/]+)$/);
  if (mx && m === 'DELETE') {
    store.borrarExterno(decodeURIComponent(mx[1]));
    store.event('externo.borrado', null, { id: mx[1] });
    return json(res, 200, { ok: true });
  }
  if (mx && m === 'POST') {
    store.revocarExterno(decodeURIComponent(mx[1]));
    store.event('externo.revocado', null, { id: mx[1] });
    return json(res, 200, { ok: true });
  }

  // --- lo que usa la maquina de fuera ---

  if (p === '/api/externo/quien' && m === 'GET') {
    const e = externoDePeticion(req);
    if (!e) return json(res, 401, { error: 'credencial no valida o revocada' });
    store.vistoExterno(e.id);
    const rec = store.recepcionistas();
    return json(res, 200, {
      nombre: e.nombre,
      recepcion: rec.map((a) => ({ nombre: a.name, area: a.area })),
      pendientes: store.pendientesExterno(e.id)
    });
  }

  if (p === '/api/externo/mensaje' && m === 'POST') {
    const e = externoDePeticion(req);
    if (!e) return json(res, 401, { error: 'credencial no valida o revocada' });
    const b = await readBody(req);
    const texto = String(b.texto || '').trim().slice(0, 20000);
    if (!texto) return json(res, 400, { error: 'mensaje vacio' });

    const rec = store.recepcionistas();
    if (!rec.length) {
      return json(res, 409, { error: 'nadie atiende la puerta: marca a un especialista como recepcion' });
    }
    // Se elige por nombre si lo pide, o el primero que atienda.
    const destino = (b.para && rec.find((a) => a.name === b.para)) || rec[0];

    store.addMessage(destino.id, 'peer', `[de ${e.nombre}, fuera del servidor] ${texto}`, { externo: e.nombre });
    const turnId = store.enqueueTurn({
      agentId: destino.id,
      prompt: `Mensaje de "${e.nombre}", un agente que trabaja FUERA de este servidor.\n\n${texto}\n\n`
        + `Si tienes que contestarle, usa send_message con destinatario "${e.nombre}". `
        + `El no puede tocar nada de este servidor: si hay que cambiar algo aqui, hazlo tu o pidelo a quien corresponda.`,
      origin: 'externo', chainId: uid('chain'), hop: 0
    });
    store.vistoExterno(e.id);
    store.event('externo.mensaje', destino.id, { de: e.nombre, turn_id: turnId });
    return json(res, 202, { ok: true, atendido_por: destino.name, turnId });
  }

  if (p === '/api/externo/pendientes' && m === 'GET') {
    const e = externoDePeticion(req);
    if (!e) return json(res, 401, { error: 'credencial no valida o revocada' });
    store.vistoExterno(e.id);
    const filas = store.recogerDeCola(e.id);
    return json(res, 200, {
      mensajes: filas.map((f) => ({ de: nameOf(f.de_agente), texto: f.cuerpo, en: f.created_at }))
    });
  }

  if (p === '/api/guardia' && m === 'GET') {
    return json(res, 200, {
      vigilando: cfg.rutasProtegidas || [],
      incidentes: store.incidentes(30).map((i) => ({ ...i, nombre: nameOf(i.agent_id) }))
    });
  }

  let mg = p.match(/^\/api\/guardia\/(\d+)\/revertir$/);
  if (mg && m === 'POST') {
    const inc = store.incidente(Number(mg[1]));
    if (!inc) return json(res, 404, { error: 'no existe ese aviso' });
    if (inc.revertido) return json(res, 400, { error: 'ya se revirtio' });
    let foto;
    try {
      foto = JSON.parse(fs.readFileSync(path.join(inc.foto, 'manifiesto.json'), 'utf8'));
    } catch {
      return json(res, 400, { error: 'ya no esta la copia: no se puede deshacer' });
    }
    const out = guardia.revertir(foto, inc.cambios);
    store.marcarIncidente(inc.id, { revertido: 1, visto: 1 });
    store.event('guardia.revertido', inc.agent_id, { incidente: inc.id, hecho: out.hecho.length, fallos: out.fallos.length });
    return json(res, 200, out);
  }

  mg = p.match(/^\/api\/guardia\/(\d+)\/visto$/);
  if (mg && m === 'POST') {
    store.marcarIncidente(Number(mg[1]), { visto: 1 });
    return json(res, 200, { ok: true });
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

function escaparHtml(t) {
  return String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderIndex() {
  let html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
  const v = assetVersion();
  // La pagina sabe con que version se cargo; si el servidor sirve otra, avisa.
  html = html.replace('</head>', `<script>window.V4_VERSION='${v}';</script>\n</head>`);

  // El nombre de la instalacion viaja en el documento: asi la pestana y la
  // marca ya salen bien en la primera pintada, sin esperar a la API.
  const nombre = cfg.nombre || 'codex-web-v4';
  html = html.replace('<title>codex-web-v4 · especialistas</title>', `<title>${escaparHtml(nombre)}</title>`);
  // replaceAll: el nombre aparece en la marca y en la pantalla de acceso, y
  // sustituir solo el primero dejaba la barra lateral con el nombre viejo.
  html = html.replaceAll('>codex-web-v4<', `>${escaparHtml(nombre)}<`);
  // Instalada en un iPhone, el nombre bajo el icono sale de esta etiqueta.
  html = html.replace('<meta name="apple-mobile-web-app-title" content="v4">',
    `<meta name="apple-mobile-web-app-title" content="${escaparHtml(nombre.slice(0, 12).trim())}">`);
  for (const recurso of ['/app.js', '/style.css', '/faces.js']) {
    html = html.replace(`"${recurso}"`, `"${recurso}?v=${v}"`);
  }

  if (!cfg.requireAuth) {
    // Sin token no hay pantalla de acceso: se elimina del documento servido.
    // Se recorta entre marcas, no con un patron sobre <div>: el perezoso
    // llegaba hasta el </div> anterior a #app y se llevaba por delante el
    // aviso de version nueva, que vive en medio. Con requireAuth en false
    // ese aviso no existia y habia que recargar a mano.
    html = html.replace(/<!-- login:inicio -->[\s\S]*?<!-- login:fin -->\s*/, '');
    html = html.replace('<div id="app" hidden>', '<div id="app">');
  }
  return html;
}

function serveStatic(req, res, url) {
  // El manifiesto tambien lleva el nombre: instalada como aplicacion, cada
  // servidor debe distinguirse en el escritorio.
  if (url.pathname === '/manifest.webmanifest') {
    try {
      const man = JSON.parse(fs.readFileSync(path.join(PUBLIC_DIR, 'manifest.webmanifest'), 'utf8'));
      man.name = cfg.nombre || man.name;
      man.short_name = (cfg.nombre || man.short_name).slice(0, 12).trim();
      res.writeHead(200, { 'content-type': MIME['.webmanifest'], 'cache-control': 'no-store' });
      return res.end(JSON.stringify(man, null, 2));
    } catch { /* si falla, se sirve el archivo tal cual */ }
  }

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
