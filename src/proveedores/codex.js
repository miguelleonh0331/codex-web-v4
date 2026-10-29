'use strict';
/**
 * Proveedor: Codex CLI (OpenAI).
 *
 * Equivalencias con Claude Code, que es lo que hace posible el adaptador:
 *
 *   claude -p "..."                     codex exec "..."
 *   --output-format stream-json         --json          (JSONL por stdout)
 *   --permission-mode bypassPermissions --dangerously-bypass-approvals-and-sandbox
 *   --mcp-config fichero.json           ~/.codex/config.toml del agente
 *   --resume <id>                       codex exec resume <id>
 *   cwd del proceso                     -C <dir>
 *
 * La diferencia real esta en MCP: Claude acepta un fichero por invocacion y
 * Codex lo lee de su configuracion. Como cada agente tiene su propio HOME,
 * se escribe un config.toml por agente y el aislamiento es el mismo.
 */
const fs = require('node:fs');
const path = require('node:path');

/** Valor TOML para pasarlo por -c, que es lo que espera el CLI. */
const tomlv = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/**
 * Servidor MCP del puente, inyectado por linea de comandos.
 *
 * No se escribe en config.toml a proposito: ese fichero vive en CODEX_HOME,
 * que es compartido porque ahi esta la sesion. Si el MCP fuera por fichero,
 * todos los agentes compartirian el mismo V4_AGENT_ID y el puente no sabria
 * quien le habla. Por linea de comandos cada turno lleva los suyos.
 */
function opcionesMcp(cfg, agent, { chainId, hop }) {
  const puente = path.join(cfg.appDir, 'src', 'bridge', 'mcp-server.js');
  const pares = [
    ['mcp_servers.v4.command', tomlv(process.execPath)],
    ['mcp_servers.v4.args', `[${tomlv(puente)}]`],
    ['mcp_servers.v4.env.V4_API', tomlv(cfg.apiUrl || `http://127.0.0.1:${cfg.port}`)],
    ['mcp_servers.v4.env.V4_BRIDGE_TOKEN', tomlv(cfg.bridgeToken)],
    ['mcp_servers.v4.env.V4_AGENT_ID', tomlv(agent.id)],
    ['mcp_servers.v4.env.V4_CHAIN_ID', tomlv(chainId || '')],
    ['mcp_servers.v4.env.V4_HOP', tomlv(String(hop || 0))]
  ];
  return pares.flatMap(([k, v]) => ['-c', `${k}=${v}`]);
}

