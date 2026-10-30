#!/usr/bin/env bash
# Instalador de codex-web-v4.
# Funciona en cualquier servidor: detecta rutas, no asume nombres fijos.
#
#   sudo ./install.sh [--user USUARIO] [--port PUERTO] [--data-dir RUTA]
#                     [--project-path RUTA] [--project-name NOMBRE]
#                     [--bind "127.0.0.1,100.x.y.z"] [--session-from RUTA_PERFIL]
#                     [--https-port 8445] [--no-tailscale] [--codex-bin RUTA]
#
# Requiere Claude Code. Codex (ChatGPT) es opcional: habilita el segundo
# proveedor y se detecta solo si esta instalado.
#
# Si Tailscale esta en marcha, publica la aplicacion por HTTPS dentro de la
# tailnet al terminar. Hace falta para instalarla en el movil y para las
# notificaciones: el navegador las niega fuera de un origen seguro.
# --no-tailscale lo omite; --https-port fija el puerto en vez de elegirlo.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_NAME="codex-web-v4"
USER_NAME="${SUDO_USER:-$(id -un)}"
GROUP_NAME=""
PORT="3212"
DATA_DIR="/var/lib/codex-web-v4"
CONFIG_DIR="/etc/codex-web-v4"
BIND="127.0.0.1"
PROJECT_PATH=""
PROJECT_NAME="proyecto"
APP_NAME="codex-web-v4"
HTTPS_PORT=""
SIN_TAILSCALE=0
SESSION_FROM=""
SESSION_DIR=""
CLAUDE_BIN=""
CODEX_BIN=""
NODE_BIN="$(command -v node || true)"
# sudo suele limpiar el PATH, asi que buscamos node donde suele vivir.
if [[ -z "$NODE_BIN" ]]; then
  for c in /usr/local/bin/node /usr/bin/node /opt/node/bin/node /snap/bin/node; do
    [[ -x "$c" ]] && { NODE_BIN="$c"; break; }
  done
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --user) USER_NAME="$2"; shift 2 ;;
    --group) GROUP_NAME="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --data-dir) DATA_DIR="$2"; shift 2 ;;
    --config-dir) CONFIG_DIR="$2"; shift 2 ;;
    --bind) BIND="$2"; shift 2 ;;
    --project-path) PROJECT_PATH="$2"; shift 2 ;;
    --project-name) PROJECT_NAME="$2"; shift 2 ;;
    --name) APP_NAME="$2"; shift 2 ;;
    --session-from) SESSION_FROM="$2"; shift 2 ;;
    --session-dir) SESSION_DIR="$2"; shift 2 ;;
    --node) NODE_BIN="$2"; shift 2 ;;
    --claude-bin) CLAUDE_BIN="$2"; shift 2 ;;
    --codex-bin) CODEX_BIN="$2"; shift 2 ;;
    --service-name) SERVICE_NAME="$2"; shift 2 ;;
    --https-port) HTTPS_PORT="$2"; shift 2 ;;
    --no-tailscale) SIN_TAILSCALE=1; shift ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    *) echo "Opcion desconocida: $1" >&2; exit 1 ;;
  esac
done

[[ -z "$GROUP_NAME" ]] && GROUP_NAME="$(id -gn "$USER_NAME")"

echo "==> Comprobaciones previas"
if [[ $EUID -ne 0 ]]; then echo "Ejecuta el instalador con sudo." >&2; exit 1; fi
if [[ -z "$NODE_BIN" ]]; then echo "No se encontro node. Instala Node >= 22.5 o pasa --node RUTA." >&2; exit 1; fi

NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')"
NODE_MINOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[1]')"
if (( NODE_MAJOR < 22 || (NODE_MAJOR == 22 && NODE_MINOR < 5) )); then
  echo "Node $("$NODE_BIN" -v) es demasiado antiguo: se necesita >= 22.5 por node:sqlite." >&2
  exit 1
fi
id "$USER_NAME" >/dev/null 2>&1 || { echo "El usuario $USER_NAME no existe." >&2; exit 1; }

# Claude Code es el motor de los especialistas: sin el, el servicio arranca pero
# ningun agente puede trabajar. Mejor fallar aqui que entregar algo inservible.
if [[ -z "$CLAUDE_BIN" ]]; then
  for c in "$(command -v claude 2>/dev/null || true)" \
           /usr/local/bin/claude \
           /opt/codex-web/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude \
           /opt/codex-web/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64-musl/claude \
           "$HOME/.local/bin/claude"; do
    [[ -n "$c" && -x "$c" ]] && { CLAUDE_BIN="$c"; break; }
  done
