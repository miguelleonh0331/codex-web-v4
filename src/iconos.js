// Icono de la aplicacion, dibujado aqui mismo.
//
// Por que generarlo y no tener archivos sueltos: el icono se usa al instalar
// como aplicacion en el movil, y con varias instalaciones (este servidor, el
// VPS nuevo) tres iconos identicos en la pantalla de inicio no se distinguen.
// Generandolo por semilla, cada instalacion puede tener el suyo y se cambia
// desde la web.
//
// No hay librerias: npm no tiene red en este servidor. Un PNG es su firma,
// unos pocos bloques con CRC y los pixeles comprimidos con zlib, que si viene
// en Node.
//
// Los dibujos NO son mios: son iconos de Lucide (licencia ISC), que es un
// juego profesional. Lo que hace aqui el codigo es interpretar sus trazos
// y pintarlos. Un icono hecho a ojo se nota a la primera.

const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { aPolilineas } = require('./trazo');
const LUCIDE = require('./iconos-datos');

// ---------------------------------------------------------------- PNG crudo

const TABLA_CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = TABLA_CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function bloque(tipo, datos) {
  const largo = Buffer.alloc(4);
  largo.writeUInt32BE(datos.length);
  const cuerpo = Buffer.concat([Buffer.from(tipo, 'ascii'), datos]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(cuerpo));
  return Buffer.concat([largo, cuerpo, crc]);
}

/** Convierte un lienzo RGBA (Uint8Array de w*h*4) en un PNG completo. */
function aPng(pixeles, w, h) {
  // Cada fila lleva delante un byte de filtro. 0 = sin filtrar: ocupa algo
  // mas, pero son iconos de 512 px y evita implementar los cinco filtros.
  const crudo = Buffer.alloc(h * (w * 4 + 1));
  for (let y = 0; y < h; y++) {
    crudo[y * (w * 4 + 1)] = 0;
    Buffer.from(pixeles.buffer, y * w * 4, w * 4).copy(crudo, y * (w * 4 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;    // 8 bits por canal
  ihdr[9] = 6;    // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    bloque('IHDR', ihdr),
    bloque('IDAT', zlib.deflateSync(crudo, { level: 9 })),
    bloque('IEND', Buffer.alloc(0))
  ]);
}

// ------------------------------------------------------------------ dibujo

function lienzo(w, h) { return { w, h, px: new Uint8Array(w * h * 4) }; }

function mezclar(l, x, y, [r, g, b], alfa) {
  if (alfa <= 0 || x < 0 || y < 0 || x >= l.w || y >= l.h) return;
  const i = (y * l.w + x) * 4;
  const a = Math.min(1, alfa);
  l.px[i]     = Math.round(l.px[i]     * (1 - a) + r * a);
  l.px[i + 1] = Math.round(l.px[i + 1] * (1 - a) + g * a);
  l.px[i + 2] = Math.round(l.px[i + 2] * (1 - a) + b * a);
  l.px[i + 3] = Math.round(l.px[i + 3] * (1 - a) + 255 * a);
}

// Cobertura suavizada: en vez de pintar o no pintar, se calcula cuanto entra
// el pixel en la figura. Sin esto los circulos salen dentados.
function suave(d) { return Math.max(0, Math.min(1, 0.5 - d)); }

/** Rellena el lienzo entero, opaco. */
function rellenar(l, color) {
  for (let y = 0; y < l.h; y++) for (let x = 0; x < l.w; x++) mezclar(l, x, y, color, 1);
}

function rectRedondo(l, x0, y0, x1, y1, r, color) {
  for (let y = Math.floor(y0); y < Math.ceil(y1); y++) {
    for (let x = Math.floor(x0); x < Math.ceil(x1); x++) {
      const dx = Math.max(x0 + r - x, 0, x - (x1 - r));
      const dy = Math.max(y0 + r - y, 0, y - (y1 - r));
      const d = Math.hypot(dx, dy) - r;
      mezclar(l, x, y, color, suave(d));
    }
  }
}

function circulo(l, cx, cy, rad, color) {
  const x0 = Math.floor(cx - rad - 1), x1 = Math.ceil(cx + rad + 1);
  const y0 = Math.floor(cy - rad - 1), y1 = Math.ceil(cy + rad + 1);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      mezclar(l, x, y, color, suave(Math.hypot(x - cx, y - cy) - rad));
    }
  }
}

