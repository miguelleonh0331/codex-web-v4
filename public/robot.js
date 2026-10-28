'use strict';
/**
 * Avatares robot de los especialistas.
 *
 * Cada dios es una combinacion de tocado, emblema y paleta, de modo que anadir
 * uno nuevo es una linea. La expresion la da el estado y la animacion la lleva
 * el CSS: no hay imagenes ni fotogramas.
 *
 * El color se puede sobreescribir por especialista: tine el halo, los LED y los
 * remates, dejando el metal neutro para que siga leyendose como robot.
 *
 * Estados: normal | escucha | piensa | responde | feliz | curioso | alerta | error
 */

const ESTADOS = ['normal', 'escucha', 'piensa', 'responde', 'feliz', 'curioso', 'alerta', 'error'];

// ------------------------------------------------------------------- color

function hexAHsl(hex) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(String(hex || '').trim());
  if (!m) return null;
  let [r, g, b] = [1, 2, 3].map((i) => parseInt(m[i], 16) / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0, s = 0;
  if (max !== min) {
    const dd = max - min;
    s = l > 0.5 ? dd / (2 - max - min) : dd / (max + min);
    if (max === r) h = (g - b) / dd + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / dd + 2;
    else h = (r - g) / dd + 4;
    h *= 60;
  }
  return { h, s: s * 100, l: l * 100 };
}

const hsl = (h, s, l) => `hsl(${Math.round(h)},${Math.round(s)}%,${Math.round(l)}%)`;

/** Deriva la paleta completa a partir de un color elegido por el usuario. */
function paletaDe(color) {
  const c = hexAHsl(color);
  if (!c) return null;
  const s = Math.max(35, Math.min(85, c.s));
  return {
    halo1: hsl(c.h, s, Math.min(52, Math.max(30, c.l))),
    halo2: hsl((c.h + 12) % 360, s * 0.8, 11),
    led: hsl(c.h, Math.min(95, s + 25), 66),
    ledSuave: hsl(c.h, Math.min(95, s + 15), 85),
    metal: '#eef2f7', metalSombra: '#c3ccd8', visorFondo: '#0b1018',
    oro: hsl(c.h, Math.min(90, s + 10), 62),
    oroSombra: hsl(c.h, Math.min(90, s + 10), 42)
  };
}

// ------------------------------------------------------------------ tocados

