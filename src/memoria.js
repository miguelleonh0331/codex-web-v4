// Memoria de trabajo de cada especialista.
//
// El problema que resuelve: sus primeros turnos quemaban 35-43 pasos internos
// averiguando rutas, probando comandos y tropezando con los mismos errores.
// Cada paso relee el contexto entero, asi que explorar sale caro. Y al turno
// siguiente lo habia olvidado otra vez.
//
// La solucion no es codigo mio: los dos CLI leen SOLOS un archivo de memoria
// del directorio de trabajo (CLAUDE.md en Claude, AGENTS.md en Codex). Aqui
// solo lo sembramos con una plantilla y le decimos al especialista que lo
// mantenga. Lo escribe el, lo lee su propio motor, y yo no toco nada.

const fs = require('node:fs');
const path = require('node:path');

// Que archivo lee cada motor por su cuenta. Si manana cambia, se cambia aqui.
const ARCHIVO_POR_PROVEEDOR = { claude: 'CLAUDE.md', codex: 'AGENTS.md' };

function plantilla(agent) {
  return `# Memoria de trabajo de ${agent.name}

Este archivo lo lees tu solo al empezar cada turno. Mantenlo tu.
Es para no volver a averiguar lo que ya averiguaste.

Reglas de mantenimiento:
- Al terminar una tarea, anota aqui lo que te habria ahorrado tiempo al empezarla.
- Corrige lo que resulte equivocado. Un dato falso aqui es peor que no tenerlo.
- Breve. Esto se lee en cada turno: si crece sin control, encarece todos.

## Rutas
<!-- Donde vive cada cosa de verdad. Con ruta absoluta.
     Ej: fuente del panel: /var/www/html/zynervoxv2/app/web -->

## Comandos que funcionan aqui
<!-- Los que ya probaste y van, con sus banderas.
     Ej: reiniciar: sudo -n systemctl restart zynervox-api -->

## Errores ya cometidos
<!-- Lo que salio mal y por que, para no repetirlo.
     Ej: editar bajo /srv/www/htdocs no surte efecto: ese arbol no se sirve. -->

## Decisiones tomadas
<!-- Acuerdos con el usuario que siguen vigentes. -->

## Mis herramientas
<!-- Scripts que escribiste en ./herramientas/ y para que sirve cada uno. -->
`;
}

const LEEME_HERRAMIENTAS = `# Herramientas de este especialista

Scripts tuyos, para no reescribir lo mismo en cada turno.

Cuando hagas la misma comprobacion por segunda vez, no la vuelvas a teclear:
dejala aqui como script, con un nombre que se entienda, y apuntala en la
seccion "Mis herramientas" de tu archivo de memoria. Al tercer uso ya te
salio gratis.

Sirve cualquier cosa ejecutable: sh, python, node. Hazlos ejecutables
(chmod +x) y que acepten argumentos en vez de llevar rutas incrustadas.
`;

/**
 * Deja el espacio de trabajo listo: memoria y caja de herramientas.
 * Es idempotente y NUNCA sobreescribe lo que el especialista haya escrito:
 * su memoria es suya.
 */
function preparar(agent, proveedorNombre) {
  const hechos = [];
  if (!agent || !agent.workspace) return hechos;

  try {
    fs.mkdirSync(agent.workspace, { recursive: true });

    const nombreArchivo = ARCHIVO_POR_PROVEEDOR[proveedorNombre] || 'CLAUDE.md';
    const memoria = path.join(agent.workspace, nombreArchivo);
    if (!fs.existsSync(memoria)) {
      fs.writeFileSync(memoria, plantilla(agent), { mode: 0o640 });
      hechos.push(nombreArchivo);
    }

    const caja = path.join(agent.workspace, 'herramientas');
    if (!fs.existsSync(caja)) {
      fs.mkdirSync(caja, { recursive: true });
      fs.writeFileSync(path.join(caja, 'LEEME.md'), LEEME_HERRAMIENTAS, { mode: 0o640 });
      hechos.push('herramientas/');
    }
  } catch { /* si el disco falla, el turno sigue: esto es ayuda, no requisito */ }

  return hechos;
}

/** Cuanto ocupa la memoria, para avisar si se descontrola. */
function tamano(agent, proveedorNombre) {
  try {
    const f = path.join(agent.workspace, ARCHIVO_POR_PROVEEDOR[proveedorNombre] || 'CLAUDE.md');
    return fs.statSync(f).size;
  } catch { return 0; }
}

module.exports = { preparar, tamano, ARCHIVO_POR_PROVEEDOR, plantilla };