function linea(l, x0, y0, x1, y1, grosor, color) {
  const minx = Math.floor(Math.min(x0, x1) - grosor - 1);
  const maxx = Math.ceil(Math.max(x0, x1) + grosor + 1);
  const miny = Math.floor(Math.min(y0, y1) - grosor - 1);
  const maxy = Math.ceil(Math.max(y0, y1) + grosor + 1);
  const vx = x1 - x0, vy = y1 - y0;
  const largo2 = vx * vx + vy * vy || 1;
  for (let y = miny; y < maxy; y++) {
    for (let x = minx; x < maxx; x++) {
      // Distancia del pixel al segmento, no a la recta: si no, la linea se
      // prolongaria mas alla de sus extremos.
      let t = ((x - x0) * vx + (y - y0) * vy) / largo2;
      t = Math.max(0, Math.min(1, t));
      const d = Math.hypot(x - (x0 + t * vx), y - (y0 + t * vy)) - grosor / 2;
      mezclar(l, x, y, color, suave(d));
    }
  }
}

/** Arco grueso: un anillo recortado entre dos angulos. */
function arco(l, cx, cy, rad, grosor, desde, hasta, color) {
  const fuera = rad + grosor / 2 + 1;
  for (let y = Math.floor(cy - fuera); y < Math.ceil(cy + fuera); y++) {
    for (let x = Math.floor(cx - fuera); x < Math.ceil(cx + fuera); x++) {
      const dx = x - cx, dy = y - cy;
      let a = Math.atan2(dy, dx);
      if (a < 0) a += Math.PI * 2;
      // Normalizamos el angulo al tramo pedido, que puede cruzar el cero.
      let d = a - desde;
      while (d < 0) d += Math.PI * 2;
      while (d > Math.PI * 2) d -= Math.PI * 2;
      if (d > hasta - desde) continue;
      mezclar(l, x, y, color, suave(Math.abs(Math.hypot(dx, dy) - rad) - grosor / 2));
    }
  }
}

// ------------------------------------------------------------------ estilo

function hsl(h, s, l) {
  h = ((h % 360) + 360) % 360; s /= 100; l /= 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x]
    : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

// Numero estable a partir de la semilla: la misma semilla da siempre el mismo
// icono, en este servidor y en cualquier otro.
function azar(semilla) {
  const h = crypto.createHash('sha256').update(String(semilla)).digest();
  let i = 0;
  return () => {
    const v = h.readUInt32BE((i * 4) % 28);
    i += 1;
    return v / 0xffffffff;
  };
}

// Iconos de empresa: los de Lucide, que es un juego profesional, en vez de
// figuras dibujadas a mano. Un icono hecho a ojo se nota a la primera.
// El orden es el del menu: primero lo que mas dice de un centro de llamadas.
const FORMAS_EMPRESA = [
  'headset',          // agente con diadema
  'headphones',       // atencion
  'phone-call',       // llamada en curso
  'phone-forwarded',  // transferencia
  'messages-square',  // conversaciones
  'message-circle',   // mensaje
  'audio-lines',      // voz
  'activity',         // actividad en vivo
  'chart-column',     // metricas
  'gauge',            // rendimiento
  'target',           // objetivos
  'shield-check',     // cumplimiento
  'users-round',      // equipo
  'network',          // nodos conectados
  'radio-tower',      // telefonia
  'building-2',       // empresa
  'ticket-check',     // tickets resueltos
  'clock',            // tiempos de espera
  'workflow',         // flujos de marcacion
  'bot'               // atencion automatica
];

