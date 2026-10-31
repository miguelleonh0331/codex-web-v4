#!/bin/bash
# Actualizador desatendido.
#
# Corre FUERA del servicio (lo lanza systemd-run) por una razon que no es
# evidente: tiene que sobrevivir al reinicio del propio programa que lo llamo.
# Si esto corriera dentro del servicio, "systemctl restart" lo mataria a mitad
# del trabajo y nadie quedaria para comprobar si la version nueva arranco.
#
# Por eso tambien puede deshacer: si la version nueva no responde, este script
# sigue vivo, vuelve a la anterior y la levanta. Sin que nadie mire.
#
# Progreso: una linea por paso en $DATA/actualizacion.log con el formato
#   estado <TAB> paso <TAB> mensaje
# donde estado es  curso | listo | error | revertido
# La web lo lee y lo pinta. Formato de lineas, no JSON, para que escribirlo
# desde bash no necesite escapar nada.

set -uo pipefail

REPO="${V4_REPO:-/opt/codex-web-v4}"
DATA="${V4_DATA:-/var/lib/codex-web-v4}"
SERVICIO="${V4_SERVICIO:-codex-web-v4}"
PUERTO="${V4_PUERTO:-3212}"
NODE="${V4_NODE:-/usr/local/bin/node}"
ESPERA="${V4_ESPERA:-90}"      # segundos que le damos para arrancar
DESTINO="${V4_DESTINO:-}"      # commit concreto; vacio = la punta de la rama

LOG="$DATA/actualizacion.log"
ANT="$DATA/version-anterior"

anterior=""
copia=""

paso()  { printf 'curso\t%s\t%s\n'  "$1" "$2" >> "$LOG"; }
fin()   { printf 'listo\t%s\t%s\n'  "$1" "$2" >> "$LOG"; }
fallo() { printf 'error\t%s\t%s\n'  "$1" "$2" >> "$LOG"; exit 1; }
vuelto(){ printf 'revertido\t%s\t%s\n' "$1" "$2" >> "$LOG"; exit 1; }
aviso() { printf 'aviso\t%s\t%s\n'  "$1" "$2" >> "$LOG"; }

# Espera a que el servicio conteste. Devuelve 0 si llego a contestar.
esperar_vivo() {
  local limite=$((SECONDS + ESPERA))
  while [ $SECONDS -lt $limite ]; do
    if curl -sf --max-time 3 "http://127.0.0.1:$PUERTO/api/health" >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
  return 1
}

# Deshacer: volver al commit de antes y levantar. Solo se llama si la version
# nueva no dio senales de vida.
deshacer() {
  local razon="$1"
  paso deshacer "La version nueva no arranco. Volviendo a la anterior"
  git -C "$REPO" reset --hard "$anterior" --quiet 2>/dev/null
  sudo -n systemctl restart "$SERVICIO" 2>/dev/null
  if esperar_vivo; then
    vuelto fin "$razon. Se volvio a la version anterior y el sistema esta en marcha"
  fi
  vuelto fin "$razon. Ademas la version anterior tampoco levanta: revisa el servidor a mano"
}

: > "$LOG"   # empezamos limpio

cd "$REPO" 2>/dev/null || fallo inicio "No encuentro la instalacion en $REPO"

# ---- 1. Nada a medio terminar en el disco ---------------------------------
# Si alguien edito archivos en el servidor, traer cambios los machacaria.
# Preferimos no tocar nada y decirlo.
if [ -n "$(git status --porcelain 2>/dev/null)" ]; then
  fallo sucio "Hay cambios sin guardar en el servidor. Guardalos o descartalos antes de actualizar"
fi

rama="$(git rev-parse --abbrev-ref HEAD 2>/dev/null)"
[ -n "$rama" ] || fallo inicio "No puedo saber en que rama estoy"
anterior="$(git rev-parse HEAD)"

