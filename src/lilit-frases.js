'use strict';
/**
 * Como habla LILIT.
 *
 * Un aviso repetido palabra por palabra deja de oirse a los tres dias: el
 * oido lo filtra como filtra el ruido de un ventilador. Por eso hay varias
 * formas de decir cada cosa y se elige una distinta cada vez.
 *
 * Reglas de escritura:
 *   - Frases cortas: esto se oye, no se lee.
 *   - Sin cifras largas ni rutas: en voz alta son ruido.
 *   - {n} es el numero, {quien} el nombre del especialista.
 *   - Nada de emojis ni markdown: el sintetizador los lee en alto.
 *
 * El tono sube con la gravedad: lo urgente se dice seco, lo normal se dice
 * como se lo dirias a alguien que esta al lado.
 */

const FRASES = {
  // ---------------------------------------------------------- conexion
  conexion: [
    'Oiga, tenemos problemas de conexion.',
    'Hay fallos de conexion, {n} {turno|turnos} no {salio|salieron}.',
    'La conexion esta dando guerra.',
    'No hay manera de conectar ahora mismo.',
    'Problemas de red: {n} {intento fallido|intentos fallidos}.',
    'Se cayo la conexion en {n} {turno|turnos}.',
    'Algo pasa con la red, no responde.',
    'Atienda, la conexion falla.',
    'No llega respuesta del otro lado.',
    'Conexion inestable, {va|van} {n} {fallo|fallos}.'
  ],

  // ------------------------------------------------------------- cuota
  cuota: [
    'Se acabo la cuota, el equipo queda esperando.',
    'Sin cuota. Los trabajos esperan y saldran solos.',
    'Llegamos al limite de uso, hay {n} {trabajo|trabajos} en espera.',
    'Cuota agotada. Nadie pierde el trabajo, pero nadie avanza.',
    'Se quedo sin cuota por ahora.',
    'El limite de cinco horas nos paro.',
    'Hay {n} {trabajo|trabajos} esperando a que vuelva la cuota.',
    'Sin cuota: todo en pausa hasta que se renueve.',
    'Se agoto el uso, reintentando cada media hora.'
  ],

  // ------------------------------------------------------- aprobacion
  aprobacion: [
    'Oiga, {quien} necesita su aprobacion.',
    '{quien} espera su visto bueno.',
    'Hay algo pendiente de que lo autorice.',
    '{quien} no sigue sin su permiso.',
    'Le estan esperando: {quien} pide aprobacion.',
    '{n} {especialista espera|especialistas esperan} que decida.',
    '{quien} quiere confirmacion antes de continuar.',
    'Necesitan su luz verde: {quien} esta parado.',
    'Hay una decision suya pendiente.',
    '{quien} se detuvo a esperarle.'
  ],

  // -------------------------------------------------------------- duda
  duda: [
    '{quien} tiene una duda para usted.',
    'Le han preguntado algo: {quien} espera respuesta.',
    'Hay {n} {pregunta|preguntas} sin contestar.',
    '{quien} necesita que le aclare algo.',
    'Tiene preguntas esperando.',
    '{quien} pregunto algo y sigue esperando.',
    'Hay dudas sin resolver en el equipo.',
    'Le esperan para aclarar una cosa.'
  ],

  // ---------------------------------------------------------- atascado
  atascado: [
    '{quien} lleva un buen rato sin avanzar.',
    'Creo que {quien} se atasco.',
    '{quien} lleva {n} {minuto|minutos} en lo mismo.',
    'Algo no va bien con {quien}, no termina.',
    'Hay un trabajo que no arranca.',
    '{quien} esta parado desde hace rato.',
    'Un turno lleva demasiado tiempo corriendo.',
    'Me preocupa {quien}, no da señales.',
    'Hay {n} {trabajo encolado|trabajos encolados} que no {sale|salen}.'
  ],

  // ---------------------------------------------------------- guardia
  guardia: [
    'Atencion: {quien} toco una ruta protegida.',
    'Se modifico algo que no deberia tocarse.',
    'Cuidado, {quien} cambio {n} {archivo protegido|archivos protegidos}.',
    'Alguien entro donde no debia: revise el guardia.',
    'Hay cambios en produccion sin revisar.',
    'Se toco una ruta vigilada: puede deshacerlo.',
    'Ojo: {n} {archivo protegido cambio|archivos protegidos cambiaron}.',
    'Revise el guardia: hay movimiento en zona protegida.'
  ],

  // --------------------------------------------------- externo callado
  externo_mudo: [
    'La maquina de fuera lleva horas sin conectarse.',
    '{quien} no da señales de vida.',
    'No sabemos nada de {quien} desde hace rato.',
    'El equipo remoto sigue desconectado.',
    '{quien} no se ha conectado todavia.',
    'La maquina externa esta callada.',
    'Sin noticias de {quien}.',
    'El agente de fuera no aparece.'
  ],

  // ------------------------------------------------ externo pendiente
  externo_pendiente: [
    'Hay {n} {mensaje|mensajes} esperando a que {quien} se conecte.',
    '{quien} tiene correo sin recoger.',
    'Le dejamos {n} {respuesta|respuestas} a {quien} y no {la|las} ha leido.',
    'Quedan mensajes pendientes para la maquina de fuera.',
    '{quien} tiene cosas esperandole.',
    'Hay respuestas sin entregar a {quien}.'
  ],

  // --------------------------------------------------- correo bloqueado
  correo_bloqueado: [
    'Hay mensajes que no llegaron a su destino.',
    '{n} {mensaje|mensajes} entre especialistas {quedo bloqueado|quedaron bloqueados}.',
    'Un especialista escribio a alguien que no existe.',
    'Se corto una cadena de mensajes: iba en bucle.',
    'Hay correo rechazado entre el equipo.',
    'Problemas de comunicacion interna: {n} {mensaje bloqueado|mensajes bloqueados}.',
    'Alguien intento escribir y no pudo.'
  ],

  // --------------------------------------------------------- contexto
  contexto: [
    'A {quien} se le esta llenando la memoria.',
    '{quien} va por el {n} por ciento de su contexto.',
    'Conviene que compacte a {quien}.',
    'La conversacion de {quien} esta casi llena.',
    '{quien} necesita que le libere contexto.',
    'Hay {n} {especialista|especialistas} con la memoria casi llena.'
  ],

  // ------------------------------------------------------------ gasto
  gasto: [
    'Llegamos al tope de gasto del dia.',
    'Se alcanzo el limite que puso: no salen trabajos nuevos.',
    'Tope de gasto alcanzado. Lo encolado sale manana.',
    'Paramos por presupuesto.',
    'Se acabo el presupuesto de hoy.'
  ],

  // ---------------------------------------------------------- timeout
  timeout: [
    'Un trabajo se quedo colgado y hubo que cortarlo.',
    '{quien} no dio señales y se corto el turno.',
    'Se agoto el tiempo de {n} {turno|turnos}.',
    'Un proceso se quedo sin responder.',
    'Hubo que parar a {quien}: no emitia nada.'
  ],

  // ----------------------------------------------------------- sesion
  sesion: [
    'La sesion del proveedor no sirve: revisela.',
    'Hay que volver a conectar el proveedor.',
    'Sin sesion valida, nadie puede trabajar.',
    'El proveedor perdio la sesion.',
    'Revise la conexion con el proveedor.'
  ],

  // ------------------------------------------------------------ error
  error: [
    '{quien} fallo en su ultimo trabajo.',
    'Hay {n} {trabajo|trabajos} que {termino|terminaron} mal.',
    'Algo salio mal con {quien}.',
    '{n} {error|errores} sin revisar.',
    'Un trabajo no se completo.',
    'Revise a {quien}: dio error.'
  ],

  // --------------------------------------------------------- resuelto
  resuelto: [
    'Listo, ya se arreglo.',
    'Todo vuelve a la normalidad.',
    'Resuelto, el equipo sigue.',
    'Ya esta, pueden continuar.',
    'Se soluciono.',
    'Volvemos a estar bien.'
  ],

  // ---------------------------------------------------- saludo inicial
  saludo: [
    'Soy Lilit. Vigilo al equipo y le aviso si algo se tuerce.',
    'Lilit en marcha. Le aviso de lo que haga falta.',
    'Aqui Lilit, atenta al equipo.',
    'Lilit escuchando. Solo hablo si hay algo que contar.'
  ]
};