// Las de antes. Se conservan porque dos de ellas leen bien como "equipo
// conectado", que es lo que el sistema hace.
const FORMAS_ABSTRACTAS = ['triada', 'rejilla', 'anillo', 'estrella', 'cadena', 'cumulo'];

const FORMAS = [...FORMAS_EMPRESA, ...FORMAS_ABSTRACTAS];

// Paletas sobrias, de dos colores. El arcoiris de puntos no pasa por el
// logotipo de una empresa: un color de marca y un neutro claro, y ya.
const PALETAS = [
  { nombre: 'azul corporativo', h: 214, s: 72, l: 54, fondo: '#0b1220' },
  { nombre: 'verde azulado',    h: 176, s: 62, l: 42, fondo: '#071614' },
  { nombre: 'indigo',           h: 248, s: 60, l: 60, fondo: '#0d0f1c' },
  { nombre: 'grafito y ambar',  h: 38,  s: 88, l: 55, fondo: '#111214' },
  { nombre: 'borgona',          h: 348, s: 58, l: 50, fondo: '#17090e' },
  { nombre: 'acero',            h: 205, s: 28, l: 62, fondo: '#0f1317' },
  { nombre: 'verde empresa',    h: 148, s: 52, l: 44, fondo: '#08140e' },
  { nombre: 'purpura sobrio',   h: 272, s: 44, l: 58, fondo: '#120d1a' }
];

const FONDOS = ['#080a0d', '#0d1117', '#101418', '#0a0f14'];

// Cuanto mas grande va el dibujo dentro del cuadro. En el cuadrado
// redondeado el tope esta en los lados, no en las diagonales, y antes de
// esto el dibujo ocupaba solo el 40% del ancho util: cabia de sobra.
// El recortable NO usa esto: alli manda la zona segura circular.
const AMPLIACION = 1.5;

/** Como queda un icono, sin dibujarlo. Sirve para describirlo en la web. */
function receta(semilla) {
  const r = azar(semilla);
  const forma = FORMAS[Math.floor(r() * FORMAS.length)];
  const empresa = FORMAS_EMPRESA.includes(forma);

  // Las de empresa van con paleta de marca: un color y un neutro. Las
  // abstractas conservan el arcoiris de antes, que para un equipo de
  // especialistas tiene sentido: cada punto es uno.
  const paleta = PALETAS[Math.floor(r() * PALETAS.length)];
  const tono = empresa ? paleta.h : Math.floor(r() * 360);
  const separacion = 60 + Math.floor(r() * 90);
  const fondo = empresa ? paleta.fondo : FONDOS[Math.floor(r() * FONDOS.length)];

  const nodos = forma === 'triada' ? 3
    : forma === 'cadena' ? 4
    : forma === 'rejilla' ? 4
    : 3 + Math.floor(r() * 4);
  const giro = r() * Math.PI * 2;

  return {
    forma, empresa, tono, separacion, fondo, nodos, giro,
    paleta: empresa ? paleta.nombre : null,
    sat: paleta.s, luz: paleta.l
  };
}

/**
 * Pinta un icono de Lucide centrado en el lienzo.
 *
 * Son trazos de 24x24 con la punta redonda, asi que basta con escalar sus
 * polilineas y pintarlas con segmentos redondeados: el grosor se escala
 * igual que el dibujo, o un icono grande saldria con el trazo de alfiler.
 */
/**
 * Cuanto se aleja del centro el dibujo de un icono, contando el grosor del
 * trazo, en unidades de la mitad de su lienzo.
 *
 * Hace falta para el recortable: Android recorta en CIRCULO, asi que ahi el
 * limite es radial y las esquinas del dibujo son lo que se pierde. Varia
 * bastante entre iconos (de 0,92 a 1,24), asi que aplicar el mismo tamaño a
 * todos deja unos cortados y otros diminutos.
 *
 * Se calcula una vez por icono y se guarda: son veinte y no cambian.
 */
