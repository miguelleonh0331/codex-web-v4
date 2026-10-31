'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { runTurn } = require('./runner');
const { uid } = require('./db');
const proveedores = require('./proveedores');
const guardia = require('./guardia');
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
/**
 * Distingue "no hay cuota" de cualquier otro fallo.
 *
 * Solo estos se reintentan: un error de codigo o una ruta mal escrita
 * fallarian igual dentro de media hora, y reintentarlos seria un bucle.
 * Los mensajes llegan del CLI en ingles.
 */
function esLimiteDeCuota(error) {
  const t = String(error || '');
  return /hit your \d+-hour limit/i.test(t) ||
         /usage limit reached/i.test(t) ||
         /rate.?limit/i.test(t) ||
         /\bquota\b/i.test(t) ||
         /resets? \d{1,2}(:\d{2})?\s*(am|pm)/i.test(t);
}

class Orchestrator {
  constructor(cfg, store) {
    this.cfg = cfg;
    this.store = store;
    this.timer = null;
    this.active = new Map();   // turnId -> agentId
    this.reintentados = new Set();   // turnos que ya se reintentaron tras recuperar la sesion
    this.procesos = new Map();       // turnId -> proceso en marcha, para poder pararlo
    // agentId -> valor de ctx_visto cuando se compacto por umbral. Impide
    // compactar en bucle: /compact no deja medida nueva, asi que ctx_usado
    // sigue alto hasta que el agente hace un turno de verdad.
    this.compactados = new Map();
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

    // Tope de gasto: se comprueba antes de lanzar, no en medio. Un turno ya
    // empezado termina; lo que se frena es empezar otro.
    const tope = Number(this.cfg.topeGastoDiario) || 0;
    if (tope > 0) {
      const hoy = this.store.gastoDelDia(this.cfg.zonaHoraria);
      if (hoy.total >= tope) {
        if (!this.avisoTope || Date.now() - this.avisoTope > 600000) {
          this.avisoTope = Date.now();
          this.store.event('gasto.tope', null, { gastado: hoy.total, tope, turnos: hoy.turnos });
        }
        return;
      }
    }

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

      // Si arrastra demasiado contexto, compactar ANTES de este turno. El
      // turno pendiente no se pierde: espera al siguiente reparto. Esto es lo
      // que evita los turnos de 15 dolares que solo releen conversacion vieja.
      const compactado = this.compactarSiHaceFalta(turn, agent);
      if (compactado) { lanzados += 1; continue; }

      this.execute(turn, agent);
      lanzados += 1;
    }
  }

  /**
   * Compacta la conversacion de un agente antes de gastarle un turno caro.
   *
   * Por que importa: el coste de un turno sigue al contexto que arrastra
   * (correlacion medida 0,71 sobre los turnos reales de este servidor), no a
   * la dificultad de la tarea. Un turno tardio puede releer 11 millones de
   * tokens para hacer nueve pasos.
   *
   * Devuelve true si lanzo una compactacion, y entonces el turno original
   * espera al siguiente reparto.
   */
  compactarSiHaceFalta(turn, agent) {
    const umbral = Number(this.cfg.compactarAlPorcentaje);
    if (!(umbral > 0)) return false;                 // 0 = desactivado
    if (turn.origin === 'compactar') return false;   // no compactar la compactacion
    if (!agent.session_id) return false;             // sin hilo no hay nada que compactar
    if (!agent.ctx_ventana || !agent.ctx_usado) return false;  // sin medida, no adivinamos

    // Un turno que vuelve de esperar cuota merece mas margen: va a releer todo
    // el contexto otra vez, y ya lleva media hora parado, asi que compactar
    // antes no le cuesta tiempo a nadie. Uno de tus turnos acumulo 13,45 $ con
    // seis reintentos de este tipo.
    const reintentado = (turn.reintentos || 0) > 0;
    const umbralEfectivo = reintentado ? Math.max(40, umbral - 20) : umbral;

    const pct = (agent.ctx_usado / agent.ctx_ventana) * 100;
    if (pct < umbralEfectivo) return false;

    // Trampa importante: /compact no consume contexto, asi que no deja medida
    // nueva y ctx_usado sigue alto despues de compactar. Sin esta guarda,
    // compactariamos en bucle a cada reparto y el agente no trabajaria nunca.
    // Esperamos a que llegue una medida NUEVA (ctx_visto cambia) para volver a
    // considerarlo.
    if (this.compactados.get(agent.id) === agent.ctx_visto) return false;

    // Y si ya hay una compactacion esperando para este agente, no apilar otra.
    const yaHay = this.store.db.prepare(
      `SELECT 1 FROM turns WHERE agent_id = ? AND origin = 'compactar'
        AND status IN ('pending','running','esperando_cuota') LIMIT 1`).get(agent.id);
    if (yaHay) return false;

    const id = this.store.enqueueTurn({
      agentId: agent.id, prompt: '/compact', origin: 'compactar',
      chainId: uid('chain'), hop: 0
    });
    const tc = this.store.getTurn(id);
    if (!tc) return false;

    this.compactados.set(agent.id, agent.ctx_visto);
    this.store.event('contexto.compactar_auto', agent.id, {
      pct: Math.round(pct), umbral: umbralEfectivo, reintentado,
      usado: agent.ctx_usado, ventana: agent.ctx_ventana, turno_aplazado: turn.id
    });
    this.store.addMessage(agent.id, 'system',
      `Contexto al ${Math.round(pct)}% de su ventana: se compacta antes de seguir. `
      + 'El trabajo pendiente sigue en cola y sale en cuanto termine.',
      { turn_id: tc.id });
    console.log(`[orq] ${agent.name} al ${Math.round(pct)}% de contexto: compacto antes del turno ${turn.id}`);

    this.execute(tc, agent);
    return true;
  }

  /** Cada evento del CLI segun llega: limites, herramientas y contexto. */
  alVuelo(agent, turn, ev) {
    // Cada proveedor avisa de los limites de uso a su manera.
    const limite = proveedores.paraAgente(agent, this.cfg).limiteDe(ev);
    if (limite) return this.store.guardarLimite(limite);

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
      const tokens = (v) => (v.inputTokens || 0) + (v.cacheReadInputTokens || 0) + (v.cacheCreationInputTokens || 0);

      // El modelo principal es el que mas trabajo hizo, no el primero de la
      // lista: un turno usa tambien modelos auxiliares (haiku para tareas
      // menores) y con opusplan conviven dos.
      const principal = Object.entries(mu).sort((a, b) => tokens(b[1]) - tokens(a[1]))[0];
      if (!principal || !principal[1].contextWindow) return;

      // El contexto es el tamano de la ULTIMA llamada, no la suma del turno:
      // cada llamada vuelve a leer la cache, asi que sumarlas contaba el mismo
      // contexto una vez por herramienta usada y daba cifras imposibles.
      const u = ev.usage || {};
      const it = Array.isArray(u.iterations) ? u.iterations : [];
      const ultima = it.length ? it[it.length - 1] : null;
      const usado = ultima
        ? (ultima.input_tokens || 0) + (ultima.cache_read_input_tokens || 0) + (ultima.cache_creation_input_tokens || 0)
        : (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);

      // Un turno que no consume contexto (como /compact) no mide nada: guardar
      // un cero borraria la ultima medida buena y mostraria 0% falso.
      if (usado > 0) {
        this.store.guardarContexto(agent.id, { usado, ventana: principal[1].contextWindow, modelo: principal[0] });
      }
    }
  }

  /**
   * Para lo que el especialista este haciendo y vacia su cola.
   * Devuelve que se paro, para poder decirselo al usuario con precision.
   */
  /**
   * Aviso al exterior de que algo termino. Se envuelve a proposito: un fallo
   * de red al notificar no puede tumbar el turno, que ya esta hecho y
   * guardado.
   */
  notificar(tipo, agent, extra) {
    if (typeof this.alAvisar !== 'function') return;
    Promise.resolve()
      .then(() => this.alAvisar(tipo, agent, extra))
      .catch((e) => { try { this.store.event('push.error', agent.id, { error: e.message }); } catch {} });
  }

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

    // Foto de las rutas protegidas antes de empezar. Si el especialista toca
    // algo ahi, se sabra al terminar y se podra deshacer.
    let foto = null;
    let dirFoto = null;
    try {
      if ((this.cfg.rutasProtegidas || []).length) {
        dirFoto = path.join(this.cfg.dataDir, 'guardia', String(turn.id));
        foto = guardia.fotografiar(this.cfg, dirFoto);
      }
    } catch (e) {
      this.store.event('guardia.error', agent.id, { turn_id: turn.id, error: e.message });
    }

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

    // Y la comprobacion. Se hace pase lo que pase con el turno: un turno que
    // fallo o que se corto a medias es justo cuando mas probable es que haya
    // dejado algo a medio escribir.
    if (foto) {
      try {
        const cambios = guardia.comparar(foto, guardia.fotografiar(this.cfg, null));
        if (cambios.length) {
          fs.writeFileSync(path.join(dirFoto, 'manifiesto.json'), JSON.stringify(foto));
          const id = this.store.registrarIncidente({
            turnId: turn.id, agentId: agent.id, cambios, foto: dirFoto
          });
          this.store.event('guardia.cambio', agent.id, { turn_id: turn.id, incidente: id, n: cambios.length });
          this.notificar('guardia', agent, { cambios, incidente: id });
        } else {
          // Sin cambios no hay nada que deshacer: la copia solo ocuparia disco.
          fs.rmSync(dirFoto, { recursive: true, force: true });
        }
      } catch (e) {
        this.store.event('guardia.error', agent.id, { turn_id: turn.id, error: e.message });
      }
    }

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

    if (out.ok && turn.origin === 'compactar') {
      if (out.sessionId) this.store.updateAgent(agent.id, { session_id: out.sessionId });
      const despues = this.store.getAgent(agent.id);
      const antes = agent.ctx_usado || 0;
      const ahora = despues.ctx_usado || 0;
      const miles = (n) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
      const texto = antes && ahora && ahora < antes
        ? `Contexto compactado: ${miles(antes)} → ${miles(ahora)} tokens. El especialista conserva el resumen de lo hablado.`
        : antes
          ? `Contexto compactado (venia de ${miles(antes)} tokens). El tamano nuevo se medira en su proxima respuesta.`
          : 'Contexto compactado. El especialista conserva el resumen de lo hablado.';
      this.store.addMessage(agent.id, 'system', texto, { turn_id: turn.id, compactado: true });
      this.store.finishTurn(turn.id, {
        status: 'done', result: texto, cost: out.cost, numTurns: out.numTurns, sessionId: out.sessionId,
        uso: out.uso, proveedor: proveedores.paraAgente(agent, this.cfg).nombre,
        modelo: agent.model || this.cfg.model || null
      });
      this.store.event('contexto.compactado', agent.id, { antes, despues: ahora });
      this.store.updateAgent(agent.id, { status: 'idle' });
      return;
    }

    if (out.ok) {
      if (out.sessionId) this.store.updateAgent(agent.id, { session_id: out.sessionId });
      this.store.addMessage(agent.id, 'assistant', out.text || '(sin texto)', {
        turn_id: turn.id, cost: out.cost, num_turns: out.numTurns
      });
      this.store.finishTurn(turn.id, {
        status: 'done', result: out.text, cost: out.cost, numTurns: out.numTurns,
        sessionId: out.sessionId,
        // Se apunta con que motor y modelo se hizo: sin eso, el informe no
        // podria comparar lo que cuesta cada proveedor.
        uso: out.uso,
        proveedor: proveedores.paraAgente(agent, this.cfg).nombre,
        modelo: agent.model || this.cfg.model || null
      });
      this.store.event('turn.done', agent.id, { turn_id: turn.id, cost: out.cost });
      // Si venia esperando cuota, el aviso lo dice: puede haber retomado de
      // madrugada y conviene saber que ya no esta parado.
      this.notificar('turn.done', agent, {
        texto: out.text,
        retomado: (turn.reintentos || 0) > 0
      });
    } else if (esLimiteDeCuota(out.error)) {
      // No es un fallo del trabajo: es que no hay cuota ahora mismo. El turno
      // se aparca con su texto intacto y vuelve a salir solo. Perderlo
      // obligaria a reescribir la orden cuando vuelva la cuota.
      const esperaMs = Number(this.cfg.reintentoCuotaMs) > 0 ? Number(this.cfg.reintentoCuotaMs) : 1800000;
      const topeMs = Number(this.cfg.topeEsperaCuotaMs) > 0 ? Number(this.cfg.topeEsperaCuotaMs) : 86400000;
      const desde = turn.espera_desde ? new Date(turn.espera_desde).getTime() : Date.now();

      if (Date.now() - desde >= topeMs) {
        // Un dia entero esperando: algo mas pasa. Se rinde y avisa, en vez de
        // reintentar indefinidamente.
        const horas = Math.round(topeMs / 3600000);
        this.store.addMessage(agent.id, 'system',
          `Se abandona tras ${horas} h esperando cuota: ${out.error}`, { turn_id: turn.id });
        this.store.finishTurn(turn.id, { status: 'error', error: out.error });
        this.store.event('turn.error', agent.id, { turn_id: turn.id, error: out.error });
        this.notificar('turn.error', agent, { error: `Sin cuota tras ${horas} h. Trabajo abandonado.` });
      } else {
        const proximo = new Date(Date.now() + esperaMs).toISOString();
        this.store.esperarCuota(turn.id, proximo, out.error);
        this.store.event('turn.espera_cuota', agent.id, {
          turn_id: turn.id, proximo, reintentos: (turn.reintentos || 0) + 1
        });
        this.store.updateAgent(agent.id, { status: 'idle' });
        return;   // sin mensaje de error: el trabajo no se ha perdido
      }
    } else {
      // Una sesion que ya no se puede reanudar no debe dejar al agente inservible.
      if (/resume|session/i.test(out.error || '') && agent.session_id) {
        this.store.updateAgent(agent.id, { session_id: null });
        this.store.event('session.reset', agent.id, { motivo: out.error });
      }
      this.store.addMessage(agent.id, 'system', `Error en el turno: ${out.error}`, { turn_id: turn.id });
      this.store.finishTurn(turn.id, { status: out.timeout ? 'timeout' : 'error', error: out.error });
      this.store.event('turn.error', agent.id, { turn_id: turn.id, error: out.error });
      this.notificar('turn.error', agent, { error: out.error });
    }

    this.store.updateAgent(agent.id, { status: 'idle' });
  }
}

module.exports = { Orchestrator, esLimiteDeCuota };
