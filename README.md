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

Opciones: `--name`, `--data-dir`, `--config-dir`, `--service-name`, `--group`, `--node`.

Con varios servidores conviene darle nombre propio a cada uno (`--name "Masterchief ·
vicibox05"`): asi la pestana, la barra lateral y el icono de la aplicacion instalada
dicen en cual estas, en vez de tres ventanas identicas.

Despues se cambia **desde la propia web**: pulsa el nombre en la barra lateral, escribe
el nuevo y Enter. Surte efecto al momento, sin reiniciar el servicio, y se guarda
conservando el resto de la configuracion.

## Gastar menos

El coste de un turno lo pone sobre todo **el contexto que arrastra**, no lo
dificil que sea la tarea: medido sobre los turnos reales de este servidor, la
correlacion es de 0,71. Por eso el sistema:

- **compacta solo** cuando un especialista pasa del 70% de su ventana (y 20
  puntos antes si el turno viene de esperar cuota), ajustable desde la web;
- le da a cada uno una **memoria de trabajo** que su propio motor lee solo
  (`CLAUDE.md` en Claude, `AGENTS.md` en Codex) con rutas, comandos que
  funcionan y errores ya cometidos;
- les pide reconocer el terreno con **rtk**, que recorta los listados un 76% y
  las lecturas estructurales un 95% antes de que entren al contexto;
- les da una **caja de herramientas** propia para no reescribir lo mismo.

Detalles, cifras y lo que se descarto en [docs/AHORRO.md](docs/AHORRO.md).

## Actualizar

**Proveedor → Buscar actualizacion → Instalar.** Sin entrar al servidor.

Antes de reiniciar copia la base de datos y revisa la sintaxis del codigo
nuevo. Si tras el reinicio nadie contesta en 90 segundos, **vuelve sola a la
version anterior**: el trabajo corre en un proceso suelto, fuera del
servicio, precisamente para sobrevivir al reinicio y poder deshacer.

Se niega a actualizar si hay archivos editados a mano en el servidor, y avisa
por nombre si hay especialistas trabajando, porque el reinicio les corta el
turno. Detalles y marcha atras manual en [docs/ACTUALIZAR.md](docs/ACTUALIZAR.md).

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

La barra lateral lleva bajo el boton el tiempo que falta para el proximo reinicio, a
secas: poner "5h" al lado de "3 h 24 min" se leia como dos tiempos distintos. Que
ventana es se ve al pasar por encima o al abrir el proveedor.

El boton muestra el **nombre del proveedor**, no la cuenta. El correo solo aparece
dentro, al pulsarlo.

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

## Llevarse el equipo a otro servidor

En la barra lateral, **Exportar** descarga un JSON con todos los especialistas: nombre,
area, instrucciones, modelo, esfuerzo, avatar y color. **Importar** lo carga en otra
instalacion.

No se exportan conversaciones, sesiones ni credenciales: son de esa maquina y de esa
cuenta, y llevarselas no serviria de nada ademas de convertir el archivo en algo
delicado de guardar. Lo que viaja es el equipo, no su historial.

Al importar nunca se toca nada sin confirmar: primero se muestra cuantos son nuevos,
cuantos ya existen y cuales se descartan por incompletos. Los repetidos se saltan por
defecto, o se actualizan si lo eliges; nunca se duplican.

El archivo guarda de que proyecto venia, asi que si lo llevas a un servidor donde el
codigo esta en otra ruta, la importacion te avisa de que las instrucciones apuntaran a
sitios que no existen hasta que las revises.

Sirve tambien de copia de seguridad del equipo.

## Ver lo que esta haciendo

El panel de la derecha tiene una pestana **Salida** con lo que ejecuta el especialista
que estas mirando: `ejecuta: wc -l CONTRACT.md`, `lee: Dialer.php`, `escribe a:
Consultas`. Pulsando una linea se despliega el argumento completo.