const radialCache = new Map();
function extensionRadial(ico, nombre) {
  if (radialCache.has(nombre)) return radialCache.get(nombre);
  const [vx, vy, vw, vh] = ico.caja;
  const cx = vx + vw / 2; const cy = vy + vh / 2;
  let max = 0;
  const mirar = (x, y) => { max = Math.max(max, Math.hypot(x - cx, y - cy)); };
  for (const fig of ico.figuras) {
    if (fig.tipo === 'circulo') {
      mirar(fig.cx + fig.r, fig.cy); mirar(fig.cx - fig.r, fig.cy);
      mirar(fig.cx, fig.cy + fig.r); mirar(fig.cx, fig.cy - fig.r);
      continue;
    }
    for (const t of aPolilineas(fig.d, { pasos: 8 })) {
      for (const p of t.pts) mirar(p[0], p[1]);
    }
  }
  const v = (max + ico.grosor / 2) / (Math.max(vw, vh) / 2);
  radialCache.set(nombre, v);
  return v;
}

function dibujarLucide(l, nombre, cx, cy, R, color) {
  const ico = LUCIDE[nombre];
  if (!ico) return false;

  const [vx, vy, vw, vh] = ico.caja;
  const escala = (R * 2) / Math.max(vw, vh);
  const px = (x) => cx + (x - vx - vw / 2) * escala;
  const py = (y) => cy + (y - vy - vh / 2) * escala;
  const grosor = Math.max(1.6, ico.grosor * escala);

  for (const fig of ico.figuras) {
    if (fig.tipo === 'circulo') {
      // Un circulo del SVG es su CONTORNO, no un disco: va con arco.
      arco(l, px(fig.cx), py(fig.cy), fig.r * escala, grosor, 0, Math.PI * 2, color);
      continue;
    }
    for (const tramo of aPolilineas(fig.d, { pasos: 14 })) {
      for (let i = 1; i < tramo.pts.length; i++) {
        const a = tramo.pts[i - 1]; const b = tramo.pts[i];
        linea(l, px(a[0]), py(a[1]), px(b[0]), py(b[1]), grosor, color);
      }
    }
  }
  return true;
}

/**
 * Dibuja el icono.
 * @param {string} semilla  misma semilla, mismo icono
 * @param {number} tam      lado en pixeles
 * @param {boolean} maskable  con margen: Android recorta en circulo y se
 *                            comeria los bordes del dibujo
 */
