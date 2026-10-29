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

/** Escapa una cadena para TOML basico. */
const toml = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/**
 * Configuracion de Codex para este agente: el servidor MCP del puente, con
 * las mismas variables que recibe en Claude. Se reescribe en cada turno
 * porque chainId y hop cambian de uno a otro.
 */
function escribirConfig(cfg, agent, { chainId, hop }) {
  const dir = path.join(agent.home, '.codex');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'config.toml');
  const puente = path.join(cfg.appDir, 'src', 'bridge', 'mcp-server.js');

  const lineas = [
    '# Generado por codex-web-v4 en cada turno. No editar a mano.',
    '',
    '[mcp_servers.v4]',
    `command = ${toml(process.execPath)}`,
    `args = [${toml(puente)}]`,
    '',
    '[mcp_servers.v4.env]',
    `V4_API = ${toml(cfg.apiUrl || `http://127.0.0.1:${cfg.port}`)}`,
    `V4_BRIDGE_TOKEN = ${toml(cfg.bridgeToken)}`,
    `V4_AGENT_ID = ${toml(agent.id)}`,
    `V4_CHAIN_ID = ${toml(chainId || '')}`,
    `V4_HOP = ${toml(String(hop || 0))}`,
    ''
  ];
  fs.writeFileSync(file, lineas.join('\n'), { mode: 0o600 });
  return file;
}

module.exports = {
  nombre: 'codex',
  etiqueta: 'ChatGPT (Codex)',
  modelos: ['gpt-5-codex', 'gpt-5', 'o3'],
  esfuerzos: ['low', 'medium', 'high'],

  reanuda: true,

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

  preparar(cfg, agent, turn, systemPrompt) {
    escribirConfig(cfg, agent, { chainId: turn.chain_id, hop: turn.hop });

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
      '-C', agent.workspace
    );
    if (agent.model || cfg.modelCodex) args.push('--model', agent.model || cfg.modelCodex);
    args.push(texto);

    return {
      args,
      cwd: agent.workspace,
      env: {
        ...process.env,
        HOME: agent.home,              // de aqui sale su .codex/config.toml
        CODEX_HOME: path.join(agent.home, '.codex'),
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
