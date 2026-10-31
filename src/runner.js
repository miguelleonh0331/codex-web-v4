'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const proveedores = require('./proveedores');
const memoria = require('./memoria');

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
- mcp__v4__recordar     : buscar en TU propia conversacion con el usuario, desde
                          el primer dia, incluso lo que ya no tienes en contexto.
- mcp__v4__vault_buscar : buscar en el conocimiento compartido del equipo.
- mcp__v4__vault_leer   : leer una nota y ver quien la enlaza.
- mcp__v4__vault_escribir: dejar ahi lo que aprendiste, para todos.

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
3-bis. Si el usuario da por sabido algo que no ves en esta conversacion —una
   decision anterior, una ruta que acordasteis, algo de hace dias— busca con
   recordar ANTES de decir que no lo tienes o de volver a investigarlo. Tu
   conversacion entera esta guardada aunque ya no quepa en tu contexto.
   Es busqueda literal: prueba con la palabra tal como se habria escrito.

3-ter. El vault es la memoria del equipo. Antes de preguntar a otro
   especialista, mira si ya esta escrito: vault_buscar cuesta cero y
   send_message le cuesta un turno entero a el. Y cuando llegues a una
   conclusion que valga para manana —una decision, un limite, como se valida
   algo—, escribela con vault_escribir enlazando con [[corchetes]] a las
   notas relacionadas. No escribas ahi el diario de lo que hiciste hoy: eso
   ya esta en tu conversacion.

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

// Por que esto esta aqui: todo lo que entra en el contexto se vuelve a leer en
// CADA paso interno del turno. Un listado de 1.200 caracteres leido veinte
// veces son 24.000. Medido en este servidor, el coste de un turno sigue al
// contexto arrastrado con una correlacion de 0,71: pesa mas lo que acumulas
// que lo que piensas. De ahi estas tres reglas.
const AHORRO_RTK = `
A. RECONOCE CON FILTRO, LEE ENTERO SOLO LO QUE VAS A TOCAR.
   Tienes "rtk" instalado, que recorta salidas antes de que lleguen a tu
   contexto. Medido sobre este codigo:
     rtk ls <dir>              en vez de ls -la      -> 76% menos
     rtk git status            en vez de git status  -> 51% menos
     rtk read -m 80 <archivo>  vista estructural     -> 95% menos
     rtk read -l aggressive <archivo>  firmas sin cuerpos -> 89% menos
   Uso correcto: rtk para ORIENTARTE (que hay, donde esta, que forma tiene).
   Cuando ya sabes que archivo vas a editar, leelo entero con tu herramienta
   normal: para editar necesitas el texto exacto.
   Aviso: "rtk read" sin banderas NO filtra nada, es un paso a traves. El
   ahorro esta en -m y en -l aggressive.
`.trim();

const AHORRO_SIN_RTK = `
A. RECONOCE ANTES DE LEER ENTERO.
   Para orientarte usa busquedas y listados acotados, no volcados completos:
   grep con contexto corto, listados sin -l, lecturas por rango de lineas.
   Lee un archivo entero solo cuando ya sabes que vas a editarlo.
`.trim();