const TOCADOS = {
  laurel: (p) => {
    const hojas = [0, 1, 2, 3].map((i) => {
      const y = -34 - i * 7.5, x = 30 - i * 2.6;
      return `<ellipse cx="${-x}" cy="${y}" rx="6" ry="3.4" fill="${p.oro}" transform="rotate(${-38 + i * 9} ${-x} ${y})"/>
              <ellipse cx="${x}" cy="${y}" rx="6" ry="3.4" fill="${p.oro}" transform="rotate(${38 - i * 9} ${x} ${y})"/>`;
    }).join('');
    return `<g class="tocado">
      <path d="M-31 -31 Q-38 -48 -20 -56" stroke="${p.oroSombra}" stroke-width="3.4" fill="none" stroke-linecap="round"/>
      <path d="M31 -31 Q38 -48 20 -56" stroke="${p.oroSombra}" stroke-width="3.4" fill="none" stroke-linecap="round"/>${hojas}</g>`;
  },

  cresta: (p) => `<g class="tocado">
    <path d="M-40 -26 Q0 -54 40 -26 L40 -33 Q0 -50 -40 -33 Z" fill="${p.oroSombra}"/>
    <path d="M-6 -48 Q0 -70 6 -48 Q14 -34 6 -28 L-6 -28 Q-14 -34 -6 -48 Z" fill="${p.oro}" class="cresta"/>
    <rect x="-3.5" y="-40" width="7" height="12" rx="3.5" fill="${p.oroSombra}"/></g>`,

  alado: (p) => `<g class="tocado">
    <path d="M-34 -30 Q0 -52 34 -30 L34 -36 Q0 -46 -34 -36 Z" fill="${p.oroSombra}"/>
    <g class="ala-izq"><path d="M-33 -36 Q-58 -50 -66 -34 Q-52 -32 -44 -26 Q-38 -30 -33 -30 Z" fill="${p.oro}"/></g>
    <g class="ala-der"><path d="M33 -36 Q58 -50 66 -34 Q52 -32 44 -26 Q38 -30 33 -30 Z" fill="${p.oro}"/></g></g>`,

  corintio: (p) => `<g class="tocado">
    <path d="M-39 -22 Q-40 -56 0 -58 Q40 -56 39 -22 L31 -24 Q32 -48 0 -50 Q-32 -48 -31 -24 Z" fill="${p.oro}"/>
    <path d="M-5 -58 Q0 -76 5 -58 Q12 -44 5 -38 L-5 -38 Q-12 -44 -5 -58 Z" fill="${p.oroSombra}" class="cresta"/></g>`,

  sol: (p) => `<g class="tocado corona-sol">
    ${[-70, -50, -30, -10, 10, 30, 50, 70].map((a) => {
    const r = Math.PI * a / 180;
    const x1 = Math.sin(r) * 36, y1 = -Math.cos(r) * 36 - 4;
    const x2 = Math.sin(r) * 54, y2 = -Math.cos(r) * 54 - 4;
    return `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${p.oro}" stroke-width="4" stroke-linecap="round"/>`;
  }).join('')}</g>`,

  luna: (p) => `<g class="tocado">
    <path d="M-30 -36 Q0 -62 30 -36 L30 -42 Q0 -56 -30 -42 Z" fill="${p.oroSombra}"/>
    <path d="M-16 -52 Q0 -72 16 -52 Q0 -60 -16 -52 Z" fill="${p.oro}"/>
    <circle cx="0" cy="-58" r="4" fill="${p.ledSuave}"/></g>`,

  flores: (p) => `<g class="tocado">
    ${[-28, -14, 0, 14, 28].map((x, i) => {
    const y = -38 - (i === 2 ? 8 : i % 2 ? 2 : 0);
    return `<g>${[0, 72, 144, 216, 288].map((a) => {
      const r = Math.PI * a / 180;
      return `<ellipse cx="${(x + Math.sin(r) * 5).toFixed(1)}" cy="${(y - Math.cos(r) * 5).toFixed(1)}" rx="3.6" ry="3.6" fill="${p.oro}"/>`;
    }).join('')}<circle cx="${x}" cy="${y}" r="2.6" fill="${p.ledSuave}"/></g>`;
  }).join('')}</g>`,

  ondas: (p) => `<g class="tocado">
    <path d="M-34 -32 Q0 -50 34 -32 L34 -39 Q0 -46 -34 -39 Z" fill="${p.oroSombra}"/>
    ${[-22, 0, 22].map((x) => `<path d="M${x - 10} -44 Q${x - 5} -58 ${x} -46 Q${x + 5} -34 ${x + 10} -48"
      stroke="${p.oro}" stroke-width="3.4" fill="none" stroke-linecap="round"/>`).join('')}</g>`,

  capucha: (p) => `<g class="tocado">
    <path d="M-46 14 Q-50 -48 0 -52 Q50 -48 46 14 L34 12 Q38 -36 0 -40 Q-38 -36 -34 12 Z" fill="${p.oroSombra}" opacity=".95"/>
    <path d="M-40 -12 Q-42 -44 0 -47 Q42 -44 40 -12 L34 -14 Q36 -40 0 -42 Q-36 -40 -34 -14 Z" fill="${p.oro}" opacity=".5"/></g>`,

  gafas: (p) => `<g class="tocado">
    <rect x="-38" y="-44" width="76" height="12" rx="6" fill="${p.oroSombra}"/>
    <circle cx="-16" cy="-38" r="9" fill="${p.led}" opacity=".85"/>
    <circle cx="16" cy="-38" r="9" fill="${p.led}" opacity=".85"/>
    <circle cx="-16" cy="-38" r="9" fill="none" stroke="${p.oro}" stroke-width="2.6"/>
    <circle cx="16" cy="-38" r="9" fill="none" stroke="${p.oro}" stroke-width="2.6"/></g>`,

  trigo: (p) => `<g class="tocado">
    ${[-26, -13, 0, 13, 26].map((x, i) => {
    const alto = i === 2 ? -62 : (i % 2 === 0 ? -48 : -56);
    return `<line x1="${x}" y1="-34" x2="${x * 0.82}" y2="${alto}" stroke="${p.oroSombra}" stroke-width="2.6" stroke-linecap="round"/>
      ${[0, 1, 2].map((k) => `<ellipse cx="${(x * 0.88 + (k % 2 ? 3 : -3)).toFixed(1)}" cy="${alto + 7 + k * 6}" rx="3.2" ry="4.6" fill="${p.oro}"/>`).join('')}`;
  }).join('')}</g>`,

  antorchas: (p) => `<g class="tocado">
    <path d="M-30 -34 Q0 -48 30 -34 L30 -40 Q0 -44 -30 -40 Z" fill="${p.oroSombra}"/>
    <g class="fuego">
      <rect x="-46" y="-48" width="5" height="18" rx="2.5" fill="${p.oroSombra}"/>
      <path d="M-43.5 -66 Q-35 -56 -39 -48 Q-43.5 -45 -48 -48 Q-52 -56 -43.5 -66 Z" fill="${p.oro}"/>
      <rect x="41" y="-48" width="5" height="18" rx="2.5" fill="${p.oroSombra}"/>
      <path d="M43.5 -66 Q52 -56 48 -48 Q43.5 -45 39 -48 Q35 -56 43.5 -66 Z" fill="${p.oro}"/></g></g>`,

  llama: (p) => `<g class="tocado">
    <path d="M-26 -36 Q0 -46 26 -36 L26 -42 Q0 -44 -26 -42 Z" fill="${p.oroSombra}"/>
    <g class="fuego">
      <path d="M0 -76 Q14 -58 10 -46 Q6 -38 0 -36 Q-6 -38 -10 -46 Q-14 -58 0 -76 Z" fill="${p.oro}"/>
      <path d="M0 -66 Q6 -54 4 -46 Q2 -41 0 -40 Q-2 -41 -4 -46 Q-6 -54 0 -66 Z" fill="${p.ledSuave}" opacity=".9"/></g></g>`,

  diadema: (p) => `<g class="tocado">
    <path d="M-34 -32 Q0 -52 34 -32 L34 -25 Q0 -44 -34 -25 Z" fill="${p.oro}"/>
    <circle cx="0" cy="-44" r="6" fill="${p.ledSuave}" class="gema"/>
    <circle cx="-19" cy="-37" r="3.2" fill="${p.ledSuave}" opacity=".8"/>
    <circle cx="19" cy="-37" r="3.2" fill="${p.ledSuave}" opacity=".8"/></g>`
};

// ------------------------------------------------------- silueta por dios

const CABEZAS = {
  redonda:  (p, g) => `<rect x="-38" y="-34" width="76" height="62" rx="30" fill="url(#metal-${g})"/>`,
  cuadrada: (p, g) => `<rect x="-39" y="-34" width="78" height="62" rx="13" fill="url(#metal-${g})"/>`,
  alta:     (p, g) => `<rect x="-34" y="-40" width="68" height="70" rx="24" fill="url(#metal-${g})"/>`,
  ancha:    (p, g) => `<rect x="-43" y="-30" width="86" height="56" rx="24" fill="url(#metal-${g})"/>`,
  ovalada:  (p, g) => `<ellipse cx="0" cy="-3" rx="40" ry="33" fill="url(#metal-${g})"/>`
};

/**
 * Sistemas de cara. Cada uno coloca sus propios ojos y su propia boca, de modo
 * que dos dioses no comparten estructura facial: cambia la optica, no el color.
 * Devuelve { marco, ojos:{sep,rx,ry}, boca } para que la expresion se adapte.
 */
const CARAS = {
  // banda oscura de lado a lado, con ceja metalica
  visor: (p) => ({
    marco: `<rect class="visor" x="-31" y="-19" width="62" height="36" rx="16" fill="${p.visorFondo}"/>
            <rect x="-31" y="-19" width="62" height="36" rx="16" fill="none" stroke="${p.oro}" stroke-width="1.6" opacity=".55"/>
            <rect x="-33" y="-24" width="66" height="7" rx="3.5" fill="${p.oroSombra}"/>`,
    ojos: { sep: 13, rx: 6.5, ry: 7.5, cy: -2 }
  }),

  // dos lentes circulares con aro metalico, estilo gafas de buzo
  lentes: (p) => ({
    marco: `<circle class="visor" cx="-15" cy="-2" r="15" fill="${p.visorFondo}"/>
            <circle class="visor" cx="15" cy="-2" r="15" fill="${p.visorFondo}"/>
            <circle cx="-15" cy="-2" r="15" fill="none" stroke="${p.oro}" stroke-width="3.2"/>
            <circle cx="15" cy="-2" r="15" fill="none" stroke="${p.oro}" stroke-width="3.2"/>
            <rect x="-5" y="-4" width="10" height="4" rx="2" fill="${p.oroSombra}"/>`,
    ojos: { sep: 15, rx: 7, ry: 7, cy: -2 }
  }),

  // un solo ojo grande, centrado
  ciclope: (p) => ({
    marco: `<circle class="visor" cx="0" cy="-4" r="19" fill="${p.visorFondo}"/>
            <circle cx="0" cy="-4" r="19" fill="none" stroke="${p.oro}" stroke-width="3.4"/>
            <circle cx="0" cy="-4" r="24" fill="none" stroke="${p.oroSombra}" stroke-width="2" opacity=".6"/>`,
    ojos: { sep: 0, rx: 10, ry: 10, cy: -4, unico: true }
  }),

  // panel rectangular con ojos de pixeles
  matriz: (p) => ({
    marco: `<rect class="visor" x="-30" y="-18" width="60" height="30" rx="5" fill="${p.visorFondo}"/>
            <rect x="-30" y="-18" width="60" height="30" rx="5" fill="none" stroke="${p.oro}" stroke-width="1.8" opacity=".7"/>
            ${[-24, -12, 0, 12, 24].map((x) => `<line x1="${x}" y1="-18" x2="${x}" y2="12" stroke="${p.oroSombra}" stroke-width=".6" opacity=".35"/>`).join('')}`,
    ojos: { sep: 13, rx: 6, ry: 6, cy: -3, cuadrado: true }
  }),

  // ceja pesada y ojos hundidos
  antifaz: (p) => ({
    marco: `<path class="visor" d="M-34 -16 Q0 -22 34 -16 L30 6 Q0 14 -30 6 Z" fill="${p.visorFondo}"/>
            <path d="M-36 -22 Q0 -30 36 -22 L34 -14 Q0 -21 -34 -14 Z" fill="${p.oroSombra}"/>`,
    ojos: { sep: 14, rx: 6.5, ry: 5, cy: -3 }
  }),

  // cara de metal con ojos saltones montados encima
  saltones: (p) => ({
    marco: `<circle cx="-16" cy="-4" r="13" fill="${p.metalSombra}"/>
            <circle cx="16" cy="-4" r="13" fill="${p.metalSombra}"/>
            <circle class="visor" cx="-16" cy="-4" r="10" fill="${p.visorFondo}"/>
            <circle class="visor" cx="16" cy="-4" r="10" fill="${p.visorFondo}"/>`,
    ojos: { sep: 16, rx: 6, ry: 6, cy: -4 }
  })
};

/** Herrajes de la boca: dan tanta personalidad como los ojos. */
const BOCAS_FIJAS = {
  rejilla: (p) => `<g class="herraje"><rect x="-15" y="14" width="30" height="13" rx="4" fill="${p.metalSombra}"/>
    ${[-9, -3, 3, 9].map((x) => `<rect x="${x}" y="16" width="3" height="9" rx="1.5" fill="${p.visorFondo}" opacity=".75"/>`).join('')}</g>`,
  altavoz: (p) => `<g class="herraje"><ellipse cx="0" cy="20" rx="14" ry="8" fill="${p.metalSombra}"/>
    ${[-7, 0, 7].map((x) => [-3, 1, 5].map((y) => `<circle cx="${x}" cy="${y + 18}" r="1.3" fill="${p.visorFondo}" opacity=".8"/>`).join('')).join('')}</g>`,
  mandibula: (p) => `<g class="herraje"><path d="M-20 14 Q0 32 20 14 L20 22 Q0 38 -20 22 Z" fill="${p.metalSombra}"/>
    <line x1="-12" y1="21" x2="12" y2="21" stroke="${p.visorFondo}" stroke-width="2" opacity=".6"/></g>`,
  barra: (p) => `<rect class="herraje" x="-11" y="18" width="22" height="4.5" rx="2.2" fill="${p.metalSombra}"/>`,
  colmillos: (p) => `<g class="herraje"><path d="M-16 14 L16 14 L12 24 L-12 24 Z" fill="${p.metalSombra}"/>
    ${[-8, 0, 8].map((x) => `<path d="M${x - 3} 14 L${x + 3} 14 L${x} 22 Z" fill="${p.visorFondo}" opacity=".8"/>`).join('')}</g>`,
  ninguna: () => ''
};

const OREJAS = {
  pastillas: (p) => `<rect x="-47" y="-10" width="11" height="22" rx="5.5" fill="${p.oro}"/>
                     <rect x="36" y="-10" width="11" height="22" rx="5.5" fill="${p.oro}"/>`,
  discos:    (p) => `<circle cx="-42" cy="0" r="9" fill="${p.oro}"/><circle cx="-42" cy="0" r="4" fill="${p.visorFondo}"/>
                     <circle cx="42" cy="0" r="9" fill="${p.oro}"/><circle cx="42" cy="0" r="4" fill="${p.visorFondo}"/>`,
  cuernos:   (p) => `<path d="M-36 -22 Q-56 -34 -52 -54 Q-42 -42 -32 -34 Z" fill="${p.oro}"/>
                     <path d="M36 -22 Q56 -34 52 -54 Q42 -42 32 -34 Z" fill="${p.oro}"/>`,
  antenitas: (p) => `<line x1="-30" y1="-34" x2="-40" y2="-52" stroke="${p.metalSombra}" stroke-width="2.6" stroke-linecap="round"/>
                     <circle cx="-41" cy="-55" r="3.6" fill="${p.led}"/>
                     <line x1="30" y1="-34" x2="40" y2="-52" stroke="${p.metalSombra}" stroke-width="2.6" stroke-linecap="round"/>
                     <circle cx="41" cy="-55" r="3.6" fill="${p.led}"/>`,
  ninguna:   () => ''
};

/** Gestos del modo de espera: aparecen de vez en cuando, nunca a la vez. */
function gestos(p) {
  return `<g class="gestos">
    <g class="g-zzz" opacity="0">
      <text x="34" y="-38" font-family="system-ui,sans-serif" font-size="13" font-weight="700" fill="${p.ledSuave}">z</text>
      <text x="44" y="-48" font-family="system-ui,sans-serif" font-size="16" font-weight="700" fill="${p.ledSuave}">z</text>
      <text x="55" y="-60" font-family="system-ui,sans-serif" font-size="20" font-weight="700" fill="${p.ledSuave}">z</text>
    </g>
    <g class="g-nota" opacity="0">
      <ellipse cx="-44" cy="-36" rx="4.6" ry="3.6" fill="${p.ledSuave}"/>
      <rect x="-41" y="-50" width="2.4" height="14" fill="${p.ledSuave}"/>
      <path d="M-38.6 -50 Q-31 -48 -33 -42" stroke="${p.ledSuave}" stroke-width="2.4" fill="none"/>
    </g>
    <g class="g-destello" opacity="0">
      ${[[-46, -30, 5], [46, -34, 6.5], [-38, 16, 4]].map(([x, y, r]) =>
    `<path d="M${x} ${y - r} L${x + r * 0.3} ${y - r * 0.3} L${x + r} ${y} L${x + r * 0.3} ${y + r * 0.3} L${x} ${y + r} L${x - r * 0.3} ${y + r * 0.3} L${x - r} ${y} L${x - r * 0.3} ${y - r * 0.3} Z" fill="${p.ledSuave}"/>`).join('')}
    </g>
    <g class="g-gota" opacity="0">
      <path d="M44 -34 Q50 -22 44 -18 Q38 -22 44 -34 Z" fill="${p.ledSuave}" opacity=".85"/>
    </g>
  </g>`;
}

// ----------------------------------------------------------------- emblemas

const EMBLEMAS = {
  rayo: (p) => `<g class="emblema rayo" filter="url(#brillo)"><path d="M46 -38 L33 -16 L44 -15 L32 4 L55 -20 L44 -21 L57 -38 Z" fill="${p.oro}"/></g>`,
  tridente: (p) => `<g class="emblema"><line x1="47" y1="18" x2="47" y2="-22" stroke="${p.oro}" stroke-width="3.4" stroke-linecap="round"/>
    <path d="M35 -22 L35 -34 M47 -22 L47 -38 M59 -22 L59 -34" stroke="${p.oro}" stroke-width="3.4" stroke-linecap="round"/>
    <path d="M35 -22 L59 -22" stroke="${p.oro}" stroke-width="3.4" stroke-linecap="round"/></g>`,
  lira: (p) => `<g class="emblema"><path d="M38 2 Q32 -16 41 -26 M56 2 Q62 -16 53 -26" stroke="${p.oro}" stroke-width="3" fill="none" stroke-linecap="round"/>
    <path d="M38 2 L56 2" stroke="${p.oro}" stroke-width="3" stroke-linecap="round"/>
    <path d="M43 -3 L43 -22 M47 -3 L47 -24 M51 -3 L51 -22" stroke="${p.oroSombra}" stroke-width="1.4"/></g>`,
  lanza: (p) => `<g class="emblema"><line x1="47" y1="16" x2="47" y2="-24" stroke="${p.oro}" stroke-width="3.6" stroke-linecap="round"/>
    <path d="M47 -36 L53 -24 L41 -24 Z" fill="${p.oro}"/></g>`,
  buho: (p) => `<g class="emblema"><ellipse cx="47" cy="-12" rx="12" ry="14" fill="${p.oro}"/>
    <circle cx="42.5" cy="-16" r="3.8" fill="#fff"/><circle cx="51.5" cy="-16" r="3.8" fill="#fff"/>
    <circle cx="42.5" cy="-16" r="1.8" fill="#1b1b1b"/><circle cx="51.5" cy="-16" r="1.8" fill="#1b1b1b"/>
    <path d="M47 -11 L43.5 -6 L50.5 -6 Z" fill="${p.ledSuave}"/></g>`,
  arco: (p) => `<g class="emblema"><path d="M54 -32 Q36 -10 54 12" stroke="${p.oro}" stroke-width="3.4" fill="none" stroke-linecap="round"/>
    <line x1="54" y1="-32" x2="54" y2="12" stroke="${p.oroSombra}" stroke-width="1.6"/>
    <line x1="38" y1="-10" x2="58" y2="-10" stroke="${p.oro}" stroke-width="2.6" stroke-linecap="round"/></g>`,
  corazon: (p) => `<g class="emblema" filter="url(#brillo)"><path d="M47 6 Q33 -6 33 -17 Q33 -26 40 -26 Q46 -26 47 -19 Q48 -26 54 -26 Q61 -26 61 -17 Q61 -6 47 6 Z" fill="${p.oro}"/></g>`,
  calavera: (p) => `<g class="emblema"><ellipse cx="47" cy="-16" rx="12" ry="13" fill="${p.oro}"/>
    <rect x="41" y="-4" width="12" height="7" rx="2.5" fill="${p.oro}"/>
    <circle cx="42.5" cy="-18" r="3.6" fill="#17121f"/><circle cx="51.5" cy="-18" r="3.6" fill="#17121f"/>
    <path d="M47 -11 L44.5 -7 L49.5 -7 Z" fill="#17121f"/></g>`,
  martillo: (p) => `<g class="emblema martillo"><rect x="34" y="-32" width="26" height="13" rx="3.5" fill="${p.oro}"/>
    <rect x="44" y="-19" width="5.5" height="28" rx="2.8" fill="${p.oroSombra}"/></g>`,
  espiga: (p) => `<g class="emblema"><line x1="47" y1="12" x2="47" y2="-26" stroke="${p.oroSombra}" stroke-width="3" stroke-linecap="round"/>
    ${[0, 1, 2, 3].map((k) => `<ellipse cx="42.5" cy="${-20 + k * 8}" rx="3.4" ry="5" fill="${p.oro}"/><ellipse cx="51.5" cy="${-20 + k * 8}" rx="3.4" ry="5" fill="${p.oro}"/>`).join('')}</g>`,
  llave: (p) => `<g class="emblema"><circle cx="45" cy="-24" r="8" fill="none" stroke="${p.oro}" stroke-width="3.6"/>
    <line x1="45" y1="-16" x2="45" y2="10" stroke="${p.oro}" stroke-width="3.6" stroke-linecap="round"/>
    <line x1="45" y1="-2" x2="54" y2="-2" stroke="${p.oro}" stroke-width="3.6" stroke-linecap="round"/>
    <line x1="45" y1="6" x2="53" y2="6" stroke="${p.oro}" stroke-width="3.6" stroke-linecap="round"/></g>`,
  hogar: (p) => `<g class="emblema fuego"><path d="M47 -32 Q59 -14 52 -2 Q47 3 42 -2 Q35 -14 47 -32 Z" fill="${p.oro}"/>
    <path d="M47 -22 Q52 -12 49 -5 Q47 -3 45 -5 Q42 -12 47 -22 Z" fill="${p.ledSuave}" opacity=".9"/></g>`,
  pergamino: (p) => `<g class="emblema"><rect x="35" y="-28" width="24" height="30" rx="3.5" fill="${p.oro}"/>
    ${[-20, -13, -6, 1].map((y) => `<line x1="40" y1="${y}" x2="${y === 1 ? 50 : 54}" y2="${y}" stroke="${p.oroSombra}" stroke-width="2"/>`).join('')}</g>`,
  pavo: (p) => `<g class="emblema"><line x1="47" y1="14" x2="47" y2="-14" stroke="${p.oroSombra}" stroke-width="2.8" stroke-linecap="round"/>
    <ellipse cx="47" cy="-24" rx="10" ry="13" fill="${p.oro}"/><ellipse cx="47" cy="-24" rx="6" ry="8" fill="${p.halo1}"/>
    <circle cx="47" cy="-24" r="3.2" fill="${p.ledSuave}"/></g>`,
  engranaje: (p) => `<g class="emblema engranaje"><circle cx="47" cy="-14" r="9" fill="none" stroke="${p.oro}" stroke-width="5"/>
    ${[0, 60, 120, 180, 240, 300].map((a) => {
    const r = Math.PI * a / 180;
    return `<line x1="${(47 + Math.sin(r) * 11).toFixed(1)}" y1="${(-14 - Math.cos(r) * 11).toFixed(1)}" x2="${(47 + Math.sin(r) * 16).toFixed(1)}" y2="${(-14 - Math.cos(r) * 16).toFixed(1)}" stroke="${p.oro}" stroke-width="4" stroke-linecap="round"/>`;
  }).join('')}</g>`
};

// -------------------------------------------------------------------- dioses

/**
 * Cada dios cambia de silueta, no solo de color: cabeza, visor, orejas, metal y
 * temperamento. El temperamento decide como se comporta cuando no hace nada.
 */
const DIOSES_ROBOT = {
  zeus:      { nombre: 'Zeus',      tocado: 'laurel',    emblema: 'rayo',      cabeza: 'ancha',    cara: 'visor', boca: 'barra',    orejas: 'pastillas', metal: '#f2f5fa', temperamento: 'serio',     h: 214, s: 48, l: 40 },
  hera:      { nombre: 'Hera',      tocado: 'diadema',   emblema: 'pavo',      cabeza: 'ovalada',  cara: 'lentes', boca: 'altavoz',  orejas: 'discos',    metal: '#f7eef3', temperamento: 'tranquilo', h: 330, s: 42, l: 40 },
  atenea:    { nombre: 'Atenea',    tocado: 'corintio',  emblema: 'buho',      cabeza: 'alta',     cara: 'antifaz', boca: 'barra', orejas: 'ninguna',   metal: '#eaf0f2', temperamento: 'serio',     h: 190, s: 45, l: 36 },
  hermes:    { nombre: 'Hermes',    tocado: 'alado',     emblema: 'lira',      cabeza: 'redonda',  cara: 'visor', boca: 'rejilla',    orejas: 'antenitas', metal: '#eef4fb', temperamento: 'nervioso',  h: 200, s: 60, l: 44 },
  apolo:     { nombre: 'Apolo',     tocado: 'sol',       emblema: 'lira',      cabeza: 'redonda',  cara: 'ciclope', boca: 'altavoz',  orejas: 'discos',    metal: '#fdf3e2', temperamento: 'alegre',    h: 38,  s: 72, l: 46 },
  ares:      { nombre: 'Ares',      tocado: 'cresta',    emblema: 'lanza',     cabeza: 'cuadrada', cara: 'matriz', boca: 'colmillos',  orejas: 'pastillas', metal: '#d8d2d2', temperamento: 'nervioso',  h: 2,   s: 62, l: 40 },
  artemisa:  { nombre: 'Artemisa',  tocado: 'luna',      emblema: 'arco',      cabeza: 'alta',     cara: 'lentes', boca: 'barra', orejas: 'antenitas', metal: '#e9f3ec', temperamento: 'tranquilo', h: 142, s: 46, l: 34 },
  afrodita:  { nombre: 'Afrodita',  tocado: 'flores',    emblema: 'corazon',   cabeza: 'ovalada',  cara: 'saltones', boca: 'ninguna',    orejas: 'discos',    metal: '#fdeef5', temperamento: 'alegre',    h: 332, s: 70, l: 52 },
  poseidon:  { nombre: 'Poseidon',  tocado: 'ondas',     emblema: 'tridente',  cabeza: 'ancha',    cara: 'lentes', boca: 'rejilla',  orejas: 'cuernos',   metal: '#e4f1f6', temperamento: 'tranquilo', h: 196, s: 72, l: 40 },
  hades:     { nombre: 'Hades',     tocado: 'capucha',   emblema: 'calavera',  cabeza: 'alta',     cara: 'antifaz', boca: 'mandibula',  orejas: 'ninguna',   metal: '#6a6475', temperamento: 'dormilon',  h: 272, s: 48, l: 32 },
  hefesto:   { nombre: 'Hefesto',   tocado: 'gafas',     emblema: 'martillo',  cabeza: 'cuadrada', cara: 'saltones', boca: 'rejilla',    orejas: 'pastillas', metal: '#cbb59a', temperamento: 'serio',     h: 22,  s: 62, l: 38 },
  demeter:   { nombre: 'Demeter',   tocado: 'trigo',     emblema: 'espiga',    cabeza: 'ovalada',  cara: 'visor', boca: 'altavoz', orejas: 'discos',    metal: '#f1f4e6', temperamento: 'dormilon',  h: 88,  s: 48, l: 36 },
  hecate:    { nombre: 'Hecate',    tocado: 'antorchas', emblema: 'llave',     cabeza: 'alta',     cara: 'matriz', boca: 'mandibula',    orejas: 'cuernos',   metal: '#e7e1f2', temperamento: 'nervioso',  h: 278, s: 46, l: 36 },
  hestia:    { nombre: 'Hestia',    tocado: 'llama',     emblema: 'hogar',     cabeza: 'redonda',  cara: 'ciclope', boca: 'barra',    orejas: 'ninguna',   metal: '#fdf0e6', temperamento: 'tranquilo', h: 18,  s: 66, l: 42 },
  mnemosine: { nombre: 'Mnemosine', tocado: 'diadema',   emblema: 'pergamino', cabeza: 'cuadrada', cara: 'antifaz', boca: 'altavoz', orejas: 'antenitas', metal: '#e6f2f0', temperamento: 'dormilon',  h: 172, s: 52, l: 36 }
};

const TEMPERAMENTOS = ['tranquilo', 'nervioso', 'dormilon', 'alegre', 'serio'];

function hashSemilla(texto) {
  let h = 0x811c9dc5;
  const s = String(texto || 'v4');
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}

/** Para una semilla que no es un dios conocido: combinacion propia y estable. */
function diosGenerado(semilla) {
  let h = hashSemilla(semilla);
  const sig = (n) => { h = (Math.imul(h, 1664525) + 1013904223) >>> 0; return h % n; };
  const tocados = Object.keys(TOCADOS), emblemas = Object.keys(EMBLEMAS);
  const cabezas = Object.keys(CABEZAS), caras = Object.keys(CARAS);
  const bocas = Object.keys(BOCAS_FIJAS), orejas = Object.keys(OREJAS);
  return {
    nombre: 'Especialista',
    tocado: tocados[sig(tocados.length)],
    emblema: emblemas[sig(emblemas.length)],
    cabeza: cabezas[sig(cabezas.length)],
    cara: caras[sig(caras.length)],
    boca: bocas[sig(bocas.length)],
    orejas: orejas[sig(orejas.length)],
    temperamento: TEMPERAMENTOS[sig(TEMPERAMENTOS.length)],
    h: sig(360), s: 45 + sig(25), l: 34 + sig(10)
  };
}

function oscurecer(hex, factor) {
  const c = hexAHsl(hex);
  return c ? hsl(c.h, c.s, Math.max(8, c.l * factor)) : '#c3ccd8';
}

function paletaDios(d) {
  const metal = d.metal || '#eef2f7';
  return {
    halo1: hsl(d.h, d.s, d.l),
    halo2: hsl((d.h + 14) % 360, d.s * 0.8, 11),
    led: hsl(d.h, Math.min(95, d.s + 30), 66),
    ledSuave: hsl(d.h, Math.min(95, d.s + 20), 86),
    metal, metalSombra: oscurecer(metal, 0.78), visorFondo: '#0b1018',
    oro: hsl(d.h, Math.min(92, d.s + 18), 62),
    oroSombra: hsl(d.h, Math.min(92, d.s + 18), 42)
  };
}

// --------------------------------------------------------------- expresiones

function ojosDe(estado, p, g) {
  const led = estado === 'error' ? '#ff5f56' : estado === 'alerta' ? '#ffb020' : p.led;
  const suave = estado === 'error' ? '#ffc9c6' : estado === 'alerta' ? '#ffe3b0' : p.ledSuave;
  const { sep, rx, ry, cy, cuadrado, unico } = g;
  const envolver = (x, cuerpo) => `<g transform="translate(${x},${cy})" filter="url(#brillo)">${cuerpo}</g>`;
  const par = (fn) => unico ? envolver(0, fn(1.0)) : envolver(-sep, fn(1)) + envolver(sep, fn(1));
  const radio = (k = 1) => ({ rx: rx * k, ry: ry * k });

  switch (estado) {
    case 'feliz':
      return par(() => `<path d="M${-rx} ${ry * .35} Q0 ${-ry} ${rx} ${ry * .35}" stroke="${led}" stroke-width="${rx * .62}" fill="none" stroke-linecap="round"/>`);
    case 'escucha':
      return par(() => `<rect class="led-barra" x="${-rx * 1.15}" y="${-ry * .32}" width="${rx * 2.3}" height="${ry * .64}" rx="${ry * .32}" fill="${led}"/>`);
    case 'piensa':
      return par(() => `<${cuadrado ? 'rect' : 'circle'} class="led-arriba" ${cuadrado
        ? `x="${-rx * .6}" y="${-ry * .9}" width="${rx * 1.2}" height="${ry * 1.2}" rx="1.5"`
        : `cx="0" cy="${-ry * .3}" r="${rx * .62}"`} fill="${led}"/>`);
    case 'curioso':
      return unico ? envolver(0, `<circle r="${rx}" fill="${led}"/><circle cx="${-rx * .3}" cy="${-ry * .3}" r="${rx * .3}" fill="${suave}"/>`)
        : envolver(-sep, `<circle r="${rx * 1.15}" fill="${led}"/><circle cx="${-rx * .3}" cy="${-ry * .3}" r="${rx * .32}" fill="${suave}"/>`) +
          envolver(sep, `<circle r="${rx * .66}" fill="${led}"/>`);
    case 'alerta':
      return par(() => `<path d="M0 ${-ry * 1.1} L${rx} ${ry * .8} L${-rx} ${ry * .8} Z" fill="${led}"/>
        <rect x="-1" y="${-ry * .4}" width="2" height="${ry * .7}" rx="1" fill="#241a05"/>`);
    case 'error':
      return par(() => `<path d="M${-rx * .85} ${-ry * .85} L${rx * .85} ${ry * .85} M${rx * .85} ${-ry * .85} L${-rx * .85} ${ry * .85}" stroke="${led}" stroke-width="${rx * .55}" stroke-linecap="round"/>`);
    case 'responde':
      return par(() => cuadrado
        ? `<rect x="${-rx}" y="${-ry}" width="${rx * 2}" height="${ry * 2}" rx="1.5" fill="${led}"/>`
        : `<ellipse rx="${rx}" ry="${ry}" fill="${led}"/><ellipse cx="${-rx * .25}" cy="${-ry * .25}" rx="${rx * .35}" ry="${ry * .3}" fill="${suave}" opacity=".9"/>`);
    default:
      return par(() => cuadrado
        ? `<rect x="${-rx}" y="${-ry}" width="${rx * 2}" height="${ry * 2}" rx="1.5" fill="${led}"/>
           <rect x="${-rx * .45}" y="${-ry * .45}" width="${rx * .9}" height="${ry * .6}" fill="${suave}" opacity=".85"/>`
        : `<ellipse rx="${rx}" ry="${ry}" fill="${led}"/>
           <ellipse cx="${-rx * .28}" cy="${-ry * .3}" rx="${rx * .38}" ry="${ry * .32}" fill="${suave}" opacity=".85"/>`);
  }
}

/** Lo que se mueve bajo los ojos segun el estado (sobre el herraje fijo). */
function bocaDe(estado, p) {
  if (estado === 'responde') {
    return `<g class="onda">${[-10, -5, 0, 5, 10].map((x, i) =>
      `<rect class="onda-barra o${i}" x="${x - 1.4}" y="-4" width="2.8" height="8" rx="1.4" fill="${p.ledSuave}"/>`).join('')}</g>`;
  }
  if (estado === 'piensa') {
    return `<g class="puntos">${[-7, 0, 7].map((x, i) =>
      `<circle class="punto p${i}" cx="${x}" cy="0" r="1.9" fill="${p.ledSuave}"/>`).join('')}</g>`;
  }
  return '';
}

// --------------------------------------------------------------------- avatar

/**
 * @param {string} clave   dios conocido o cualquier texto estable
 * @param {string} estado  uno de ESTADOS
 * @param {number} tam     lado en px
 * @param {string} color   color opcional en hexadecimal que tine todo el avatar
 */
function robotSvg(clave, estado = 'normal', tam = 40, color = null) {
  const k = String(clave || '').toLowerCase().trim();
  const d = DIOSES_ROBOT[k] || diosGenerado(clave);
  const e = ESTADOS.includes(estado) ? estado : 'normal';
  const p = (color && paletaDe(color)) || paletaDios(d);
  const uid = hashSemilla(`${k}|${e}|${color || ''}`).toString(36);

  const cara = (CARAS[d.cara] || CARAS.visor)(p);
  const tocado = (TOCADOS[d.tocado] || TOCADOS.laurel)(p);
  const emblema = (EMBLEMAS[d.emblema] || EMBLEMAS.rayo)(p);
  const temperamento = d.temperamento || 'tranquilo';
  // Cada avatar respira a su ritmo y empieza en un momento distinto: si todos
  // bostezaran a la vez pareceria una pantalla, no un grupo de personajes.
  const semillaRitmo = hashSemilla(`${k}-ritmo`);
  const ritmo = (3 + (semillaRitmo % 26) / 10).toFixed(1);
  const retraso = ((semillaRitmo >> 5) % 90) / 10;

  return `
