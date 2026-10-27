# Entrega — codex-web-v4

Fecha: 2026-10-27 · Construido en una sesion, sobre el servidor vicibox05.

## Acceso

```
http://100.92.146.21:3212/?token=6ee9ac38b8f42221a4786a496bd32fc006d184f1060867f4
```

El token tambien esta en `/etc/codex-web-v4/config.json`. Desde la terminal: `v4ctl`.

## Que se construyo

Una plataforma propia de especialistas, independiente de `openbot.run`, paralela a
`codex-web.service` y sin tocarlo.

| Pieza | Donde |
| --- | --- |
| Aplicacion | `/opt/codex-web-v4` (repo Git, rama `main`, 2 commits) |
| Datos | `/var/lib/codex-web-v4` (SQLite, sesion, workspaces, registros) |
| Configuracion | `/etc/codex-web-v4/config.json` |
| Servicio | `codex-web-v4.service` (activo y habilitado al arranque) |
| Puerto | 3212, atado a loopback y a la IP de Tailscale |

**El requisito numero uno quedo resuelto:** una sola sesion de Claude para N agentes.
Los agentes arrancan con `CLAUDE_CONFIG_DIR` apuntando a `/var/lib/codex-web-v4/session`.
Crear un especialista cuesta una fila en la base, no una licencia.

**Colaboracion real.** Cada agente recibe por MCP: `send_message`, `list_agents`,
`read_inbox`, `claim_files`, `release_files`, `list_claims`. El envio es asincrono: deja
el mensaje y el motor despierta al destinatario en su propio turno.

**Para que no se pisen.** Reservas de archivos con rechazo si ya estan tomados, limite de
saltos por cadena, descarte de duplicados y un turno a la vez por agente.

## Pruebas realizadas

| Prueba | Resultado |
| --- | --- |
| Autodiagnostico (`test/selftest.js`) | 21 de 21 |
| Turno real de un especialista | correcto |
| Conversacion entre agentes `TEST-COLAB-V4-20261027` | Telefonia → Base de Datos → Telefonia, conclusion citando los 3 casos recibidos, sin bucle |
| Conversacion en sentido inverso `TEST-FINAL-V4` | Base de Datos → Telefonia → Base de Datos, correcta |
| Acceso real al proyecto `TEST-REAL-V4-20261027` | leyo `/opt/zynervoxv2-fuente/asterisk` y reservo una ruta |
| Colision `TEST-COLISION-V4-20261027` | el segundo agente fue rechazado, no edito y remitio al responsable |
| Reinicio del servicio | conversaciones conservadas, agentes en reposo |
| Servicios existentes | `codex-web`, `codex-webv2`, Apache, MySQL, Asterisk, Tailscale y OpenBot siguen activos |
| Perfil CL102 original | intacto (md5 identico al respaldo) |
| Proyecto Zynervox | sin cambios: mismo commit, mismos 2 archivos modificados que antes |

Los dos especialistas creados —**Telefonia** y **Base de Datos**— quedan operativos.

## Hallazgos del servidor

**1. Todo el espacio de puertos era efimero.** `ip_local_port_range` valia `1024 65535`,
asi que cualquier conexion saliente podia robar el puerto de un servicio. De hecho Apache
tenia tomado el 3212. Esto amenazaba tambien a `codex-web` (3210) y `codex-webv2` (3211):
si reiniciaban en el momento equivocado, no arrancaban.

Se creo `/etc/sysctl.d/90-codex-web-ports.conf` reservando **3210-3212**, lo que protege
tambien a los dos servicios que ya existian. Ademas el servidor reintenta el bind en
segundo plano en vez de rendirse.

Queda pendiente, como mejora del sistema: subir el limite inferior del rango efimero
(`net.ipv4.ip_local_port_range = 32768 60999`) o reservar el resto de puertos de
servicio. No lo toque para no alterar el comportamiento de servicios ajenos.

**2. El loopback sigue retenido.** Apache mantiene sockets en `CLOSE-WAIT` sobre
127.0.0.1:3212. El servicio funciona por la IP de Tailscale y reintentara el loopback
cada minuto hasta conseguirlo; no requiere intervencion.

## Sobre la sesion

`/var/lib/codex-web-v4/session` es una **copia** de las credenciales del perfil
`CL102$-TRAVEL`, no un enlace. El perfil original esta intacto y respaldado en
`/var/lib/codex-web-v4/backups/`.

Aviso importante: cuando v4 refresque el token, su copia divergira del original. Si
Anthropic rota el token de refresco, el perfil CL102 dentro de `codex-web` podria quedar
desautenticado y habria que volver a iniciar sesion en el. Por eso conviene considerar
ese perfil **cedido a v4** y no usarlo en paralelo desde `codex-web`.

## Pendiente de ti

1. **Publicar en GitHub.** El repo esta listo y commiteado en local, pero no hay
   credenciales en este servidor: no hay `gh`, y la llave SSH de `codex-web` recibe
   `Permission denied` de GitHub. Cuando crees el repositorio:

   ```bash
   cd /opt/codex-web-v4
   git remote add origin git@github.com:<usuario>/codex-web-v4.git
   git push -u origin main
   ```

2. **Instalar en otro servidor** (por ejemplo `zynervoxv100`, cuyo SSH ya quedo probado):

   ```bash
   git clone <repo> /opt/codex-web-v4 && cd /opt/codex-web-v4
   sudo ./install.sh --user <usuario> --port 3212 --project-path <ruta> \
                     --session-from <perfil-con-credenciales>
   ```

3. **Decidir el equipo definitivo.** Hay dos especialistas de ejemplo. Conviene definir
   el resto (usuarios, carga de base, panel, instalador…) con responsabilidades y rutas
   reales antes de ampliar.

## Lo que no se hizo, y por que

- **No se publico el repo**: sin credenciales de GitHub, y crear repos en tu cuenta sin
  que lo veas no me parecia correcto.
- **No se instalo en el VPS remoto**: dijiste que el visto bueno era tuyo.
- **No se toco la ACL de `/opt/zynervoxv2-fuente`**: ya no hace falta, los agentes de v4
  corren como `codex-web` y leen el proyecto directamente. Esa ACL era para OpenBot.
- **No se detuvo ni modifico OpenBot**: sigue corriendo intacto por si lo quieres comparar.
- **No hay rotacion de registros**: `logs/service.log` crece sin limite. Con el uso de
  unos dias no es un problema, pero conviene un `logrotate` si esto se queda.
