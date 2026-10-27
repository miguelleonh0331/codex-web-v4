#!/usr/bin/env bash
# Instalador de codex-web-v4.
# Funciona en cualquier servidor: detecta rutas, no asume nombres fijos.
#
#   sudo ./install.sh [--user USUARIO] [--port PUERTO] [--data-dir RUTA]
#                     [--project-path RUTA] [--project-name NOMBRE]
#                     [--bind "127.0.0.1,100.x.y.z"] [--session-from RUTA_PERFIL]
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
SESSION_FROM=""
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
    --session-from) SESSION_FROM="$2"; shift 2 ;;
    --node) NODE_BIN="$2"; shift 2 ;;
    --service-name) SERVICE_NAME="$2"; shift 2 ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
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
  cat > "$CONFIG_FILE" <<JSON
{
  "port": ${PORT},
  "bindHosts": [${BIND_JSON}],
  "dataDir": "${DATA_DIR}",
  "model": "sonnet",
  "maxConcurrentTurns": 2,
  "turnTimeoutMs": 900000,
  "maxHops": 6,
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
if [[ -n "$SESSION_FROM" ]]; then
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
    echo "Instalado. Abre:  http://<host>:${PORT}/?token=${TOKEN}"
    echo "Estado:           systemctl status ${SERVICE_NAME}"
    echo "Registro:         ${DATA_DIR}/logs/service.log"
    exit 0
  fi
  sleep 1
done

echo "El servicio no respondio a tiempo. Revisa: journalctl -u ${SERVICE_NAME} -n 50" >&2
exit 1