<svg class="robot ${e} t-${temperamento}" viewBox="-70 -78 140 150" width="${tam}" height="${tam}"
     style="--ritmo:${ritmo}s;--retraso:-${retraso}s" role="img" aria-label="${d.nombre}">
  <defs>
    <radialGradient id="halo-${uid}" cx="36%" cy="24%">
      <stop offset="0%" stop-color="${p.halo1}"/><stop offset="100%" stop-color="${p.halo2}"/>
    </radialGradient>
    <linearGradient id="metal-${uid}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#ffffff"/><stop offset="55%" stop-color="${p.metal}"/>
      <stop offset="100%" stop-color="${p.metalSombra}"/>
    </linearGradient>
    <filter id="brillo" x="-80%" y="-80%" width="260%" height="260%">
      <feGaussianBlur stdDeviation="2.4" result="b"/>
      <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
  </defs>

  <circle r="62" fill="url(#halo-${uid})"/>
  <circle r="62" fill="none" stroke="rgba(255,255,255,.10)" stroke-width="2"/>

  <g class="cuerpo">
    ${emblema}
    <path d="M-26 36 Q0 27 26 36 L29 50 Q0 58 -29 50 Z" fill="url(#metal-${uid})"/>
    <rect x="-7" y="22" width="14" height="9" rx="4" fill="${p.metalSombra}"/>
    <circle cx="0" cy="43" r="5.6" fill="${p.oro}" class="nucleo"/>

    ${(OREJAS[d.orejas] || OREJAS.pastillas)(p)}

    ${(CABEZAS[d.cabeza] || CABEZAS.redonda)(p, uid)}
    <rect x="-30" y="-30" width="60" height="14" rx="7" fill="#ffffff" opacity=".4"/>

    ${cara.marco}
    <rect class="barrido" x="-30" y="-20" width="60" height="6" rx="3" fill="${p.ledSuave}" opacity=".12"/>

    <g class="ojos">${ojosDe(e, p, cara.ojos)}</g>
    ${(BOCAS_FIJAS[d.boca] || BOCAS_FIJAS.barra)(p)}
    <g class="boca" transform="translate(0,19)">${bocaDe(e, p)}</g>

    ${tocado}

    <g class="antena">
      <line x1="0" y1="-34" x2="0" y2="-48" stroke="${p.metalSombra}" stroke-width="3" stroke-linecap="round"/>
      <circle class="antena-luz" cx="0" cy="-52" r="4.6" fill="${p.led}" filter="url(#brillo)"/>
    </g>
    ${gestos(p)}
  </g>
</svg>`.trim();
}

/** Color principal de un avatar: sirve para teñir su nombre en la conversacion. */
function colorDe(clave, override) {
  if (override) {
    const c = hexAHsl(override);
    return c ? hsl(c.h, Math.min(90, c.s + 20), 66) : override;
  }
  const k = String(clave || '').toLowerCase().trim();
  const d = DIOSES_ROBOT[k] || diosGenerado(clave);
  return hsl(d.h, Math.min(95, d.s + 30), 68);
}

function listaDioses() {
  return Object.entries(DIOSES_ROBOT).map(([clave, d]) => ({ clave, nombre: d.nombre }));
}

if (typeof window !== 'undefined') {
  window.robotSvg = robotSvg;
  window.colorDe = colorDe;
  window.listaDioses = listaDioses;
  window.ESTADOS_ROBOT = ESTADOS;
}
if (typeof module !== 'undefined') module.exports = { robotSvg, colorDe, listaDioses, ESTADOS, DIOSES_ROBOT };
