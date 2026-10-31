// Cuando vuelve la cuota.
//
// El CLI no dice solo "no hay cuota": dice a que hora vuelve.
//
//   You've hit your session limit · resets 4:30am (America/Lima)
//
// Hasta ahora esa hora se tiraba a la basura y el turno se aparcaba media
// hora fija. Con un aviso a las 4:24 que dice "resets 4:30", eso son seis
// minutos de espera util y veinticuatro de espera inventada, durante los
// cuales la cuota ya habia vuelto y el usuario estaba trabajando a mano
// mientras su equipo seguia parado. Leer la hora cuesta esto y lo arregla.

/**
 * Desfase de una zona horaria respecto a UTC, en ms, en un instante dado.
 *
 * No vale con una tabla: hay horario de verano. Se le pide a Intl la hora
 * de pared en esa zona y se compara con la hora UTC del mismo instante.
 */
function desfaseZona(zona, t) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: zona, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
  const p = {};
  for (const x of f.formatToParts(new Date(t))) p[x.type] = x.value;
  // hour puede venir como "24" a medianoche segun el entorno.
  const h = Number(p.hour) % 24;
  const comoSiFueraUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day),
    h, Number(p.minute), Number(p.second));
  return comoSiFueraUtc - t;
}

/** Proxima vez que el reloj de pared de `zona` marque hora:minuto. */
function proximaHoraDePared(hora, minuto, zona, ahora) {
  const desfase = desfaseZona(zona, ahora);
  const pared = new Date(ahora + desfase);
  let t = Date.UTC(pared.getUTCFullYear(), pared.getUTCMonth(), pared.getUTCDate(),
    hora, minuto) - desfase;
  // Ya paso hoy: el aviso habla de manana.
  if (t <= ahora) {
    t = Date.UTC(pared.getUTCFullYear(), pared.getUTCMonth(), pared.getUTCDate() + 1,
      hora, minuto) - desfaseZona(zona, t + 86400000);
  }
  return t;
}

const TOPE_CONFIABLE_MS = 12 * 3600000;

/**
 * Lee del texto del error cuando vuelve la cuota.
 *
 * @returns {number|null} instante en ms, o null si no se puede leer o la
 *   hora leida no es creible. Null significa "usa la espera de siempre":
 *   ante la duda se espera de mas, nunca de menos.
 */
function cuandoVuelve(error, { zona = 'America/Lima', ahora = Date.now(), margenMs = 30000 } = {}) {
  const t = String(error || '');
  const m = t.match(/resets?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (!m) return null;

  let hora = Number(m[1]);
  const minuto = m[2] ? Number(m[2]) : 0;
  const sufijo = (m[3] || '').toLowerCase();
  if (sufijo === 'pm' && hora < 12) hora += 12;
  if (sufijo === 'am' && hora === 12) hora = 0;
  if (hora > 23 || minuto > 59) return null;

  // El propio aviso suele traer la zona entre parentesis. Es mas fiable que
  // la configurada: la dice quien pone el limite.
  const z = t.match(/\(([A-Za-z]+\/[A-Za-z_+-]+)\)/);
  let zonaUsada = z ? z[1] : zona;

  let cuando;
  try {
    cuando = proximaHoraDePared(hora, minuto, zonaUsada, ahora);
  } catch {
    // Zona desconocida en el aviso: se reintenta con la configurada antes
    // de rendirse, que es mejor que perder la hora por un nombre raro.
    if (!z) return null;
    try {
      zonaUsada = zona;
      cuando = proximaHoraDePared(hora, minuto, zonaUsada, ahora);
    } catch { return null; }
  }

  // Una espera de mas de medio dia no la deducimos de un "resets 4:30am":
  // lo mas probable es que hayamos entendido mal el aviso. Se descarta y
  // manda la espera fija, que al menos reintenta.
  if (cuando - ahora > TOPE_CONFIABLE_MS) return null;

  return cuando + margenMs;
}

module.exports = { cuandoVuelve, desfaseZona, proximaHoraDePared };