Antes vivia debajo de la conversacion y le robaba alto justo cuando mas falta hacia.
En el panel tiene columna propia y el chat no se mueve.

La pestana **Sistema**, al lado, es otra cosa: eventos de todo el equipo (turnos, correo,
reservas), no lo que teclea un especialista.

Se guardan los ultimos 200 eventos por agente y los viejos se podan solos: un turno
largo son cientos de llamadas y la base no debe crecer sin freno.

## Avisos cuando termina un trabajo

Al acabar un turno suena un aviso corto y la fila del especialista queda marcada con
un **!** rojo que late, ademas de teñirse, hasta que abres su conversacion. El titulo de
la pestaña lleva la cuenta, asi que lo ves aunque estes en otra ventana.

El sonido distingue el desenlace: dos notas ascendentes si termino bien, dos
descendentes si acabo en error. Se sintetizan al vuelo, sin ningun archivo de audio, y
hay un interruptor **Avisos** al pie de la barra lateral que se recuerda entre sesiones.
Encenderlo suena una vez, lo que de paso desbloquea el audio en navegadores que exigen
un gesto del usuario antes de reproducir nada.

Lo que ya leiste no vuelve a avisar: se guarda por especialista en el navegador, de modo
que abrir su conversacion lo da por revisado.

## Mencionar a otro especialista

Escribiendo `@` en el cuadro de mensaje se despliega la lista del equipo: flechas para
elegir, Enter o Tab para insertar. Resuelve bien los nombres compuestos como
`Base de Datos`, que a mano es facil escribir mal.

Una mencion no es una sugerencia: el servidor la reconoce y anade al mensaje la
instruccion de consultar a esa persona con `send_message` antes de responder, y de
esperar su respuesta en vez de suponerla. Las menciones quedan resaltadas en la
conversacion y registradas como evento.

Si mencionas un nombre que no existe, la interfaz avisa antes de enviar: un nombre mal
escrito costaria un turno entero para acabar en "no existe ese especialista". Lo que no
case con nadie se ignora, porque puede ser un correo o una ruta.

## Eliminar un especialista

En **Instrucciones** hay un boton **Eliminar**. Por defecto lo saca de la lista y
conserva su conversacion en la base, por si hiciera falta recuperar algo. Marcando
*borrar tambien su conversacion* desaparece del todo: mensajes, turnos, actividad y
correo incluidos, sin vuelta atras.

Si estaba trabajando se le detiene primero: borrarlo a media faena dejaria un proceso
suelto gastando cuota.

## Compactar

**Compactar** resume la conversacion y libera contexto conservando lo importante: en que
quedasteis, que se decidio y que falta. No es lo mismo que **Reiniciar contexto**, que
tira la sesion entera y deja al especialista sin memoria de lo hablado.

Por dentro se usa el propio `/compact` de Claude Code sobre la sesion del agente, asi que
el resumen lo hace el modelo con su mecanismo nativo, no un apano nuestro. Queda anotado
en la conversacion con cuanto se libero, por ejemplo `74k → 37k tokens`.

## Parar a un especialista

Mientras trabaja, la cabecera del chat muestra **⏹ Parar**. Corta el turno en marcha y
descarta lo que tuviera en cola, y te dice exactamente que paro. El turno queda como
`cancelado`, no como error: no fue un fallo del especialista.

Se le pide al proceso que termine por las buenas y, si no obedece en cuatro segundos, se
fuerza. El especialista queda en reposo y listo para el siguiente mensaje, con su
conversacion intacta.

## Cuanto contexto lleva cada uno

Cada especialista tiene su propia sesion, asi que el contexto es **suyo**: uno puede ir
al 70% mientras otro esta al 3%. Por eso no hay una barra global.

- en la cabecera del chat: `contexto 73,8k / 1000k · 7%`
- bajo cada fila de la lista, una barra fina que pasa a ambar al 70% y a rojo al 90%

