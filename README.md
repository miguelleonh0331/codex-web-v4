# codex-web-v4

Plataforma de **especialistas que conversan entre si** para desarrollar sobre cualquier
sistema. Cada especialista es un agente con su area, sus instrucciones, su espacio de
trabajo y su propia conversacion. Todos comparten **una sola sesion de Claude**: crear un
especialista cuesta un registro en la base de datos, no una licencia nueva.

Se disenio como herramienta de desarrollo: los agentes corren de forma nativa, con los
permisos reales del usuario del servicio, de modo que pueden leer el codigo del proyecto,
validarlo y —si la tarea lo autoriza— desplegarlo.

## Que resuelve

| Problema | Como se resuelve |
| --- | --- |
| Un login por agente | Sesion compartida via `CLAUDE_CONFIG_DIR`; N agentes, una cuenta |
| Los agentes no se hablan | Buzon real con `send_message`, entrega asincrona y despertado por turnos |
| Dos agentes pisan el mismo archivo | Reservas (`claim_files`) con rechazo si ya esta tomado |
| Conversaciones infinitas entre bots | Limite de saltos por cadena y descarte de duplicados |
| Atado a un servidor concreto | Todo por configuracion; instalador para cualquier host |

## Instalacion

Requisitos: Linux con systemd, Node >= 22.5 (por `node:sqlite`) y el binario de
Claude Code accesible en el servidor.

```bash
git clone <repo> /opt/codex-web-v4
cd /opt/codex-web-v4
sudo ./install.sh \
  --user codex-web \
  --port 3212 \
  --bind "127.0.0.1,100.92.146.21" \
  --project-name zynervoxv2 \
  --project-path /opt/zynervoxv2-fuente \
  --session-from /ruta/a/un/perfil/con/credenciales
```

El instalador comprueba la version de Node, que el puerto este libre, crea los
directorios, genera los tokens, escribe la unidad de systemd a partir de la plantilla,
reserva el puerto frente al rango efimero y espera a que el servicio responda. Al
terminar imprime la URL con el token.

Opciones: `--data-dir`, `--config-dir`, `--service-name`, `--group`, `--node`.

### La sesion compartida

El servicio arranca los agentes con `CLAUDE_CONFIG_DIR` apuntando a
`<data-dir>/session`. Ahi debe haber un `.credentials.json` valido. Dos formas:

- copiarlo de un perfil que ya tenga sesion: `--session-from <dir>`;
- iniciar sesion a mano:
  `sudo -u <user> env HOME=<data-dir> CLAUDE_CONFIG_DIR=<data-dir>/session claude /login`.

Esa copia es **propiedad de v4**: cuando el token se refresca se reescribe aqui, no en el
perfil de origen.

## Uso

Interfaz web en `http://<host>:<puerto>/?token=<authToken>` (el token esta en
`/etc/codex-web-v4/config.json`). Tres zonas: especialistas, conversacion y un panel con
el correo entre agentes, las reservas y la actividad.

Desde la terminal:

```bash
v4ctl agents                      # lista
v4ctl create "Telefonia" "Asterisk, dialplan" instrucciones.txt
v4ctl say Telefonia "Revisa las troncales y dime que falta"
v4ctl mailbox                     # correo entre especialistas
v4ctl turns                       # ultimos turnos, con coste
v4ctl claims                      # archivos reservados ahora mismo
```

## Como colaboran

Cada agente recibe estas herramientas en su sesion:

| Herramienta | Para que |
| --- | --- |
| `list_agents` | saber quien existe y de que se encarga |
| `send_message` | consultar o responder a otro especialista |
| `read_inbox` | releer lo recibido |
| `claim_files` | reservar archivos antes de editarlos |
| `release_files` | liberarlos al terminar |
| `list_claims` | ver que esta ocupado y por quien |

`send_message` no bloquea: deja el mensaje y el motor despierta al destinatario en su
propio turno. La respuesta vuelve como un mensaje nuevo. Cada cadena lleva un contador de
saltos; al llegar al limite (`maxHops`) el envio se rechaza y queda registrado, de modo
que dos agentes no pueden quedarse dandose las gracias indefinidamente.

## Configuracion

`/etc/codex-web-v4/config.json`:

| Clave | Significado |
| --- | --- |
| `port`, `bindHosts` | donde escucha; se puede atar a loopback y a una IP de tailnet |
| `dataDir` | base de datos, sesion, workspaces y registros |
| `model` | modelo por defecto; cada agente puede llevar el suyo |
| `maxConcurrentTurns` | cuantos agentes trabajan a la vez |
| `turnTimeoutMs` | corte de un turno que se cuelga |
| `maxHops` | tope de mensajes encadenados entre agentes |
| `dedupeWindowMs` | ventana para descartar mensajes identicos |
| `project` | nombre, ruta del codigo, ruta de despliegue y como se valida |
| `authToken` / `bridgeToken` | acceso a la UI y de los agentes a la API interna |

## Operacion

```bash
systemctl status codex-web-v4
journalctl -u codex-web-v4 -f
tail -f /var/lib/codex-web-v4/logs/service.log     # servicio
tail -f /var/lib/codex-web-v4/logs/<agent-id>.log  # turnos de un agente
node /opt/codex-web-v4/test/selftest.js            # 21 comprobaciones, sin gasto de modelo
```

Un reinicio marca como error los turnos que estaban en vuelo y deja a los agentes en
reposo; las conversaciones se conservan.

## Estructura

```
src/server.js        API HTTP y UI
src/orchestrator.js  cola de turnos, entrega del correo, limite de concurrencia
src/runner.js        lanza Claude por turno con la sesion compartida
src/bridge/          servidor MCP que da las herramientas de colaboracion al agente
src/db.js            esquema SQLite y consultas
public/              interfaz web sin dependencias
bin/v4ctl.js         control por terminal
install.sh           instalacion en cualquier servidor
test/selftest.js     autodiagnostico
```

## Notas del entorno

- `node:sqlite` es experimental en Node 22; el servicio arranca con `--no-warnings`.
- Si `ip_local_port_range` cubre todo el espacio de puertos, una conexion saliente puede
  robar el puerto del servicio. El instalador lo reserva en `/etc/sysctl.d/`, y el
  servidor reintenta el bind antes de rendirse.
- Los agentes heredan los permisos del usuario del servicio. Es deliberado: necesitan
  tocar el proyecto de verdad. Instala v4 solo en servidores de desarrollo.
