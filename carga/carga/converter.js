/* ==========================================================================
   Carga por Microciclo 2026 · motor de conversão
   Lê o export bruto da Catapult (Jogos_CTR_2026.xlsx) + a planilha GRUPOS TAG
   e devolve a base usada pelo painel (window.CARGA).
   Roda igual no navegador (atualizar.html) e no Node (gerar_base.js).
   ========================================================================== */
(function (root) {
  'use strict';

  var CFG = {
    INICIO_TEMPORADA: '2026-01-01',   // nada antes disso entra
    PERIODO: 'Session',               // linha que a Catapult usa como total do dia do atleta
    COL: {
      atleta: 'Player Name', periodo: 'Period Name', data: 'Date', dia: 'Day Name',
      duracao: 'Total Duration', dist: 'Total Distance',
      b5: 'Velocity Band 5 Total Distance', b6: 'Velocity Band 6 Total Distance',
      b7: 'Velocity Band 7 Total Distance', b8: 'Velocity Band 8 Total Distance',
      acel: 'Acceleration B2-3 Total Efforts (Gen 2)', desacel: 'Deceleration B2-3 Total Efforts (Gen 2)'
    }
  };
  var DIAS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function iso(y, m, d) { return y + '-' + pad(m) + '-' + pad(d); }
  function valida(y, m, d) {
    if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
    var t = new Date(Date.UTC(y, m - 1, d));
    return (t.getUTCMonth() === m - 1) ? t : null;
  }
  function diffDias(a, b) { return Math.abs(Date.parse(a) - Date.parse(b)) / 864e5; }
  function num(v) {
    if (v === null || v === undefined || v === '') return 0;
    if (typeof v === 'number') return isFinite(v) ? v : 0;
    var n = parseFloat(String(v).replace(',', '.'));
    return isFinite(n) ? n : 0;
  }

  /* Leituras possíveis de uma célula Date: a direta e a com dia/mês trocados. */
  function candidatas(v) {
    var y, m, d;
    if (v instanceof Date) { y = v.getFullYear(); m = v.getMonth() + 1; d = v.getDate(); }
    else if (typeof v === 'number') {               // serial do Excel
      var t = new Date(Math.round((v - 25569) * 864e5));
      y = t.getUTCFullYear(); m = t.getUTCMonth() + 1; d = t.getUTCDate();
    } else if (typeof v === 'string') {
      var p = v.trim().split(/[\/\-]/);
      if (p.length !== 3) return [];
      if (p[0].length === 4) { y = +p[0]; m = +p[1]; d = +p[2]; }
      else { d = +p[0]; m = +p[1]; y = +p[2]; }  // texto vem dd/mm/aaaa
    } else return [];
    var out = [];
    [[y, m, d], [y, d, m]].forEach(function (c) {
      var t = valida(c[0], c[1], c[2]);
      if (t) { var s = iso(c[0], c[1], c[2]); if (out.indexOf(s) < 0) out.push(s); }
    });
    return out;
  }
  function diaSemana(s) { return DIAS[new Date(s + 'T00:00:00Z').getUTCDay()]; }

  /* Duração em minutos: texto "HH:MM:SS", hora do Excel (Date) ou fração de dia. */
  var EPOCA = new Date(1899, 11, 30); // fuso local, igual ao SheetJS (evita a armadilha LMT)
  function minutos(v) {
    if (v === null || v === undefined || v === '') return 0;
    if (v instanceof Date) return (v - EPOCA) / 60000;
    if (typeof v === 'number') return v * 1440;
    var p = String(v).trim().split(':').map(Number);
    if (p.length === 3) return p[0] * 60 + p[1] + p[2] / 60;
    if (p.length === 2) return p[0] + p[1] / 60;
    return 0;
  }

  /* ---------------- Catapult ---------------- */
  function lerCatapult(linhas, log) {
    log = log || function () {};
    var cab = linhas[0].map(function (c) { return String(c || '').trim(); });
    var ix = {};
    Object.keys(CFG.COL).forEach(function (k) { ix[k] = cab.indexOf(CFG.COL[k]); });
    ['atleta', 'periodo', 'data', 'dia', 'duracao', 'dist', 'b5', 'b6', 'acel', 'desacel'].forEach(function (k) {
      if (ix[k] < 0) throw new Error('Coluna não encontrada no export: "' + CFG.COL[k] + '"');
    });
    if (ix.b7 < 0) log('Aviso: coluna de Banda 7 ausente — HSR calculado só com B5+B6.');
    if (ix.b8 < 0) log('Banda 8 não existe no export (o tenant tem 7 bandas) — entra como 0 no HSR.');

    // 1ª passada: datas de todas as linhas, conferidas contra o Day Name
    var n = linhas.length, res = new Array(n), amb = new Array(n);
    var stats = { linhas: 0, diretas: 0, ambiguas: 0, semDia: 0 };
    for (var i = 1; i < n; i++) {
      var r = linhas[i]; if (!r || !r[ix.atleta]) continue;
      stats.linhas++;
      var c = candidatas(r[ix.data]);
      var dn = String(r[ix.dia] || '').trim();
      var ok = c.filter(function (s) { return diaSemana(s) === dn; });
      if (ok.length === 1) { res[i] = ok[0]; stats.diretas++; }
      else if (ok.length > 1) { amb[i] = ok; stats.ambiguas++; }
      else { amb[i] = c.length ? [c[0]] : null; stats.semDia++; } // Day Name ausente/errado: leitura direta
    }
    // 2ª passada: ambíguas desempatadas pela vizinhança (o arquivo é cronológico)
    var ant = new Array(n), prox = new Array(n), u = null;
    for (i = 1; i < n; i++) { ant[i] = u; if (res[i]) u = res[i]; }
    u = null;
    for (i = n - 1; i >= 1; i--) { prox[i] = u; if (res[i]) u = res[i]; }
    for (i = 1; i < n; i++) {
      if (res[i] || !amb[i]) continue;
      if (amb[i].length === 1) { res[i] = amb[i][0]; continue; }
      var refs = [ant[i], prox[i]].filter(Boolean);
      res[i] = amb[i].slice().sort(function (a, b) {
        var da = Math.min.apply(null, refs.map(function (x) { return diffDias(a, x); }));
        var db = Math.min.apply(null, refs.map(function (x) { return diffDias(b, x); }));
        return da - db;
      })[0];
    }

    // 3ª passada: só a linha Session da temporada, uma por atleta-dia-sessão
    var vistos = {}, regs = [], atletas = {}, dupl = 0, zeradas = 0;
    for (i = 1; i < n; i++) {
      r = linhas[i];
      if (!r || !r[ix.atleta] || !res[i]) continue;
      if (String(r[ix.periodo] || '').trim() !== CFG.PERIODO) continue;
      if (res[i] < CFG.INICIO_TEMPORADA) continue;
      var nome = String(r[ix.atleta]).trim();
      var mId = nome.match(/^(\d+)\s*(.*)$/);
      var id = mId ? mId[1] : nome, curto = mId ? mId[2] : nome;
      var dist = num(r[ix.dist]);
      if (dist <= 0) { zeradas++; continue; }
      var dur = minutos(r[ix.duracao]);
      var chave = id + '|' + res[i] + '|' + Math.round(dur * 60) + '|' + dist.toFixed(2);
      if (vistos[chave]) { dupl++; continue; }
      vistos[chave] = 1;
      var hsr = num(r[ix.b5]) + num(r[ix.b6]) + (ix.b7 >= 0 ? num(r[ix.b7]) : 0) + (ix.b8 >= 0 ? num(r[ix.b8]) : 0);
      regs.push([res[i], id, +dur.toFixed(1), Math.round(dist), Math.round(hsr), num(r[ix.acel]), num(r[ix.desacel])]);
      atletas[id] = curto;
    }
    regs.sort(function (a, b) { return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : (+a[1]) - (+b[1]); });
    stats.sessoes = regs.length; stats.duplicadas = dupl; stats.zeradas = zeradas;
    stats.ultimaData = regs.length ? regs[regs.length - 1][0] : null;
    stats.primeiraData = regs.length ? regs[0][0] : null;
    return { regs: regs, atletas: atletas, stats: stats };
  }

  /* ---------------- GRUPOS TAG (aba Página1) ---------------- */
  // ADV traz "TREINO 09-10" ou "CEARÁ (F) 08-03": o dd-mm desempata a leitura da data.
  function dataTag(v, adv, padrao) {
    var c;
    if (v instanceof Date) return iso(v.getFullYear(), v.getMonth() + 1, v.getDate());
    if (typeof v === 'number') { c = candidatas(v); return c[0] || null; }
    if (typeof v !== 'string') return null;
    var p = v.trim().split(/[\/\-]/);
    if (p.length !== 3) return null;
    if (p[0].length === 4) return iso(+p[0], +p[1], +p[2]);
    var a = +p[0], b = +p[1], y = +p[2];
    var md = valida(y, a, b) ? iso(y, a, b) : null;   // m/d/aaaa (formato do CSV publicado)
    var dm = valida(y, b, a) ? iso(y, b, a) : null;   // d/m/aaaa
    var m = String(adv || '').match(/(\d{2})-(\d{2})\s*$/);
    if (m) {
      var alvo = '-' + m[2] + '-' + m[1];
      if (md && md.slice(4) === alvo) return md;
      if (dm && dm.slice(4) === alvo) return dm;
    }
    if (md && dm) return padrao === 'dm' ? dm : md;   // sem pista no ADV: formato predominante do arquivo
    return md || dm;
  }

  function lerTag(linhas) {
    var cab = linhas[0].map(function (c) { return String(c || '').trim(); });
    var iId = cab.indexOf('ID'), iData = cab.indexOf('Data'), iG = cab.indexOf('Grupo'),
        iCod = cab.indexOf('Dia Código'), iAdv = cab.indexOf('ADV'), iNome = cab.indexOf('Nome Catapult');
    if (iId < 0 || iData < 0 || iG < 0) throw new Error('A planilha de Tag precisa das colunas ID, Data e Grupo (aba Página1).');
    // formato predominante das datas em texto: conta as leituras que só cabem em um dos dois
    var votoMD = 0, votoDM = 0;
    for (var j = 1; j < linhas.length; j++) {
      var v = linhas[j] && linhas[j][iData];
      if (typeof v !== 'string') continue;
      var q = v.trim().split('/'); if (q.length !== 3) continue;
      if (+q[0] > 12) votoDM++; else if (+q[1] > 12) votoMD++;
    }
    var padrao = votoDM > votoMD ? 'dm' : 'md';
    var tag = {}, dias = {};
    for (var i = 1; i < linhas.length; i++) {
      var r = linhas[i]; if (!r || r[iId] === null || r[iId] === undefined || r[iId] === '') continue;
      var adv = iAdv >= 0 ? r[iAdv] : '';
      var d = dataTag(r[iData], adv, padrao);
      if (!d || d < CFG.INICIO_TEMPORADA) continue;
      var id = String(r[iId]).trim().replace(/\.0$/, '');
      var g = String(r[iG] || '').trim().toUpperCase() || 'SEM TAG';
      tag[id + '|' + d] = g;
      var cod = iCod >= 0 ? String(r[iCod] || '').trim() : '';
      if (!dias[d]) dias[d] = { cod: {}, adv: String(adv || '').trim() };
      if (cod) dias[d].cod[cod] = (dias[d].cod[cod] || 0) + 1;
    }
    // código predominante do dia (o mais frequente no elenco)
    var cal = {};
    Object.keys(dias).forEach(function (d) {
      var best = '', bn = 0;
      Object.keys(dias[d].cod).forEach(function (k) { if (dias[d].cod[k] > bn) { bn = dias[d].cod[k]; best = k; } });
      cal[d] = [best, dias[d].adv];
    });
    return { tag: tag, cal: cal };
  }

  /* ---------------- Junta tudo ---------------- */
  function montar(cat, tg) {
    var grupos = {}, semTag = 0;
    cat.regs.forEach(function (r) {
      var g = tg.tag[r[1] + '|' + r[0]];
      if (!g) { g = 'SEM TAG'; semTag++; }
      r.push(g);
      grupos[g] = (grupos[g] || 0) + 1;
    });
    // jogos = dias com código D_0 na Tag
    var jogos = {};
    Object.keys(tg.cal).forEach(function (d) { if (tg.cal[d][0] === 'D_0') jogos[d] = tg.cal[d][1]; });
    cat.stats.semTag = semTag; cat.stats.grupos = grupos;
    return {
      gerado: new Date().toISOString(),
      campos: ['data', 'id', 'min', 'dist', 'hsr', 'acel', 'desacel', 'grupo'],
      regs: cat.regs, atletas: cat.atletas, cal: tg.cal, jogos: jogos, stats: cat.stats
    };
  }

  var API = { CFG: CFG, lerCatapult: lerCatapult, lerTag: lerTag, montar: montar, _candidatas: candidatas, _dataTag: dataTag };
  if (typeof module !== 'undefined' && module.exports) module.exports = API; else root.Conversor = API;
})(this);