/**
 * Tratamiento. LILIT se dirige siempre al usuario como "señor", pero
 * colocarlo siempre en el mismo sitio suena a mayordomo de dibujos: se
 * alterna entre el principio, el final y el medio.
 */
// Palabras con las que empiezan las frases del diccionario: no son nombres
// propios aunque vayan en mayuscula, asi que pueden bajar a minuscula.
const PALABRAS_COMUNES = new Set([
  'Oye', 'Oiga', 'Atento', 'Atienda', 'Mira', 'Mire', 'Fijese', 'Escucha', 'Vera', 'Atencion', 'Cuidado', 'Ojo', 'Hay', 'Se',
  'No', 'Un', 'Una', 'La', 'El', 'Te', 'Creo', 'Me', 'Revise', 'Problemas',
  'Conexion', 'Algo', 'Listo', 'Todo', 'Ya', 'Resuelto', 'Volvemos', 'Soy',
  'Aqui', 'Lilit', 'Llegamos', 'Tope', 'Paramos', 'Sin', 'Quedan', 'Necesitan',
  'Tienes', 'Conviene', 'Le', 'Alguien', 'Para', 'Importante', 'Disculpe',
  'Perdone', 'Cuota', 'Hubo', 'Vuelve', 'Nadie'
]);

const TRATAMIENTOS = [
  { donde: 'inicio', texto: 'Señor, ' },
  { donde: 'inicio', texto: 'Señor. ' },
  { donde: 'final', texto: ', señor.' },
  { donde: 'final', texto: ', señor.' },
  { donde: 'inicio', texto: 'Disculpe, señor. ' },
  { donde: 'inicio', texto: 'Señor, atencion: ' },
  { donde: 'final', texto: '. Le aviso, señor.' },
  { donde: 'inicio', texto: 'Perdone, señor. ' }
];

