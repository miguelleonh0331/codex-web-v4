'use strict';
const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS agents (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL UNIQUE,
  area         TEXT,
  instructions TEXT NOT NULL,
  model        TEXT,
  status       TEXT NOT NULL DEFAULT 'idle',
  session_id   TEXT,
  home         TEXT NOT NULL,
  workspace    TEXT NOT NULL,
  archived     INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id   TEXT NOT NULL,
  role       TEXT NOT NULL,              -- user | assistant | peer | system
  body       TEXT NOT NULL,
  meta       TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_agent ON messages(agent_id, id);

CREATE TABLE IF NOT EXISTS mailbox (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  from_agent   TEXT NOT NULL,
  to_agent     TEXT NOT NULL,
  body         TEXT NOT NULL,
  chain_id     TEXT NOT NULL,
  hop          INTEGER NOT NULL DEFAULT 0,
  status       TEXT NOT NULL DEFAULT 'queued',  -- queued | delivered | blocked
  reason       TEXT,
  created_at   TEXT NOT NULL,
  delivered_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_mailbox_to ON mailbox(to_agent, status);

CREATE TABLE IF NOT EXISTS turns (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id   TEXT NOT NULL,
  prompt     TEXT NOT NULL,
  origin     TEXT NOT NULL,              -- user | peer | system
  mailbox_id INTEGER,
  chain_id   TEXT,
  hop        INTEGER NOT NULL DEFAULT 0,
  status     TEXT NOT NULL DEFAULT 'pending', -- pending | running | done | error | timeout
  result     TEXT,
  error      TEXT,
  cost_usd   REAL,
  num_turns  INTEGER,
  session_id TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  ended_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_turns_status ON turns(status, id);

CREATE TABLE IF NOT EXISTS claims (
  path       TEXT PRIMARY KEY,
  agent_id   TEXT NOT NULL,
  note       TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS actividad (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id   TEXT NOT NULL,
  turn_id    INTEGER,
  tipo       TEXT NOT NULL,               -- herramienta | texto | fin
  herramienta TEXT,
  resumen    TEXT,
  detalle    TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_actividad_agente ON actividad(agent_id, id);

CREATE TABLE IF NOT EXISTS limites (
  tipo        TEXT PRIMARY KEY,            -- five_hour | seven_day | seven_day_opus...
  utilizacion REAL,                        -- 0..1, solo llega cerca del limite
  reinicia_en INTEGER,                     -- epoch en segundos
  estado      TEXT,
  sobreuso    INTEGER NOT NULL DEFAULT 0,
  visto_en    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT NOT NULL,
  agent_id   TEXT,
  data       TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_id ON events(id);
`;

function now() { return new Date().toISOString(); }
function uid(prefix) { return `${prefix}-${crypto.randomUUID()}`; }

// Migraciones aditivas: cada columna nueva se anade si falta, para que una base
// ya existente siga funcionando sin tocarla a mano.
const COLUMNAS_NUEVAS = [
  ['agents', 'avatar_seed', 'TEXT'],
  ['agents', 'effort', 'TEXT'],
  ['agents', 'avatar_color', 'TEXT'],
  ['agents', 'ctx_usado', 'INTEGER'],
  ['agents', 'ctx_ventana', 'INTEGER'],
  ['agents', 'ctx_modelo', 'TEXT'],
  ['agents', 'ctx_visto', 'TEXT']
];

function migrar(db) {
  for (const [tabla, columna, tipo] of COLUMNAS_NUEVAS) {
    const cols = db.prepare(`PRAGMA table_info(${tabla})`).all().map((c) => c.name);
    if (!cols.includes(columna)) db.exec(`ALTER TABLE ${tabla} ADD COLUMN ${columna} ${tipo}`);
  }
}

function open(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA);
  migrar(db);
  return db;
}

class Store {
  constructor(dbPath) {
    this.db = open(dbPath);
  }

  // ---------- eventos ----------
  event(kind, agentId, data) {
    this.db.prepare('INSERT INTO events (kind, agent_id, data, created_at) VALUES (?,?,?,?)')
      .run(kind, agentId || null, data ? JSON.stringify(data) : null, now());
  }

  listEvents(sinceId = 0, limit = 200) {
    return this.db.prepare('SELECT * FROM events WHERE id > ? ORDER BY id DESC LIMIT ?').all(sinceId, limit);
  }

  // ---------- actividad en vivo ----------
  /**
   * Deja constancia de cada herramienta que usa el especialista. Se poda a los
   * ultimos MAX por agente: un turno largo son cientos de llamadas y la base no
   * debe crecer sin freno.
   */
  registrarActividad(agentId, turnId, { tipo, herramienta, resumen, detalle }, max = 200) {
    this.db.prepare(`INSERT INTO actividad (agent_id, turn_id, tipo, herramienta, resumen, detalle, created_at)
                     VALUES (?,?,?,?,?,?,?)`)
      .run(agentId, turnId || null, tipo, herramienta || null,
           (resumen || '').slice(0, 400), detalle ? String(detalle).slice(0, 4000) : null, now());

    this.db.prepare(`DELETE FROM actividad WHERE agent_id = ? AND id NOT IN
                     (SELECT id FROM actividad WHERE agent_id = ? ORDER BY id DESC LIMIT ?)`)
      .run(agentId, agentId, max);
  }

  listarActividad(agentId, desde = 0, limite = 150) {
    return this.db.prepare('SELECT * FROM actividad WHERE agent_id = ? AND id > ? ORDER BY id ASC LIMIT ?')
      .all(agentId, desde, limite);
  }

  /** Contexto consumido en el ultimo turno, con la ventana real de su modelo. */
  guardarContexto(agentId, { usado, ventana, modelo }) {
    this.db.prepare('UPDATE agents SET ctx_usado = ?, ctx_ventana = ?, ctx_modelo = ?, ctx_visto = ? WHERE id = ?')
      .run(usado || null, ventana || null, modelo || null, now(), agentId);
  }

  // ---------- limites de uso del proveedor ----------
  /** Guarda el ultimo aviso de cada ventana tal y como lo manda el CLI. */
  guardarLimite(info) {
    if (!info || !info.rateLimitType) return;
    this.db.prepare(`INSERT INTO limites (tipo, utilizacion, reinicia_en, estado, sobreuso, visto_en)
                     VALUES (?,?,?,?,?,?)
                     ON CONFLICT(tipo) DO UPDATE SET
                       utilizacion = excluded.utilizacion,
                       reinicia_en = excluded.reinicia_en,
                       estado = excluded.estado,
                       sobreuso = excluded.sobreuso,
                       visto_en = excluded.visto_en`)
      .run(String(info.rateLimitType),
           typeof info.utilization === 'number' ? info.utilization : null,
           Number(info.resetsAt) || null,
           String(info.status || ''),
           info.isUsingOverage ? 1 : 0,
           now());
  }

  listarLimites() {
    return this.db.prepare('SELECT * FROM limites ORDER BY tipo').all();
  }

  // ---------- agentes ----------
  createAgent({ id, name, area, instructions, model, effort, home, workspace, avatarSeed }) {
    const ts = now();
    this.db.prepare(`INSERT INTO agents (id,name,area,instructions,model,effort,status,home,workspace,avatar_seed,created_at,updated_at)
                     VALUES (?,?,?,?,?,?,'idle',?,?,?,?,?)`)
      .run(id, name, area || null, instructions, model || null, effort || null, home, workspace, avatarSeed || id, ts, ts);
    this.event('agent.created', id, { name, area });
    return this.getAgent(id);
  }

  getAgent(id) {
    return this.db.prepare('SELECT * FROM agents WHERE id = ?').get(id) || null;
  }

  getAgentByName(name) {
    return this.db.prepare('SELECT * FROM agents WHERE lower(name) = lower(?)').get(name) || null;
  }

  resolveAgent(ref) {
    if (!ref) return null;
    return this.getAgent(ref) || this.getAgentByName(ref);
  }

  listAgents(includeArchived = false) {
    const sql = includeArchived
      ? 'SELECT * FROM agents ORDER BY created_at'
      : 'SELECT * FROM agents WHERE archived = 0 ORDER BY created_at';
    return this.db.prepare(sql).all();
  }

  updateAgent(id, fields) {
    const allowed = ['name', 'area', 'instructions', 'model', 'effort', 'status', 'session_id', 'archived', 'avatar_seed', 'avatar_color'];
    const keys = Object.keys(fields).filter((k) => allowed.includes(k));
    if (!keys.length) return this.getAgent(id);
    const sets = keys.map((k) => `${k} = ?`).join(', ');
    this.db.prepare(`UPDATE agents SET ${sets}, updated_at = ? WHERE id = ?`)
      .run(...keys.map((k) => fields[k]), now(), id);
    return this.getAgent(id);
  }

  // ---------- mensajes de la conversacion ----------
  addMessage(agentId, role, body, meta) {
    const ts = now();
    const info = this.db.prepare('INSERT INTO messages (agent_id, role, body, meta, created_at) VALUES (?,?,?,?,?)')
      .run(agentId, role, body, meta ? JSON.stringify(meta) : null, ts);
    return Number(info.lastInsertRowid);
  }

  listMessages(agentId, limit = 500) {
    return this.db.prepare('SELECT * FROM messages WHERE agent_id = ? ORDER BY id ASC LIMIT ?').all(agentId, limit);
  }

  // ---------- buzon entre agentes ----------
  queueMail({ fromAgent, toAgent, body, chainId, hop }) {
    const ts = now();
    const info = this.db.prepare(`INSERT INTO mailbox (from_agent,to_agent,body,chain_id,hop,status,created_at)
                                  VALUES (?,?,?,?,?,'queued',?)`)
      .run(fromAgent, toAgent, body, chainId, hop, ts);
    const id = Number(info.lastInsertRowid);
    this.event('mail.queued', fromAgent, { mailbox_id: id, to: toAgent, chain_id: chainId, hop });
    return id;
  }

  blockMail({ fromAgent, toAgent, body, chainId, hop, reason }) {
    const ts = now();
    const info = this.db.prepare(`INSERT INTO mailbox (from_agent,to_agent,body,chain_id,hop,status,reason,created_at)
                                  VALUES (?,?,?,?,?,'blocked',?,?)`)
      .run(fromAgent, toAgent, body, chainId, hop, reason, ts);
    this.event('mail.blocked', fromAgent, { to: toAgent, reason });
    return Number(info.lastInsertRowid);
  }

  markMailDelivered(id) {
    this.db.prepare("UPDATE mailbox SET status = 'delivered', delivered_at = ? WHERE id = ?").run(now(), id);
  }

  recentMailFrom(fromAgent, toAgent, body, windowMs) {
    const since = new Date(Date.now() - windowMs).toISOString();
    return this.db.prepare(`SELECT * FROM mailbox WHERE from_agent = ? AND to_agent = ? AND body = ? AND created_at > ?`)
      .get(fromAgent, toAgent, body, since) || null;
  }

  listMailbox(limit = 200) {
    return this.db.prepare('SELECT * FROM mailbox ORDER BY id DESC LIMIT ?').all(limit);
  }

  inboxFor(agentId, limit = 50) {
    return this.db.prepare(`SELECT * FROM mailbox WHERE to_agent = ? ORDER BY id DESC LIMIT ?`).all(agentId, limit);
  }

  // ---------- turnos ----------
  enqueueTurn({ agentId, prompt, origin, mailboxId = null, chainId = null, hop = 0 }) {
    const info = this.db.prepare(`INSERT INTO turns (agent_id,prompt,origin,mailbox_id,chain_id,hop,status,created_at)
                                  VALUES (?,?,?,?,?,?,'pending',?)`)
      .run(agentId, prompt, origin, mailboxId, chainId, hop, now());
    const id = Number(info.lastInsertRowid);
    this.event('turn.queued', agentId, { turn_id: id, origin });
    return id;
  }

  nextPendingTurns(limit) {
    return this.db.prepare(`SELECT * FROM turns WHERE status = 'pending' ORDER BY id ASC LIMIT ?`).all(limit);
  }

  runningCount() {
    return this.db.prepare("SELECT COUNT(*) AS c FROM turns WHERE status = 'running'").get().c;
  }

  agentHasRunningTurn(agentId) {
    return this.db.prepare("SELECT COUNT(*) AS c FROM turns WHERE status = 'running' AND agent_id = ?").get(agentId).c > 0;
  }

  markTurnRunning(id) {
    this.db.prepare("UPDATE turns SET status = 'running', started_at = ? WHERE id = ?").run(now(), id);
  }

  finishTurn(id, { status, result, error, cost, numTurns, sessionId }) {
    this.db.prepare(`UPDATE turns SET status = ?, result = ?, error = ?, cost_usd = ?, num_turns = ?, session_id = ?, ended_at = ?
                     WHERE id = ?`)
      .run(status, result || null, error || null, cost ?? null, numTurns ?? null, sessionId || null, now(), id);
  }

  getTurn(id) {
    return this.db.prepare('SELECT * FROM turns WHERE id = ?').get(id) || null;
  }

  listTurns(limit = 100) {
    return this.db.prepare('SELECT * FROM turns ORDER BY id DESC LIMIT ?').all(limit);
  }

  // Recupera turnos que quedaron 'running' tras un reinicio del servicio.
  recoverStaleTurns() {
    const stale = this.db.prepare("SELECT id FROM turns WHERE status = 'running'").all();
    if (stale.length) {
      this.db.prepare("UPDATE turns SET status = 'error', error = 'interrumpido por reinicio del servicio', ended_at = ? WHERE status = 'running'")
        .run(now());
      this.db.prepare("UPDATE agents SET status = 'idle' WHERE status = 'working'").run();
    }
    return stale.length;
  }

  // ---------- reservas de archivos ----------
  claim(paths, agentId, note) {
    const taken = [];
    const done = [];
    for (const p of paths) {
      const existing = this.db.prepare('SELECT * FROM claims WHERE path = ?').get(p);
      if (existing && existing.agent_id !== agentId) { taken.push({ path: p, agent_id: existing.agent_id }); continue; }
      this.db.prepare('INSERT OR REPLACE INTO claims (path, agent_id, note, created_at) VALUES (?,?,?,?)')
        .run(p, agentId, note || null, now());
      done.push(p);
    }
    this.event('claim', agentId, { claimed: done, rejected: taken });
    return { claimed: done, rejected: taken };
  }

  release(paths, agentId) {
    const released = [];
    for (const p of paths) {
      const existing = this.db.prepare('SELECT * FROM claims WHERE path = ?').get(p);
      if (existing && existing.agent_id === agentId) {
        this.db.prepare('DELETE FROM claims WHERE path = ?').run(p);
        released.push(p);
      }
    }
    this.event('claim.release', agentId, { released });
    return released;
  }

  listClaims() {
    return this.db.prepare('SELECT * FROM claims ORDER BY created_at').all();
  }

  releaseAllFor(agentId) {
    this.db.prepare('DELETE FROM claims WHERE agent_id = ?').run(agentId);
  }
}

module.exports = { Store, now, uid };
