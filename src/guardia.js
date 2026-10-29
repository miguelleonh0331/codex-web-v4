'use strict';
/**
 * Guardia de rutas protegidas.
 *
 * Los especialistas corren con los permisos desactivados en los dos motores:
 * pueden escribir donde quieran. Eso es util y es peligroso. Una regla en el
 * prompt no sirve de garantia, porque el modelo puede ignorarla.
 *
 * Esto no impide la escritura: la detecta. Antes de cada turno se toma una
 * foto de las rutas que declares protegidas; al terminar se compara. Si algo
 * cambio, se avisa con el detalle y se puede deshacer.
 *
 * Es deliberado que vigile en vez de bloquear: un bloqueo real exigiria
 * meterse dentro del CLI, y ademas hay cambios legitimos. Lo que no puede
 * pasar es que cambie algo y nadie se entere.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Un fichero de configuracion de Asterisk ocupa kilobytes. Por encima de
// esto se guarda solo la huella: se detecta el cambio pero no se puede
// deshacer, y se dice claramente.
const MAX_COPIA = 512 * 1024;
const MAX_FICHEROS = 4000;

const huella = (buf) => crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);

/** Recorre una ruta y devuelve sus ficheros, sin seguir enlaces simbolicos. */
function recorrer(raiz, acc, tope) {
  let st;
  try { st = fs.lstatSync(raiz); } catch { return; }
  if (st.isSymbolicLink()) return;          // un enlace apunta fuera: no es nuestro
  if (st.isFile()) { acc.push(raiz); return; }
  if (!st.isDirectory()) return;
  let hijos;
  try { hijos = fs.readdirSync(raiz); } catch { return; }
  for (const h of hijos) {
    if (acc.length >= tope) return;
    if (h === '.git' || h === 'node_modules') continue;
    recorrer(path.join(raiz, h), acc, tope);
  }
}

/**
 * Foto de las rutas protegidas: huella de cada fichero y copia de los
 * pequenos, para poder restaurarlos.
 */
function fotografiar(cfg, destino) {
  const rutas = (cfg.rutasProtegidas || []).filter(Boolean);
  if (!rutas.length) return null;

  const ficheros = [];
  for (const r of rutas) recorrer(r, ficheros, MAX_FICHEROS);

  const manifiesto = {};
  let copiados = 0;
  for (const f of ficheros) {
    try {
      const st = fs.statSync(f);
      const datos = st.size <= MAX_COPIA ? fs.readFileSync(f) : null;
      manifiesto[f] = {
        h: datos ? huella(datos) : `tam:${st.size}:${Math.floor(st.mtimeMs)}`,
        bytes: st.size,
        modo: st.mode & 0o777,
        copia: !!datos
      };
      if (datos && destino) {
        const dst = path.join(destino, f.replace(/[^\w.-]/g, '_'));
        fs.mkdirSync(destino, { recursive: true });
        fs.writeFileSync(dst, datos);
        manifiesto[f].en = dst;
        copiados += 1;
      }
    } catch { /* ilegible: se ignora, no se inventa */ }
  }
  return { cuando: new Date().toISOString(), rutas, ficheros: manifiesto, copiados, truncado: ficheros.length >= MAX_FICHEROS };
}

/** Que cambio entre dos fotos. */
function comparar(antes, despues) {
  if (!antes || !despues) return [];
  const cambios = [];
  const a = antes.ficheros || {};
  const d = despues.ficheros || {};

  for (const [f, info] of Object.entries(d)) {
    if (!a[f]) cambios.push({ ruta: f, cambio: 'creado', bytes: info.bytes, reversible: true });
    else if (a[f].h !== info.h) {
      cambios.push({
        ruta: f, cambio: 'modificado', bytes: info.bytes,
        antes: a[f].bytes, reversible: !!a[f].copia
      });
    }
  }
  for (const f of Object.keys(a)) {
    if (!d[f]) cambios.push({ ruta: f, cambio: 'borrado', antes: a[f].bytes, reversible: !!a[f].copia });
  }
  return cambios;
}

/**
 * Deshace los cambios detectados, volviendo al estado de la foto.
 *
 * Solo toca las rutas que salieron en la comparacion: no restaura el arbol
 * entero, que podria pisar cambios legitimos hechos fuera del turno.
 */
function revertir(foto, cambios) {
  const hecho = [];
  const fallos = [];
  for (const c of cambios) {
    const info = foto.ficheros[c.ruta];
    try {
      if (c.cambio === 'creado') {
        fs.unlinkSync(c.ruta);
        hecho.push({ ...c, accion: 'eliminado' });
      } else if (info && info.en && fs.existsSync(info.en)) {
        fs.mkdirSync(path.dirname(c.ruta), { recursive: true });
        fs.copyFileSync(info.en, c.ruta);
        if (info.modo) fs.chmodSync(c.ruta, info.modo);
        hecho.push({ ...c, accion: 'restaurado' });
      } else {
        fallos.push({ ...c, motivo: 'no habia copia: era demasiado grande' });
      }
    } catch (e) {
      fallos.push({ ...c, motivo: e.message });
    }
  }
  return { hecho, fallos };
}

module.exports = { fotografiar, comparar, revertir, MAX_COPIA };
