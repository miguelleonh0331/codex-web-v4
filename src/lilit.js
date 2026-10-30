'use strict';
/**
 * LILIT: auditora del equipo.
 *
 * Mira el estado y decide si hay algo que contarte. NO es un especialista y
 * no usa modelo, por dos razones que decidieron el diseño:
 *
 *   1. Un especialista cuesta un turno cada vez que mira. Vigilar cada
 *      minuto saldria mas caro que el trabajo vigilado.
 *   2. Si dependiera de la cuota, se quedaria muda justo cuando se agota
 *      la cuota, que es uno de los avisos que mas falta hacen.
 *
 * Todo lo que detecta sale de datos que el sistema ya tiene. El modelo
 * externo, si se configura, solo reescribe el aviso para que suene mejor;
 * si no responde, se usa el diccionario y nadie se entera.
 */
const { frase } = require('./lilit-frases');

// Cada cuanto se considera que algo lleva demasiado tiempo.
const MIN_ATASCADO = 45 * 60 * 1000;      // un turno corriendo sin terminar
const MIN_ENCOLADO = 10 * 60 * 1000;      // un turno que no llega a salir
const MIN_EXTERNO_MUDO = 6 * 60 * 60 * 1000;
const CONTEXTO_ALTO = 85;                 // por ciento

// Frases que delatan que un especialista espera algo de ti. Se buscan en su
// ultima respuesta: no hace falta modelo para reconocerlas.
const PIDE_APROBACION = [
  'necesito tu aprobacion', 'necesito tu aprobación', 'espero tu aprobacion',
  'espero tu aprobación', 'necesito autorizacion', 'necesito autorización',
  'no puedo continuar sin', 'requiere tu confirmacion', 'requiere tu confirmación',
  'me confirmas', 'confirmame', 'confírmame', 'autorizas', 'doy por hecho que',
  'esperando tu visto bueno', 'necesito permiso', 'quedo a la espera de tu'
];
const PREGUNTA = [
  'que prefieres', 'qué prefieres', 'cual de las dos', 'cuál de las dos',
  'me puedes decir', 'podrias aclarar', 'podrías aclarar', 'no me queda claro',
  'tengo una duda', 'necesito saber', 'me aclaras'
];

const sinTildes = (s) => String(s || '').toLowerCase()
  .normalize('NFD').replace(/[̀-ͯ]/g, '');

function contiene(texto, lista) {
  const t = sinTildes(texto);
  return lista.some((f) => t.includes(sinTildes(f)));
}

/**
 * Revisa el estado y devuelve los hallazgos.
 *
 * Cada hallazgo lleva una clave estable: asi se sabe cual es nuevo y cual
 * es el mismo de hace un minuto, y no se repite el aviso.
 */