function generar(semilla, tam = 512, maskable = false) {
  const { forma, empresa, tono, separacion, fondo, nodos, giro, sat, luz } = receta(semilla);
  const l = lienzo(tam, tam);

  const rgbFondo = [
    parseInt(fondo.slice(1, 3), 16),
    parseInt(fondo.slice(3, 5), 16),
    parseInt(fondo.slice(5, 7), 16)
  ];

  // En maskable el fondo llega a los bordes porque el recorte lo hace el
  // sistema; en el normal, esquinas redondeadas como cualquier icono.
  // Ojo: aqui no vale rectRedondo con radio 0. Su suavizado da media
  // opacidad justo en el borde de la figura, y con radio 0 TODO el rectangulo
  // es borde: el fondo saldria translucido y el icono, gris.
  if (maskable) rellenar(l, rgbFondo);
  else rectRedondo(l, 0, 0, tam, tam, tam * 0.22, rgbFondo);

  // La zona segura de un icono maskable es el circulo central del 80%: el
  // dibujo no debe pasar de 0,4 del lado contando desde el centro. Con los
  // nodos en 0,78 del radio y su propio tamano encima, 0,14 de margen deja
  // el dibujo en 0,378: dentro, y sin quedarse diminuto.
  const margen = maskable ? tam * 0.14 : tam * 0.21;
  const radio = (tam - margen * 2) / 2;
  const cx = tam / 2, cy = tam / 2;

  // Las de empresa se dibujan aparte: otro lenguaje y otra paleta.
  if (empresa) {
    const marca = hsl(tono, sat, luz);
    const ico = LUCIDE[forma];

    // El tamaño se decide distinto segun la variante, porque el recorte es
    // distinto. En el cuadrado redondeado el limite esta en los lados; en el
    // recortable es un circulo y manda la esquina del dibujo.
    let R;
    if (maskable) {
      // Tan grande como quepa en la zona segura (circulo del 80% central),
      // con un pelin de respiro. Por icono, no a ojo.
      const rad = ico ? extensionRadial(ico, forma) : 1.24;
      R = (tam * 0.38) / rad;
    } else {
      R = radio * 0.92 * AMPLIACION;
    }

    // Un trazo de un solo color, como se usan estos iconos. Mezclar dos en un
    // icono de linea lo ensucia: pierde la limpieza que es su razon de ser.
    dibujarLucide(l, forma, cx, cy, R, marca);
    return aPng(l.px, tam, tam);
  }
  const rNodo = radio * (forma === 'cumulo' ? 0.3 : forma === 'rejilla' ? 0.26 : 0.27);
  const grosor = Math.max(2, radio * 0.085);
  const gris = [0x2a, 0x31, 0x3c];

  const color = (i) => hsl(tono + separacion * i, 68, 62);

  const puntos = [];
  if (forma === 'rejilla') {
    const d = radio * 0.62;
    puntos.push([cx - d, cy - d], [cx + d, cy - d], [cx - d, cy + d], [cx + d, cy + d]);
  } else if (forma === 'cumulo') {
    // Apinados y solapandose: el unico que no es un poligono regular.
    const r2 = azar(semilla + ':cumulo');
    for (let i = 0; i < nodos; i++) {
      const a = giro + (i / nodos) * Math.PI * 2;
      const d = radio * (0.3 + r2() * 0.45);
      puntos.push([cx + Math.cos(a) * d, cy + Math.sin(a) * d]);
    }
  } else {
    for (let i = 0; i < nodos; i++) {
      const a = giro + (i / nodos) * Math.PI * 2 - Math.PI / 2;
      puntos.push([cx + Math.cos(a) * radio * 0.78, cy + Math.sin(a) * radio * 0.78]);
    }
  }

  // Los enlaces van debajo de los nodos.
  if (forma === 'estrella') {
    for (const [x, y] of puntos) linea(l, cx, cy, x, y, grosor, gris);
  } else if (forma === 'cadena') {
    for (let i = 0; i < puntos.length - 1; i++) {
      linea(l, ...puntos[i], ...puntos[i + 1], grosor, gris);
    }
  } else if (forma === 'rejilla') {
    linea(l, ...puntos[0], ...puntos[1], grosor, gris);
    linea(l, ...puntos[0], ...puntos[2], grosor, gris);
    linea(l, ...puntos[1], ...puntos[3], grosor, gris);
    linea(l, ...puntos[2], ...puntos[3], grosor, gris);
  } else if (forma !== 'cumulo') {
    for (let i = 0; i < puntos.length; i++) {
      linea(l, ...puntos[i], ...puntos[(i + 1) % puntos.length], grosor, gris);
    }
  }

  if (forma === 'estrella') circulo(l, cx, cy, rNodo * 0.8, hsl(tono + 180, 20, 86));
  puntos.forEach(([x, y], i) => circulo(l, x, y, rNodo, color(i)));

  return aPng(l.px, tam, tam);
}

/** Semillas nuevas para enseñar como opciones. */
function opciones(n = 8) {
  return Array.from({ length: n }, () => crypto.randomBytes(4).toString('hex'));
}

module.exports = { generar, opciones, receta, FORMAS };
