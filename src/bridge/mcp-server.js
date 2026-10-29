'use strict';
/**
 * Puente MCP (stdio) que cada agente recibe en su sesion de Claude Code.
 * Expone las herramientas de colaboracion: quien soy, quien mas existe,
 * enviar mensajes a otro especialista, leer el buzon y reservar archivos.
 *
 * Variables de entorno requeridas:
 *   V4_API          URL base del servidor v4 (ej. http://127.0.0.1:3212)
 *   V4_BRIDGE_TOKEN token interno
 *   V4_AGENT_ID     identificador del agente que ejecuta esta sesion
 *   V4_CHAIN_ID     cadena de conversacion en curso (opcional)
 *   V4_HOP          salto actual dentro de la cadena (opcional)
 */

const API = process.env.V4_API || 'http://127.0.0.1:3212';
const TOKEN = process.env.V4_BRIDGE_TOKEN || '';
const AGENT_ID = process.env.V4_AGENT_ID || '';
const CHAIN_ID = process.env.V4_CHAIN_ID || '';
const HOP = Number(process.env.V4_HOP || 0);

const PROTOCOL_VERSION = '2024-11-05';

const TOOLS = [
  {
    name: 'whoami',
    description: 'Devuelve tu identidad como especialista: id, nombre, area y responsabilidad.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'list_agents',
    description: 'Lista los demas especialistas disponibles, con su area y su estado actual. Usala antes de delegar para saber a quien corresponde.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'send_message',
    description: 'Envia un mensaje real a otro especialista y lo despierta para que lo atienda. Es la unica forma de consultarle algo: no supongas su respuesta. La entrega es asincrona.',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Nombre o id del especialista destinatario.' },
        text: { type: 'string', description: 'Mensaje: objetivo, contexto, que esperas de vuelta.' }
      },
      required: ['to', 'text'],
      additionalProperties: false
    }
  },
  {
    name: 'ask_team',
    description: 'Lanza la MISMA pregunta a todos los demas especialistas a la vez y despierta a cada uno. Para saber a quien afecta un cambio o quien esta tocando una zona del codigo. Cada uno respondera por su cuenta; sus respuestas te llegaran como mensajes nuevos. No sirve para repartir tareas: para eso usa send_message con el responsable.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'La pregunta, redactada para que cualquier area pueda contestarla.' }
      },
      required: ['text'],
      additionalProperties: false
    }
  },
  {
    name: 'create_specialist',
    description: 'Da de alta un especialista NUEVO cuando ningun miembro del equipo cubre un area. Usala solo despues de comprobar con list_agents que no existe ya uno adecuado. El nuevo especialista queda disponible de inmediato para todos.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Nombre corto y unico, por su area. Ej: "Reportes".' },
        area: { type: 'string', description: 'Palabras clave de su dominio.' },
        instructions: { type: 'string', description: 'Su responsabilidad, las rutas reales que le pertenecen, sus limites, con quien coordina, que no debe tocar y como valida.' }
      },
      required: ['name', 'area', 'instructions'],
      additionalProperties: false
    }
  },
  {
    name: 'read_inbox',
    description: 'Muestra los ultimos mensajes que otros especialistas te enviaron.',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'integer', minimum: 1, maximum: 100 } },
      additionalProperties: false
    }
  },
  {
    name: 'recordar',
    description: 'Busca en TU propia conversacion con el usuario, desde el primer dia. '
      + 'Sirve para recuperar algo que ya hablasteis y que ya no tienes en contexto, '
      + 'por ejemplo una decision tomada hace dias. Es busqueda literal: encuentra las '
      + 'palabras tal como se escribieron, no por significado. Solo ve tu conversacion, '
      + 'no la de otros especialistas.',
    inputSchema: {
      type: 'object',
      properties: {
        texto: { type: 'string', description: 'Palabra o frase a buscar, tal como se habria escrito.' },
        limite: { type: 'integer', minimum: 1, maximum: 20, description: 'Cuantos resultados, por defecto 8.' }
      },
      required: ['texto'],
      additionalProperties: false
    }
  },
  {
    name: 'vault_escribir',
    description: 'Guarda lo que has aprendido en el vault compartido del equipo, en Markdown. '
      + 'Enlaza a otras notas con [[Titulo de la nota]]: eso es lo que convierte las notas '
      + 'en un mapa. Escribe aqui decisiones, contratos y hallazgos duraderos, no el diario '
      + 'de lo que hiciste hoy. Si la nota ya existe, la reemplazas: leela antes.',
    inputSchema: {
      type: 'object',
      properties: {
        titulo: { type: 'string', description: 'Nombre de la nota, tal como la enlazaran otros.' },
        texto: { type: 'string', description: 'Contenido en Markdown, con enlaces [[asi]].' },
        carpeta: { type: 'string', description: 'Tu area, o "comun" si es de todos. Por defecto: tu nombre.' }
      },
      required: ['titulo', 'texto'],
      additionalProperties: false
    }
  },
  {
    name: 'vault_leer',
    description: 'Lee una nota del vault compartido y ve quien la enlaza. Usalo ANTES de '
      + 'preguntar a otro especialista: si alguien ya lo documento, no hace falta molestarle.',
    inputSchema: {
      type: 'object',
      properties: { titulo: { type: 'string' }, carpeta: { type: 'string' } },
      required: ['titulo'],
      additionalProperties: false
    }
  },
  {
    name: 'vault_buscar',
    description: 'Busca en todas las notas del equipo, de cualquier especialista. '
      + 'Sin argumento devuelve el indice completo.',
    inputSchema: {
      type: 'object',
      properties: { texto: { type: 'string' } },
      additionalProperties: false
    }
  },
  {
    name: 'claim_files',
    description: 'Reserva archivos o rutas antes de editarlos para que ningun otro especialista los toque. Falla si ya estan reservados por otro.',
    inputSchema: {
      type: 'object',
      properties: {
        paths: { type: 'array', items: { type: 'string' }, description: 'Rutas absolutas a reservar.' },
        note: { type: 'string', description: 'Motivo breve de la reserva.' }
      },
      required: ['paths'],
      additionalProperties: false
    }
  },
  {
    name: 'release_files',
    description: 'Libera archivos que habias reservado. Hazlo al terminar de editarlos.',
    inputSchema: {
      type: 'object',
      properties: { paths: { type: 'array', items: { type: 'string' } } },
      required: ['paths'],
      additionalProperties: false
    }
  },
  {
    name: 'list_claims',
    description: 'Muestra que archivos estan reservados ahora mismo y por quien.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  }
];

