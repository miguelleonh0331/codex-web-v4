// Interprete de trazos SVG.
//
// Existe para poder usar iconos de verdad en vez de figuras dibujadas a mano.
// Los juegos buenos (Lucide y companeros) son trazos de 24x24 con punta
// redonda, y eso encaja con lo que ya sabemos pintar: convertimos cada
// trazo en una polilinea y la pintamos con segmentos de punta redonda.
//
// No hay librerias: npm no tiene red en este servidor. Son doscientas lineas
// y evita una dependencia para algo que no va a cambiar nunca.

/** Parte la cadena "d" en ordenes: letra + numeros. */
function ordenes(d) {
  const fuera = [];
  const re = /([MmLlHhVvCcSsQqTtAaZz])|(-?(?:\d*\.\d+|\d+)(?:[eE][-+]?\d+)?)/g;
  let m;
  let actual = null;
  while ((m = re.exec(d))) {
    if (m[1]) {
      actual = { cmd: m[1], args: [] };
      fuera.push(actual);
    } else if (actual) {
      actual.args.push(parseFloat(m[2]));
    }
  }
  return fuera;
}

function bezier3(p0, p1, p2, p3, pasos) {
  const pts = [];
  for (let i = 1; i <= pasos; i++) {
    const t = i / pasos; const u = 1 - t;
    pts.push([
      u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
      u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1]
    ]);
  }
  return pts;
}

function bezier2(p0, p1, p2, pasos) {
  const pts = [];
  for (let i = 1; i <= pasos; i++) {
    const t = i / pasos; const u = 1 - t;
    pts.push([
      u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0],
      u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1]
    ]);
  }
  return pts;
}

/**
 * Arco eliptico de SVG.
 *
 * El formato da el punto final, no el centro, asi que hay que deducirlo.
 * Es el procedimiento del estandar (F.6.5): se lleva el arco al origen, se
 * calcula el centro y de ahi los angulos. Sin esto no se pueden dibujar las
 * esquinas redondeadas, que es de lo que estan hechos casi todos los iconos.
 */
function arcoSvg(p0, rx, ry, giroGrados, arcoGrande, barrido, p1, pasos) {
  if (rx === 0 || ry === 0) return [p1];
  rx = Math.abs(rx); ry = Math.abs(ry);
  const fi = (giroGrados * Math.PI) / 180;
  const cosF = Math.cos(fi); const senF = Math.sin(fi);

  const dx2 = (p0[0] - p1[0]) / 2; const dy2 = (p0[1] - p1[1]) / 2;
  const x1 = cosF * dx2 + senF * dy2;
  const y1 = -senF * dx2 + cosF * dy2;

  // Si los radios no alcanzan, el estandar manda agrandarlos.
  const lambda = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
  if (lambda > 1) { const k = Math.sqrt(lambda); rx *= k; ry *= k; }

  const num = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1;
  const den = rx * rx * y1 * y1 + ry * ry * x1 * x1;
  let coef = Math.sqrt(Math.max(0, num / den));
  if (arcoGrande === barrido) coef = -coef;

  const cx1 = (coef * rx * y1) / ry;
  const cy1 = (-coef * ry * x1) / rx;
  const cx = cosF * cx1 - senF * cy1 + (p0[0] + p1[0]) / 2;
  const cy = senF * cx1 + cosF * cy1 + (p0[1] + p1[1]) / 2;

  const ang = (ux, uy, vx, vy) => {
    const punto = ux * vx + uy * vy;
    const modulos = Math.hypot(ux, uy) * Math.hypot(vx, vy);
    let a = Math.acos(Math.max(-1, Math.min(1, punto / modulos)));
    if (ux * vy - uy * vx < 0) a = -a;
    return a;
  };
  const theta = ang(1, 0, (x1 - cx1) / rx, (y1 - cy1) / ry);
  let delta = ang((x1 - cx1) / rx, (y1 - cy1) / ry, (-x1 - cx1) / rx, (-y1 - cy1) / ry);
  if (!barrido && delta > 0) delta -= Math.PI * 2;
  if (barrido && delta < 0) delta += Math.PI * 2;

  const n = Math.max(3, Math.ceil(pasos * (Math.abs(delta) / (Math.PI / 2))));
  const pts = [];
  for (let i = 1; i <= n; i++) {
    const t = theta + (delta * i) / n;
    const ex = rx * Math.cos(t); const ey = ry * Math.sin(t);
    pts.push([cosF * ex - senF * ey + cx, senF * ex + cosF * ey + cy]);
  }
  return pts;
}

