'use strict';
const path = require('node:path');
const { runTurn } = require('./runner');

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
      if (!to) {
        this.store.db.prepare("UPDATE mailbox SET status='blocked', reason='destinatario inexistente' WHERE id = ?").run(mail.id);
        continue;
      }

      const remitente = from ? `${from.name}${from.area ? ` (${from.area})` : ''}` : 'el usuario';
      const prompt = [
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

  async execute(turn, agent) {
    this.active.set(turn.id, turn.agent_id);
    this.store.markTurnRunning(turn.id);
    this.store.updateAgent(agent.id, { status: 'working' });
    this.store.event('turn.started', agent.id, { turn_id: turn.id, origin: turn.origin });

    const log = path.join(this.cfg.logsDir, `${agent.id}.log`);
    let out;
    try {
      out = await runTurn(this.cfg, agent, turn, log);
    } catch (err) {
      out = { ok: false, error: err.message };
    }

    this.active.delete(turn.id);

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