fi
if [[ -z "$CLAUDE_BIN" ]]; then
  cat >&2 <<'FALTA'

No se encontro Claude Code, y sin el los especialistas no pueden trabajar.

Instalalo y vuelve a ejecutar el instalador:

    npm install -g @anthropic-ai/claude-code

Si ya lo tienes en una ruta propia, indicala:

    sudo ./install.sh --claude-bin /ruta/a/claude ...

FALTA
  exit 1
fi
echo "    claude: $CLAUDE_BIN"

if ! "$CLAUDE_BIN" --version >/dev/null 2>&1; then
  echo "    aviso: $CLAUDE_BIN no responde a --version; comprueba que es ejecutable" >&2
fi

# Codex es el SEGUNDO proveedor y es opcional: sin el, el sistema funciona
# entero sobre Claude. Pero conviene decirlo ahora y no que se descubra en la
# pantalla de Proveedor con un "no instalado" sin explicacion.
if [[ -z "$CODEX_BIN" ]]; then
  for c in "$(command -v codex 2>/dev/null || true)" \
           /usr/local/bin/codex \
           /usr/bin/codex \
           /opt/codex-web/node_modules/.bin/codex; do
    [[ -n "$c" && -x "$c" ]] && { CODEX_BIN="$c"; break; }
  done
fi
if [[ -n "$CODEX_BIN" ]]; then
  echo "    codex:  $CODEX_BIN"
else
  echo "    codex:  no instalado (opcional)"
fi

if ss -ltn 2>/dev/null | grep -q ":${PORT}\b"; then
  echo "El puerto ${PORT} ya esta ocupado. Elige otro con --port." >&2; exit 1
fi
if systemctl list-unit-files 2>/dev/null | grep -q "^${SERVICE_NAME}.service"; then
  echo "    aviso: ${SERVICE_NAME}.service ya existe; se va a sobrescribir."
fi

echo "==> Directorios"
mkdir -p "$DATA_DIR"/{session,agents,logs,backups} "$CONFIG_DIR"
chown -R "$USER_NAME:$GROUP_NAME" "$DATA_DIR" "$CONFIG_DIR" "$APP_DIR"
chmod 750 "$DATA_DIR"

echo "==> Configuracion"
CONFIG_FILE="$CONFIG_DIR/config.json"
if [[ -f "$CONFIG_FILE" ]]; then
  echo "    $CONFIG_FILE ya existe, se conserva"
else
  BIND_JSON="$(printf '%s' "$BIND" | awk -F, '{for(i=1;i<=NF;i++){printf "%s\"%s\"", (i>1?", ":""), $i}}')"
  CODEX_BIN_JSON="$([[ -n "$CODEX_BIN" ]] && printf '"%s"' "$CODEX_BIN" || echo null)"
  cat > "$CONFIG_FILE" <<JSON
{
  "nombre": "${APP_NAME}",
  "port": ${PORT},
  "bindHosts": [${BIND_JSON}],
  "dataDir": "${DATA_DIR}",
  "model": "sonnet",
  "codexBin": ${CODEX_BIN_JSON},
  "maxConcurrentTurns": 2,
  "turnTimeoutMs": 0,
  "inactivityTimeoutMs": 1800000,
  "maxHops": 6,
  "claudeBin": "${CLAUDE_BIN}",
  "project": {
    "name": "${PROJECT_NAME}",
    "path": "${PROJECT_PATH}",
    "deployPath": null,
    "validate": null
  }
}
JSON
  chown "$USER_NAME:$GROUP_NAME" "$CONFIG_FILE"
  chmod 600 "$CONFIG_FILE"
fi

echo "==> Sesion compartida"
if [[ -n "$SESSION_DIR" ]]; then
  # Preferible a copiar: un unico archivo de credenciales, sin copias que compitan.
  "$NODE_BIN" -e "
    const fs=require('fs');const p='$CONFIG_FILE';
    const c=JSON.parse(fs.readFileSync(p,'utf8'));c.sessionDir='$SESSION_DIR';
    fs.writeFileSync(p,JSON.stringify(c,null,2)+'\n');"
  echo "    la sesion se comparte en $SESSION_DIR (sin copia)"
