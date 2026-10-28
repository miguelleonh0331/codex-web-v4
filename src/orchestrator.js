'use strict';
const path = require('node:path');
const { runTurn } = require('./runner');
const sesion = require('./session');

/** Resume la llamada a una herramienta en una linea legible. */
function resumirHerramienta(nombre, entrada) {
  const e = entrada || {};
  const corto = (v, n = 160) => String(v).replace(/\s+/g, ' ').slice(0, n);
  switch (nombre) {
    case 'Bash': return corto(e.command || '');
    case 'Read': return corto(e.file_path || e.path || '');
    case 'Write': case 'Edit': case 'NotebookEdit': return corto(e.file_path || '');
    case 'Grep': return `"${corto(e.pattern || '', 60)}"${e.path ? ` en ${corto(e.path, 60)}` : ''}`;
    case 'Glob': return corto(e.pattern || '');
    case 'WebFetch': case 'WebSearch': return corto(e.url || e.query || '');
    case 'mcp__v4__send_message': return `a ${corto(e.to || '?', 40)}: ${corto(e.text || '', 90)}`;
    case 'mcp__v4__ask_team': return `a todo el equipo: ${corto(e.text || '', 110)}`;
    case 'mcp__v4__claim_files': case 'mcp__v4__release_files': return corto((e.paths || []).join(', '));
    case 'mcp__v4__create_specialist': return corto(e.name || '');
    default: {
      const primera = Object.values(e).find((v) => typeof v === 'string');
      return primera ? corto(primera) : '';
    }
  }
}

/** Nombre amable para la tira de actividad. */
function etiquetaHerramienta(nombre) {
  const mapa = {
    Bash: 'ejecuta', Read: 'lee', Write: 'escribe', Edit: 'edita', Grep: 'busca',
    Glob: 'lista', WebFetch: 'consulta la web', WebSearch: 'busca en la web',
    TodoWrite: 'planifica', Task: 'delega',
    mcp__v4__send_message: 'escribe a', mcp__v4__ask_team: 'pregunta al equipo',
    mcp__v4__claim_files: 'reserva', mcp__v4__release_files: 'libera',
    mcp__v4__list_agents: 'mira el equipo', mcp__v4__read_inbox: 'lee su buzon',
    mcp__v4__list_claims: 'mira las reservas', mcp__v4__create_specialist: 'crea especialista'
  };
  return mapa[nombre] || nombre;
}

/**
 * Motor de turnos: decide quien ejecuta, entrega el correo entre agentes
 * y mantiene la conversacion de cada especialista.
 */
class Orchestrator {
  constructor(cfg, store) {
    this.cfg = cfg;
    this.store = store;
    this.timer = null;
    this.active = new Map();   // turnId -> agentId
    this.reintentados = new Set();   // turnos que ya se reintentaron tras recuperar la sesion
    this.procesos = new Map();       // turnId -> proceso en marcha, para poder pararlo
    this.cancelados = new Set();     // turnos parados a mano: su error no es un fallo
    this.stopping = false;
  }

  start(intervalMs = 1000) {
    const recovered = this.store.recoverStaleTurns();
    if (recovered) console.log(`[orq] ${recovered} turno(s) interrumpido(s) por un reinicio previo, marcados como error`);
    this.timer = setInterval(() => this.tick().catch((e) => console.error('[orq]', e)), intervalMs);
    this.tick().catch(() => {});
  }

  stop() {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
  }

  get busy() { return this.active.size; }

  async tick() {
    if (this.stopping) return;
    this.deliverMail();
    this.dispatch();
  }

