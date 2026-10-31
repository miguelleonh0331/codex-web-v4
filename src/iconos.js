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
// en Node. Son unas ochenta lineas y evita una dependencia.

const zlib = require('node:zlib');
const crypto = require('node:crypto');

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

/**
 * Arco grueso: un anillo recortado entre dos angulos.
 * Es la pieza de los auriculares y de las ondas de voz.
 */
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

/** Barra vertical con las puntas redondeadas: es una linea gruesa. */
function barra(l, x, yBase, alto, grosor, color) {
  linea(l, x, yBase, x, yBase - alto, grosor, color);
}

/** Triangulo relleno, por el signo del area respecto a cada lado. */
function triangulo(l, p1, p2, p3, color) {
  const xs = [p1[0], p2[0], p3[0]], ys = [p1[1], p2[1], p3[1]];
  const lado = (p, a, b) => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
  for (let y = Math.floor(Math.min(...ys)); y < Math.ceil(Math.max(...ys)); y++) {
    for (let x = Math.floor(Math.min(...xs)); x < Math.ceil(Math.max(...xs)); x++) {
      const p = [x + 0.5, y + 0.5];
      const a = lado(p, p1, p2), b = lado(p, p2, p3), c = lado(p, p3, p1);
      if ((a >= 0 && b >= 0 && c >= 0) || (a <= 0 && b <= 0 && c <= 0)) mezclar(l, x, y, color, 1);
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

// Formas de empresa: lo que se reconoce de un vistazo a 48 pixeles en una
// pestaña. Pensadas para un centro de llamadas.
const FORMAS_EMPRESA = [
  'auricular',   // atencion telefonica
  'burbujas',    // conversacion
  'ondas',       // voz en linea
  'barras',      // metricas del panel
  'embudo',      // leads y campanas
  'escudo',      // seguridad y cumplimiento
  'diana',       // objetivos y acuerdos de servicio
  'traspaso'     // pasar la llamada a otro agente
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
 * Dibuja una forma de empresa.
 *
 * Dos colores y nada mas: el de marca y un neutro claro. Lo que hace que un
 * icono parezca corporativo no es el dibujo, es la contencion.
 */
function dibujarEmpresa(l, forma, cx, cy, R, marca, claro, apagado) {
  const g = R * 0.22;   // grosor base de los trazos

  if (forma === 'auricular') {
    // Diadema y dos cascos. El microfono es lo que lo hace inconfundible.
    arco(l, cx, cy + R * 0.08, R * 0.74, g * 0.85, Math.PI, Math.PI * 2, marca);
    const yc = cy + R * 0.12;
    rectRedondo(l, cx - R * 0.95, yc, cx - R * 0.5, yc + R * 0.72, R * 0.2, marca);
    rectRedondo(l, cx + R * 0.5, yc, cx + R * 0.95, yc + R * 0.72, R * 0.2, marca);
    // Brazo del microfono, saliendo del casco derecho.
    arco(l, cx + R * 0.22, cy + R * 0.5, R * 0.52, g * 0.5, Math.PI * 0.08, Math.PI * 0.6, claro);
    circulo(l, cx + R * 0.1, cy + R * 1.02, R * 0.17, claro);
    return;
  }

  if (forma === 'burbujas') {
    // Dos burbujas: la de atras apagada, la de delante en color. Una
    // conversacion, no un mensaje suelto.
    rectRedondo(l, cx - R * 0.9, cy - R * 0.85, cx + R * 0.35, cy + R * 0.1, R * 0.26, apagado);
    rectRedondo(l, cx - R * 0.35, cy - R * 0.25, cx + R * 0.9, cy + R * 0.7, R * 0.26, marca);
    // El rabito, que es lo que la convierte en burbuja y no en rectangulo.
    triangulo(l, [cx + R * 0.3, cy + R * 0.6], [cx + R * 0.3, cy + R * 1.0], [cx - R * 0.02, cy + R * 0.66], marca);
    return;
  }

  if (forma === 'ondas') {
    // Origen a la izquierda y tres arcos que se alejan: voz en linea.
    circulo(l, cx - R * 0.62, cy, R * 0.26, marca);
    [0.45, 0.78, 1.1].forEach((f, i) => {
      arco(l, cx - R * 0.62, cy, R * f, g * 0.55,
        -Math.PI * 0.33, Math.PI * 0.33, i === 2 ? apagado : (i === 1 ? claro : marca));
    });
    return;
  }

  if (forma === 'barras') {
    // Cuatro barras crecientes: el panel de metricas de cualquier operacion.
    const base = cy + R * 0.82;
    const alturas = [0.5, 0.82, 0.62, 1.15];
    alturas.forEach((h, i) => {
      barra(l, cx + (i - 1.5) * R * 0.5, base, R * h, R * 0.26,
        i === 3 ? marca : (i % 2 ? claro : apagado));
    });
    return;
  }

  if (forma === 'embudo') {
    // Embudo de leads: boca ancha, salida estrecha y una gota debajo.
    triangulo(l, [cx - R * 0.78, cy - R * 0.85], [cx + R * 0.78, cy - R * 0.85], [cx, cy + R * 0.42], marca);
    rectRedondo(l, cx - R * 0.13, cy + R * 0.3, cx + R * 0.13, cy + R * 0.82, R * 0.11, claro);
    circulo(l, cx, cy + R * 1.0, R * 0.15, apagado);
    return;
  }

  if (forma === 'escudo') {
    // Hombros rectos arriba y punta abajo.
    rectRedondo(l, cx - R * 0.78, cy - R * 0.88, cx + R * 0.78, cy + R * 0.12, R * 0.22, marca);
    triangulo(l, [cx - R * 0.78, cy - R * 0.1], [cx + R * 0.78, cy - R * 0.1], [cx, cy + R * 0.98], marca);
    // Marca de validacion, en hueco.
    linea(l, cx - R * 0.3, cy - R * 0.22, cx - R * 0.06, cy + R * 0.04, g * 0.62, claro);
    linea(l, cx - R * 0.06, cy + R * 0.04, cx + R * 0.38, cy - R * 0.46, g * 0.62, claro);
    return;
  }

  if (forma === 'diana') {
    // Anillos concentricos: objetivos y acuerdos de servicio.
    arco(l, cx, cy, R * 0.88, g * 0.6, 0, Math.PI * 2, apagado);
    arco(l, cx, cy, R * 0.55, g * 0.6, 0, Math.PI * 2, claro);
    circulo(l, cx, cy, R * 0.24, marca);
    return;
  }

  // traspaso: dos puestos y una llamada que salta de uno a otro.
  circulo(l, cx - R * 0.68, cy + R * 0.38, R * 0.3, marca);
  circulo(l, cx + R * 0.68, cy + R * 0.38, R * 0.3, claro);
  arco(l, cx, cy + R * 0.38, R * 0.68, g * 0.5, Math.PI, Math.PI * 2, apagado);
  circulo(l, cx, cy - R * 0.3, R * 0.16, marca);
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
    dibujarEmpresa(l, forma, cx, cy, radio,
      hsl(tono, sat, luz),              // color de marca
      hsl(tono, Math.max(8, sat - 45), 92),  // neutro claro, casi blanco
      hsl(tono, Math.max(6, sat - 50), 38)); // apagado, para lo secundario
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
