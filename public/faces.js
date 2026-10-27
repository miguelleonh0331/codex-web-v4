'use strict';
/**
 * Caras de los especialistas.
 *
 * Cada agente tiene un rostro propio y estable: se deriva de su semilla, asi que
 * el mismo especialista siempre se ve igual, en cualquier navegador y sin guardar
 * ninguna imagen. Todo es SVG, y la animacion la lleva el CSS.
 */

function hashSemilla(texto) {
  let h = 0x811c9dc5;
  const s = String(texto || 'v4');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

// Generador determinista: del mismo hash salen siempre los mismos rasgos.
function rasgos(semilla) {
  let h = hashSemilla(semilla);
  const sig = (n) => { h = (Math.imul(h, 1664525) + 1013904223) >>> 0; return h % n; };
  const tono = sig(360);
  return {
    tono,
    tono2: (tono + 25 + sig(40)) % 360,
    ojos: sig(6),
    boca: sig(6),
    cejas: sig(3),
    extra: sig(5),
    rubor: sig(2) === 0,
    ritmo: 3.2 + (sig(30) / 10)   // cada cara parpadea a su propio ritmo
  };
}

function ojos(tipo, r) {
  const brillo = '<circle cx="-2.6" cy="-2.6" r="1.7" fill="#fff" opacity=".9"/>';
  switch (tipo) {
    case 0: return `<g class="ojo"><circle r="6.4" fill="#10131a"/>${brillo}</g>`;
    case 1: return `<g class="ojo"><ellipse rx="5.2" ry="7" fill="#10131a"/>${brillo}</g>`;
    case 2: return `<g class="ojo"><path d="M-7 2 Q0 -8 7 2" stroke="#10131a" stroke-width="3.4" fill="none" stroke-linecap="round"/></g>`;
    case 3: return `<g class="ojo"><circle r="7.6" fill="#fff"/><circle r="3.8" fill="#10131a"/><circle cx="-1.4" cy="-1.4" r="1.3" fill="#fff"/></g>`;
    case 4: return `<g class="ojo"><rect x="-6.5" y="-5" width="13" height="10" rx="4.5" fill="#10131a"/>${brillo}</g>`;
    default: return `<g class="ojo"><circle r="6.4" fill="#10131a"/><path d="M-8 -7 Q0 -12 8 -7" stroke="#10131a" stroke-width="2.6" fill="none" stroke-linecap="round" opacity=".55"/>${brillo}</g>`;
  }
}

function boca(tipo) {
  switch (tipo) {
    case 0: return '<path class="boca" d="M-13 2 Q0 14 13 2" stroke="#10131a" stroke-width="3.6" fill="none" stroke-linecap="round"/>';
    case 1: return '<ellipse class="boca" rx="8" ry="7.5" fill="#10131a"/><ellipse class="lengua" cy="4" rx="4.6" ry="3" fill="#ff7a90"/>';
    case 2: return '<path class="boca" d="M-11 4 L11 4" stroke="#10131a" stroke-width="3.4" stroke-linecap="round"/>';
    case 3: return '<path class="boca" d="M-12 0 Q-6 8 0 1 Q6 -6 12 2" stroke="#10131a" stroke-width="3.2" fill="none" stroke-linecap="round"/>';
    case 4: return '<path class="boca" d="M-12 0 Q0 13 12 0 Z" fill="#10131a"/><path d="M-8 0 L8 0" stroke="#fff" stroke-width="3" stroke-linecap="round"/>';
    default: return '<path class="boca" d="M-9 1 Q0 9 9 1" stroke="#10131a" stroke-width="3.6" fill="none" stroke-linecap="round"/>';
  }
}

function cejas(tipo) {
  if (tipo === 0) return '';
  if (tipo === 1) {
    return '<path d="M-26 -22 Q-19 -27 -12 -23" stroke="#10131a" stroke-width="3" fill="none" stroke-linecap="round" opacity=".75"/>' +
           '<path d="M12 -23 Q19 -27 26 -22" stroke="#10131a" stroke-width="3" fill="none" stroke-linecap="round" opacity=".75"/>';
  }
  return '<path d="M-26 -24 L-12 -21" stroke="#10131a" stroke-width="3" stroke-linecap="round" opacity=".7"/>' +
         '<path d="M12 -21 L26 -24" stroke="#10131a" stroke-width="3" stroke-linecap="round" opacity=".7"/>';
}

function extra(tipo, tono) {
  switch (tipo) {
    case 0: return `<g class="antena"><line x1="0" y1="-46" x2="0" y2="-58" stroke="hsl(${tono},70%,75%)" stroke-width="3" stroke-linecap="round"/><circle cx="0" cy="-61" r="5" fill="hsl(${tono},85%,70%)" class="antena-luz"/></g>`;
    case 1: return '<g opacity=".85"><circle cx="-17" cy="-4" r="11" fill="none" stroke="#10131a" stroke-width="2.6"/><circle cx="17" cy="-4" r="11" fill="none" stroke="#10131a" stroke-width="2.6"/><line x1="-6" y1="-4" x2="6" y2="-4" stroke="#10131a" stroke-width="2.6"/></g>';
    case 2: return `<path d="M-40 -18 Q0 -54 40 -18 Q0 -36 -40 -18 Z" fill="hsl(${tono},45%,22%)" opacity=".9"/>`;
    default: return '';
  }
}

/**
 * Devuelve el SVG de una cara.
 * @param {string} semilla  texto estable (el id del agente)
 * @param {string} estado   'idle' | 'working'
 * @param {number} tam      lado en px
 */
function caraSvg(semilla, estado = 'idle', tam = 40) {
  const r = rasgos(semilla);
  const id = 'g' + hashSemilla(semilla).toString(36);
  return `
<svg class="cara ${estado}" width="${tam}" height="${tam}" viewBox="-60 -70 120 130"
     style="--ritmo:${r.ritmo}s" role="img" aria-hidden="true">
  <defs>
    <radialGradient id="${id}" cx="35%" cy="28%">
      <stop offset="0%" stop-color="hsl(${r.tono},85%,68%)"/>
      <stop offset="100%" stop-color="hsl(${r.tono2},65%,46%)"/>
    </radialGradient>
  </defs>
  <g class="cuerpo">
    ${extra(r.extra, r.tono)}
    <circle r="46" fill="url(#${id})"/>
    <circle r="46" fill="none" stroke="rgba(0,0,0,.22)" stroke-width="2"/>
    ${r.rubor ? `<ellipse cx="-30" cy="14" rx="8" ry="5" fill="hsl(${r.tono},90%,60%)" opacity=".45"/>
                 <ellipse cx="30" cy="14" rx="8" ry="5" fill="hsl(${r.tono},90%,60%)" opacity=".45"/>` : ''}
    ${cejas(r.cejas)}
    <g class="ojos">
      <g transform="translate(-17,-5)">${ojos(r.ojos, r)}</g>
      <g transform="translate(17,-5)">${ojos(r.ojos, r)}</g>
    </g>
    <g transform="translate(0,20)"><g class="bocas">${boca(r.boca)}</g></g>
  </g>
</svg>`.trim();
}

window.caraSvg = caraSvg;
