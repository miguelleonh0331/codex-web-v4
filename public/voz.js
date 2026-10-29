'use strict';
/**
 * Voz de cada especialista, con el sintetizador del navegador.
 *
 * Se usa el del propio navegador y no un servicio de pago porque es gratis,
 * instantaneo, funciona sin conexion y no necesita ninguna clave. La calidad
 * es menor que la de una voz clonada, pero para "he terminado" sobra.
 *
 * Solo habla al terminar una tarea. Con trece especialistas, que hablaran en
 * cada paso seria insufrible.
 */
const VOZ = (() => {
  const soportado = typeof speechSynthesis !== 'undefined' && typeof SpeechSynthesisUtterance !== 'undefined';
  let voces = [];
  let activa = localStorage.getItem('v4-voz') === '1';

  // Cola propia: si tres especialistas terminan a la vez, hablan por turnos
  // en vez de pisarse. El navegador encola, pero no garantiza el orden.
  const cola = [];
  let hablando = false;

  function cargar() {
    if (!soportado) return;
    // Se prefieren las voces en espanol, que es el idioma de la interfaz.
    const todas = speechSynthesis.getVoices() || [];
    const es = todas.filter((v) => /^es/i.test(v.lang));
    voces = es.length ? es : todas;
  }

  if (soportado) {
    cargar();
    // En varios navegadores la lista llega despues de la primera llamada.
    speechSynthesis.addEventListener('voiceschanged', cargar);
  }

  /** Numero estable a partir de un texto: el mismo nombre, la misma voz. */
  function semilla(txt) {
    let h = 0;
    for (let i = 0; i < String(txt).length; i += 1) h = (h * 31 + String(txt).charCodeAt(i)) >>> 0;
    return h;
  }

  /**
   * Voz y tono de un especialista. Si hay menos voces que especialistas, se
   * reparten y se separan ademas por tono: dos que compartan voz no sonaran
   * igual.
   */
  function timbre(nombre) {
    const s = semilla(nombre);
    const voz = voces.length ? voces[s % voces.length] : null;
    return {
      voz,
      tono: 0.8 + ((s >> 3) % 9) * 0.05,      // 0.80 .. 1.20
      ritmo: 0.9 + ((s >> 7) % 5) * 0.05      // 0.90 .. 1.10
    };
  }

  function siguiente() {
    if (hablando || !cola.length) return;
    const { texto, nombre } = cola.shift();
    const t = timbre(nombre);
    const u = new SpeechSynthesisUtterance(texto);
    if (t.voz) { u.voice = t.voz; u.lang = t.voz.lang; }
    u.pitch = t.tono;
    u.rate = t.ritmo;
    hablando = true;
    u.onend = () => { hablando = false; siguiente(); };
    // Si el navegador falla, no se puede dejar la cola bloqueada para siempre.
    u.onerror = () => { hablando = false; siguiente(); };
    try { speechSynthesis.speak(u); } catch { hablando = false; }
  }

  return {
    get soportado() { return soportado; },
    get activa() { return activa && soportado; },
    set activa(v) {
      activa = !!v;
      localStorage.setItem('v4-voz', activa ? '1' : '0');
      if (!activa) this.callar();
    },
    /** Cuantas voces distintas hay para repartir. */
    get cuantas() { return voces.length; },

    anuncia(nombre, texto) {
      if (!this.activa) return;
      // Se recorta: el aviso es "he terminado", no la respuesta entera.
      const limpio = String(texto || '')
        .replace(/```[\s\S]*?```/g, ' ')       // bloques de codigo, impronunciables
        .replace(/[*_`#>|]/g, ' ')
        .replace(/https?:\/\/\S+/g, ' un enlace ')
        .replace(/\/[\w./-]{12,}/g, ' una ruta ')
        .replace(/\s+/g, ' ')
        .trim();
      const frase = limpio.split(/(?<=[.!?])\s/)[0] || '';
      cola.push({ nombre, texto: `${nombre}. ${frase.slice(0, 180)}` });
      siguiente();
    },

    prueba(nombre) {
      const antes = activa;
      activa = true;
      cola.push({ nombre, texto: `Hola, soy ${nombre}. Asi sueno cuando termino una tarea.` });
      siguiente();
      activa = antes;
    },

    callar() {
      cola.length = 0;
      hablando = false;
      try { speechSynthesis.cancel(); } catch { /* da igual */ }
    }
  };
})();
