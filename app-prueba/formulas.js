/**
 * Telechange: TODAS las fórmulas del negocio en un solo lugar.
 * Este mismo archivo lo usan la pantalla (index.html), el servidor (Apps Script) y las pruebas (test/).
 * Si cambia una fórmula, se cambia aquí y se corre `cd test && npm test`.
 *
 * Reglas confirmadas por Willi (ver docs/REGLAS_NEGOCIO.md):
 *  - Tasa Binance (tB) = precio USDT en pesos ÷ precio USDT en bolívares. Se usa completa, sin redondear.
 *  - Colombia → Venezuela: Willi escribe la tasa diaria (tD). bolívares = pesos ÷ tD; pesos = bolívares × tD.
 *    % ganancia = 1 − tB ÷ tD. Tasa sugerida = tB ÷ (1 − margen)  (o tB × (1 + pago móvil) ÷ (1 − margen) con "10 % limpio").
 *  - Venezuela → Colombia: tasa = tB − descuento (0,30). pesos = bolívares × tasa; bolívares = pesos ÷ tasa.
 *  - Toda tasa que calcula la app se redondea a 2 decimales A FAVOR DE WILLI: Colombia → Venezuela hacia arriba,
 *    Venezuela → Colombia hacia abajo (configurable). La tarjeta muestra esa tasa y el cálculo usa esa misma tasa.
 *  - Monto en dólares BCV: bolívares = dólares × dólar BCV, y de ahí sigue el cálculo normal.
 *  - La ganancia SOLO la ve Willi. Nunca va en la tarjeta ni en el texto del mensaje.
 */