function auditar(store, cfg, extra = {}) {
  const hallazgos = [];
  const ahora = Date.now();
  const edad = (iso) => (iso ? ahora - new Date(iso).getTime() : 0);
  const agentes = store.listAgents();
  const nombre = (id) => {
    const a = agentes.find((x) => x.id === id);
    return a ? a.name : 'un especialista';
  };
  const sql = (q, ...p) => { try { return store.db.prepare(q).all(...p); } catch { return []; } };

  // --- lo que te bloquea a ti: alguien espera una decision tuya ---
  for (const a of agentes) {
    if (a.status !== 'idle') continue;
    const u = sql(
      "SELECT body, created_at FROM messages WHERE agent_id = ? AND role = 'assistant' ORDER BY id DESC LIMIT 1",
      a.id)[0];
    if (!u) continue;
    if (contiene(u.body, PIDE_APROBACION)) {
      hallazgos.push({ clave: `aprobacion:${a.id}:${u.created_at}`, tipo: 'aprobacion',
        nivel: 'normal', quien: a.name, agente: a.id });
    } else if (contiene(u.body, PREGUNTA)) {
      hallazgos.push({ clave: `duda:${a.id}:${u.created_at}`, tipo: 'duda',
        nivel: 'normal', quien: a.name, agente: a.id });
    }
  }

  // --- trabajo que no avanza ---
  for (const t of sql("SELECT id, agent_id, started_at FROM turns WHERE status = 'running'")) {
    if (edad(t.started_at) > MIN_ATASCADO) {
      hallazgos.push({ clave: `atascado:${t.id}`, tipo: 'atascado', nivel: 'urgente',
        quien: nombre(t.agent_id), agente: t.agent_id,
        n: Math.round(edad(t.started_at) / 60000) });
    }
  }
  const encolados = sql("SELECT id, created_at FROM turns WHERE status = 'pending'")
    .filter((t) => edad(t.created_at) > MIN_ENCOLADO);
  if (encolados.length) {
    hallazgos.push({ clave: `encolado:${encolados.length}`, tipo: 'atascado',
      nivel: 'normal', n: encolados.length });
  }

  // --- sin cuota ---
  const esperando = sql("SELECT COUNT(*) c FROM turns WHERE status = 'esperando_cuota'")[0];
  if (esperando && esperando.c) {
    hallazgos.push({ clave: `cuota:${esperando.c}`, tipo: 'cuota', nivel: 'urgente', n: esperando.c });
  }

  // --- fallos recientes, separando los de conexion del resto ---
  const fallos = sql(
    "SELECT agent_id, error FROM turns WHERE status IN ('error','timeout') AND ended_at > ? ORDER BY id DESC LIMIT 20",
    new Date(ahora - 30 * 60 * 1000).toISOString());
  const deRed = fallos.filter((f) => /econn|network|socket|timeout de red|connection|refused|dns|unreachable/i.test(f.error || ''));
  const otros = fallos.filter((f) => !deRed.includes(f));
  if (deRed.length) {
    hallazgos.push({ clave: `conexion:${deRed.length}`, tipo: 'conexion', nivel: 'urgente', n: deRed.length });
  }
  if (otros.length) {
    hallazgos.push({ clave: `error:${otros.length}:${otros[0].agent_id}`, tipo: 'error',
      nivel: 'normal', n: otros.length, quien: nombre(otros[0].agent_id), agente: otros[0].agent_id });
  }

  // --- rutas protegidas tocadas ---
  const inc = sql('SELECT id, agent_id, cambios FROM guardia WHERE visto = 0 ORDER BY id DESC');
  for (const i of inc) {
    let n = 1;
    try { n = JSON.parse(i.cambios).length; } catch { /* da igual */ }
    hallazgos.push({ clave: `guardia:${i.id}`, tipo: 'guardia', nivel: 'urgente',
      quien: nombre(i.agent_id), agente: i.agent_id, n });
  }

  // --- maquinas de fuera ---
  for (const e of sql('SELECT * FROM externos WHERE activo = 1')) {
    const pend = sql('SELECT COUNT(*) c FROM externo_cola WHERE externo_id = ? AND entregado = 0', e.id)[0];
    if (pend && pend.c) {
      hallazgos.push({ clave: `extpend:${e.id}:${pend.c}`, tipo: 'externo_pendiente',
        nivel: 'normal', quien: e.nombre, n: pend.c });
    }
    const mudo = !e.ultimo_visto || edad(e.ultimo_visto) > MIN_EXTERNO_MUDO;
    // Solo se avisa de un externo callado si tiene algo esperandole: que una
    // maquina este apagada no es noticia por si sola.
    if (mudo && pend && pend.c) {
      hallazgos.push({ clave: `extmudo:${e.id}`, tipo: 'externo_mudo', nivel: 'normal', quien: e.nombre });
    }
  }

  // --- comunicacion interna rota ---
  const bloq = sql("SELECT COUNT(*) c FROM mailbox WHERE status = 'blocked' AND created_at > ?",
    new Date(ahora - 60 * 60 * 1000).toISOString())[0];
  if (bloq && bloq.c) {
    hallazgos.push({ clave: `correo:${bloq.c}`, tipo: 'correo_bloqueado', nivel: 'normal', n: bloq.c });
  }

  // --- memoria llenandose ---
  const llenos = agentes.filter((a) => a.ctx_ventana > 0 && (a.ctx_usado / a.ctx_ventana) * 100 > CONTEXTO_ALTO);
  for (const a of llenos) {
    hallazgos.push({ clave: `ctx:${a.id}`, tipo: 'contexto', nivel: 'bajo',
      quien: a.name, agente: a.id, n: Math.round((a.ctx_usado / a.ctx_ventana) * 100) });
  }

  // --- presupuesto ---
  if (extra.gasto && extra.gasto.frenado) {
    hallazgos.push({ clave: `gasto:${extra.gasto.dia}`, tipo: 'gasto', nivel: 'urgente' });
  }

  // --- el proveedor no puede trabajar ---
  if (extra.sesion && extra.sesion.utilizable === false) {
    hallazgos.push({ clave: 'sesion', tipo: 'sesion', nivel: 'urgente' });
  }

  return hallazgos;
}