La ventana se toma del modelo real que uso en el ultimo turno, no de una constante: un
`opus[1m]` y un `sonnet` no miden igual. Con eso, **Reiniciar contexto** deja de ser una
corazonada.

## Aspecto

La zona de conversacion se ve como una terminal. Cada mensaje es una linea de cabecera
con su marca, quien habla y la hora, y debajo el texto:

```
tu > en que ruta estas trabajando ahora ? cual es tu home ?
Telefonia > Analizando el problema
Consultas > el indice ya existe en vicidial_list
sistema > turno detenido por el usuario
```

Un mensaje, una linea. **La franja de color ocupa el turno entero**, de lado a lado, y
lleva el color de quien habla: el del especialista es el de su avatar. Con eso se sigue
una conversacion de tres de un vistazo y sobran los simbolos delante.

La respuesta del especialista **aprovecha todo el ancho del chat**, que es donde van los
bloques de codigo y las rutas largas. **Lo tuyo se queda recogido a la derecha**, asi que
distingues pregunta de respuesta sin leer nada. Lo que da la vuelta se alinea bajo el
texto y no bajo el nombre.

La hora y el boton de copiar solo aparecen al pasar por encima: mientras lees, estorban.
Los avatares no se repiten en cada linea, solo en la lista y la cabecera. La barra lateral y el panel derecho se quedan
como estaban.

Detras de la conversacion cae una lluvia de caracteres, deliberadamente tenue: si pelea
con el texto deja de ser ambiente y pasa a estorbar. Se apaga desde la casilla **Fondo
matrix**, se detiene sola cuando la pestana no se ve, y no se dibuja si el sistema pide
menos animacion.

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
| `nombre` | como se llama esta instalacion; se cambia pulsando la marca en la barra lateral |
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

## Requisitos

- **Node 22.5+** (por `node:sqlite`).
- **Claude Code** — obligatorio: `npm install -g @anthropic-ai/claude-code`
- **Codex CLI** — opcional, habilita ChatGPT como segundo proveedor:
  `npm install -g @openai/codex`

El instalador detecta los dos solos. Sin Codex el sistema funciona entero
sobre Claude; la pantalla de Proveedor dira "no instalado" y nada mas.

## LILIT, la auditora

Vigila el equipo y te avisa **por voz** cuando algo se tuerce: alguien espera
tu aprobacion, falla la conexion, se acabo la cuota, una maquina remota no
conecta, se toco una ruta protegida.

No es un especialista y **no gasta cuota**: lee el estado y habla. Eso es
deliberado — si dependiera del modelo, se quedaria muda justo cuando se
agota la cuota, que es uno de los avisos que mas falta hacen.

Tiene 112 formas distintas de decir las cosas para que no suene a grabacion.
Opcionalmente puede redactar con un modelo externo (Groq) cuando hay varias
incidencias a la vez; si no responde, usa su diccionario y nadie lo nota.
Al modelo solo se le manda el tipo de incidencia, nunca el contenido del
trabajo.

La clave se pone **desde la web**: Proveedor > LILIT · modelo externo. Se
comprueba contra el servicio antes de guardarla —una clave mala dejaria a
LILIT con el diccionario sin decir por que— y se escribe fuera del
repositorio con permisos 600. Nunca se vuelve a mostrar entera.

Tambien se puede pasar por entorno con `GROQ_API_KEY`, que manda sobre el
fichero.

## Actualizar

Aplicar una version nueva sobre una instalacion con trabajo dentro:
ver [docs/ACTUALIZAR.md](docs/ACTUALIZAR.md). Las migraciones son aditivas,
asi que la marcha atras es segura.

## Agentes de otras maquinas

Un agente que corre en tu PC o en otro servidor puede coordinarse con este
equipo sin poder tocar nada de aqui: escribe a quien atienda la puerta y
recoge las respuestas. Credencial propia, estrecha y revocable.

Ver [docs/AGENTE-EXTERNO.md](docs/AGENTE-EXTERNO.md).