  /** Convierte el correo encolado en turnos del destinatario. */
  deliverMail() {
    const pend = this.store.db
      .prepare("SELECT * FROM mailbox WHERE status = 'queued' ORDER BY id ASC LIMIT 20")
      .all();

    for (const mail of pend) {
      const from = this.store.getAgent(mail.from_agent);
      const to = this.store.getAgent(mail.to_agent);
      if (!to || to.archived) {
        this.store.db
          .prepare("UPDATE mailbox SET status='blocked', reason=? WHERE id = ?")
          .run(to ? 'el destinatario esta archivado' : 'destinatario inexistente', mail.id);
        continue;
      }

      const remitente = from ? `${from.name}${from.area ? ` (${from.area})` : ''}` : 'el usuario';

      // Si el mismo cuerpo fue a varios destinatarios en la misma cadena, es una difusion.
      const difusion = this.store.db
        .prepare('SELECT COUNT(*) AS c FROM mailbox WHERE chain_id = ? AND body = ?')
        .get(mail.chain_id, mail.body).c > 1;

      const prompt = difusion
        ? [
          `[PREGUNTA A TODO EL EQUIPO - de ${remitente}]`,
          '',
          mail.body,
          '',
          'Responde solo desde tu area y se breve. Si no te afecta, dilo en una linea.',
          `Envia tu respuesta a "${from ? from.name : 'el usuario'}" con mcp__v4__send_message.`,
          'No reenvies esta pregunta: ya la han recibido todos. Al terminar, detente.'
        ].join('\n')
        : [
          `[MENSAJE INTERNO del equipo - de ${remitente}]`,
          '',
          mail.body,
          '',
          `Atiende esta consulta dentro de tu area. Cuando tengas la respuesta, enviasela a "${from ? from.name : 'el usuario'}" con mcp__v4__send_message.`,
          'Si no es de tu competencia, dilo y no reenvies a nadie mas. Al terminar, detente.'
        ].join('\n');

      this.store.addMessage(to.id, 'peer', mail.body, { from: from ? from.name : null, mailbox_id: mail.id });
      this.store.enqueueTurn({
        agentId: to.id,
        prompt,
        origin: 'peer',
        mailboxId: mail.id,
        chainId: mail.chain_id,
        hop: mail.hop + 1
      });
      this.store.markMailDelivered(mail.id);
    }
  }

  /** Lanza turnos pendientes respetando el limite de concurrencia. */
  dispatch() {
    const libres = this.cfg.maxConcurrentTurns - this.active.size;
    if (libres <= 0) return;

    const candidatos = this.store.nextPendingTurns(libres * 4);
    let lanzados = 0;

    for (const turn of candidatos) {
      if (lanzados >= libres) break;
      // Un agente solo ejecuta un turno a la vez: su conversacion es secuencial.
      if ([...this.active.values()].includes(turn.agent_id)) continue;

      const agent = this.store.getAgent(turn.agent_id);
      if (!agent || agent.archived) {
        this.store.finishTurn(turn.id, { status: 'error', error: 'agente inexistente o archivado' });
        continue;
      }

      this.execute(turn, agent);
      lanzados += 1;
    }
  }

  /** Cada evento del CLI segun llega: limites, herramientas y contexto. */
  alVuelo(agent, turn, ev) {
    if (ev.type === 'rate_limit_event' && ev.rate_limit_info) {
      return this.store.guardarLimite(ev.rate_limit_info);
    }

    if (ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
      for (const bloque of ev.message.content) {
        if (bloque.type === 'tool_use') {
          this.store.registrarActividad(agent.id, turn.id, {
            tipo: 'herramienta',
            herramienta: etiquetaHerramienta(bloque.name),
            resumen: resumirHerramienta(bloque.name, bloque.input),
            detalle: JSON.stringify(bloque.input || {})
          });
        }
      }
    }

    if (ev.type === 'result') {
      const mu = ev.modelUsage || {};
      const modelo = Object.keys(mu)[0];
      const u = modelo ? mu[modelo] : null;
      if (u && u.contextWindow) {
        this.store.guardarContexto(agent.id, {
          usado: (u.inputTokens || 0) + (u.cacheReadInputTokens || 0) + (u.cacheCreationInputTokens || 0),
          ventana: u.contextWindow,
          modelo
        });
      }
    }
  }