const AHORRO = `
ECONOMIA DEL CONTEXTO (obligatorio)

Todo lo que metes en el contexto se relee en cada paso del turno. Reconocer
el terreno con herramientas crudas es lo que encarece el trabajo.

%RECONOCIMIENTO%

B. TU MEMORIA DE TRABAJO.
   En tu espacio de trabajo tienes un archivo de memoria que tu motor lee solo
   al empezar cada turno, con secciones de rutas, comandos que funcionan,
   errores ya cometidos y decisiones tomadas.
   Al TERMINAR cada tarea, actualizalo: anota lo que te habria ahorrado tiempo
   al empezarla, y corrige lo que resulto equivocado. Es la diferencia entre
   empezar sabiendo donde esta todo y volver a averiguarlo cada vez.
   Mantenlo breve: se lee en cada turno, asi que si crece sin control encarece
   todos los siguientes. Rutas y hechos, no diario de actividad.

C. NO REHAGAS TU PROPIO TRABAJO.
   Tienes una carpeta "herramientas" en tu espacio. La segunda vez que hagas
   la misma comprobacion, dejala ahi como script con argumentos y apuntala en
   tu memoria. A la tercera ya te sale gratis.
   Antes de escribir un script, mira si ya lo tienes.
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

  const prov = proveedores.paraAgente(agent, cfg);
  const archivoMemoria = memoria.ARCHIVO_POR_PROVEEDOR[prov.nombre] || 'CLAUDE.md';
  partes.push(`Tu espacio de trabajo propio es ${agent.workspace}. Usalo para notas y borradores.`
    + `\nTu memoria de trabajo es ${archivoMemoria} (ahi mismo), y tu caja de herramientas, ./herramientas/.`);
  partes.push(COLABORACION);
  if (cfg.ahorroContexto !== false) {
    partes.push(AHORRO.replace('%RECONOCIMIENTO%', cfg.rtkBin ? AHORRO_RTK : AHORRO_SIN_RTK));
  }
  return partes.join('\n\n');
}

/**
 * Ejecuta un turno del agente. Devuelve { ok, text, sessionId, cost, numTurns, raw, error }.
 */
function runTurn(cfg, agent, turn, rutaLog, onEvento, onProceso) {
  return new Promise((resolve) => {
    // Quien ejecuta este turno. De aqui en adelante da igual cual sea.
    const prov = proveedores.paraAgente(agent, cfg);
    const bin = prov.binario(cfg);
    if (!bin) return resolve({ ok: false, error: prov.faltaBinario });

    fs.mkdirSync(agent.home, { recursive: true });
    fs.mkdirSync(agent.workspace, { recursive: true });

    // Memoria y caja de herramientas. Se siembra aqui, al empezar el turno, y
    // no al crear el especialista, para que los que ya existian la tengan sin
    // tener que recrearlos. Es idempotente: nunca pisa lo que el ya escribio.
    const sembrado = memoria.preparar(agent, prov.nombre);
    if (sembrado.length && rutaLog) {
      // Ojo: esto es una RUTA, no una funcion. Se escribe en el archivo.
      try {
        fs.appendFileSync(rutaLog, `\n==== memoria preparada para ${agent.name}: ${sembrado.join(', ')} ====\n`);
      } catch { /* el registro no debe tumbar el turno */ }
    }

    let plan;
    try {
      plan = prov.preparar(cfg, agent, turn, buildSystemPrompt(agent, cfg));
    } catch (e) {
      return resolve({ ok: false, error: `No se pudo preparar el turno (${prov.nombre}): ${e.message}` });
    }

    // El PATH del servicio es /usr/sbin:/usr/bin:/sbin:/bin, sin /usr/local/bin.
    // Sin esto, pedirle al especialista que use rtk seria pedirle un comando
    // que no puede encontrar.
    if (cfg.rtkBin) {
      const dir = path.dirname(cfg.rtkBin);
      const actual = plan.env.PATH || process.env.PATH || '';
      if (!actual.split(':').includes(dir)) plan.env.PATH = `${dir}:${actual}`;
    }

    const child = spawn(bin, plan.args, { cwd: plan.cwd, env: plan.env, stdio: ['ignore', 'pipe', 'pipe'] });
    // El orquestador necesita el proceso para poder pararlo a peticion del usuario.
    if (onProceso) { try { onProceso(child); } catch { /* no debe impedir el turno */ } }

    let stdout = '';
    let stderr = '';
    let settled = false;
    let resto = '';          // ultima linea a medio llegar
    let resultado = null;    // evento final, capturado al vuelo
    // Lo que el proveedor necesite ir juntando por el camino: hay motores
    // que reparten el resultado entre varios eventos.
    const bolsa = {};

    // El CLI escribe NDJSON segun avanza. Interpretarlo al momento es lo que
    // permite ver la actividad en vivo en vez de un volcado al terminar.
    const procesar = (trozo) => {
      resto += trozo;
      let corte;
      while ((corte = resto.indexOf('\n')) >= 0) {
        const linea = resto.slice(0, corte).trim();
        resto = resto.slice(corte + 1);
        if (!linea) continue;
        let ev;
        try { ev = JSON.parse(linea); } catch { continue; }
        if (prov.recolectar) { try { prov.recolectar(ev, bolsa); } catch { /* nunca tumba el turno */ } }
        if (prov.esFinal(ev)) resultado = ev;
        if (onEvento) { try { onEvento(ev); } catch { /* nunca debe tumbar el turno */ } }
      }
    };

    /**
     * Fin del turno por tiempo.
     *
     * Se separa "lleva horas trabajando" de "esta muerto". Un turno largo es
     * legitimo: una verificacion de varios modulos puede tardar lo que tarde.
     * Lo que no es legitimo es un proceso colgado consumiendo cuota sin
     * emitir nada. Por eso el tope principal es de INACTIVIDAD, y se reinicia
     * con cada linea que el CLI escribe.
     *
     * Se pide primero la salida por las buenas (SIGTERM) y solo se mata a los
     * cuatro segundos, igual que hace el boton de Parar. Matar en seco a
     * mitad de una escritura puede dejar un fichero truncado.
     */
    // Redondear a minutos daba "durante 0 min" con valores pequeños.
    const legible = (ms) => (ms >= 60000 ? `${Math.round(ms / 60000)} min` : `${Math.round(ms / 1000)}s`);

    const terminar = (motivo) => {
      if (settled) return;
      settled = true;
      limpiarRelojes();
      try { child.kill('SIGTERM'); } catch { /* ya murio */ }
      const golpe = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 4000);
      if (golpe.unref) golpe.unref();
      resolve({ ok: false, error: motivo, timeout: true });
    };

    // 0 o ausente = sin tope total. El agente puede trabajar lo que haga falta.
    const topeTotal = Number(cfg.turnTimeoutMs) > 0 ? Number(cfg.turnTimeoutMs) : 0;
    const topeQuieto = Number(cfg.inactivityTimeoutMs) > 0 ? Number(cfg.inactivityTimeoutMs) : 0;

    let relojTotal = null;
    let relojQuieto = null;
    const limpiarRelojes = () => {
      if (relojTotal) clearTimeout(relojTotal);
      if (relojQuieto) clearTimeout(relojQuieto);
    };
    const reiniciarQuieto = () => {
      if (!topeQuieto) return;
      if (relojQuieto) clearTimeout(relojQuieto);
      relojQuieto = setTimeout(
        () => terminar(`Sin señales de vida durante ${legible(topeQuieto)}: el proceso parecia colgado`),
        topeQuieto);
    };

    if (topeTotal) {
      relojTotal = setTimeout(
        () => terminar(`Tiempo agotado tras ${legible(topeTotal)}`),
        topeTotal);
    }
    reiniciarQuieto();

    child.stdout.on('data', (d) => { stdout += d; reiniciarQuieto(); procesar(String(d)); });
    child.stderr.on('data', (d) => { stderr += d; reiniciarQuieto(); });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      limpiarRelojes();
      resolve({ ok: false, error: `No se pudo lanzar ${prov.etiqueta}: ${err.message}` });
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      limpiarRelojes();

      if (rutaLog) {
        try {
          fs.appendFileSync(rutaLog, `\n==== turno ${turn.id} agente ${agent.name} code=${code} ====\n${stdout}\n--- stderr ---\n${stderr}\n`);
        } catch { /* el log no debe tumbar el turno */ }
      }

      procesar('\n');              // por si la ultima linea llego sin salto
      // Cada proveedor sabe leer su propia salida; aqui solo se recoge.
      resolve(prov.resultado(resultado, { stdout, stderr, code, bolsa }));
    });
  });
}

module.exports = { runTurn, buildSystemPrompt, COLABORACION };
