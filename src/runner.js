'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const COLABORACION = `
PROTOCOLO DE COLABORACION (obligatorio)

Trabajas dentro de un equipo de especialistas. Cada uno tiene su area y su propia
conversacion. Dispones de herramientas reales para hablar con ellos:

- mcp__v4__list_agents  : quien existe y de que se encarga cada uno.
- mcp__v4__send_message : enviar una consulta o una respuesta a otro especialista.
- mcp__v4__ask_team     : preguntar lo mismo a TODO el equipo de una vez.
- mcp__v4__create_specialist : dar de alta un especialista que falta.
- mcp__v4__read_inbox   : releer lo que te han enviado.
- mcp__v4__claim_files  : reservar archivos ANTES de editarlos.
- mcp__v4__release_files: liberarlos al terminar.
- mcp__v4__list_claims  : ver que esta reservado y por quien.

Reglas:
1. Si necesitas algo del area de otro especialista, PREGUNTASELO con send_message.
   Nunca inventes ni simules su respuesta, y no des por hecho lo que diria.

1-bis. QUIEN TE PREGUNTA CAMBIA LO QUE DEBES HACER:
   - Si te escribe EL USUARIO y el asunto es de otra area: no lo rechaces. Averigua
     con list_agents a quien corresponde, consultale con send_message y, cuando
     responda, entregale tu la conclusion al usuario. El usuario habla contigo; el
     equipo se organiza solo.
   - Si no hay ningun especialista para ese asunto, dilo y resuelvelo tu si puedes.
   - Si te escribe OTRO ESPECIALISTA algo que no es tuyo: dilo y NO lo reenvies a
     nadie. Asi se evitan las cadenas que no terminan.
   - Si la pregunta llega por ask_team (va dirigida a todo el equipo): responde solo
     desde tu area, breve. Si no te afecta, dilo en una linea. Nunca reenvies un
     ask_team ni lances otro como respuesta.
2. La entrega es asincrona: send_message deja el mensaje y despierta al otro en su
   propio turno. Su respuesta te llegara despues como un mensaje nuevo. No esperes
   dentro de este turno ni reenvies el mismo mensaje.
3. Si te escriben a ti, responde al remitente con send_message. Contestar solo en tu
   texto no le llega.
4. Antes de editar cualquier archivo, reservalo con claim_files. Si te lo rechazan,
   no lo toques: coordina con su responsable.
5. ask_team es para cuando necesitas saber a quien afecta algo o quien esta tocando
   una zona del codigo. No lo uses para tareas: para eso delega en quien corresponde.
5-bis. SI NO EXISTE EL ESPECIALISTA QUE HACE FALTA:
   - comprueba primero con list_agents que de verdad no esta;
   - si hay un Arquitecto en el equipo, consultale a el: dar de alta un area es
     decision suya;
   - si no lo hay, crealo tu con create_specialist, con rutas reales y limites
     claros, y delegale la parte que le toca.
   Nunca inventes un area que ya cubre otro ni crees un especialista para una
   tarea puntual.
6. Cuando hayas cumplido tu parte, TERMINA. No generes cadenas de cortesia ni
   agradecimientos; cada mensaje despierta al otro agente y consume trabajo real.
7. Entrega siempre: resultado, archivos tocados, validacion hecha y pendientes.
   Si algo te bloquea (permiso, dependencia, respuesta que no llega), dilo con precision.
`.trim();

function buildSystemPrompt(agent, cfg) {
  const partes = [];
  partes.push(`Eres "${agent.name}", especialista de ${agent.area || 'area no definida'} dentro del equipo codex-web-v4.`);
  partes.push(agent.instructions.trim());

  if (cfg.project && cfg.project.path) {
    const p = [`PROYECTO: ${cfg.project.name || 'sin nombre'}`, `Codigo fuente: ${cfg.project.path}`];
    if (cfg.project.deployPath) p.push(`Despliegue: ${cfg.project.deployPath}`);
    if (cfg.project.validate) p.push(`Validacion del proyecto: ${cfg.project.validate}`);
    p.push('Lee las instrucciones del repositorio y revisa el estado de Git antes de editar.');
    partes.push(p.join('\n'));
  }

  partes.push(`Tu espacio de trabajo propio es ${agent.workspace}. Usalo para notas y borradores.`);
  partes.push(COLABORACION);
  return partes.join('\n\n');
}

function writeMcpConfig(cfg, agent, { chainId, hop }) {
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

/**
 * Ejecuta un turno del agente. Devuelve { ok, text, sessionId, cost, numTurns, raw, error }.
 */
function runTurn(cfg, agent, turn, log) {
  return new Promise((resolve) => {
    if (!cfg.claudeBin) {
      return resolve({ ok: false, error: 'No se encontro el binario de Claude Code (config.claudeBin).' });
    }

    fs.mkdirSync(agent.home, { recursive: true });
    fs.mkdirSync(agent.workspace, { recursive: true });

    const mcpFile = writeMcpConfig(cfg, agent, { chainId: turn.chain_id, hop: turn.hop });
    const args = [
      '-p', turn.prompt,
      '--output-format', 'json',
      '--permission-mode', 'bypassPermissions',
      '--mcp-config', mcpFile,
      '--append-system-prompt', buildSystemPrompt(agent, cfg)
    ];
    if (agent.model || cfg.model) args.push('--model', agent.model || cfg.model);
    const esfuerzo = agent.effort || cfg.effort;
    if (esfuerzo) args.push('--effort', esfuerzo);
    if (agent.session_id) args.push('--resume', agent.session_id);

    const env = {
      ...process.env,
      HOME: agent.home,
      CLAUDE_CONFIG_DIR: cfg.sessionDir,
      V4_AGENT_ID: agent.id,
      V4_AGENT_NAME: agent.name
    };

    const child = spawn(cfg.claudeBin, args, { cwd: agent.workspace, env, stdio: ['ignore', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGKILL'); } catch { /* ya murio */ }
      resolve({ ok: false, error: `Tiempo agotado tras ${Math.round(cfg.turnTimeoutMs / 1000)}s`, timeout: true });
    }, cfg.turnTimeoutMs);

    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, error: `No se pudo lanzar Claude: ${err.message}` });
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      if (log) {
        try {
          fs.appendFileSync(log, `\n==== turno ${turn.id} agente ${agent.name} code=${code} ====\n${stdout}\n--- stderr ---\n${stderr}\n`);
        } catch { /* el log no debe tumbar el turno */ }
      }

      let parsed = null;
      try { parsed = JSON.parse(stdout); } catch { /* salida no JSON */ }

      if (!parsed) {
        const detalle = (stderr || stdout || '').trim().slice(-600);
        return resolve({ ok: false, error: `Salida no interpretable (code ${code}): ${detalle || 'sin salida'}` });
      }

      if (parsed.is_error) {
        return resolve({
          ok: false,
          error: String(parsed.result || 'error reportado por Claude'),
          sessionId: parsed.session_id,
          raw: parsed
        });
      }

      resolve({
        ok: true,
        text: String(parsed.result ?? ''),
        sessionId: parsed.session_id,
        cost: parsed.total_cost_usd,
        numTurns: parsed.num_turns,
        raw: parsed
      });
    });
  });
}

module.exports = { runTurn, buildSystemPrompt, COLABORACION };