  /**
   * Para lo que el especialista este haciendo y vacia su cola.
   * Devuelve que se paro, para poder decirselo al usuario con precision.
   */
  detener(agentId) {
    let parado = 0;
    for (const [turnId, agente] of this.active) {
      if (agente !== agentId) continue;
      this.cancelados.add(turnId);
      const proc = this.procesos.get(turnId);
      if (proc) {
        try { proc.kill('SIGTERM'); } catch { /* ya murio */ }
        // Si no se va por las buenas, se fuerza.
        setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* ya murio */ } }, 4000).unref();
      }
      parado += 1;
    }

    const enCola = this.store.db
      .prepare("SELECT id FROM turns WHERE agent_id = ? AND status = 'pending'").all(agentId);
    for (const t of enCola) {
      this.store.finishTurn(t.id, { status: 'cancelado', error: 'descartado al detener al especialista' });
    }
    if (!parado && !enCola.length) this.store.updateAgent(agentId, { status: 'idle' });

    this.store.event('agente.detenido', agentId, { en_curso: parado, en_cola: enCola.length });
    return { en_curso: parado, en_cola: enCola.length };
  }

  async execute(turn, agent) {
    this.active.set(turn.id, turn.agent_id);
    this.store.markTurnRunning(turn.id);
    this.store.updateAgent(agent.id, { status: 'working' });
    this.store.event('turn.started', agent.id, { turn_id: turn.id, origin: turn.origin });

    const log = path.join(this.cfg.logsDir, `${agent.id}.log`);
    let out;
    try {
      out = await runTurn(
        this.cfg, agent, turn, log,
        (ev) => this.alVuelo(agent, turn, ev),
        (proc) => this.procesos.set(turn.id, proc)
      );
    } catch (err) {
      out = { ok: false, error: err.message };
    }

    this.active.delete(turn.id);
    this.procesos.delete(turn.id);

    // Si lo paro el usuario, no es un error del especialista: se cuenta como tal.
    if (this.cancelados.has(turn.id)) {
      this.cancelados.delete(turn.id);
      this.store.addMessage(agent.id, 'system', 'Turno detenido por el usuario.', { turn_id: turn.id });
      this.store.finishTurn(turn.id, { status: 'cancelado', error: 'detenido por el usuario' });
      this.store.event('turn.cancelado', agent.id, { turn_id: turn.id });
      this.store.updateAgent(agent.id, { status: 'idle' });
      return;
    }

    // Una sesion caducada no es culpa del turno: se recupera y se reintenta una vez.
    if (!out.ok && /oauth|authenticate|session expired|not logged in/i.test(out.error || '') && !this.reintentados.has(turn.id)) {
      this.reintentados.add(turn.id);
      const r = sesion.recuperar(this.cfg);
      this.store.event('session.recuperada', agent.id, { turn_id: turn.id, ok: r.ok, motivo: r.motivo || null, expira: r.expira || null });
      if (r.ok) {
        console.warn(`[orq] sesion caducada: recuperada del origen (vence ${r.expira}); reintentando turno ${turn.id}`);
        this.store.db.prepare("UPDATE turns SET status='pending', started_at=NULL WHERE id = ?").run(turn.id);
        this.store.updateAgent(agent.id, { status: 'idle' });
        return;
      }
      console.error(`[orq] sesion caducada y no se pudo recuperar: ${r.motivo}`);
      out = { ok: false, error: `Sesion de Claude caducada y no se pudo recuperar: ${r.motivo}. Actualiza ${sesion.archivoSesion(this.cfg)}` };
    }

    // Un hilo de conversacion que ya no existe (se movio el directorio de sesion, se
    // limpio el historial) no debe costarle al usuario el mensaje: se empieza hilo
    // nuevo y se reintenta el mismo turno una vez.
    if (!out.ok && agent.session_id && !this.reintentados.has(turn.id) &&
        /no conversation found|session id|--resume|resume/i.test(out.error || '')) {
      this.reintentados.add(turn.id);
      this.store.updateAgent(agent.id, { session_id: null });
      this.store.event('session.reset', agent.id, { turn_id: turn.id, motivo: out.error, reintentado: true });
      console.warn(`[orq] hilo inexistente para ${agent.name}: se empieza uno nuevo y se reintenta el turno ${turn.id}`);
      this.store.db.prepare("UPDATE turns SET status='pending', started_at=NULL WHERE id = ?").run(turn.id);
      this.store.updateAgent(agent.id, { status: 'idle' });
      return;
    }

    if (out.ok) {
      if (out.sessionId) this.store.updateAgent(agent.id, { session_id: out.sessionId });
      this.store.addMessage(agent.id, 'assistant', out.text || '(sin texto)', {
        turn_id: turn.id, cost: out.cost, num_turns: out.numTurns
      });
      this.store.finishTurn(turn.id, {
        status: 'done', result: out.text, cost: out.cost, numTurns: out.numTurns, sessionId: out.sessionId
      });
      this.store.event('turn.done', agent.id, { turn_id: turn.id, cost: out.cost });
    } else {
      // Una sesion que ya no se puede reanudar no debe dejar al agente inservible.
      if (/resume|session/i.test(out.error || '') && agent.session_id) {
        this.store.updateAgent(agent.id, { session_id: null });
        this.store.event('session.reset', agent.id, { motivo: out.error });
      }
      this.store.addMessage(agent.id, 'system', `Error en el turno: ${out.error}`, { turn_id: turn.id });
      this.store.finishTurn(turn.id, { status: out.timeout ? 'timeout' : 'error', error: out.error });
      this.store.event('turn.error', agent.id, { turn_id: turn.id, error: out.error });
    }

    this.store.updateAgent(agent.id, { status: 'idle' });
  }
}

module.exports = { Orchestrator };
