'use strict';
/**
 * Avatares robot de los especialistas (prototipo).
 *
 * Estilo: robot de cabeza redondeada con visor y ojos LED, mas los atributos
 * del dios que le toca. La expresion la da el estado, y toda la animacion la
 * lleva el CSS: no hay imagenes ni fotogramas.
 *
 * Estados: normal | escucha | piensa | responde | feliz | curioso | alerta | error
 */

const DIOSES_ROBOT = {
  zeus: {
    nombre: 'Zeus',
    rol: 'Arquitecto',
    halo1: '#2b4a7d', halo2: '#0e1726',   // cielo de tormenta
    led: '#58b7ff', ledSuave: '#bfe4ff',
    metal: '#eef2f7', metalSombra: '#c3ccd8',
    oro: '#f0c75e', oroSombra: '#c89b3a',
    tocado: 'laurel',
    emblema: 'rayo'
  }
};

const ESTADOS = ['normal', 'escucha', 'piensa', 'responde', 'feliz', 'curioso', 'alerta', 'error'];

// --------------------------------------------------------------- expresiones

/** Cada estado dibuja sus propios ojos; el color lo decide el estado, no el dios. */
function ojosDe(estado, d) {
  const led = estado === 'error' ? '#ff5f56' : estado === 'alerta' ? '#ffb020' : d.led;
  const suave = estado === 'error' ? '#ffc9c6' : estado === 'alerta' ? '#ffe3b0' : d.ledSuave;
  const ojo = (x, cuerpo) => `<g transform="translate(${x},0)" filter="url(#brillo)">${cuerpo}</g>`;

  switch (estado) {
    case 'feliz':
      return ojosPar((x) => ojo(x, `<path d="M-7 3 Q0 -7 7 3" stroke="${led}" stroke-width="4.5" fill="none" stroke-linecap="round"/>`));
    case 'escucha':
      return ojosPar((x) => ojo(x, `<rect class="led-barra" x="-8" y="-2.5" width="16" height="5" rx="2.5" fill="${led}"/>`));
    case 'piensa':
      return ojosPar((x) => ojo(x, `<circle class="led-arriba" cx="0" cy="-3" r="4.2" fill="${led}"/>`));
    case 'responde':
      return ojosPar((x) => ojo(x, `<rect x="-6.5" y="-7" width="13" height="14" rx="6.5" fill="${led}"/>
        <rect x="-3" y="-4" width="6" height="5" rx="2.5" fill="${suave}" opacity=".9"/>`));
    case 'curioso':
      return ojo(-13, `<circle r="7.6" fill="${led}"/><circle cx="-2" cy="-2.4" r="2.4" fill="${suave}"/>`) +
             ojo(13, `<circle r="4.6" fill="${led}"/>`);
    case 'alerta':
      return ojosPar((x) => ojo(x, `<path d="M0 -8 L7.5 6 L-7.5 6 Z" fill="${led}"/><rect x="-1" y="-3" width="2" height="5" rx="1" fill="#241a05"/><circle cy="4" r="1.1" fill="#241a05"/>`));
    case 'error':
      return ojosPar((x) => ojo(x, `<path d="M-6 -6 L6 6 M6 -6 L-6 6" stroke="${led}" stroke-width="4" stroke-linecap="round"/>`));
    default: // normal
      return ojosPar((x) => ojo(x, `<rect x="-6.5" y="-7.5" width="13" height="15" rx="6.5" fill="${led}"/>
        <rect x="-3.2" y="-4.6" width="6.4" height="5.4" rx="2.7" fill="${suave}" opacity=".85"/>`));
  }
}

function ojosPar(fn) { return fn(-13) + fn(13); }

/** Debajo del visor, una barra que delata lo que esta haciendo. */
function bocaDe(estado, d) {
  if (estado === 'responde') {
    return `<g class="onda">${[-10, -5, 0, 5, 10].map((x, i) =>
      `<rect class="onda-barra o${i}" x="${x - 1.4}" y="-4" width="2.8" height="8" rx="1.4" fill="${d.ledSuave}"/>`).join('')}</g>`;
  }
  if (estado === 'piensa') {
    return `<g class="puntos">${[-7, 0, 7].map((x, i) =>
      `<circle class="punto p${i}" cx="${x}" cy="0" r="1.9" fill="${d.ledSuave}"/>`).join('')}</g>`;
  }
  if (estado === 'feliz') return `<path d="M-7 -1 Q0 4 7 -1" stroke="${d.ledSuave}" stroke-width="2" fill="none" stroke-linecap="round" opacity=".8"/>`;
  if (estado === 'error') return `<path d="M-7 2 Q0 -3 7 2" stroke="#ff8b85" stroke-width="2" fill="none" stroke-linecap="round" opacity=".8"/>`;
  return `<rect x="-6" y="-1.2" width="12" height="2.4" rx="1.2" fill="${d.ledSuave}" opacity=".45"/>`;
}

// ------------------------------------------------------------------- adornos