module.exports = {
  nombre: 'codex',
  etiqueta: 'ChatGPT (Codex)',
  // Comprobados uno a uno contra el propio CLI con una cuenta de ChatGPT:
  // un modelo invalido devuelve 400 model_not_found al instante. "gpt-5" y
  // "o3" NO valen por esta via, aunque existan en la API.
  modelos: ['gpt-5.3-codex', 'gpt-5.2-codex', 'gpt-5.1-codex', 'gpt-5-codex'],
  esfuerzos: ['low', 'medium', 'high'],

  reanuda: true,
  // Sin --model, lo elige el propio CLI.
  modeloPorDefecto: null,

  binario(cfg) {
    if (cfg.codexBin) return cfg.codexBin;
    // Las mismas rutas donde suele quedar instalado, incluida la del paquete
    // npm que ya convive con codex-web en este servidor.
    const candidatos = [
      '/usr/local/bin/codex',
      '/usr/bin/codex',
      '/opt/codex-web/node_modules/.bin/codex',
      path.join(process.env.HOME || '/root', '.local/bin/codex')
    ];
    for (const c of candidatos) {
      try { fs.accessSync(c, fs.constants.X_OK); return c; } catch { /* siguiente */ }
    }
    return null;
  },

  faltaBinario: 'No se encontro el binario de Codex. Instalalo o indica config.codexBin.',

  /** Donde vive la sesion compartida por todos los especialistas. */
  dirSesion(cfg) {
    return cfg.sessionDirCodex || path.join(cfg.dataDir, 'session-codex');
  },

  preparar(cfg, agent, turn, systemPrompt) {
    // Codex no tiene equivalente de --append-system-prompt: las instrucciones
    // del especialista y el protocolo del equipo van al principio del propio
    // mensaje, separadas de la tarea.
    const texto = `${systemPrompt}\n\n---\n\nTAREA:\n${turn.prompt}`;

    const args = ['exec'];
    if (agent.session_id) args.push('resume', agent.session_id);
    args.push(
      '--json',
      '--dangerously-bypass-approvals-and-sandbox',
      '--skip-git-repo-check',
      '-C', agent.workspace,
      ...opcionesMcp(cfg, agent, { chainId: turn.chain_id, hop: turn.hop })
    );
    if (agent.model || cfg.modelCodex) args.push('--model', agent.model || cfg.modelCodex);
    args.push(texto);

    const sesion = this.dirSesion(cfg);
    fs.mkdirSync(sesion, { recursive: true });

    return {
      args,
      cwd: agent.workspace,
      env: {
        ...process.env,
        // El codex instalado por npm es un script con cabecera
        // "#!/usr/bin/env node". Si node no esta en el PATH del usuario del
        // servicio, el lanzamiento falla con un "node: no such file" que no
        // dice nada de Codex. Se garantiza aqui.
        PATH: `${path.dirname(process.execPath)}:${process.env.PATH || ''}`,
        HOME: agent.home,
        // Compartido a proposito: una sola sesion para todos los
        // especialistas, igual que CLAUDE_CONFIG_DIR en el otro proveedor.
        CODEX_HOME: sesion,
        V4_AGENT_ID: agent.id,
        V4_AGENT_NAME: agent.name
      }
    };
  },

  /**
   * Codex emite varios tipos de evento. El que cierra el turno trae el
   * mensaje final del agente. Se aceptan varias formas porque el esquema ha
   * cambiado entre versiones y no conviene atarse a una sola.
   */
  esFinal(ev) {
    if (!ev) return false;
    const t = ev.type || (ev.msg && ev.msg.type);
    return t === 'task_complete' || t === 'turn.completed' || t === 'item.completed' ||
           t === 'agent_message' || t === 'thread.finished';
  },

  limiteDe(ev) {
    if (!ev) return null;
    const t = ev.type || (ev.msg && ev.msg.type) || '';
    if (!/rate.?limit|usage.?limit/i.test(String(t))) return null;
    const info = ev.rate_limit_info || (ev.msg && ev.msg.rate_limits) || ev.rate_limits;
    return info || null;
  },

  resultado(final, { stdout, stderr, code }) {
    // Texto del mensaje final, buscado en los sitios donde lo han puesto las
    // distintas versiones del CLI.
    const leerTexto = (e) => {
      if (!e) return null;
      const m = e.msg || e;
      if (typeof m.last_agent_message === 'string') return m.last_agent_message;
      if (typeof m.message === 'string') return m.message;
      if (typeof m.text === 'string') return m.text;
      if (m.item && typeof m.item.text === 'string') return m.item.text;
      if (Array.isArray(m.content)) {
        return m.content.map((c) => (typeof c === 'string' ? c : c.text || '')).join('').trim() || null;
      }
      return null;
    };

    const texto = leerTexto(final);
    if (texto === null) {
      const detalle = (stderr || stdout || '').trim().slice(-600);
      return { ok: false, error: `Salida no interpretable (code ${code}): ${detalle || 'sin salida'}` };
    }

    const m = (final && final.msg) || final || {};
    const uso = m.usage || m.token_usage || null;
    return {
      ok: true,
      text: String(texto),
      // El identificador permite continuar la conversacion en el turno siguiente.
      sessionId: m.session_id || m.thread_id || m.conversation_id ||
                 (final && (final.session_id || final.thread_id)) || null,
      // Codex no publica coste en dolares: queda a null y la interfaz lo
      // muestra vacio en vez de inventarse una cifra.
      cost: null,
      numTurns: m.num_turns || null,
      uso,
      modelUsage: null,
      raw: final
    };
  }
};