elif [[ -n "$SESSION_FROM" ]]; then
  for f in .credentials.json .claude.json; do
    if [[ -f "$SESSION_FROM/$f" ]]; then
      cp -a "$SESSION_FROM/$f" "$DATA_DIR/session/$f"
      chown "$USER_NAME:$GROUP_NAME" "$DATA_DIR/session/$f"
    fi
  done
  chmod 600 "$DATA_DIR/session/.credentials.json" 2>/dev/null || true
  echo "    copiada desde $SESSION_FROM"
elif [[ -f "$DATA_DIR/session/.credentials.json" ]]; then
  echo "    ya existe una sesion en $DATA_DIR/session"
else
  echo "    AVISO: no hay sesion. Copia un .credentials.json valido a $DATA_DIR/session/"
  echo "    o ejecuta:  sudo -u $USER_NAME env HOME=$DATA_DIR CLAUDE_CONFIG_DIR=$DATA_DIR/session claude /login"
fi

echo "==> Reserva del puerto frente al rango efimero"
# En hosts con ip_local_port_range amplio, una conexion saliente puede robar el puerto.
RESERVED="/etc/sysctl.d/90-${SERVICE_NAME}-ports.conf"
if [[ ! -f "$RESERVED" ]]; then
  echo "net.ipv4.ip_local_reserved_ports = ${PORT}" > "$RESERVED"
  sysctl -p "$RESERVED" >/dev/null 2>&1 || true
fi

echo "==> Servicio systemd"
UNIT="/etc/systemd/system/${SERVICE_NAME}.service"
sed -e "s|__APP_DIR__|${APP_DIR}|g" \
    -e "s|__USER__|${USER_NAME}|g" \
    -e "s|__GROUP__|${GROUP_NAME}|g" \
    -e "s|__DATA_DIR__|${DATA_DIR}|g" \
    -e "s|__CONFIG__|${CONFIG_FILE}|g" \
    -e "s|__NODE__|${NODE_BIN}|g" \
    "$APP_DIR/systemd/codex-web-v4.service.template" > "$UNIT"

systemctl daemon-reload
systemctl enable --now "${SERVICE_NAME}.service"

