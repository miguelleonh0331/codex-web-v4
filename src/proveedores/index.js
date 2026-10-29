'use strict';
/**
 * Registro de proveedores.
 *
 * Cada proveedor sabe lanzar un turno y traducir su respuesta a una forma
 * comun. El resto del sistema —cola, correo entre agentes, reservas de
 * archivos, memoria, interfaz— no sabe cual se esta usando.
 *
 * Contrato que debe cumplir un proveedor:
 *
 *   nombre, etiqueta, modelos[], esfuerzos[]
 *   reanuda            si sabe continuar una conversacion anterior
 *   binario(cfg)       ruta al ejecutable, o null si no esta configurado
 *   faltaBinario       que decir cuando no esta
 *   preparar(...)      -> { args, env, cwd }
 *   esFinal(ev)        -> boolean
 *   limiteDe(ev)       -> info de limite de uso, o null
 *   resultado(...)     -> { ok, text, sessionId, cost, numTurns, uso, error }
 *
 * Si un proveedor no sabe hacer algo (por ejemplo reanudar sesiones), se
 * degrada solo para el. El proveedor mas limitado no marca el techo de todos.
 */
const claude = require('./claude');
const codex = require('./codex');

const PROVEEDORES = { claude, codex };
const POR_DEFECTO = 'claude';

function obtener(nombre) {
  return PROVEEDORES[String(nombre || POR_DEFECTO).toLowerCase()] || PROVEEDORES[POR_DEFECTO];
}

/** El que corresponde a un agente, con el de la instalacion como respaldo. */
function paraAgente(agent, cfg) {
  return obtener((agent && agent.proveedor) || (cfg && cfg.proveedor) || POR_DEFECTO);
}

/** Cuales estan realmente usables en este servidor, para pintarlos. */
function disponibles(cfg) {
  return Object.values(PROVEEDORES).map((p) => ({
    nombre: p.nombre,
    etiqueta: p.etiqueta,
    modelos: p.modelos,
    esfuerzos: p.esfuerzos || [],
    modeloPorDefecto: p.modeloPorDefecto === undefined ? null : p.modeloPorDefecto,
    reanuda: !!p.reanuda,
    instalado: !!p.binario(cfg)
  }));
}

module.exports = { obtener, paraAgente, disponibles, PROVEEDORES, POR_DEFECTO };