/**
 * Convierte un atributo "d" en polilineas.
 * @returns {Array<{pts: Array<[number,number]>, cerrado: boolean}>}
 */
function aPolilineas(d, { pasos = 10 } = {}) {
  const trozos = [];
  let actual = null;
  let x = 0; let y = 0;          // posicion
  let ix = 0; let iy = 0;        // inicio del subtrazo, para la Z
  let ctrlX = null; let ctrlY = null;  // control reflejado de S y T

  const abrir = () => { actual = { pts: [[x, y]], cerrado: false }; trozos.push(actual); };
  const meter = (pts) => { if (actual) for (const p of pts) actual.pts.push(p); };

  for (const { cmd, args } of ordenes(d)) {
    const rel = cmd === cmd.toLowerCase();
    const C = cmd.toUpperCase();
    let i = 0;

    if (C === 'Z') {
      if (actual) { actual.cerrado = true; actual.pts.push([ix, iy]); }
      x = ix; y = iy; ctrlX = null; ctrlY = null;
      continue;
    }

    // Una orden puede traer varios juegos de argumentos seguidos.
    while (i < args.length) {
      if (C === 'M') {
        x = rel ? x + args[i] : args[i];
        y = rel ? y + args[i + 1] : args[i + 1];
        i += 2;
        ix = x; iy = y;
        abrir();
        // Los pares siguientes de una M son lineas, segun el estandar.
        while (i + 1 < args.length) {
          x = rel ? x + args[i] : args[i];
          y = rel ? y + args[i + 1] : args[i + 1];
          i += 2;
          meter([[x, y]]);
        }
        ctrlX = null; ctrlY = null;
      } else if (C === 'L') {
        x = rel ? x + args[i] : args[i];
        y = rel ? y + args[i + 1] : args[i + 1];
        i += 2;
        if (!actual) abrir(); else meter([[x, y]]);
        ctrlX = null; ctrlY = null;
      } else if (C === 'H') {
        x = rel ? x + args[i] : args[i];
        i += 1;
        if (!actual) abrir(); else meter([[x, y]]);
        ctrlX = null; ctrlY = null;
      } else if (C === 'V') {
        y = rel ? y + args[i] : args[i];
        i += 1;
        if (!actual) abrir(); else meter([[x, y]]);
        ctrlX = null; ctrlY = null;
      } else if (C === 'C' || C === 'S') {
        let c1x; let c1y;
        if (C === 'C') {
          c1x = rel ? x + args[i] : args[i];
          c1y = rel ? y + args[i + 1] : args[i + 1];
          i += 2;
        } else {
          // S reutiliza el control anterior, reflejado.
          c1x = ctrlX === null ? x : 2 * x - ctrlX;
          c1y = ctrlY === null ? y : 2 * y - ctrlY;
        }
        const c2x = rel ? x + args[i] : args[i];
        const c2y = rel ? y + args[i + 1] : args[i + 1];
        const fx = rel ? x + args[i + 2] : args[i + 2];
        const fy = rel ? y + args[i + 3] : args[i + 3];
        i += 4;
        if (!actual) abrir();
        meter(bezier3([x, y], [c1x, c1y], [c2x, c2y], [fx, fy], pasos));
        ctrlX = c2x; ctrlY = c2y;
        x = fx; y = fy;
      } else if (C === 'Q' || C === 'T') {
        let cqx; let cqy;
        if (C === 'Q') {
          cqx = rel ? x + args[i] : args[i];
          cqy = rel ? y + args[i + 1] : args[i + 1];
          i += 2;
        } else {
          cqx = ctrlX === null ? x : 2 * x - ctrlX;
          cqy = ctrlY === null ? y : 2 * y - ctrlY;
        }
        const fx = rel ? x + args[i] : args[i];
        const fy = rel ? y + args[i + 1] : args[i + 1];
        i += 2;
        if (!actual) abrir();
        meter(bezier2([x, y], [cqx, cqy], [fx, fy], pasos));
        ctrlX = cqx; ctrlY = cqy;
        x = fx; y = fy;
      } else if (C === 'A') {
        const rx = args[i]; const ry = args[i + 1]; const giro = args[i + 2];
        const grande = args[i + 3] !== 0; const barrido = args[i + 4] !== 0;
        const fx = rel ? x + args[i + 5] : args[i + 5];
        const fy = rel ? y + args[i + 6] : args[i + 6];
        i += 7;
        if (!actual) abrir();
        meter(arcoSvg([x, y], rx, ry, giro, grande, barrido, [fx, fy], pasos));
        x = fx; y = fy;
        ctrlX = null; ctrlY = null;
      } else {
        break;   // orden desconocida: se ignora en vez de romper el icono
      }
    }
  }

  return trozos.filter((t) => t.pts.length > 1);
}

