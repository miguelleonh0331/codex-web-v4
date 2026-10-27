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
    name: 'read_inbox',
    description: 'Muestra los ultimos mensajes que otros especialistas te enviaron.',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'integer', minimum: 1, maximum: 100 } },
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
    case 'read_inbox': {
      const { messages } = await api(`/api/internal/agents/${encodeURIComponent(AGENT_ID)}/inbox?limit=${args.limit || 20}`);
      if (!messages.length) return 'Buzon vacio.';
      return messages.map((m) => `[${m.created_at}] de ${m.from_name}: ${m.body}`).join('\n---\n');
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