function laurel(d) {
  const hojas = [0, 1, 2, 3].map((i) => {
    const y = -34 - i * 7.5;
    const x = 30 - i * 2.6;
    return `<ellipse cx="${-x}" cy="${y}" rx="6" ry="3.4" fill="${d.oro}" transform="rotate(${-38 + i * 9} ${-x} ${y})"/>
            <ellipse cx="${x}" cy="${y}" rx="6" ry="3.4" fill="${d.oro}" transform="rotate(${38 - i * 9} ${x} ${y})"/>`;
  }).join('');
  return `<g class="tocado">
    <path d="M-31 -31 Q-38 -48 -20 -56" stroke="${d.oroSombra}" stroke-width="3.4" fill="none" stroke-linecap="round"/>
    <path d="M31 -31 Q38 -48 20 -56" stroke="${d.oroSombra}" stroke-width="3.4" fill="none" stroke-linecap="round"/>
    ${hojas}
  </g>`;
}

function rayo(d) {
  return `<g class="rayo" filter="url(#brillo)">
    <path d="M46 -38 L33 -16 L44 -15 L32 4 L55 -20 L44 -21 L57 -38 Z" fill="${d.oro}"/>
    <path d="M46 -38 L33 -16 L44 -15 L32 4 L55 -20 L44 -21 L57 -38 Z" fill="none" stroke="#fff6d6" stroke-width="1" opacity=".7"/>
  </g>`;
}

// --------------------------------------------------------------------- avatar

function robotSvg(clave, estado = 'normal', tam = 160) {
  const d = DIOSES_ROBOT[String(clave).toLowerCase()] || DIOSES_ROBOT.zeus;
  const e = ESTADOS.includes(estado) ? estado : 'normal';
  const uid = `${clave}-${e}`;

  return `
<svg class="robot ${e}" viewBox="-70 -78 140 150" width="${tam}" height="${tam}"
     role="img" aria-label="${d.nombre} (${e})">
  <defs>
    <radialGradient id="halo-${uid}" cx="36%" cy="24%">
      <stop offset="0%" stop-color="${d.halo1}"/>
      <stop offset="100%" stop-color="${d.halo2}"/>
    </radialGradient>
    <linearGradient id="metal-${uid}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#ffffff"/>
      <stop offset="55%" stop-color="${d.metal}"/>
      <stop offset="100%" stop-color="${d.metalSombra}"/>
    </linearGradient>
    <filter id="brillo" x="-80%" y="-80%" width="260%" height="260%">
      <feGaussianBlur stdDeviation="2.4" result="b"/>
      <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
  </defs>

  <circle r="62" fill="url(#halo-${uid})"/>
  <circle r="62" fill="none" stroke="rgba(255,255,255,.10)" stroke-width="2"/>

  <g class="cuerpo">
    ${rayo(d)}

    <!-- torso y hombros, apenas insinuados -->
    <path d="M-26 36 Q0 27 26 36 L29 50 Q0 58 -29 50 Z" fill="url(#metal-${uid})"/>
    <rect x="-7" y="22" width="14" height="9" rx="4" fill="${d.metalSombra}"/>
    <circle cx="0" cy="43" r="5.6" fill="${d.oro}" class="nucleo"/>

    <!-- orejeras -->
    <rect x="-47" y="-10" width="11" height="22" rx="5.5" fill="${d.oro}"/>
    <rect x="36" y="-10" width="11" height="22" rx="5.5" fill="${d.oro}"/>

    <!-- cabeza -->
    <rect x="-38" y="-34" width="76" height="62" rx="26" fill="url(#metal-${uid})"/>
    <rect x="-38" y="-34" width="76" height="62" rx="26" fill="none" stroke="rgba(0,0,0,.18)" stroke-width="1.6"/>
    <rect x="-30" y="-30" width="60" height="16" rx="8" fill="#ffffff" opacity=".5"/>

    <!-- visor -->
    <rect class="visor" x="-30" y="-20" width="60" height="38" rx="17" fill="#0b1018"/>
    <rect x="-30" y="-20" width="60" height="38" rx="17" fill="none" stroke="${d.oro}" stroke-width="1.6" opacity=".55"/>
    <rect class="barrido" x="-30" y="-20" width="60" height="6" rx="3" fill="${d.ledSuave}" opacity=".12"/>

    <g class="ojos" transform="translate(0,-4)">${ojosDe(e, d)}</g>
    <g class="boca" transform="translate(0,12)">${bocaDe(e, d)}</g>

    ${laurel(d)}

    <!-- antena -->
    <g class="antena">
      <line x1="0" y1="-34" x2="0" y2="-48" stroke="${d.metalSombra}" stroke-width="3" stroke-linecap="round"/>
      <circle class="antena-luz" cx="0" cy="-52" r="4.6" fill="${d.led}" filter="url(#brillo)"/>
    </g>
  </g>
</svg>`.trim();
}

if (typeof window !== 'undefined') {
  window.robotSvg = robotSvg;
  window.ESTADOS_ROBOT = ESTADOS;
  window.DIOSES_ROBOT = DIOSES_ROBOT;
}
if (typeof module !== 'undefined') module.exports = { robotSvg, ESTADOS, DIOSES_ROBOT };
