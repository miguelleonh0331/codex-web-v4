# Actualizar una instalacion que ya existe

Aplicar una version nueva sobre un servidor con especialistas y
conversaciones dentro. Probado sobre una base real de 15 agentes y 171
mensajes.

## Lo normal: el boton

**Proveedor → Buscar actualizacion → Instalar.** No hace falta entrar al
servidor.

El boton hace lo mismo que el procedimiento manual de mas abajo, en este
orden, y se planta si algo no cuadra:

| Paso | Si falla |
|---|---|
| Comprueba que no hay archivos editados a mano en el servidor | No sigue. Los machacaria |
| Copia la base de datos, en caliente | No sigue. No trabaja sin red |
| Trae los cambios de GitHub | No sigue |
| Comprueba que es un avance en linea recta | No sigue. Hay que resolverlo a mano |
| Revisa la sintaxis de todo el codigo nuevo | Deshace. No reinicia |
| Reinicia y espera a que conteste (90 s) | **Vuelve sola a la version anterior** |
| Pasa las 395 pruebas | Avisa, pero no deshace: tus datos estan bien |

Dos detalles que no son evidentes:

**El trabajo no corre dentro del programa.** Corre en un proceso suelto que
lanza `systemd-run`, porque un programa no puede vigilar su propio reinicio:
`systemctl restart` mataria al que tiene que comprobar si la version nueva
arranco. Al vivir fuera, sigue ahi para deshacer si hace falta.

**La copia de la base se hace con el servicio en marcha**, con `VACUUM INTO`.
Copiar el archivo a pelo no sirve con WAL: saldria a medias. Queda en
`backups/v4-antes-de-actualizar-<fecha>.db`.

Si hay especialistas trabajando, avisa por nombre antes de reiniciar: el
turno se les corta a medias. Y queda un boton **Volver atras** a un clic, que
no toca conversaciones ni especialistas.

## Por que es seguro

Las migraciones son **aditivas**: anaden columnas y tablas, nunca modifican
ni borran. Eso tiene una consecuencia practica importante: **el codigo
anterior puede volver a leer la base migrada**. Si algo sale mal, basta con
volver a la rama de antes; no hay que restaurar nada.

Comprobado en los dos sentidos:

| | agentes | mensajes |
|---|---|---|
| Antes | 15 | 171 |
| Con el codigo nuevo | 15 | 171 |
| Volviendo al anterior | 15 | 171 |

Las claves de configuracion que falten se rellenan con sus valores por
defecto al arrancar, sin tocar tu `config.json`.

## El parche

```bash
sudo systemctl stop codex-web-v4
sudo cp -a /var/lib/codex-web-v4/v4.db \
          /var/lib/codex-web-v4/backups/v4-$(date +%F-%H%M).db

cd /opt/codex-web-v4
git fetch origin
git checkout <rama o etiqueta>

sudo systemctl start codex-web-v4
node test/selftest.js
```

El servicio se para antes de copiar porque SQLite va en modo WAL: copiar la
base con el servicio escribiendo da una copia incoherente. Son unos
segundos.

## Marcha atras

```bash
cd /opt/codex-web-v4 && git checkout main
sudo systemctl restart codex-web-v4
```

La base migrada le sirve igual.

## Lo que NO se migra solo

Son decisiones tuyas, y por eso no se aplican sin pedirtelo.

**Proveedor de los especialistas.** Los existentes quedan con `proveedor`
vacio, que significa "el de la instalacion". Nada cambia hasta que asignes
alguno a otro motor.

**Rutas protegidas.** El guardia no vigila nada hasta que declares que. Es
lo primero que conviene poner en un servidor con produccion:

```json
"rutasProtegidas": ["/etc/asterisk", "/var/www/html/zynervoxv2"]
```

**Tope de gasto.** Queda en 0 (sin tope). Se fija desde la web, en la
pantalla de Proveedor.

**Valores escritos por un instalador antiguo.** `install.sh` conserva el
`config.json` que encuentre, asi que un valor ya escrito gana sobre el nuevo
valor por defecto. El caso que mas se nota:

```json
"turnTimeoutMs": 900000     // instalaciones antiguas: corta a los 15 min
"turnTimeoutMs": 0          // comportamiento nuevo: sin tope total
"inactivityTimeoutMs": 1800000   // corta solo si no emite nada en 30 min
```

Si quieres el comportamiento nuevo, cambialo a mano.

## Segundo proveedor

Codex (ChatGPT) es **opcional**. Sin el, todo funciona sobre Claude; con el,
puedes asignar especialistas a uno u otro.

```bash
npm install -g @openai/codex
sudo ./install.sh --codex-bin "$(command -v codex)"
```

Si ya estaba instalado, el instalador lo detecta solo. Despues se conecta
desde la web: **Proveedor → Conectar ChatGPT**.

## Comprobar que quedo bien

```bash
node test/selftest.js
```

Si el autodiagnostico dice que la sesion no sirve, mira si es que caduco o
si no hay ninguna: no es lo mismo. Un token caducado **pero renovable** se
renueva solo en el siguiente turno y no hay nada que hacer.
