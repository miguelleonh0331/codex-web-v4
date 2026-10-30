# Conectar un agente de otra maquina

Un agente que corre en tu PC, en un portatil o en otro VPS puede coordinarse
con el equipo de este servidor. Trabaja en **su** maquina sobre **sus**
ficheros, y usa este canal solo para hablar.

## Que puede y que no

| Puede | No puede |
|---|---|
| Escribir a quien atienda la puerta | Tocar ficheros de este servidor |
| Recibir respuestas del equipo | Crear especialistas |
| Saber quien atiende | Reservar archivos de aqui |
| | Escribir en el vault |
| | Hablar con cualquier especialista |

La separacion es a proposito. Una maquina de escritorio se apaga, cambia de
red y tiene software que no controlas: no debe tener las llaves de todo. Por
eso **no** se usa el token del puente interno, que abre demasiado, sino una
credencial propia, estrecha y revocable.

## Montarlo

### 1. Marca quien atiende la puerta

En la web, edita un especialista y activa **Recibe peticiones externas**.
Sin nadie marcado, el canal responde `409` y no entra nada.

Elige a quien tenga el area mas cercana a lo que va a llegar. Es quien leera
los avisos y decidira si actua o se lo pasa a otro.

### 2. Crea la credencial

En la web, seccion **Agentes externos**, dale un nombre: ese nombre es con el
que aparecera en las conversaciones y con el que el equipo le contestara.

El token se muestra **una sola vez**. Solo se guarda su huella, asi que si lo
pierdes hay que emitir otro.

### 3. Dasela a la maquina de fuera

```bash
export V4_URL=https://<tu-servidor>.tailnet.ts.net:8445
export V4_EXTERNO=<el token>
```

## El canal, en tres llamadas

```bash
# Quien soy y quien me atiende
curl -s $V4_URL/api/externo/quien -H "x-v4-externo: $V4_EXTERNO"

# Informar de algo
curl -s -X POST $V4_URL/api/externo/mensaje \
  -H "x-v4-externo: $V4_EXTERNO" -H 'content-type: application/json' \
  -d '{"texto":"La app dejo de enviar telemetria. El log dice: connection refused."}'

# Recoger lo que me hayan contestado
curl -s $V4_URL/api/externo/pendientes -H "x-v4-externo: $V4_EXTERNO"
```

`/api/externo/pendientes` **vacia la cola** al devolverla: lo que recojas no
vuelve a salir. Guardalo si lo necesitas.

Con `para` se elige a quien atiende, si hay varios:

```json
{"texto":"...", "para":"Telefonia"}
```

## Como se conecta con MCP

Hay dos formas, segun lo que necesites.

### A. Como herramienta del agente de fuera

Lo normal. El agente de tu PC usa Claude Code o Codex en local, y le das un
servidor MCP minimo que envuelva esas tres llamadas. El agente trabaja sobre
tus ficheros y, cuando necesita algo del servidor, lo pregunta.

Un servidor MCP asi son unas cincuenta lineas: declara tres herramientas
(`informar`, `recoger`, `quien_atiende`) y cada una hace su `fetch`.

### B. Como miembro de pleno derecho del equipo

Si quieres que el agente de fuera use **las trece herramientas** del equipo
—`send_message`, `ask_team`, `claim_files`, `recordar`, `vault_*`— puedes
apuntar el puente interno de este repositorio a la URL del servidor:

```bash
V4_API=https://<tu-servidor>.tailnet.ts.net:8445 \
V4_BRIDGE_TOKEN=<token del puente, en /etc/codex-web-v4/config.json> \
V4_AGENT_ID=<id del especialista, creado desde la web> \
node src/bridge/mcp-server.js
```

**Piensalo dos veces.** Eso le da acceso completo: crear especialistas,
escribir a cualquiera, reservar ficheros y modificar el vault. Tiene sentido
para otro servidor tuyo que administras igual de bien. No para un PC de
escritorio.

Y hay un limite que conviene saber: si un especialista de aqui le escribe a
ese agente, el turno **se ejecutaria en este servidor**, no en su maquina,
porque el orquestador despacha en local. Hacia fuera funciona; hacia dentro,
no. El canal de agente externo existe justamente para cubrir ese hueco sin
pretender lo que no es.

## Si su maquina esta apagada

No pasa nada. Lo que el equipo le conteste se queda en su cola y lo recogera
cuando vuelva a conectarse. Por eso `send_message` hacia un agente externo
responde `encolado_fuera` y no un error.

## Revocar

Desde la web, **Revocar** deja la credencial inservible al instante sin
borrar el historial. **Borrar** elimina ademas su cola de mensajes.

Revoca en cuanto una maquina deje de ser de confianza: es el unico punto por
donde entra alguien de fuera.