/**
 * Quien esta trabajando ahora mismo.
 *
 * Esto NO sale en la vigilancia automatica: anunciar cada vez que alguien
 * empieza o termina seria ruido constante. Es para cuando se pide el parte
 * a mano, que es cuando la pregunta es "como vamos".
 */
function actividad(store) {
  const agentes = store.listAgents();
  const sql = (q, ...p) => { try { return store.db.prepare(q).all(...p); } catch { return []; } };

  const trabajando = agentes.filter((a) => a.status === 'working').map((a) => a.name);
  const enCola = sql("SELECT COUNT(*) c FROM turns WHERE status = 'pending'")[0];
  const esperandoCuota = sql("SELECT COUNT(*) c FROM turns WHERE status = 'esperando_cuota'")[0];

  // Cuanto llevan los que estan en marcha: "trabajando" sin mas no dice si
  // acaba de empezar o lleva media hora.
  const corriendo = sql("SELECT agent_id, started_at FROM turns WHERE status = 'running'");
  const masViejo = corriendo.reduce((max, t) => {
    const min = t.started_at ? Math.round((Date.now() - new Date(t.started_at).getTime()) / 60000) : 0;
    return min > max ? min : max;
  }, 0);

  return {
    trabajando,
    enCola: enCola ? enCola.c : 0,
    esperandoCuota: esperandoCuota ? esperandoCuota.c : 0,
    inactivos: agentes.filter((a) => a.status === 'idle').length,
    total: agentes.length,
    desdeHaceMin: masViejo
  };
}

/** El parte de actividad, dicho como se diria en voz alta. */
function decirActividad(act) {
  const lista = (ns) => (ns.length === 1 ? ns[0]
    : `${ns.slice(0, -1).join(', ')} y ${ns[ns.length - 1]}`);

  const partes = [];
  if (!act.trabajando.length) {
    partes.push(act.total
      ? 'Ahora mismo no hay nadie trabajando'
      : 'Todavia no hay especialistas');
  } else if (act.trabajando.length === 1) {
    partes.push(`${act.trabajando[0]} esta trabajando`
      + (act.desdeHaceMin > 1 ? `, lleva ${act.desdeHaceMin} minutos` : ''));
  } else {
    // Mas de tres nombres seguidos no se retienen de oido: se dicen tres y
    // se cierra con "entre otros", que no choca con la "y" de la lista.
    const sobran = act.trabajando.length > 3;
    const ns = act.trabajando.slice(0, 3);
    partes.push(`Hay ${act.trabajando.length} trabajando: `
      + (sobran ? `${ns.join(', ')}, entre otros` : lista(ns)));
  }
  if (act.enCola) partes.push(`${act.enCola} ${act.enCola === 1 ? 'trabajo' : 'trabajos'} en cola`);
  if (act.esperandoCuota) {
    partes.push(`${act.esperandoCuota} ${act.esperandoCuota === 1 ? 'esperando' : 'esperando'} a que vuelva la cuota`);
  }
  return `${partes.join('. ')}.`;
}

/** Convierte un hallazgo en la frase que se dira en voz alta. */
function decir(h) {
  return frase(h.tipo, { n: h.n, quien: h.quien }, h.nivel === 'urgente');
}

module.exports = { auditar, decir, actividad, decirActividad, PIDE_APROBACION, PREGUNTA, contiene };
