'use strict';
/**
 * Rostros de los especialistas: dioses griegos.
 *
 * Cada especialista lleva el dios que le corresponde por oficio, no al azar:
 * Hermes mensajero para Telefonia, Hefesto herrero para el Instalador, Demeter
 * de las cosechas para la Granja. Todo es SVG generado al vuelo; la animacion
 * la lleva el CSS y no se guarda ninguna imagen.
 *
 * Si la semilla no es un dios conocido, se genera un rostro propio igualmente
 * estable, para que cualquier especialista nuevo tenga cara desde el primer dia.
 */

const PIEL = '#f6e4cd';
const PIEL_SOMBRA = '#e3c9a8';
const TRAZO = '#2a2118';

function hashSemilla(texto) {
  let h = 0x811c9dc5;
  const s = String(texto || 'v4');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

// ------------------------------------------------------------------ piezas

const TOCADOS = {
  laurel: (c) => `
    <g class="tocado">
      <path d="M-34 -22 Q-40 -38 -22 -45" stroke="${c}" stroke-width="4" fill="none" stroke-linecap="round"/>
      <path d="M34 -22 Q40 -38 22 -45" stroke="${c}" stroke-width="4" fill="none" stroke-linecap="round"/>
      ${[0, 1, 2, 3].map((i) => {
    const t = -24 - i * 7;
    return `<ellipse cx="${-33 + i * 3.4}" cy="${t}" rx="5" ry="3" fill="${c}" transform="rotate(${-40 + i * 8} ${-33 + i * 3.4} ${t})"/>
            <ellipse cx="${33 - i * 3.4}" cy="${t}" rx="5" ry="3" fill="${c}" transform="rotate(${40 - i * 8} ${33 - i * 3.4} ${t})"/>`;
  }).join('')}
    </g>`,

  casco_cresta: (c, c2) => `
    <g class="tocado">
      <path d="M-40 -16 Q0 -62 40 -16 L40 -22 Q0 -54 -40 -22 Z" fill="${c}"/>
      <path d="M-40 -16 Q0 -58 40 -16" fill="${c}" opacity=".95"/>
      <path d="M-6 -56 Q0 -74 6 -56 Q14 -40 6 -34 L-6 -34 Q-14 -40 -6 -56 Z" fill="${c2}" class="cresta"/>
      <rect x="-3" y="-34" width="6" height="26" rx="3" fill="${c}"/>
    </g>`,

  casco_alado: (c, c2) => `
    <g class="tocado">
      <path d="M-36 -20 Q0 -56 36 -20 L36 -26 Q0 -50 -36 -26 Z" fill="${c}"/>
      <path d="M-36 -20 Q0 -52 36 -20" fill="${c}"/>
      <g class="ala-izq">
        <path d="M-34 -30 Q-58 -42 -64 -28 Q-52 -26 -46 -20 Q-40 -24 -34 -24 Z" fill="${c2}"/>
        <path d="M-34 -26 Q-52 -32 -58 -22" stroke="${c}" stroke-width="1.6" fill="none" opacity=".6"/>
      </g>
      <g class="ala-der">
        <path d="M34 -30 Q58 -42 64 -28 Q52 -26 46 -20 Q40 -24 34 -24 Z" fill="${c2}"/>
        <path d="M34 -26 Q52 -32 58 -22" stroke="${c}" stroke-width="1.6" fill="none" opacity=".6"/>
      </g>
    </g>`,

  casco_corintio: (c, c2) => `
    <g class="tocado">
      <path d="M-38 -14 Q-40 -56 0 -58 Q40 -56 38 -14 L30 -16 Q32 -48 0 -50 Q-32 -48 -30 -16 Z" fill="${c}"/>
      <path d="M-5 -58 Q0 -76 5 -58 Q12 -44 5 -38 L-5 -38 Q-12 -44 -5 -58 Z" fill="${c2}" class="cresta"/>
    </g>`,

  trigo: (c) => `
    <g class="tocado">
      ${[-30, -15, 0, 15, 30].map((x, i) => {
    const alto = i === 2 ? -58 : (i % 2 === 0 ? -44 : -52);
    return `<line x1="${x}" y1="-30" x2="${x * 0.8}" y2="${alto}" stroke="${c}" stroke-width="3" stroke-linecap="round"/>
            ${[0, 1, 2].map((k) => `<ellipse cx="${x * 0.86 + (k % 2 ? 3.4 : -3.4)}" cy="${alto + 7 + k * 6}" rx="3.4" ry="5" fill="${c}" opacity=".95"/>`).join('')}`;
  }).join('')}
    </g>`,

  llama: (c, c2) => `
    <g class="tocado">
      <path d="M-26 -28 Q0 -38 26 -28 L26 -22 Q0 -30 -26 -22 Z" fill="${c}"/>
      <g class="fuego">
        <path d="M0 -72 Q14 -54 10 -42 Q6 -32 0 -30 Q-6 -32 -10 -42 Q-14 -54 0 -72 Z" fill="${c2}"/>
        <path d="M0 -62 Q6 -50 4 -42 Q2 -36 0 -35 Q-2 -36 -4 -42 Q-6 -50 0 -62 Z" fill="#fff6c4" opacity=".85"/>
      </g>
    </g>`,

  antorchas: (c, c2) => `
    <g class="tocado">
      <path d="M-30 -26 Q0 -44 30 -26 L30 -20 Q0 -36 -30 -20 Z" fill="${c}"/>
      <g class="fuego">
        <rect x="-44" y="-44" width="5" height="20" rx="2" fill="${c}"/>
        <path d="M-41.5 -62 Q-33 -52 -37 -44 Q-41.5 -41 -46 -44 Q-50 -52 -41.5 -62 Z" fill="${c2}"/>
        <rect x="39" y="-44" width="5" height="20" rx="2" fill="${c}"/>
        <path d="M41.5 -62 Q50 -52 46 -44 Q41.5 -41 37 -44 Q33 -52 41.5 -62 Z" fill="${c2}"/>
      </g>
    </g>`,

  diadema: (c, c2) => `
    <g class="tocado">
      <path d="M-34 -24 Q0 -46 34 -24 L34 -17 Q0 -38 -34 -17 Z" fill="${c}"/>
      <circle cx="0" cy="-36" r="6" fill="${c2}" class="gema"/>
      <circle cx="-18" cy="-30" r="3.2" fill="${c2}" opacity=".8"/>
      <circle cx="18" cy="-30" r="3.2" fill="${c2}" opacity=".8"/>
    </g>`,

  gorro_herrero: (c, c2) => `
    <g class="tocado">
      <path d="M-34 -18 Q-36 -46 0 -48 Q36 -46 34 -18 L28 -20 Q30 -40 0 -42 Q-30 -40 -28 -20 Z" fill="${c}"/>
      <rect x="-36" y="-22" width="72" height="9" rx="4.5" fill="${c2}"/>
    </g>`,

  velo: (c) => `
    <g class="tocado">
      <path d="M-44 6 Q-46 -46 0 -48 Q46 -46 44 6 L36 6 Q38 -38 0 -40 Q-38 -38 -36 6 Z" fill="${c}" opacity=".92"/>
    </g>`
};

const EMBLEMAS = {
  rayo: (c) => `<g class="emblema rayo"><path d="M46 -34 L34 -14 L43 -13 L33 4 L50 -16 L41 -17 L52 -34 Z" fill="${c}" stroke="rgba(0,0,0,.25)" stroke-width="1"/></g>`,
  lira: (c) => `<g class="emblema"><path d="M40 -6 Q34 -22 42 -30 M54 -6 Q60 -22 52 -30" stroke="${c}" stroke-width="3" fill="none" stroke-linecap="round"/><path d="M40 -6 L54 -6" stroke="${c}" stroke-width="3" stroke-linecap="round"/><path d="M44 -10 L44 -26 M47 -10 L47 -27 M50 -10 L50 -26" stroke="${c}" stroke-width="1.4" opacity=".8"/></g>`,
  martillo: (c) => `<g class="emblema martillo"><rect x="36" y="-30" width="22" height="12" rx="3" fill="${c}"/><rect x="44" y="-18" width="5" height="24" rx="2.5" fill="${c}" opacity=".85"/></g>`,
  buho: (c) => `<g class="emblema"><ellipse cx="47" cy="-14" rx="11" ry="13" fill="${c}"/><circle cx="43" cy="-18" r="3.4" fill="#fff"/><circle cx="51" cy="-18" r="3.4" fill="#fff"/><circle cx="43" cy="-18" r="1.6" fill="${TRAZO}"/><circle cx="51" cy="-18" r="1.6" fill="${TRAZO}"/><path d="M47 -14 L44 -10 L50 -10 Z" fill="#ffb020"/></g>`,
  llave: (c) => `<g class="emblema"><circle cx="44" cy="-24" r="7" fill="none" stroke="${c}" stroke-width="3.5"/><line x1="44" y1="-17" x2="44" y2="2" stroke="${c}" stroke-width="3.5" stroke-linecap="round"/><line x1="44" y1="-4" x2="52" y2="-4" stroke="${c}" stroke-width="3.5" stroke-linecap="round"/><line x1="44" y1="2" x2="51" y2="2" stroke="${c}" stroke-width="3.5" stroke-linecap="round"/></g>`,
  pergamino: (c) => `<g class="emblema"><rect x="36" y="-26" width="22" height="26" rx="3" fill="${c}"/><line x1="40" y1="-19" x2="54" y2="-19" stroke="rgba(0,0,0,.35)" stroke-width="2"/><line x1="40" y1="-13" x2="54" y2="-13" stroke="rgba(0,0,0,.35)" stroke-width="2"/><line x1="40" y1="-7" x2="49" y2="-7" stroke="rgba(0,0,0,.35)" stroke-width="2"/></g>`,
  espiga: (c) => `<g class="emblema"><line x1="46" y1="2" x2="46" y2="-26" stroke="${c}" stroke-width="3" stroke-linecap="round"/>${[0, 1, 2].map((k) => `<ellipse cx="${42 - 0}" cy="${-20 + k * 7}" rx="3.4" ry="5" fill="${c}"/><ellipse cx="${50}" cy="${-20 + k * 7}" rx="3.4" ry="5" fill="${c}"/>`).join('')}</g>`,
  lanza: (c) => `<g class="emblema"><line x1="47" y1="6" x2="47" y2="-24" stroke="${c}" stroke-width="3.5" stroke-linecap="round"/><path d="M47 -34 L52 -24 L42 -24 Z" fill="${c}"/></g>`,
  llamaEmb: (c) => `<g class="emblema fuego"><path d="M46 -30 Q56 -16 50 -6 Q46 -2 42 -6 Q36 -16 46 -30 Z" fill="${c}"/></g>`,
  caduceo: (c) => `<g class="emblema"><line x1="47" y1="6" x2="47" y2="-28" stroke="${c}" stroke-width="3" stroke-linecap="round"/><path d="M41 -22 Q47 -18 53 -14 M41 -14 Q47 -10 53 -6" stroke="${c}" stroke-width="2.4" fill="none" stroke-linecap="round"/><path d="M40 -30 Q47 -36 54 -30" stroke="${c}" stroke-width="2.4" fill="none" stroke-linecap="round"/></g>`
};

function barba(tipo, c) {
  if (tipo === 'larga') {
    return `<path d="M-26 4 Q-30 40 0 50 Q30 40 26 4 Q14 18 0 18 Q-14 18 -26 4 Z" fill="${c}"/>
            <path d="M-14 -2 Q0 8 14 -2" stroke="${c}" stroke-width="5" fill="none" stroke-linecap="round" opacity=".9"/>`;
  }
  if (tipo === 'corta') {
    return `<path d="M-23 6 Q-24 30 0 34 Q24 30 23 6 Q12 16 0 16 Q-12 16 -23 6 Z" fill="${c}" opacity=".95"/>`;
  }
  return '';
}

// ------------------------------------------------------------------ dioses

const DIOSES = {
  zeus: { nombre: 'Zeus', h: 45, h2: 38, tocado: ['laurel', '#f0c75e'], barba: ['larga', '#e8e2d6'], emblema: ['rayo', '#ffd75e'], boca: 'seria', ojos: 'firme' },
  hermes: { nombre: 'Hermes', h: 195, h2: 205, tocado: ['casco_alado', '#cfd8e3', '#ffffff'], barba: ['', ''], emblema: ['caduceo', '#e6edf6'], boca: 'sonrisa', ojos: 'vivo' },
  apolo: { nombre: 'Apolo', h: 38, h2: 28, tocado: ['laurel', '#ffd98a'], barba: ['', ''], emblema: ['lira', '#ffd98a'], boca: 'sonrisa', ojos: 'sereno' },
  ares: { nombre: 'Ares', h: 2, h2: 352, tocado: ['casco_cresta', '#b9c2cc', '#d6453f'], barba: ['corta', '#3a2a22'], emblema: ['lanza', '#d8dde3'], boca: 'seria', ojos: 'firme' },
  atenea: { nombre: 'Atenea', h: 212, h2: 225, tocado: ['casco_corintio', '#c9b273', '#4f7fd6'], barba: ['', ''], emblema: ['buho', '#b89a5c'], boca: 'seria', ojos: 'sereno' },
  hefesto: { nombre: 'Hefesto', h: 20, h2: 12, tocado: ['gorro_herrero', '#8a5a3b', '#5c3a26'], barba: ['larga', '#4a3328'], emblema: ['martillo', '#a9b2bb'], boca: 'seria', ojos: 'firme' },
  demeter: { nombre: 'Demeter', h: 88, h2: 70, tocado: ['trigo', '#e3bb55'], barba: ['', ''], emblema: ['espiga', '#e3bb55'], boca: 'sonrisa', ojos: 'sereno' },
  hecate: { nombre: 'Hecate', h: 278, h2: 262, tocado: ['antorchas', '#7d6bb0', '#ffb74d'], barba: ['', ''], emblema: ['llave', '#d9cff2'], boca: 'seria', ojos: 'vivo' },
  mnemosine: { nombre: 'Mnemosine', h: 172, h2: 186, tocado: ['diadema', '#cdb86a', '#59d6c0'], barba: ['', ''], emblema: ['pergamino', '#efe4c9'], boca: 'sonrisa', ojos: 'sereno' },
  hestia: { nombre: 'Hestia', h: 14, h2: 32, tocado: ['velo', '#d8b39a'], barba: ['', ''], emblema: ['llamaEmb', '#ff9f43'], boca: 'sonrisa', ojos: 'sereno' }
};

const OJOS = {
  sereno: `<g class="ojo"><ellipse rx="5.4" ry="6.2" fill="${TRAZO}"/><circle cx="-2" cy="-2" r="1.6" fill="#fff" opacity=".9"/></g>`,
  firme: `<g class="ojo"><path d="M-7 -4 L7 -2" stroke="${TRAZO}" stroke-width="2.6" stroke-linecap="round" opacity=".8"/><circle cy="2" r="5" fill="${TRAZO}"/><circle cx="-1.6" cy="0.4" r="1.4" fill="#fff" opacity=".9"/></g>`,
  vivo: `<g class="ojo"><circle r="6.6" fill="#fff"/><circle r="3.4" fill="${TRAZO}"/><circle cx="-1.2" cy="-1.2" r="1.2" fill="#fff"/></g>`
};

const BOCAS = {
  sonrisa: `<path class="boca" d="M-11 0 Q0 9 11 0" stroke="${TRAZO}" stroke-width="3.2" fill="none" stroke-linecap="round"/>`,
  seria: `<path class="boca" d="M-10 2 Q0 5 10 2" stroke="${TRAZO}" stroke-width="3.2" fill="none" stroke-linecap="round"/>`
};

function esDios(semilla) {
  const k = String(semilla || '').toLowerCase().trim();
  return Object.prototype.hasOwnProperty.call(DIOSES, k) ? k : null;
}

/** Rostro propio para semillas que no son un dios conocido. */
function dioseGenerado(semilla) {
  let h = hashSemilla(semilla);
  const sig = (n) => { h = (Math.imul(h, 1664525) + 1013904223) >>> 0; return h % n; };
  const claves = Object.keys(TOCADOS);
  const embl = Object.keys(EMBLEMAS);
  const tono = sig(360);
  const paleta = `hsl(${tono},55%,62%)`;
  const paleta2 = `hsl(${(tono + 40) % 360},70%,66%)`;
  const bar = ['', 'corta', 'larga'][sig(3)];
  return {
    nombre: 'Especialista',
    h: tono,
    h2: (tono + 28) % 360,
    tocado: [claves[sig(claves.length)], paleta, paleta2],
    barba: [bar, `hsl(${tono},25%,${bar ? 32 : 40}%)`],
    emblema: [embl[sig(embl.length)], paleta2],
    boca: sig(2) ? 'sonrisa' : 'seria',
    ojos: ['sereno', 'firme', 'vivo'][sig(3)],
    ritmo: 3.2 + sig(30) / 10
  };
}

/**
 * Devuelve el SVG del rostro.
 * @param {string} semilla  clave de dios ('zeus') o cualquier texto estable
 * @param {string} estado   'idle' | 'working'
 * @param {number} tam      lado en px
 */
function caraSvg(semilla, estado = 'idle', tam = 40) {
  const clave = esDios(semilla);
  const d = clave ? DIOSES[clave] : dioseGenerado(semilla);
  const ritmo = d.ritmo || (3.2 + (hashSemilla(semilla) % 30) / 10);
  const gid = 'h' + hashSemilla(String(semilla)).toString(36);

  const halo1 = `hsl(${d.h},62%,58%)`;
  const halo2 = `hsl(${d.h2},52%,34%)`;
  const [tocadoNombre, tc1, tc2] = d.tocado;
  const pintarTocado = TOCADOS[tocadoNombre] || TOCADOS.laurel;
  const [embNombre, embColor] = d.emblema;
  const pintarEmblema = EMBLEMAS[embNombre] || EMBLEMAS.rayo;

  return `
<svg class="cara ${estado}" width="${tam}" height="${tam}" viewBox="-68 -80 136 150"
     style="--ritmo:${ritmo}s" role="img" aria-label="${d.nombre}">
  <defs>
    <radialGradient id="${gid}" cx="34%" cy="26%">
      <stop offset="0%" stop-color="${halo1}"/>
      <stop offset="100%" stop-color="${halo2}"/>
    </radialGradient>
  </defs>
  <g class="cuerpo">
    <circle r="52" fill="url(#${gid})"/>
    <circle r="52" fill="none" stroke="rgba(0,0,0,.25)" stroke-width="2"/>
    ${pintarEmblema(embColor)}
    <circle r="40" fill="${PIEL}"/>
    <path d="M-38 10 Q0 44 38 10 Q0 24 -38 10 Z" fill="${PIEL_SOMBRA}" opacity=".3"/>
    ${barba(d.barba[0], d.barba[1])}
    <g class="ojos">
      <g transform="translate(-15,-6)">${OJOS[d.ojos] || OJOS.sereno}</g>
      <g transform="translate(15,-6)">${OJOS[d.ojos] || OJOS.sereno}</g>
    </g>
    <path d="M0 -2 L-2.5 8 L2 8" stroke="${PIEL_SOMBRA}" stroke-width="2" fill="none" stroke-linecap="round" opacity=".9"/>
    <g transform="translate(0,18)"><g class="bocas">${BOCAS[d.boca] || BOCAS.sonrisa}</g></g>
    ${pintarTocado(tc1, tc2)}
  </g>
</svg>`.trim();
}

function listaDioses() {
  return Object.entries(DIOSES).map(([clave, d]) => ({ clave, nombre: d.nombre }));
}

if (typeof window !== 'undefined') {
  window.caraSvg = caraSvg;
  window.listaDioses = listaDioses;
}
if (typeof module !== 'undefined') module.exports = { caraSvg, listaDioses, DIOSES };