echo "==> Esperando a que responda"
for i in $(seq 1 20); do
  if curl -fsS -m 2 "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
    TOKEN="$("$NODE_BIN" -p "JSON.parse(require('fs').readFileSync('${CONFIG_FILE}','utf8')).authToken")"
    echo
    # Direccion con certificado, si Tailscale la esta sirviendo. Importa
    # porque la PWA y las notificaciones solo funcionan en origen seguro:
    # por IP y HTTP el navegador ni registra el service worker.
    ACCESO_HTTPS="$("$NODE_BIN" -e "
      try{
        const {execFileSync}=require('node:child_process');
        const d=JSON.parse(execFileSync('tailscale',['serve','status','--json'],
          {timeout:3000,encoding:'utf8',stdio:['ignore','pipe','ignore']}));
        const mio='http://127.0.0.1:${PORT}';
        for(const [hp,c] of Object.entries(d.Web||{}))
          for(const h of Object.values(c.Handlers||{}))
            if(h.Proxy===mio){process.stdout.write('https://'+hp+'/');process.exit(0);}
      }catch{}" 2>/dev/null)"

    # Si no la hay y Tailscale esta en marcha, se configura aqui mismo.
    # serve expone solo dentro de la tailnet, igual que el bind actual: no
    # amplia el alcance. (funnel, que si publica a internet, no se toca.)
    if [[ -z "$ACCESO_HTTPS" && $SIN_TAILSCALE -eq 0 ]] && command -v tailscale >/dev/null 2>&1; then
      if tailscale status --json 2>/dev/null | grep -q '"BackendState": *"Running"'; then
        if [[ -z "$HTTPS_PORT" ]]; then
          # Primer puerto libre del rango, sin pisar lo que ya sirva otra
          # instalacion en esta misma maquina.
          HTTPS_PORT="$("$NODE_BIN" -e "
            let usados=new Set();
            try{
              const {execFileSync}=require('node:child_process');
              const d=JSON.parse(execFileSync('tailscale',['serve','status','--json'],
                {timeout:3000,encoding:'utf8',stdio:['ignore','pipe','ignore']}));
              usados=new Set(Object.keys(d.TCP||{}).map(Number));
            }catch{}
            for(let p=8443;p<8500;p++) if(!usados.has(p)){process.stdout.write(String(p));break;}" 2>/dev/null)"
        fi
        if [[ -n "$HTTPS_PORT" ]]; then
          echo "==> Publicando por HTTPS en la tailnet (puerto ${HTTPS_PORT})"
          if SERVE_ERR="$(tailscale serve --bg --https="${HTTPS_PORT}" "http://127.0.0.1:${PORT}" 2>&1)"; then
            sleep 1
            ACCESO_HTTPS="$("$NODE_BIN" -e "
              try{
                const {execFileSync}=require('node:child_process');
                const d=JSON.parse(execFileSync('tailscale',['serve','status','--json'],
                  {timeout:3000,encoding:'utf8',stdio:['ignore','pipe','ignore']}));
                const mio='http://127.0.0.1:${PORT}';
                for(const [hp,c] of Object.entries(d.Web||{}))
                  for(const h of Object.values(c.Handlers||{}))
                    if(h.Proxy===mio){process.stdout.write('https://'+hp+'/');process.exit(0);}
              }catch{}" 2>/dev/null)"
          else
            echo "    No se pudo: ${SERVE_ERR}"
            if grep -qi "cert\|https" <<<"$SERVE_ERR"; then
              echo "    Suele faltar activar los certificados HTTPS de la tailnet:"
              echo "    consola de Tailscale > Settings > DNS > HTTPS Certificates > Enable."
            fi
          fi
        fi
      fi
    fi

    if [[ -n "$ACCESO_HTTPS" ]]; then
      echo "Instalado. Abre:  ${ACCESO_HTTPS}"
      echo "                  (desde el movil usa esta, no la IP)"
    else
      echo "Instalado. Abre:  http://<host>:${PORT}/"
      echo
      echo "Sin direccion HTTPS: la aplicacion funcionara, pero NO se podra"
      echo "instalar en el movil ni enviar notificaciones. El navegador lo"
      echo "impide fuera de un origen seguro. Cuando puedas:"
      echo "  tailscale serve --bg --https=8445 http://127.0.0.1:${PORT}"
    fi
    SESION_OK="$("$NODE_BIN" -e "
      const fs=require('fs');const p=require('path');
      const c=JSON.parse(fs.readFileSync('${CONFIG_FILE}','utf8'));
      const d=c.sessionDir||p.join(c.dataDir||'${DATA_DIR}','session');
      try{const o=JSON.parse(fs.readFileSync(p.join(d,'.credentials.json'),'utf8'));
        const e=(o.claudeAiOauth||o).expiresAt||0;process.stdout.write(e>Date.now()?'si':'caducada');}
      catch{process.stdout.write('no');}")"
    if [[ "$SESION_OK" != "si" ]]; then
      echo
      echo "FALTA LA SESION DE CLAUDE (${SESION_OK}). Los agentes no podran trabajar hasta que la inicies."
      echo "Hazlo desde la propia aplicacion, en la seccion Proveedores, o a mano:"
      echo "  sudo -u ${USER_NAME} env HOME=${DATA_DIR} CLAUDE_CONFIG_DIR=\$(${NODE_BIN} -p \"JSON.parse(require('fs').readFileSync('${CONFIG_FILE}','utf8')).sessionDir||'${DATA_DIR}/session'\") ${CLAUDE_BIN} auth login"
    fi
    if [[ -z "$CODEX_BIN" ]]; then
      echo
      echo "SEGUNDO PROVEEDOR (opcional). ChatGPT no esta disponible en este servidor."
      echo "El sistema funciona entero sobre Claude; esto solo anade la opcion de"
      echo "asignar especialistas a ChatGPT. Para tenerlo:"
      echo "  npm install -g @openai/codex"
      echo "  sudo ./install.sh --codex-bin \$(command -v codex)   # o reejecuta sin mas"
      echo "Despues, conectalo desde la web: Proveedor > Conectar ChatGPT."
    fi
    echo "Estado:           systemctl status ${SERVICE_NAME}"
    echo "Registro:         ${DATA_DIR}/logs/service.log"
    exit 0
  fi
  sleep 1
done

echo "El servicio no respondio a tiempo. Revisa: journalctl -u ${SERVICE_NAME} -n 50" >&2
exit 1