/** Coletillas que se anteponen a veces, para que no empiece siempre igual. */
// En registro de usted: "oye" y "mira" chocan con el "señor".
const APERTURAS = ['', '', '', 'Oiga, ', 'Mire, ', 'Fijese, ', 'Por cierto, ', 'Vera, '];

/** Cuando algo es urgente conviene que suene distinto desde la primera silaba. */
const APERTURAS_URGENTES = ['Atencion. ', 'Importante. ', 'Para un momento. ', ''];

/**
 * Elige una frase sin repetir la anterior del mismo tipo.
 *
 * El "sinRepetir" importa mas de lo que parece: oir dos veces seguidas la
 * misma frase hace que suene a grabacion, y entonces se deja de escuchar.
 */
const ultimas = new Map();

function frase(tipo, datos = {}, urgente = false) {
  const lista = FRASES[tipo] || FRASES.error;
  const previa = ultimas.get(tipo);
  const posibles = lista.length > 1 ? lista.filter((f) => f !== previa) : lista;
  const plantilla = posibles[Math.floor(Math.random() * posibles.length)];
  ultimas.set(tipo, plantilla);

  // El tratamiento se elige primero porque manda sobre lo demas: si va
  // delante, hace de coletilla y no se le encadena otra. Tres capas
  // —tratamiento, coletilla y frase— suenan recargadas.
  const trato = TRATAMIENTOS[Math.floor(Math.random() * TRATAMIENTOS.length)];
  const aperturas = urgente ? APERTURAS_URGENTES : APERTURAS;
  const ap = (trato.donde === 'final')
    ? aperturas[Math.floor(Math.random() * aperturas.length)]
    : '';

  // Si la frase ya trae coletilla propia, no se le encadena otra.
  const yaTieneColetilla = /^(oye|oiga|atento|atienda|mira|mire|fijese|escucha|vera|atencion|cuidado|ojo)/i.test(plantilla);

  let texto = plantilla;
  if (ap && !yaTieneColetilla) {
    // Se decide sobre la PLANTILLA, antes de sustituir: asi se sabe si
    // empieza por un nombre propio, que nunca debe ir en minuscula.
    const empiezaPorNombre = plantilla.startsWith('{quien}');
    // Una coletilla acabada en punto abre frase nueva y conserva la
    // mayuscula; una acabada en coma la continua y la baja.
    const continuaFrase = /,\s$/.test(ap);
    texto = (continuaFrase && !empiezaPorNombre)
      ? ap + plantilla.charAt(0).toLowerCase() + plantilla.slice(1)
      : ap + plantilla;
  }

  // Concordancia: {singular|plural} elige segun n. Sin esto se oye
  // "hay 1 mensajes", que en voz alta canta mucho mas que escrito.
  const uno = datos.n === 1;
  texto = texto
    .replace(/\{([^{}|]+)\|([^{}|]+)\}/g, (_, sing, plur) => (uno ? sing : plur))
    .replace(/\{n\}/g, datos.n != null ? String(datos.n) : 'varios')
    .replace(/\{quien\}/g, datos.quien || 'un especialista');

  return conTratamiento(texto, trato);
}

/**
 * Coloca el tratamiento en la frase ya montada.
 *
 * Se hace al final, sobre el texto completo, porque aqui ya se sabe como
 * empieza y como acaba y no hay que pelearse con las coletillas.
 */
function conTratamiento(texto, trato) {
  const t = trato || TRATAMIENTOS[Math.floor(Math.random() * TRATAMIENTOS.length)];

  if (t.donde === 'final') {
    // Se sustituye el punto final en vez de encadenar otro.
    return texto.replace(/\s*[.!?]+\s*$/, '') + t.texto;
  }

  // Un tratamiento acabado en punto abre frase nueva: la inicial se queda
  // en mayuscula. Uno acabado en coma o en dos puntos la continua y la baja,
  // salvo que sea un nombre propio.
  const abreFrase = /[.!?]\s*$/.test(t.texto);
  if (abreFrase) return t.texto + texto;

  const primera = texto.split(/\s+/)[0] || '';
  const esNombrePropio = /^[A-ZÁÉÍÓÚÑ][a-zñáéíóú]+$/.test(primera) && !PALABRAS_COMUNES.has(primera);
  return t.texto + (esNombrePropio ? texto : texto.charAt(0).toLowerCase() + texto.slice(1));
}

function cuantas() {
  return Object.values(FRASES).reduce((n, l) => n + l.length, 0);
}

module.exports = { FRASES, frase, cuantas, APERTURAS, APERTURAS_URGENTES, TRATAMIENTOS, conTratamiento };
