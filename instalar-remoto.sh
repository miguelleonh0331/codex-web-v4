#!/usr/bin/env bash
# Instala codex-web-v4 en otro servidor por SSH, sin pasar por GitHub.
#
#   ./instalar-remoto.sh <destino-ssh> [opciones-del-instalador...]
#
# Ejemplo:
#   ./instalar-remoto.sh zynervoxv100 --user rocky --port 3212 \
#       --project-name zynervox --project-path /opt/zynervox
#
# El destino puede ser un alias de ~/.ssh/config o usuario@host. Se copia el
# repositorio completo (con su historia), se comprueban los requisitos y se
# ejecuta el instalador tal cual se ejecutaria en local.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DESTINO="${1:-}"
shift || true

if [[ -z "$DESTINO" ]]; then
  sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'
  exit 1
fi

RUTA_REMOTA="${RUTA_REMOTA:-/opt/codex-web-v4}"
BUNDLE="/tmp/codex-web-v4-$(date +%Y%m%d%H%M%S).bundle"

echo "==> Comprobando el destino"
ssh -o BatchMode=yes "$DESTINO" true || { echo "No se pudo conectar por SSH a $DESTINO" >&2; exit 1; }

NODE_REMOTO="$(ssh "$DESTINO" 'command -v node || ls /usr/local/bin/node 2>/dev/null || true')"
if [[ -z "$NODE_REMOTO" ]]; then
  echo "El destino no tiene node. Instala Node >= 22.5 alli antes de seguir." >&2
  exit 1
fi
VERSION="$(ssh "$DESTINO" "$NODE_REMOTO -p 'process.versions.node'")"
echo "    node $VERSION en $NODE_REMOTO"

echo "==> Empaquetando el repositorio (con su historia)"
git -C "$APP_DIR" bundle create "$BUNDLE" --all >/dev/null
echo "    $(du -h "$BUNDLE" | cut -f1) en $BUNDLE"

echo "==> Copiando"
scp -q "$BUNDLE" "$DESTINO:/tmp/codex-web-v4.bundle"

echo "==> Clonando en el destino ($RUTA_REMOTA)"
ssh "$DESTINO" "sudo -n mkdir -p '$RUTA_REMOTA' && sudo -n chown \$(id -un):\$(id -gn) '$RUTA_REMOTA' && \
  if [ -d '$RUTA_REMOTA/.git' ]; then \
    git -C '$RUTA_REMOTA' fetch -q /tmp/codex-web-v4.bundle 'refs/heads/*:refs/remotes/paquete/*' && \
    git -C '$RUTA_REMOTA' reset -q --hard paquete/main && echo '    actualizado'; \
  else \
    git clone -q -b main /tmp/codex-web-v4.bundle '$RUTA_REMOTA' && echo '    clonado'; \
  fi"

echo "==> Ejecutando el instalador en el destino"
ssh -t "$DESTINO" "cd '$RUTA_REMOTA' && sudo -n ./install.sh $*"

rm -f "$BUNDLE"
echo
echo "Listo. Recuerda que alli tambien hace falta una sesion de Claude valida:"
echo "  --session-dir <directorio con .credentials.json>   (compartido, recomendado)"
echo "  --session-from <perfil>                            (copia)"