(function (raiz) {
  'use strict';

  const EPS = 1e-9;

  /** Redondea a `dec` decimales: 'arriba', 'abajo' o 'normal'. Tolera errores de coma flotante (3,53 no se vuelve 3,54). */
  function redondear(x, sentido, dec) {
    dec = dec == null ? 2 : dec;
    const f = Math.pow(10, dec), v = Number(x) * f;
    if (!isFinite(v)) return NaN;
    if (sentido === 'arriba') return Math.ceil(v - EPS) / f;
    if (sentido === 'abajo') return Math.floor(v + EPS) / f;
    return Math.round(v + (v >= 0 ? EPS : -EPS)) / f;
  }
  const r2 = x => redondear(x, 'normal', 2);
  const r0 = x => redondear(x, 'normal', 0);

  /**
   * Lee un número escrito a la venezolana o a la gringa:
   * "16.393,44" → 16393.44 · "3,59" → 3.59 · "3.390" → 3390 · "1.070,00" → 1070 · "3.59" → 3.59 · "858000" → 858000
   */
  function leerNumero(txt) {
    if (typeof txt === 'number') return txt;
    let s = String(txt == null ? '' : txt).trim().replace(/\s|\$|€/g, '');
    if (!s) return NaN;
    if (s.indexOf(',') >= 0) s = s.replace(/\./g, '').replace(',', '.');
    else if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, ''); // solo puntos de miles
    if (!/^-?\d+(\.\d+)?$/.test(s)) return NaN;
    return Number(s);
  }

  /** Formato venezolano: 16393.44 → "16.393,44". */
  function formato(n, dec) {
    dec = dec == null ? 2 : dec;
    if (n == null || !isFinite(n)) return '—';
    const neg = n < 0, v = redondear(Math.abs(n), 'normal', dec);
    const [ent, frac] = v.toFixed(dec).split('.');
    const miles = ent.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
    return (neg ? '-' : '') + miles + (dec > 0 ? ',' + frac : '');
  }
  const pesos = n => formato(n, 0);
  const bolivares = n => formato(n, 2);
  /** Tasa con 2 decimales, o con 4 si la tasa no es "redonda" (la tasa Binance se muestra con 4). */
  const tasa = (n, dec) => formato(n, dec == null ? 2 : dec);
  const porcentaje = n => formato(n * 100, 2) + ' %';

  const AJUSTES_BASE = {
    margen: 0.10,            // margen objetivo
    pagoMovil: 0.003,        // 0,3 % de los bolívares transferidos (lo absorbe Willi)
    limpio: false,           // "10 % limpio": la sugerida cubre también el pago móvil
    descuentoVeCo: 0.30,     // tasa Venezuela → Colombia = tB − descuento
    redondeoCoVe: 'arriba',  // a favor de Willi
    redondeoVeCo: 'abajo'    // a favor de Willi
  };
  function ajustes(a) { return Object.assign({}, AJUSTES_BASE, a || {}); }

  function tasaBinance(usdtPesos, usdtBolivares) {
    usdtPesos = Number(usdtPesos); usdtBolivares = Number(usdtBolivares);
    if (!(usdtPesos > 0) || !(usdtBolivares > 0)) return NaN;
    return usdtPesos / usdtBolivares;
  }

  /** % de ganancia de Colombia → Venezuela con una tasa diaria: 1 − tB ÷ tD. */
  function margen(tB, tD) { return 1 - tB / tD; }
  /** % de ganancia descontando el pago móvil: 1 − tB × (1 + pm) ÷ tD. */
  function margenReal(tB, tD, pm) { return 1 - tB * (1 + pm) / tD; }

  /** Tasa diaria sugerida para llegar al margen objetivo. Devuelve la exacta y la redondeada (la que se muestra y se usa). */
  function tasaSugerida(tB, a) {
    a = ajustes(a);
    const exacta = (a.limpio ? tB * (1 + a.pagoMovil) : tB) / (1 - a.margen);
    return { exacta, tasa: redondear(exacta, a.redondeoCoVe, 2) };
  }

  /** Tasa Venezuela → Colombia: tB − descuento, redondeada a favor de Willi. */
  function tasaVeCo(tB, a) {
    a = ajustes(a);
    const exacta = tB - a.descuentoVeCo;
    return { exacta, tasa: redondear(exacta, a.redondeoVeCo, 2) };
  }

  /**
   * Aviso cuando la tasa diaria quedó por debajo del margen objetivo (porque cambió Binance).
   * Con "10 % limpio" se compara el margen real (descontando el pago móvil).
   */
  function avisoMargen(tB, tD, a) {
    a = ajustes(a);
    if (!(tB > 0) || !(tD > 0)) return null;
    const actual = a.limpio ? margenReal(tB, tD, a.pagoMovil) : margen(tB, tD);
    if (actual + EPS >= a.margen) return null;
    return { margen: actual, objetivo: a.margen, sugerida: tasaSugerida(tB, a).tasa, limpio: a.limpio };
  }

  const REFERENCIAS = {
    usd_bcv: { simbolo: '$', nombre: 'BCV', moneda: 'dolar' },
    eur_bcv: { simbolo: '€', nombre: 'BCV', moneda: 'euro' },
    usd_binance: { simbolo: '$', nombre: 'Binance', moneda: 'dolar' }
  };

  /**
   * El cálculo completo de una operación.
   * p = {
   *   direccion: 'CO-VE' | 'VE-CO',
   *   montoEn: 'pesos' | 'bolivares' | 'dolares',   (dolares = dólares al BCV)
   *   monto: número,
   *   referencia: 'usd_bcv' | 'eur_bcv' | 'usd_binance',
   *   tasas: { usdtPesos, usdtBolivares, tasaDiaria, dolarBcv, euroBcv },
   *   ajustes: {...}
   * }
   * Devuelve { ok, error?, pesos, bolivares, tasa, tB, equivalencia, ganancia, gananciaPct, gananciaReal, gananciaRealPct, pagoMovil... }
   */
  function calcular(p) {
    const a = ajustes(p.ajustes), t = p.tasas || {};
    const monto = Number(p.monto);
    if (!(monto > 0)) return { ok: false, error: 'Escribe el monto' };
    const tB = tasaBinance(t.usdtPesos, t.usdtBolivares);
    if (!(tB > 0)) return { ok: false, error: 'Faltan los precios del USDT en Tasas' };

    let tasaUsada;
    if (p.direccion === 'VE-CO') {
      tasaUsada = tasaVeCo(tB, a).tasa;
      if (!(tasaUsada > 0)) return { ok: false, error: 'La tasa Venezuela → Colombia no es válida: revisa el descuento en Ajustes' };
    } else {
      tasaUsada = Number(t.tasaDiaria);
      if (!(tasaUsada > 0)) return { ok: false, error: 'Escribe la tasa diaria en Tasas' };
    }

    let bs, ps, dolares = null;
    if (p.montoEn === 'pesos') {
      ps = r0(monto);
      bs = r2(ps / tasaUsada);
    } else {
      if (p.montoEn === 'dolares') {
        if (!(t.dolarBcv > 0)) return { ok: false, error: 'Falta el dólar BCV de hoy' };
        dolares = r2(monto);
        bs = r2(dolares * t.dolarBcv);
      } else {
        bs = r2(monto);
      }
      ps = r0(bs * tasaUsada);
    }

    // Equivalencia que va en el mensaje (solo cambia la referencia, no el cálculo)
    const ref = REFERENCIAS[p.referencia] ? p.referencia : 'usd_bcv';
    const divisor = ref === 'eur_bcv' ? t.euroBcv : ref === 'usd_binance' ? t.usdtBolivares : t.dolarBcv;
    const equivalencia = divisor > 0
      ? { referencia: ref, simbolo: REFERENCIAS[ref].simbolo, nombre: REFERENCIAS[ref].nombre, valor: r2(bs / divisor), tasaRef: Number(divisor) }
      : { referencia: ref, simbolo: REFERENCIAS[ref].simbolo, nombre: REFERENCIAS[ref].nombre, valor: null, tasaRef: null };

    let ganancia, gananciaPct, pagoMovilBs = 0, pagoMovilPesos = 0, gananciaReal, gananciaRealPct;
    if (p.direccion === 'VE-CO') {
      // Willi recibe bolívares, los cambia a USDT y a pesos (bolívares × tB) y entrega bolívares × tasa
      ganancia = bs * (tB - tasaUsada);
      gananciaPct = ganancia / (bs * tB);
      gananciaReal = ganancia; gananciaRealPct = gananciaPct; // aquí no aplica el pago móvil
    } else {
      ganancia = ps * (1 - tB / tasaUsada);
      gananciaPct = margen(tB, tasaUsada);
      pagoMovilBs = bs * a.pagoMovil;
      pagoMovilPesos = pagoMovilBs * tB;
      gananciaReal = ganancia - pagoMovilPesos;
      gananciaRealPct = gananciaReal / ps;
    }

    return {
      ok: true,
      direccion: p.direccion === 'VE-CO' ? 'VE-CO' : 'CO-VE',
      montoEn: p.montoEn,
      pesos: ps,
      bolivares: bs,
      dolares,
      tasa: tasaUsada,
      tB,
      equivalencia,
      ganancia: r0(ganancia),
      gananciaPct,
      gananciaReal: r0(gananciaReal),
      gananciaRealPct,
      pagoMovilBs: r2(pagoMovilBs),
      pagoMovilPesos: r0(pagoMovilPesos)
    };
  }

  const DIAS = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
  /** "Miércoles, 11/11/26" a partir de "2026-11-11". */
  function fechaLarga(iso) {
    const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return '';
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    return DIAS[d.getUTCDay()] + ', ' + m[3] + '/' + m[2] + '/' + m[1].slice(2);
  }

  /**
   * Lo que va en la tarjeta del cliente. SOLO datos para el cliente: nunca la ganancia.
   * La pantalla dibuja exactamente esto; las pruebas revisan que no haya ganancia aquí.
   */
  function tarjeta(r, negocio, fechaIso) {
    negocio = negocio || {};
    const eq = r.equivalencia || {};
    const filaRef = eq.referencia === 'usd_binance'
      ? { etiqueta: 'Tasa Binance', valor: '1 $ = ' + formato(eq.tasaRef, 2) + ' Bs' }
      : eq.referencia === 'eur_bcv'
        ? { etiqueta: 'Tasa BCV', valor: '1 € = ' + formato(eq.tasaRef, 2) + ' Bs' }
        : { etiqueta: 'Tasa BCV', valor: '1 $ = ' + formato(eq.tasaRef, 2) + ' Bs' };
    const equivale = eq.valor == null ? '—'
      : (eq.simbolo === '€' ? formato(eq.valor, 2) + ' €' : '$' + formato(eq.valor, 2)) + ' ' + eq.nombre;
    const P = { valor: pesos(r.pesos), unidad: 'pesos' }, B = { valor: bolivares(r.bolivares), unidad: 'Bs' };
    let arriba, grande;
    if (r.direccion === 'VE-CO') {
      // el cliente entrega bolívares en Venezuela y llegan pesos en Colombia
      if (r.montoEn === 'pesos') { arriba = { etiqueta: 'Para que lleguen', ...P }; grande = { etiqueta: 'Envías desde Venezuela', ...B }; }
      else { arriba = { etiqueta: 'Envías desde Venezuela', ...B }; grande = { etiqueta: 'Llegan a Colombia', ...P }; }
    } else {
      if (r.montoEn === 'pesos') { arriba = { etiqueta: 'Envías', ...P }; grande = { etiqueta: 'Se transfieren', ...B }; }
      else { arriba = { etiqueta: 'Para que lleguen', ...B }; grande = { etiqueta: 'Envías', ...P }; }
    }
    if (r.montoEn === 'dolares' && r.dolares != null) arriba.nota = '($' + formato(r.dolares, 2) + ' BCV)';
    return {
      nombre: negocio.nombre || 'Telechange',
      frase: negocio.frase || 'Casa de Cambios · Tu envío rápido y seguro',
      arriba,
      grande,
      filas: [
        { etiqueta: 'Tasa del día', valor: tasa(r.tasa) },
        filaRef,
        { etiqueta: 'Equivale a', valor: equivale, fuerte: true }
      ],
      fecha: fechaLarga(fechaIso),
      etiquetaValida: 'Tasa válida para hoy'
    };
  }

  /** Texto para "Copiar texto": las mismas líneas de la tarjeta, una por renglón (formato de WhatsApp). */
  function mensajeTexto(r, negocio, fechaIso) {
    const t = tarjeta(r, negocio, fechaIso);
    const lineas = [
      '*' + t.nombre + '* · ' + t.frase,
      t.arriba.etiqueta + ': ' + t.arriba.valor + ' ' + t.arriba.unidad + (t.arriba.nota ? ' ' + t.arriba.nota : ''),
      t.grande.etiqueta + ': *' + t.grande.valor + ' ' + t.grande.unidad + '*'
    ];
    t.filas.forEach(f => lineas.push(f.etiqueta + ': ' + f.valor));
    lineas.push(t.fecha + ' · ' + t.etiquetaValida);
    return lineas.join('\n');
  }

  const API = {
    redondear, leerNumero, formato, pesos, bolivares, tasa, porcentaje,
    AJUSTES_BASE, ajustes, tasaBinance, margen, margenReal, tasaSugerida, tasaVeCo, avisoMargen,
    REFERENCIAS, calcular, fechaLarga, tarjeta, mensajeTexto
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  raiz.F = API;
})(typeof globalThis !== 'undefined' ? globalThis : this);
