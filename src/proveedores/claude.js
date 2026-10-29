'use strict';
/**
 * Proveedor: Claude Code.
 *
 * Traduce entre lo que el sistema necesita de un turno y la forma concreta
 * que tiene este CLI de pedirlo y de contestar. Todo lo especifico de Claude
 * vive aqui; el runner no sabe de banderas ni de nombres de evento.
 */
const fs = require('node:fs');
const path = require('node:path');

/**
 * Configuracion MCP del puente. Se escribe en el home del agente, que es
 * suyo y solo suyo: dos agentes no comparten fichero ni se pisan el chainId.
 */
function escribirMcp(cfg, agent, { chainId, hop }) {
  const file = path.join(agent.home, 'mcp.json');
  const conf = {
    mcpServers: {
      v4: {
        command: process.execPath,
        args: [path.join(cfg.appDir, 'src', 'bridge', 'mcp-server.js')],
        env: {
          V4_API: cfg.apiUrl || `http://127.0.0.1:${cfg.port}`,
          V4_BRIDGE_TOKEN: cfg.bridgeToken,
          V4_AGENT_ID: agent.id,
          V4_CHAIN_ID: chainId || '',
          V4_HOP: String(hop || 0)
        }
      }
    }
  };
  fs.writeFileSync(file, JSON.stringify(conf, null, 2), { mode: 0o600 });
  return file;
}

module.exports = {
  nombre: 'claude',
  etiqueta: 'Claude',
  modelos: ['haiku', 'sonnet', 'opus', 'opusplan', 'fable'],
  esfuerzos: ['low', 'medium', 'high', 'xhigh', 'max'],

  /** Admite reanudar la conversacion anterior por identificador de sesion. */
  reanuda: true,
  /** El de la configuracion de la instalacion. */
  modeloPorDefecto: 'sonnet',

  binario(cfg) {
    return cfg.claudeBin || null;
  },

  faltaBinario: 'No se encontro el binario de Claude Code (config.claudeBin).',

  /** Como se lanza un turno: argumentos, entorno y directorio. */
  preparar(cfg, agent, turn, systemPrompt) {
    const mcpFile = escribirMcp(cfg, agent, { chainId: turn.chain_id, hop: turn.hop });
    const args = [
      '-p', turn.prompt,
      // En streaming llegan ademas los avisos de limite de uso (rate_limit_event),
      // que es la unica forma de saber cuando se reinicia la ventana.
      '--output-format', 'stream-json', '--verbose',
      '--permission-mode', 'bypassPermissions',
      '--mcp-config', mcpFile,
      '--append-system-prompt', systemPrompt
    ];
    if (agent.model || cfg.model) args.push('--model', agent.model || cfg.model);
    const esfuerzo = agent.effort || cfg.effort;
    if (esfuerzo) args.push('--effort', esfuerzo);
    if (agent.session_id) args.push('--resume', agent.session_id);

    return {
      args,
      cwd: agent.workspace,
      env: {
        ...process.env,
        HOME: agent.home,
        CLAUDE_CONFIG_DIR: cfg.sessionDir,
        V4_AGENT_ID: agent.id,
        V4_AGENT_NAME: agent.name
      }
    };
  },

  /** El evento que cierra el turno y trae el resultado. */
  esFinal(ev) {
    return ev && ev.type === 'result';
  },

  /** Aviso de limite de uso, si el evento lo es. */
  limiteDe(ev) {
    return (ev && ev.type === 'rate_limit_event' && ev.rate_limit_info) || null;
  },

  /** Traduce el evento final a la forma comun que entiende el sistema. */
  resultado(final, { stdout, stderr, code }) {
    let parsed = final;
    // Compatibilidad: si alguna version devolviera un unico objeto JSON.
    if (!parsed) { try { parsed = JSON.parse(stdout); } catch { /* nada */ } }

    if (!parsed) {
      const detalle = (stderr || stdout || '').trim().slice(-600);
      return { ok: false, error: `Salida no interpretable (code ${code}): ${detalle || 'sin salida'}` };
    }

    if (parsed.is_error) {
      return {
        ok: false,
        error: String(parsed.result || 'error reportado por Claude'),
        sessionId: parsed.session_id,
        raw: parsed
      };
    }

    return {
      ok: true,
      text: String(parsed.result ?? ''),
      sessionId: parsed.session_id,
      cost: parsed.total_cost_usd,
      numTurns: parsed.num_turns,
      uso: parsed.usage || null,
      modelUsage: parsed.modelUsage || null,
      raw: parsed
    };
  }
};