async function api(pathname, options = {}) {
  const res = await fetch(`${API}${pathname}`, {
    ...options,
    headers: {
      'content-type': 'application/json',
      'x-v4-bridge-token': TOKEN,
      ...(options.headers || {})
    }
  });
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

async function callTool(name, args = {}) {
  switch (name) {
    case 'whoami': {
      const me = await api(`/api/internal/agents/${encodeURIComponent(AGENT_ID)}`);
      return `Eres ${me.name} (id ${me.id}). Area: ${me.area || 'sin area'}.`;
    }
    case 'list_agents': {
      const { agents } = await api('/api/internal/agents');
      const otros = agents.filter((a) => a.id !== AGENT_ID);
      if (!otros.length) return 'No hay otros especialistas registrados.';
      return otros.map((a) => `- ${a.name} (id ${a.id}) | area: ${a.area || 'sin area'} | estado: ${a.status}`).join('\n');
    }
    case 'send_message': {
      const out = await api('/api/internal/mailbox', {
        method: 'POST',
        body: JSON.stringify({ from: AGENT_ID, to: args.to, text: args.text, chainId: CHAIN_ID, hop: HOP })
      });
      if (out.status === 'blocked') {
        return `NO ENTREGADO a ${args.to}: ${out.reason}. No reintentes; informa del bloqueo en tu respuesta.`;
      }
      return `Entregado a ${out.to_name} (mensaje ${out.mailbox_id}). Responderá en su propio turno; su respuesta te llegará como un mensaje nuevo.`;
    }
    case 'ask_team': {
      const out = await api('/api/internal/broadcast', {
        method: 'POST',
        body: JSON.stringify({ from: AGENT_ID, text: args.text, chainId: CHAIN_ID, hop: HOP })
      });
      if (out.status === 'blocked') {
        return `NO ENVIADO: ${out.reason}. No insistas; sigue con lo que puedas resolver.`;
      }
      return `Preguntado a ${out.total} especialistas: ${out.enviados.map((e) => e.to_name).join(', ')}. ` +
             'Cada uno respondera en su turno y veras sus respuestas como mensajes nuevos. No vuelvas a preguntar.';
    }
    case 'create_specialist': {
      const out = await api('/api/internal/agents', {
        method: 'POST',
        body: JSON.stringify({
          name: args.name, area: args.area, instructions: args.instructions,
          createdBy: AGENT_ID, hop: HOP
        })
      });
      if (out.status === 'blocked') return `NO CREADO: ${out.reason}`;
      return `Creado el especialista "${out.name}" (id ${out.id}). Ya puedes consultarle con send_message.`;
    }
    case 'read_inbox': {
      const { messages } = await api(`/api/internal/agents/${encodeURIComponent(AGENT_ID)}/inbox?limit=${args.limit || 20}`);
      if (!messages.length) return 'Buzon vacio.';
      return messages.map((m) => `[${m.created_at}] de ${m.from_name}: ${m.body}`).join('\n---\n');
    }
    case 'recordar': {
      const q = String(args.texto || '').trim();
      if (!q) return 'Indica que buscar.';
      const { resultados } = await api(
        `/api/internal/agents/${encodeURIComponent(AGENT_ID)}/historial`
        + `?q=${encodeURIComponent(q)}&limite=${args.limite || 8}`);
      if (!resultados.length) {
        return `No encontre "${q}" en tu conversacion. Recuerda que la busqueda es literal: `
          + 'prueba con otra palabra, tal como se habria escrito.';
      }
      const quien = { user: 'el usuario', assistant: 'tu', peer: 'otro especialista', system: 'el sistema' };
      return resultados
        .map((r) => `[${r.fecha.slice(0, 16).replace('T', ' ')}] ${quien[r.role] || r.role}: ${r.texto}`)
        .join('\n---\n');
    }
    case 'vault_escribir': {
      const out = await api('/api/internal/vault/escribir', {
        method: 'POST',
        body: JSON.stringify({ titulo: args.titulo, texto: args.texto, carpeta: args.carpeta, agentId: AGENT_ID })
      });
      const e = out.enlaces && out.enlaces.length ? ` Enlaza a: ${out.enlaces.join(', ')}.` : '';
      return `Guardada "${out.titulo}" en ${out.carpeta}.${e}`;
    }
    case 'vault_leer': {
      const q = `titulo=${encodeURIComponent(args.titulo)}`
        + (args.carpeta ? `&carpeta=${encodeURIComponent(args.carpeta)}` : '');
      try {
        const n = await api(`/api/internal/vault/leer?${q}`);
        const atras = n.retroenlaces && n.retroenlaces.length
          ? `\n\nLa enlazan: ${n.retroenlaces.map((r) => r.titulo).join(', ')}` : '';
        return `# ${n.titulo} (${n.carpeta})\n\n${n.texto}${atras}`;
      } catch {
        return `No existe la nota "${args.titulo}". Usa vault_buscar para ver que hay.`;
      }
    }
    case 'vault_buscar': {
      if (!args.texto) {
        const { notas } = await api('/api/internal/vault/listar');
        if (!notas.length) return 'El vault esta vacio todavia.';
        return notas.map((n) => `- [[${n.titulo}]] (${n.carpeta || 'raiz'})`).join('\n');
      }
      const { resultados } = await api(`/api/internal/vault/buscar?q=${encodeURIComponent(args.texto)}`);
      if (!resultados.length) return `Nada sobre "${args.texto}" en el vault.`;
      return resultados.map((r) => `## ${r.titulo} (${r.carpeta || 'raiz'})\n${r.trozo}`).join('\n\n');
    }
    case 'claim_files': {
      const out = await api('/api/internal/claims', {
        method: 'POST',
        body: JSON.stringify({ agentId: AGENT_ID, paths: args.paths, note: args.note })
      });
      const lines = [];
      if (out.claimed.length) lines.push(`Reservados: ${out.claimed.join(', ')}`);
      if (out.rejected.length) {
        lines.push(`RECHAZADOS (ya los tiene otro especialista): ${out.rejected.map((r) => `${r.path} -> ${r.agent_name}`).join(', ')}`);
        lines.push('No edites los rechazados. Coordina con su responsable usando send_message.');
      }
      return lines.join('\n');
    }
    case 'release_files': {
      const out = await api('/api/internal/claims/release', {
        method: 'POST',
        body: JSON.stringify({ agentId: AGENT_ID, paths: args.paths })
      });
      return out.released.length ? `Liberados: ${out.released.join(', ')}` : 'No tenias ninguna de esas rutas reservada.';
    }
    case 'list_claims': {
      const { claims } = await api('/api/internal/claims');
      if (!claims.length) return 'No hay archivos reservados.';
      return claims.map((c) => `- ${c.path} -> ${c.agent_name}${c.note ? ` (${c.note})` : ''}`).join('\n');
    }
    default:
      throw new Error(`Herramienta desconocida: ${name}`);
  }
}

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

async function handle(msg) {
  const { id, method, params } = msg;

  if (method === 'initialize') {
    return send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: params?.protocolVersion || PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'codex-web-v4', version: '1.0.0' }
      }
    });
  }

  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return;

  if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} });

  if (method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });

  if (method === 'tools/call') {
    try {
      const text = await callTool(params?.name, params?.arguments || {});
      return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: String(text) }] } });
    } catch (err) {
      return send({
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true }
      });
    }
  }

  if (id !== undefined) {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Metodo no soportado: ${method}` } });
  }
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    handle(msg).catch((err) => {
      if (msg.id !== undefined) {
        send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: err.message } });
      }
    });
  }
});
process.stdin.on('end', () => process.exit(0));
