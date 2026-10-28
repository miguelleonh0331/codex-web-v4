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

El servicio arranca los agentes con `CLAUDE_CONFIG_DIR` apuntando a `sessionDir`, donde
debe haber un `.credentials.json` valido.

**Comparte el directorio, no copies el archivo.** Un token OAuth se refresca y rota: si
existen dos copias, la primera que refresque invalida a la otra y el sistema se queda sin
sesion sin previo aviso. Apunta `sessionDir` al directorio de un perfil que ya tenga
sesion y habra un unico archivo para todos:

```bash
sudo ./install.sh ... --session-dir /ruta/al/perfil/con/sesion
```

Las otras dos formas, menos recomendables:

- `--session-from <dir>` copia las credenciales a `<data-dir>/session` (sirve si ese
  perfil no se va a usar nunca mas desde ningun otro sitio);
- iniciar sesion a mano:
  `sudo -u <user> env HOME=<data-dir> CLAUDE_CONFIG_DIR=<data-dir>/session claude /login`.

`/api/health` publica `session.valida` y `session.expira`, y el autodiagnostico falla si
la sesion caduco: es el punto mas fragil del sistema y conviene vigilarlo.

## Uso

Interfaz web en `http://<host>:<puerto>/`, instalable como aplicacion (PWA) y adaptada a
movil. Por defecto **no pide token**: el servicio
solo escucha en loopback y en las interfaces privadas que indiques en `bindHosts`. Tres
zonas: especialistas, conversacion y un panel con el correo entre agentes, las reservas y
la actividad.

Si lo expones a una red menos fiable, pon `"requireAuth": true` en la configuracion y
reinicia: entonces se entra con `?token=<authToken>` o escribiendo el token.

### Instalar en el movil

El navegador solo ofrece instalar una PWA sobre **HTTPS** (o en `localhost`). Con
Tailscale basta un comando, sin certificados que gestionar:

```bash
sudo tailscale serve --bg --https=8445 http://127.0.0.1:3212
```

Luego se abre `https://<host>.<tailnet>.ts.net:8445/` desde el movil y se usa
"Anadir a pantalla de inicio" (Android: el aviso de instalacion sale solo).

En movil la interfaz pasa a una sola columna con una barra inferior de tres vistas:
especialistas, conversacion y equipo. Al elegir un especialista salta a su conversacion,
y la pestana del equipo se marca cuando llega correo nuevo entre agentes.

El service worker sirve para que la aplicacion abra sin conexion. Nunca cachea `/api/`:
el estado de los agentes siempre se pide a la red.

Desde la terminal:

```bash
v4ctl agents                      # lista
v4ctl create "Telefonia" "Asterisk, dialplan" instrucciones.txt
v4ctl say Telefonia "Revisa las troncales y dime que falta"
v4ctl mailbox                     # correo entre especialistas
v4ctl turns                       # ultimos turnos, con coste
v4ctl claims                      # archivos reservados ahora mismo
```

## Las caras

Cada especialista tiene un rostro propio, generado a partir de su semilla: el mismo
agente se ve siempre igual en cualquier navegador y no se guarda ninguna imagen. Son
SVG y la animacion la lleva el CSS, asi que no pesan nada.

En reposo parpadean y flotan, cada uno a su ritmo. **Mientras el especialista trabaja,
su cara habla**: la boca se mueve y el parpadeo se acelera, de modo que de un vistazo
se ve quien esta ocupado. Se respeta `prefers-reduced-motion`.

La cara aparece en la lista, en la cabecera de la conversacion, junto a cada respuesta y
en el buzon, donde se ve quien escribe a quien. Al crear o editar un especialista hay una
vista previa con un boton para cambiarla; la semilla se guarda en `avatar_seed`.

## Como colaboran

Cada agente recibe estas herramientas en su sesion:

| Herramienta | Para que |
| --- | --- |
| `list_agents` | saber quien existe y de que se encarga |
| `send_message` | consultar o responder a otro especialista |
| `ask_team` | lanzar la misma pregunta a todo el equipo |
| `read_inbox` | releer lo recibido |
| `claim_files` | reservar archivos antes de editarlos |
| `release_files` | liberarlos al terminar |
| `list_claims` | ver que esta ocupado y por quien |

### Si le pides algo que no es suyo

El especialista no te manda a otra ventana: averigua a quien corresponde, se lo consulta
y te entrega la conclusion. Tu hablas con cualquiera y el equipo se organiza solo.

La regla cambia segun quien pregunte, y es deliberado:

- te escribe **el usuario** y el tema es de otro → **delega** y responde con lo que reciba;
- le escribe **otro especialista** algo que no es suyo → lo dice y **no reenvia**, para que
  ninguna cadena se propague sola.

### Preguntar a todo el equipo

`ask_team` manda la misma pregunta a todos a la vez. Sirve para "¿a quien le afecta esto?"
o "¿quien esta tocando esta zona?", no para repartir tareas.

Desde la interfaz: boton **Preguntar a todo el equipo**; cada especialista responde en su
propia conversacion. Desde la terminal: `v4ctl askteam "<pregunta>"`, que espera y reune
todas las respuestas juntas.

Dos limites lo mantienen bajo control: solo se admite **al atender una peticion directa**
(nunca dentro de una conversacion entre agentes, para que una difusion no provoque otra),
y cuesta un turno por especialista, asi que con un equipo grande conviene usarlo con
criterio.

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
| `requireAuth` | si la UI pide token; `false` por defecto |
| `authToken` / `bridgeToken` | token de la UI (si `requireAuth`) y de los agentes a la API interna |

## Operacion

```bash
systemctl status codex-web-v4
journalctl -u codex-web-v4 -f
tail -f /var/lib/codex-web-v4/logs/service.log     # servicio
tail -f /var/lib/codex-web-v4/logs/<agent-id>.log  # turnos de un agente
node /opt/codex-web-v4/test/selftest.js            # 27 comprobaciones, sin gasto de modelo
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
public/              interfaz web sin dependencias (PWA: manifiesto, sw.js, iconos)
public/faces.js      genera la cara animada de cada especialista
tools/make-icons.py  genera los iconos PNG sin dependencias externas
tools/render-faces.py  rasteriza las caras a PNG para revisarlas sin navegador
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
