'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const CONFIG_PATH = process.env.V4_CONFIG || '/etc/codex-web-v4/config.json';

const DEFAULTS = {
  nombre: 'codex-web-v4',     // como se llama ESTA instalacion; se ve en la interfaz
  port: 3212,
  bindHosts: ['127.0.0.1'],
  dataDir: '/var/lib/codex-web-v4',
  appDir: path.resolve(__dirname, '..'),
  sessionDir: null,           // se deriva de dataDir si viene null
  sessionSource: null,        // credenciales de origen: si la sesion caduca, se recupera de aqui
  claudeBin: null,            // autodeteccion si viene null
  model: 'sonnet',
  effort: null,               // low | medium | high | xhigh | max; null deja el del CLI
  maxConcurrentTurns: 2,
  turnTimeoutMs: 900000,
  maxHops: 6,
  maxAgents: 24,              // tope de especialistas que el propio equipo puede crear
  maxUploadMb: 50,            // tope por archivo adjunto
  dedupeWindowMs: 60000,
  requireAuth: false,         // la UI solo escucha en redes privadas; sin token por defecto
  authToken: null,            // se genera al primer arranque (solo se exige si requireAuth)
  bridgeToken: null,          // se genera al primer arranque
  project: {
    name: 'proyecto',
    path: null,
    deployPath: null,
    validate: null
  }
};

// Rutas candidatas del binario de Claude Code, en orden de preferencia.
const CLAUDE_CANDIDATES = [
  '/opt/codex-web/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude',
  '/opt/codex-web/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64-musl/claude',
  '/usr/local/bin/claude',
  '/usr/bin/claude'
];

function detectClaude() {
  for (const c of CLAUDE_CANDIDATES) {
    try {
      fs.accessSync(c, fs.constants.X_OK);
      return c;
    } catch { /* siguiente candidato */ }
  }
  return null;
}

function readConfigFile() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw new Error(`Configuracion ilegible en ${CONFIG_PATH}: ${err.message}`);
  }
}

function load() {
  const file = readConfigFile();
  const cfg = { ...DEFAULTS, ...file, project: { ...DEFAULTS.project, ...(file.project || {}) } };

  cfg.sessionDir = cfg.sessionDir || path.join(cfg.dataDir, 'session');
  cfg.agentsDir = path.join(cfg.dataDir, 'agents');
  cfg.dbPath = cfg.dbPath || path.join(cfg.dataDir, 'v4.db');
  cfg.logsDir = path.join(cfg.dataDir, 'logs');
  cfg.claudeBin = cfg.claudeBin || detectClaude();

  // Variables de entorno para despliegues donde el archivo no manda.
  if (process.env.V4_PORT) cfg.port = Number(process.env.V4_PORT);
  if (process.env.V4_DATA_DIR) cfg.dataDir = process.env.V4_DATA_DIR;
  if (process.env.V4_BIND) cfg.bindHosts = process.env.V4_BIND.split(',').map((s) => s.trim());

  let mutated = false;
  if (!cfg.authToken) { cfg.authToken = crypto.randomBytes(24).toString('hex'); mutated = true; }
  if (!cfg.bridgeToken) { cfg.bridgeToken = crypto.randomBytes(24).toString('hex'); mutated = true; }

  if (mutated) {
    const toWrite = { ...file, authToken: cfg.authToken, bridgeToken: cfg.bridgeToken };
    try {
      fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(toWrite, null, 2) + '\n', { mode: 0o600 });
    } catch (err) {
      console.warn(`[config] no se pudieron persistir los tokens: ${err.message}`);
    }
  }

  for (const dir of [cfg.dataDir, cfg.sessionDir, cfg.agentsDir, cfg.logsDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  return cfg;
}

/**
 * Escribe claves sueltas en el archivo de configuracion conservando el resto.
 * Se relee del disco en vez de volcar el objeto en memoria: ahi hay valores
 * derivados (rutas, apiUrl) que no deben acabar fijados en el archivo.
 */
function guardar(cambios) {
  const actual = readConfigFile();
  const nuevo = { ...actual, ...cambios };
  const tmp = `${CONFIG_PATH}.nuevo`;
  fs.writeFileSync(tmp, JSON.stringify(nuevo, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, CONFIG_PATH);
  return nuevo;
}

module.exports = { load, guardar, CONFIG_PATH, detectClaude, DEFAULTS };
