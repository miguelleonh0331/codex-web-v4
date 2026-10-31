# Economia de contexto

Por que el sistema hace cosas para gastar menos, y cuales.

## El dato que lo motivo

Medido sobre los turnos reales de este servidor, dos dias de trabajo de un
solo especialista:

| | |
|---|---|
| Turnos | 41 |
| Coste | $164.48 |
| Mediana por turno | $2.77 |
| Turno mas caro | $15.25 |
| **Correlacion coste ↔ contexto releido** | **r = 0,71** |

Ese 0,71 es la clave y es contraintuitivo: **el precio de un turno lo pone
sobre todo lo que arrastra, no lo dificil que sea la tarea.** El turno de
$15.25 no era el mas complejo —hizo 12 pasos— sino el mas tardio: releyo 7,3
millones de tokens de conversacion acumulada.

Un corolario que conviene tener claro: bajar el modelo no arregla esto. Si un
turno cuesta mucho por releer once millones de tokens, hacerlo en un modelo
mas barato abarata el precio por token pero **sigue releyendo los once
millones**. Hay que quitar los once millones.

De ahi salen las cuatro medidas de abajo, por orden de lo que devuelven.

## 1. Compactar solo al llenarse el contexto

Cuando un especialista pasa del umbral (`compactarAlPorcentaje`, 70% por
defecto), antes de gastarle el siguiente turno se resume su conversacion. El
trabajo pendiente no se pierde: espera al siguiente reparto.

Se ajusta desde la web, en **Proveedor**. `0` lo desactiva. Por debajo de 30
se rechaza: compactaria tan a menudo que se perderia mas en resumir de lo que
se ahorra.

**Si el turno viene de esperar cuota, el umbral baja 20 puntos.** Va a releer
todo otra vez y ya lleva media hora parado, asi que compactar antes no le
cuesta tiempo a nadie. Uno de los turnos medidos acumulo $13.45 con seis
reintentos de ese tipo.

### La trampa del bucle

`/compact` no consume contexto, asi que **no deja medida nueva** y `ctx_usado`
sigue alto despues de compactar. Sin una guarda, el reparto volveria a ver el
contexto lleno, compactaria otra vez, y el especialista no trabajaria nunca.

La guarda: se recuerda el valor de `ctx_visto` (la marca de la ultima medida)
cuando se compacto, y no se vuelve a considerar hasta que llegue una medida
**nueva**. Esta cubierta por el autodiagnostico, porque romperla deja a un
especialista inservible en silencio.

## 1-bis. Enterarse a tiempo, no despues

El contexto se media **solo al terminar el turno**. Un turno largo podia ir
del 50% al 95% y uno se enteraba cuando ya habia pasado.

Resulta que el CLI si lo dice durante: en un turno real habia 879 eventos
`assistant` con su propio `usage`. El tamaño de la ventana no viene ahi, pero
ya lo sabemos de turnos anteriores, asi que el porcentaje se sigue en vivo.
Consecuencia: **empieza a funcionar en el segundo turno** de cada
especialista. Antes que inventar un tamaño por el nombre del modelo y enseñar
un porcentaje falso, no se enseña nada.

Tres detalles que costaron:

- **No se escribe en la base en cada respuesta.** Solo cuando el porcentaje
  se mueve un punto entero: en una prueba de 600 respuestas, 60 escrituras en
  vez de 600. El filtro llevaba un `&& usado <= previo.usado` que lo anulaba,
  porque el contexto siempre crece y esa parte nunca se cumplia.
- **Un aviso por subida, no por respuesta.** Treinta avisos seguidos se
  silencian, y entonces no sirve ninguno. Se rearma solo cuando baja.
- **El aviso tiene etiqueta propia** (`contexto-<agente>`), para no pisar al
  de "termino", que es el que mas se espera.

El aviso va al movil con lo accionable: el porcentaje, cuantos turnos quedan
a ese ritmo y a que porcentaje se compactara solo. Se ajusta en **Proveedor**
y tiene que ser menor que el umbral de compactacion: avisar por encima no
diria nada nuevo, porque para entonces ya se habria compactado.