# ---- 2. Copia de la base, en caliente -------------------------------------
# VACUUM INTO da una copia consistente sin parar el servicio. Copiar el
# archivo a pelo no sirve: la base va en modo WAL y la copia saldria a medias.
paso copia "Guardando una copia de la base de datos"
mkdir -p "$DATA/backups"
copia="$DATA/backups/v4-antes-de-actualizar-$(date +%F-%H%M%S).db"
if ! "$NODE" --no-warnings -e "
const {DatabaseSync}=require('node:sqlite');
const d=new DatabaseSync(process.argv[1],{readOnly:true});
d.exec(\"VACUUM INTO '\"+process.argv[2]+\"'\");
" "$DATA/v4.db" "$copia" 2>/dev/null; then
  fallo copia "No pude copiar la base de datos. No sigo sin red de seguridad"
fi

# ---- 3. Traer los cambios --------------------------------------------------
paso traer "Trayendo los cambios de GitHub"
if ! timeout 120 git fetch origin --quiet 2>/dev/null; then
  fallo traer "No pude contactar con GitHub"
fi

objetivo="${DESTINO:-origin/$rama}"
sha_obj="$(git rev-parse "$objetivo" 2>/dev/null)"
[ -n "$sha_obj" ] || fallo traer "No encuentro $objetivo"

if [ "$sha_obj" = "$anterior" ]; then
  fin fin "Ya estabas en la ultima version. No habia nada que traer"
  exit 0
fi

if [ -n "$DESTINO" ]; then
  # Destino pedido a mano: normalmente el boton de volver atras. Aqui el
  # objetivo esta DETRAS, asi que no es un avance y hay que plantarse en el
  # commit tal cual. Es seguro porque el arbol ya se comprobo limpio arriba.
  paso aplicar "Volviendo a la version $(git rev-parse --short "$sha_obj")"
  if ! git reset --hard "$sha_obj" --quiet 2>/dev/null; then
    fallo aplicar "No pude cambiar a esa version"
  fi
else
  # Solo avance en linea recta. Si la rama local se separo de la de GitHub,
  # fusionar a ciegas puede dar conflictos o perder trabajo: mejor paramos.
  if ! git merge-base --is-ancestor HEAD "$sha_obj" 2>/dev/null; then
    fallo traer "La copia del servidor se separo de GitHub. Hay que resolverlo a mano"
  fi
  paso aplicar "Aplicando la version nueva"
  if ! git merge --ff-only "$sha_obj" --quiet 2>/dev/null; then
    fallo aplicar "No pude aplicar los cambios"
  fi
fi
echo "$anterior" > "$ANT"

# ---- 4. Mirar el codigo antes de confiarle el servicio ---------------------
# Un parentesis mal cerrado en cualquier archivo tumbaria el arranque. Esto
# lo detecta en un segundo, antes de reiniciar nada.
paso revisar "Revisando que el codigo nuevo este bien escrito"
malos=""
while IFS= read -r f; do
  "$NODE" --check "$f" >/dev/null 2>&1 || malos="$malos $(basename "$f")"
done < <(find "$REPO/src" "$REPO/public" "$REPO/test" "$REPO/tools" \
           -maxdepth 2 -name '*.js' 2>/dev/null)
if [ -n "$malos" ]; then
  git reset --hard "$anterior" --quiet 2>/dev/null
  fallo revisar "La version nueva trae errores de sintaxis en:$malos. No la instale"
fi

# ---- 5. Reiniciar y comprobar que vuelve ----------------------------------
paso reiniciar "Reiniciando el sistema"
sudo -n systemctl restart "$SERVICIO" 2>/dev/null

if ! esperar_vivo; then
  deshacer "El sistema no respondio en $ESPERA segundos"
fi

# ---- 6. Autocomprobacion ---------------------------------------------------
# Aqui NO deshacemos: el sistema esta vivo y tus datos estan bien. Una prueba
# en rojo puede ser un detalle menor, y deshacer a ciegas seria peor que
# avisarte. Tienes el boton de volver atras a un clic.
paso comprobar "Pasando las pruebas"
salida="$("$NODE" "$REPO/test/selftest.js" 2>&1 | tail -5)"
fallidas="$(printf '%s' "$salida" | grep -oE '[0-9]+ fallidas' | grep -oE '^[0-9]+')"
correctas="$(printf '%s' "$salida" | grep -oE '[0-9]+ correctas' | grep -oE '^[0-9]+')"

nuevo_corto="$(git rev-parse --short HEAD)"
titulo="$(git log -1 --pretty=%s)"

if [ -n "${fallidas:-}" ] && [ "$fallidas" != "0" ]; then
  aviso comprobar "El sistema funciona, pero $fallidas pruebas salieron en rojo"
  fin fin "Actualizado a $nuevo_corto: $titulo (con $fallidas pruebas en rojo)"
  exit 0
fi

fin fin "Actualizado a $nuevo_corto: $titulo. ${correctas:-0} pruebas correctas"
