/* ============================================================================
   campo2d.js — Módulo de análise posicional 2D para a plataforma FEC Performance
   ----------------------------------------------------------------------------
   Portado do modelo Python de gabrielgazone/futebol-eventos-api para JavaScript,
   mantendo a stack atual (Node + HTML, sem Python no backend).

   Três funções-núcleo (Etapa 2 do pipeline):
     1. gpsParaCampo()        — converte lat/lon do GPS em X/Y no campo (metros)
     2. detectarEsforcos()    — agrupa o stream 10Hz em esforços por banda de velocidade
     3. enriquecerTatico()    — adiciona Zona (terços) e Direção (ofensivo/defensivo/lateral)

   As bandas de velocidade aceitam zonas INDIVIDUAIS por atleta (vindas da
   Catapult). Se não houver, cai no default B1–B6.
   ============================================================================ */

(function (global) {
  'use strict';

  /* --------------------------------------------------------------------------
     BANDAS DE VELOCIDADE
     Cada banda: { id, nome, min, max, color }  — min/max em km/h.
     Default idêntico ao do Gabriel e ao seu relatório atual.
     -------------------------------------------------------------------------- */
  const BANDAS_VEL_DEFAULT = [
    { id: 1, nome: 'Caminhada',       min: 0.0,  max: 7.0,   color: '#2196F3' },
    { id: 2, nome: 'Trote',           min: 7.0,  max: 14.4,  color: '#4CAF50' },
    { id: 3, nome: 'Corrida',         min: 14.4, max: 19.8,  color: '#CDDC39' },
    { id: 4, nome: 'Corrida Intensa', min: 19.8, max: 25.2,  color: '#FF9800' },
    { id: 5, nome: 'Alta Velocidade', min: 25.2, max: 29.9,  color: '#FF5722' },
    { id: 6, nome: 'Sprint',          min: 29.9, max: 45.0,  color: '#F44336' },
  ];

  /* Converte zonas vindas da API Catapult (min_ms/max_ms em m/s) para o formato
     de bandas em km/h. Se zones for nulo/vazio, devolve o default. */
  function bandasDeZonas(zones) {
    if (!zones || !zones.length) return BANDAS_VEL_DEFAULT.slice();
    return zones.map(function (z, i) {
      const minKmh = +( (z.min_ms || 0) * 3.6 ).toFixed(1);
      const maxRaw = (z.max_ms == null ? 9999 : z.max_ms);
      const maxKmh = maxRaw < 9000 ? +(maxRaw * 3.6).toFixed(1) : 9999;
      const def = BANDAS_VEL_DEFAULT[i] || {};
      return {
        id: i + 1,
        nome: z.name || def.nome || ('B' + (i + 1)),
        min: minKmh,
        max: maxKmh,
        color: z.color || def.color || '#888888',
      };
    });
  }

  /* --------------------------------------------------------------------------
     1) CONVERSÃO GPS → CAMPO
     Porta de gps_para_campo_coords (Python, linha 2392).
     campoConfig = { lat, lon, rot (graus), fl (comprimento m), fw (largura m) }
     Retorna { x: [...], y: [...] } em metros, origem no canto inferior esquerdo.
     -------------------------------------------------------------------------- */
  const M_POR_GRAU = 111320.0; // metros por grau de latitude (aprox.)

  function gpsParaCampo(lats, lons, campoConfig) {
    const cLat = +campoConfig.lat;
    const cLon = +campoConfig.lon;
    const rot  = (+campoConfig.rot) * Math.PI / 180.0;
    const fl   = +campoConfig.fl;
    const fw   = +campoConfig.fw;
    const cosLat = Math.cos(cLat * Math.PI / 180.0);
    const cosR = Math.cos(rot), sinR = Math.sin(rot);

    const x = new Array(lats.length);
    const y = new Array(lats.length);
    for (let i = 0; i < lats.length; i++) {
      const northM = (lats[i] - cLat) * M_POR_GRAU;
      const eastM  = (lons[i] - cLon) * M_POR_GRAU * cosLat;
      // rotação inversa (idêntica à derivada da função JS campo_para_latlon)
      let xm = eastM * cosR - northM * sinR;   // comprimento do campo
      let ym = northM * cosR + eastM * sinR;   // largura do campo
      // centro → canto inferior esquerdo, com clamp para tolerar erro de GPS
      x[i] = clamp(xm + fl / 2, -5, fl + 5);
      y[i] = clamp(ym + fw / 2, -5, fw + 5);
    }
    return { x: x, y: y };
  }

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  /* --------------------------------------------------------------------------
     2) DETECÇÃO DE ESFORÇOS
     Porta de calcular_efforts_velocidade_sensor (Python, linha 5118).
     Entrada:
       xn, yn  — coordenadas no campo (saída de gpsParaCampo)
       velKmh  — array de velocidades em km/h (mesmo comprimento)
       ts      — array de timestamps (epoch s) opcional
       bandas  — array de bandas (bandasDeZonas)
       opts    — { minDurS: 1.0, freqHz: 10 }
     Saída: array de esforços, cada um com início, duração, vel., distância,
            banda, e os índices de segmento (para desenhar a seta).
     -------------------------------------------------------------------------- */
  function detectarEsforcos(xn, yn, velKmh, ts, bandas, opts) {
    opts = opts || {};
    const freqHz = opts.freqHz || 10;
    const minDurS = opts.minDurS != null ? opts.minDurS : 1.0;
    const minFrames = Math.max(1, Math.round(minDurS * freqHz));
    const n = velKmh.length;
    if (!n || !xn.length || !yn.length) return [];

    // distâncias ponto-a-ponto no plano do campo
    const dists = new Array(n).fill(0);
    const lim = Math.min(n, xn.length, yn.length);
    for (let i = 1; i < lim; i++) {
      const dx = xn[i] - xn[i - 1];
      const dy = yn[i] - yn[i - 1];
      dists[i] = Math.sqrt(dx * dx + dy * dy);
    }

    let maxVelGlobal = 0;
    for (let i = 0; i < n; i++) if (velKmh[i] > maxVelGlobal) maxVelGlobal = velKmh[i];
    if (maxVelGlobal <= 0) maxVelGlobal = 1;

    const records = [];
    for (let b = 0; b < bandas.length; b++) {
      const banda = bandas[b];
      // máscara: ponto dentro da banda
      const mask = new Array(n);
      for (let i = 0; i < n; i++) mask[i] = (velKmh[i] >= banda.min && velKmh[i] < banda.max);

      // segmentos contínuos da máscara
      const segs = segmentosDeMask(mask);
      for (let s = 0; s < segs.length; s++) {
        const segS = segs[s][0], segE = segs[s][1]; // [início, fim) exclusivo
        const durFrames = segE - segS;
        if (durFrames < minFrames) continue;

        let segDist = 0, velMax = -Infinity;
        for (let i = segS; i < segE; i++) {
          segDist += dists[i];
          if (velKmh[i] > velMax) velMax = velKmh[i];
        }
        const durS = durFrames / freqHz;
        const velIni = velKmh[segS];
        const pctMax = +(velMax / maxVelGlobal * 100).toFixed(1);

        let tsS = 0, tsE = 0, horaStr = (segS / freqHz).toFixed(1) + 's';
        if (ts && ts.length > segS && ts[segS] > 0) {
          tsS = +ts[segS];
          tsE = (segE - 1 < ts.length) ? +ts[segE - 1] : tsS + durS;
          horaStr = formatHora(tsS);
        }

        records.push({
          esforco: 0, // renumerado depois da ordenação
          inicio: horaStr,
          duracaoS: +durS.toFixed(1),
          velMaxKmh: +velMax.toFixed(1),
          velIniKmh: +velIni.toFixed(1),
          distanciaM: +segDist.toFixed(1),
          pctMaximo: pctMax,
          bandaId: banda.id,
          bandaNome: banda.nome,
          bandaColor: banda.color,
          _startTs: tsS,
          _endTs: tsE,
          _segStart: segS,
          _segEnd: segE,
        });
      }
    }

    // ordena por timestamp (ou por índice de início se não houver ts) e renumera
    const temTs = records.some(function (r) { return r._startTs > 0; });
    records.sort(function (a, b) {
      return temTs ? (a._startTs - b._startTs) : (a._segStart - b._segStart);
    });
    records.forEach(function (r, i) { r.esforco = i + 1; });
    return records;
  }

  /* agrupa índices consecutivos true em [início, fim) — porta de _segmentos_de_mask */
  function segmentosDeMask(mask) {
    const segs = [];
    let i = 0, n = mask.length;
    while (i < n) {
      if (mask[i]) {
        let j = i;
        while (j < n && mask[j]) j++;
        segs.push([i, j]);
        i = j;
      } else { i++; }
    }
    return segs;
  }

  /* --------------------------------------------------------------------------
     3) ENRIQUECIMENTO TÁTICO
     Porta de enriquecer_esforcos_taticos (Python, linha 5802).
     Adiciona zona (terços do campo pelo X) e direção (avanço/recuo no X).
     -------------------------------------------------------------------------- */
  function enriquecerTatico(esforcos, xn, fieldLength) {
    const fl = fieldLength || 105;
    const fl3 = fl / 3.0;
    for (let k = 0; k < esforcos.length; k++) {
      const e = esforcos[k];
      const si = e._segStart, ei = e._segEnd;
      let xIni = null, xFim = null;
      if (si >= 0 && si < ei && ei <= xn.length) {
        xIni = xn[si];
        xFim = xn[ei - 1];
      }
      // zona (pelo X inicial)
      if (xIni != null) {
        e.zona = xIni < fl3 ? 'Defensivo' : (xIni < 2 * fl3 ? 'Meio' : 'Ataque');
      } else { e.zona = '—'; }
      // direção (avanço no X)
      if (xIni != null && xFim != null) {
        const dx = xFim - xIni;
        e.direcao = dx > 5 ? 'Ofensivo' : (dx < -5 ? 'Defensivo' : 'Lateral');
      } else { e.direcao = '—'; }
    }
    return esforcos;
  }

  /* --------------------------------------------------------------------------
     Helpers
     -------------------------------------------------------------------------- */
  function formatHora(epochS) {
    try {
      const d = new Date(epochS * 1000);
      const p = function (x) { return String(x).padStart(2, '0'); };
      return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
    } catch (e) { return String(epochS); }
  }

  /* Estatísticas de movimentação (distância total, largura/profundidade de
     atuação, área via convex hull) — equivalente ao rodapé do print 1. */
  function estatisticasMovimentacao(xn, yn) {
    if (!xn.length) return null;
    let distTotal = 0;
    for (let i = 1; i < xn.length; i++) {
      const dx = xn[i] - xn[i - 1], dy = yn[i] - yn[i - 1];
      distTotal += Math.sqrt(dx * dx + dy * dy);
    }
    const xMin = Math.min.apply(null, xn), xMax = Math.max.apply(null, xn);
    const yMin = Math.min.apply(null, yn), yMax = Math.max.apply(null, yn);
    const hull = convexHull(xn, yn);
    return {
      distanciaTotalM: +(distTotal).toFixed(1),
      distanciaTotalKm: +(distTotal / 1000).toFixed(2),
      profundidadeM: +(xMax - xMin).toFixed(0), // ao longo do comprimento
      larguraM: +(yMax - yMin).toFixed(0),       // ao longo da largura
      areaM2: +polyArea(hull).toFixed(0),
    };
  }

  /* convex hull (monotone chain) — porta de _convex_hull */
  function convexHull(xs, ys) {
    const pts = xs.map(function (x, i) { return [x, ys[i]]; })
      .sort(function (a, b) { return a[0] - b[0] || a[1] - b[1]; });
    if (pts.length < 3) return pts;
    const cross = function (o, a, b) {
      return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    };
    const lower = [];
    for (const p of pts) {
      while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
      lower.push(p);
    }
    const upper = [];
    for (let i = pts.length - 1; i >= 0; i--) {
      const p = pts[i];
      while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
      upper.push(p);
    }
    lower.pop(); upper.pop();
    return lower.concat(upper);
  }

  function polyArea(hull) {
    let a = 0;
    for (let i = 0; i < hull.length; i++) {
      const j = (i + 1) % hull.length;
      a += hull[i][0] * hull[j][1] - hull[j][0] * hull[i][1];
    }
    return Math.abs(a) / 2;
  }

  /* --------------------------------------------------------------------------
     API pública
     -------------------------------------------------------------------------- */
  const Campo2D = {
    BANDAS_VEL_DEFAULT: BANDAS_VEL_DEFAULT,
    bandasDeZonas: bandasDeZonas,
    gpsParaCampo: gpsParaCampo,
    detectarEsforcos: detectarEsforcos,
    enriquecerTatico: enriquecerTatico,
    estatisticasMovimentacao: estatisticasMovimentacao,
    segmentosDeMask: segmentosDeMask,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = Campo2D;
  else global.Campo2D = Campo2D;

})(typeof window !== 'undefined' ? window : this);