/** Saca de un SVG sus trazos y circulos, ya en coordenadas del viewBox. */
function leerSvg(texto) {
  const figuras = [];
  for (const m of texto.matchAll(/<path[^>]*\sd="([^"]+)"/g)) {
    figuras.push({ tipo: 'trazo', d: m[1] });
  }
  const atributo = (etiqueta, k) => {
    const v = etiqueta.match(new RegExp(`\\s${k}="([^"]+)"`));
    return v ? parseFloat(v[1]) : null;
  };

  for (const m of texto.matchAll(/<circle[^>]*>/g)) {
    const cx = atributo(m[0], 'cx'); const cy = atributo(m[0], 'cy'); const r = atributo(m[0], 'r');
    if (cx !== null && cy !== null && r) figuras.push({ tipo: 'circulo', cx, cy, r });
  }

  // Los rectangulos existen y se me pasaron: tres iconos del juego los usan
  // (bot, network, workflow) y salian a medio dibujar, con la caja de fuera
  // desaparecida. Se convierten a trazo para no tener otro caso aparte.
  for (const m of texto.matchAll(/<rect[^>]*>/g)) {
    const x = atributo(m[0], 'x') || 0;
    const y = atributo(m[0], 'y') || 0;
    const w = atributo(m[0], 'width');
    const h = atributo(m[0], 'height');
    if (!w || !h) continue;
    const rx = Math.min(atributo(m[0], 'rx') || 0, w / 2);
    const ry = Math.min(atributo(m[0], 'ry') || rx, h / 2);
    const d = rx > 0
      ? `M${x + rx} ${y}H${x + w - rx}A${rx} ${ry} 0 0 1 ${x + w} ${y + ry}`
        + `V${y + h - ry}A${rx} ${ry} 0 0 1 ${x + w - rx} ${y + h}`
        + `H${x + rx}A${rx} ${ry} 0 0 1 ${x} ${y + h - ry}`
        + `V${y + ry}A${rx} ${ry} 0 0 1 ${x + rx} ${y}Z`
      : `M${x} ${y}H${x + w}V${y + h}H${x}Z`;
    figuras.push({ tipo: 'trazo', d });
  }
  const vb = texto.match(/viewBox="([^"]+)"/);
  const caja = vb ? vb[1].trim().split(/\s+/).map(Number) : [0, 0, 24, 24];
  const anchoTrazo = parseFloat((texto.match(/stroke-width="([^"]+)"/) || [])[1] || '2');
  return { figuras, caja, anchoTrazo };
}

module.exports = { aPolilineas, leerSvg, ordenes };
