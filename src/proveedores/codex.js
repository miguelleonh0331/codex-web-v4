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
  /*
   * Comprobados ejecutando un turno real con una cuenta ChatGPT Plus: un
   * nombre invalido devuelve 400 model_not_found al instante.
   *
   * El esquema es gpt-<generacion>-<nombre>. Los nombres sueltos (sol, luna,
   * terra) NO valen como --model: les falta el prefijo.
   *
   * Rechazados por esta via, aunque existan: gpt-6.1-luna, gpt-6.1-astra,
   * gpt-6.1-spark, gpt-6-terra, toda la familia *-codex y los gpt-5 / o3.
   * El mensaje es "not supported when using Codex with a ChatGPT account",
   * asi que puede ser cuestion de plan: con Pro quiza aparezcan mas.
   */
  modelos: ['gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-sol'],
  esfuerzos: ['low', 'medium', 'high'],

  reanuda: true,
  // Lo que usa el CLI si no se le dice nada, comprobado en ejecucion.
  modeloPorDefecto: 'gpt-6.1-sol',

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
   * Codex reparte el turno en varios eventos y el texto llega ANTES del que
   * lo cierra, asi que no vale con quedarse con el ultimo. Esquema real,
   * capturado de una ejecucion:
   *
   *   {"type":"thread.started","thread_id":"..."}
   *   {"type":"turn.started"}
   *   {"type":"item.completed","item":{"type":"agent_message","text":"..."}}
   *   {"type":"turn.completed","usage":{...}}
   *
   * Por eso se va recogiendo por el camino en vez de guardar un solo evento.
   */
  recolectar(ev, bolsa) {
    if (!ev || !ev.type) return;
    if (ev.type === 'thread.started' && ev.thread_id) bolsa.sesion = ev.thread_id;
    if (ev.type === 'item.completed' && ev.item && ev.item.type === 'agent_message') {
      // El ultimo mensaje del agente es su respuesta; los anteriores son
      // pasos intermedios.
      bolsa.texto = ev.item.text || '';
    }
    if (ev.type === 'turn.completed') {
      bolsa.cerrado = true;
      if (ev.usage) bolsa.uso = ev.usage;
    }
    if (ev.type === 'turn.failed' || ev.type === 'error') {
      bolsa.error = (ev.error && (ev.error.message || ev.error)) || ev.message || 'error de Codex';
    }
  },

  esFinal(ev) {
    return !!ev && ev.type === 'turn.completed';
  },

  limiteDe(ev) {
    if (!ev || !ev.type) return null;
    if (!/rate.?limit|usage.?limit/i.test(ev.type)) return null;
    return ev.rate_limit_info || ev.rate_limits || null;
  },

  resultado(final, { stdout, stderr, code, bolsa = {} }) {
    if (bolsa.error) {
      return { ok: false, error: String(bolsa.error), sessionId: bolsa.sesion || null };
    }
    if (typeof bolsa.texto !== 'string') {
      const detalle = (stderr || stdout || '').trim().slice(-600);
      return { ok: false, error: `Salida no interpretable (code ${code}): ${detalle || 'sin salida'}` };
    }

    const u = bolsa.uso || (final && final.usage) || null;
    return {
      ok: true,
      text: bolsa.texto,
      // thread_id: permite continuar la conversacion con "exec resume".
      sessionId: bolsa.sesion || null,
      // Codex no publica coste en dolares: null, no un cero que se leeria
      // como gratis.
      cost: null,
      numTurns: null,
      uso: u ? {
        input_tokens: u.input_tokens || 0,
        output_tokens: u.output_tokens || 0,
        cache_read_input_tokens: u.cached_input_tokens || 0,
        cache_creation_input_tokens: u.cache_write_input_tokens || 0
      } : null,
      modelUsage: null,
      raw: final
    };
  }
};
