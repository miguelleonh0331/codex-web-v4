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

### Requisitos

| | Por que |
| --- | --- |
| Linux con systemd | el servicio se instala como unidad |
| **Node >= 22.5** | se usa `node:sqlite`, que no existe antes |
| **Claude Code instalado** | es el motor de los especialistas |
| Una cuenta de Claude | con suscripcion; la sesion se inicia desde la propia aplicacion |

Claude Code se instala asi:

```bash
npm install -g @anthropic-ai/claude-code
claude --version
```

El instalador **no sigue adelante si no lo encuentra**: antes dejaba un servicio
que arrancaba pero cuyos agentes no podian trabajar. Si lo tienes en una ruta
propia, pasala con `--claude-bin /ruta/a/claude`.

No hace falta iniciar sesion antes: el instalador avisa si falta y se hace desde
la aplicacion, en **Proveedor**.

### En otro servidor, con un solo comando

Si ya tienes acceso SSH al destino, no hace falta pasar por GitHub:

```bash
./instalar-remoto.sh <destino-ssh> --user <usuario> --port 3212 \
   --project-name <proyecto> --project-path <ruta> --session-dir <perfil-con-sesion>
```

Empaqueta el repositorio con toda su historia, lo copia, comprueba que el destino
tiene Node suficiente y ejecuta el instalador alli. Si ya estaba instalado, lo
actualiza en vez de duplicarlo.

### Desde el repositorio

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

## Proveedor y sesion

La barra lateral tiene un boton **Proveedor** que muestra el estado real: cuenta,
plan, cuando caduca el token y donde vive la sesion. Si no hay sesion utilizable,
el boton se pone en rojo y lo avisa, porque sin ella ningun especialista trabaja.

Desde ahi se inicia sesion sin tocar la terminal: la aplicacion lanza el flujo
OAuth del CLI, te muestra **la direccion que debes abrir**, y tu pegas el codigo
que te devuelve Claude. Tambien se puede cerrar sesion o cambiar de cuenta.

Ademas muestra **cuanto queda de cada ventana de uso**: la de 5 horas y la semanal,
con su cuenta atras en vivo y, cuando Claude lo informa, el porcentaje consumido. El
dato no se inventa ni se estima: llega del propio CLI en sus avisos `rate_limit_event`
mientras los especialistas trabajan, y por eso el porcentaje solo aparece cuando te
acercas al limite, que es cuando Claude lo manda.

La barra lateral lleva un resumen permanente bajo el boton de proveedor.

Un detalle que importa: el exito no se da por supuesto. Se comprueba que el
archivo de credenciales **cambio de verdad**, porque preguntar solo "hay sesion"
daria por bueno un codigo invalido cuando ya existia una sesion anterior.

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

## Los avatares

Cada especialista lleva un robot con visor y ojos LED, vestido del dios que le toca.
Hay **quince** (`zeus`, `hera`, `atenea`, `hermes`, `apolo`, `ares`, `artemisa`,
`afrodita`, `poseidon`, `hades`, `hefesto`, `demeter`, `hecate`, `hestia`, `mnemosine`)
y cualquier otra semilla genera uno propio y estable, de modo que un especialista nuevo
tiene avatar desde el primer dia.

No se distinguen solo por color: cada uno cambia de **estructura facial**. Hay seis
sistemas opticos (banda de visor, lentes con aro, ojo unico, matriz de pixeles, antifaz
de ceja pesada, ojos saltones), seis herrajes de boca (rejilla, altavoz, mandibula,
barra, colmillos, ninguna), cinco formas de cabeza, cinco tipos de orejas y tono de metal
propio. Apolo es un ciclope dorado, Ares una matriz roja con colmillos, Hefesto un par de
ojos saltones tras una rejilla.

Son SVG generados al vuelo y animados por CSS: ni imagenes ni fotogramas. **La expresion
cuenta lo que esta pasando**: en reposo parpadea y flota; mientras trabaja, la mirada
sube y tres puntos se encienden por turnos. El generador admite ocho estados (normal,
escucha, piensa, responde, feliz, curioso, alerta, error) y respeta
`prefers-reduced-motion`.

**El color se personaliza por especialista.** Al crear o editar hay una galeria con los
quince y una paleta, mas un selector de color libre. El color elegido tine el halo, los
LED y los remates, dejando el metal neutro; se guarda en `avatar_color` y vacio significa
el color propio del dios.

Hay una pagina para verlos todos: `/demo-avatar.html`.

## Modelo y esfuerzo por especialista

Cada especialista puede llevar su propio modelo (`haiku`, `sonnet`, `opus`, `opusplan`,
`fable` o un nombre completo) y su propio nivel de esfuerzo (`low`, `medium`, `high`,
`xhigh`, `max`). Se eligen al crearlo o editarlo, y se ven en la lista bajo su nombre.
Vacio significa el valor por defecto de la configuracion.

La idea es gastar donde importa: un Arquitecto que decide contratos merece `opus` con
esfuerzo alto; un especialista que solo consulta rutas va sobrado con `haiku` y `low`.
El servidor rechaza un esfuerzo que el CLI no admita, para que un error de escritura no
tumbe el turno.

## Adjuntar archivos

El cuadro de escritura acepta **cualquier tipo de archivo**, de tres formas: pegando con
Ctrl+V (lo normal para una captura de pantalla), arrastrando y soltando, o con el boton
del clip. Se suben antes de enviar y se ven como miniatura o como ficha con su nombre.

Lo importante es que al especialista **no le llega una copia en el texto, sino la ruta
real**: el archivo se guarda en `adjuntos/` dentro de su workspace y el agente lo abre
con su propia herramienta de lectura. Por eso puede mirar de verdad una captura y
decirte que ve en ella.

El nombre que manda el navegador nunca se usa tal cual: se le quita la ruta y se dejan
solo caracteres inofensivos, de modo que un nombre como `../../etc/passwd` acaba escrito
como `passwd` dentro del workspace y no fuera. El tope por archivo es `maxUploadMb`
(50 MB por defecto).

Aviso: los especialistas corren con permisos reales sobre el servidor. Lo que subas, el
agente puede leerlo y usarlo.

## Ver lo que esta haciendo

La cabecera del chat tiene una casilla **Ver actividad**. Al encenderla aparece una tira
en vivo con cada herramienta que usa el especialista: `ejecuta: wc -l CONTRACT.md`,
`lee: Dialer.php`, `escribe a: Consultas`. Pulsando una linea se despliega el argumento
completo.

Sale apagada por defecto y se recuerda por especialista, porque ahi se ven rutas y
comandos reales: es justo lo util, y tambien lo que no conviene tener siempre a la vista.

Se guardan los ultimos 200 eventos por agente y los viejos se podan solos: un turno
largo son cientos de llamadas y la base no debe crecer sin freno.

## Cuanto contexto lleva cada uno

Cada especialista tiene su propia sesion, asi que el contexto es **suyo**: uno puede ir
al 70% mientras otro esta al 3%. Por eso no hay una barra global.

- en la cabecera del chat: `contexto 73,8k / 1000k · 7%`
- bajo cada fila de la lista, una barra fina que pasa a ambar al 70% y a rojo al 90%

La ventana se toma del modelo real que uso en el ultimo turno, no de una constante: un
`opus[1m]` y un `sonnet` no miden igual. Con eso, **Reiniciar contexto** deja de ser una
corazonada.

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
| `model` | modelo por defecto; cada especialista puede llevar el suyo |
| `effort` | esfuerzo de razonamiento por defecto: low, medium, high, xhigh, max |
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