### Cuantos turnos quedan

Mas util que un porcentaje. Se calcula con la **mediana** de las subidas de
los ultimos doce turnos —no la media, para que un turno que leyo un archivo
enorme no decida la prevision— y **las bajadas no cuentan**: una compactacion
hundiria la media y diria que quedan muchos mas turnos de los que quedan.

Si no hay historico suficiente devuelve `null` y no se enseña nada. Esto
empezo a grabarse con esta version, asi que en una instalacion que venga de
antes tarda unos turnos en tener algo que decir.

## 2. Memoria de trabajo por especialista

Los primeros turnos de un especialista quemaban 35-43 pasos internos
averiguando rutas, probando comandos y tropezando con los mismos errores. Al
turno siguiente lo habia olvidado.

Esto **no es codigo nuestro**: los dos CLI leen solos un archivo del
directorio de trabajo. Nosotros solo lo sembramos y pedimos que lo mantenga.

| motor | archivo |
|---|---|
| Claude | `CLAUDE.md` |
| Codex | `AGENTS.md` |

Con cuatro secciones: rutas reales, comandos que funcionan aqui, errores ya
cometidos y decisiones tomadas.

Se siembra **al empezar el turno**, no al crear el especialista, para que los
que ya existian la tengan sin recrearlos. Y **nunca se sobreescribe**: pisar
lo que el agente aprendio seria peor que no darle memoria.

## 3. rtk para reconocer el terreno

`rtk` recorta las salidas antes de que lleguen al contexto. Medido sobre este
mismo codigo:

| | ahorro |
|---|---|
| `rtk ls <dir>` | 76% |
| `rtk git status` | 51% |
| `rtk read -m 80 <archivo>` | 95% |
| `rtk read -l aggressive <archivo>` | 89% |
| **`rtk read` sin banderas** | **0% — es un paso a traves** |

Esa ultima fila importa: el ahorro esta en las banderas, no en el comando. El
prompt se lo dice explicitamente a los especialistas, porque `rtk read` pelado
devuelve el archivo igual de grande.

Uso correcto: rtk para **orientarse**; la herramienta normal para leer entero
lo que se va a editar, porque para editar hace falta el texto exacto.

Dos detalles de instalacion:

- El PATH del servicio es `/usr/sbin:/usr/bin:/sbin:/bin`, **sin
  `/usr/local/bin`**. Se inyecta el directorio de rtk en el entorno del
  especialista; sin eso, pedirle que use rtk seria pedirle un comando que no
  puede encontrar.
- Si no hay rtk instalado, el prompt **no lo menciona** y da la alternativa
  genericamente. Nunca se pide un comando que no existe.

## 4. Caja de herramientas propia

Cada especialista tiene `herramientas/` en su espacio, con la regla: la
segunda vez que hagas la misma comprobacion, dejala como script con argumentos
y apuntala en tu memoria. A la tercera sale gratis.

## Lo que esto cuesta

Las reglas ocupan ~1,6 KB en el prompt del sistema de cada turno (~400
tokens). Va en la parte cacheada, asi que se paga una vez por sesion y no por
paso. Frente a releer millones de tokens, es ruido.

Si molesta, `ahorroContexto: false` las quita.

## Lo que NO se hizo, y por que

**Elegir modelo y esfuerzo por tarea (autorregulacion).** Un especialista no
puede elegir el modelo de su propio turno: el proceso se lanza con `--model`
ya fijado, asi que cuando lee el encargo ya esta corriendo en el modelo que se
queria evitar. Solo puede decidirlo quien reparte, antes de lanzar.

Y en los datos medidos no compensaba: la variacion de 5-10x dentro de un mismo
especialista no venia de la dificultad de las tareas sino del contexto
acumulado (de nuevo el 0,71). Un enrutador costaria un turno por decidir —un
25% de recargo en los especialistas baratos— y cambiar de modelo probablemente
fuerce sesion nueva, perdiendo el contexto del proyecto y volviendo a
explorar.

La regla que si funciona: **el modelo lo marca el area del especialista, que es
estable; no la tarea, que es impredecible.**
