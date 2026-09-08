/* ============================================================================
 mdp.js — Núcleo de cálculo dos Períodos Mais Exigentes (MDP)
 ----------------------------------------------------------------------------
 Fortaleza EC · Fisiologia · Estudo MDP 1/3/5 min

 Sem dependência de rede: recebe o stream 10 Hz já baixado e devolve os picos
 e a contagem de janelas independentes por faixa de intensidade.

 Decisões travadas com o Felipe (08/09/2026):
   - máxima de referência = do próprio atleta, naquele jogo;
   - cada variável tem seu próprio pico (busca independente por variável);
   - goleiros fora (filtrados antes, no endpoint).

 Convenções herdadas do projeto:
   - aceleração derivada da velocidade em janela FIXA DE TEMPO (0,6 s),
     nunca o campo `a` bruto da Catapult;
   - histerese em 70% do limiar, mesclagem < 0,4 s, esforço contado no
     instante em que COMEÇA;
   - janela deslizante nunca atravessa fronteira de período.
 ============================================================================ */

'use strict';

// ── Configuração travada do estudo ────────────────────────────────────────
const CONFIG = {
  JANELAS_S: [60, 180, 300],        // 1, 3 e 5 minutos
  PASSO_S: 1,                        // resolução da janela deslizante
  HSR_KMH: 19.8,                     // alta intensidade
  SPRINT_KMH: 25.2,                  // sprint
  ACC_LIMIAR: 3.0,                   // m/s²
  DEC_LIMIAR: -3.0,                  // m/s²
  JANELA_ACC_S: 0.6,                 // janela da diferença central
  HISTERESE: 0.70,                   // continua enquanto |a| >= 70% do limiar
  MESCLA_S: 0.4,                     // esforços do mesmo sinal mais próximos que isso viram um
  DUR_MIN_ESFORCO_S: 0.4,            // duração mínima para valer como esforço
  CORTES_PCT: [0.80, 0.85, 0.90],    // faixas de intensidade
  // ── Esforços explosivos: CRITÉRIO FEC, não é o da Catapult ──────────────
  // Varredura de 20 combinações em 4 atletas (jogo x Goiás, 08/09/2026): o
  // melhor ajuste possível errou 17,3% por atleta, e o erro por atleta ficou
  // MAIOR que o erro do total somado — sinal de que a diferença é de definição,
  // não de limiar. A Catapult provavelmente usa o acelerômetro do colete, que
  // não vem no stream de sensor. Tentar reproduzir o número dela seria ajustar
  // um botão que não existe no nosso painel.
  // Decisão: variável própria, limiares declarados, nunca comparada de igual
  // para igual com "Esforços Explosivos 2" do OpenField.
  EXPL_CRITERIO: 'FEC',
  EXPL_ACC: 1.8,                     // m/s² — força mínima da arrancada
  EXPL_VEL_FIM_KMH: 14.4,            // km/h — velocidade que a arrancada precisa atingir
  HDOP_MAX: null,                    // filtro de qualidade DESLIGADO por padrão:
                                     // descartar ponto ruim tira metros que
                                     // aconteceram de verdade, e a Catapult (com
                                     // quem comparamos) não filtra nada.
                                     // Ligue com ?hdopMax=3 se precisar.
  VAO_MAX_S: 2.0,                    // buraco de sinal maior que isso não é costurado
  BANCO_MMIN: 25,                    // densidade abaixo disso em bin de 60 s = banco
  TOLERANCIA_OFICIAL_S: 45,          // divergência aceita contra a duração oficial
};

const VARIAVEIS = ['dist', 'hsr', 'sprint', 'acel', 'decel', 'explosivo'];

// ── Utilidades ────────────────────────────────────────────────────────────

function kmh(vms) { return vms * 3.6; }

/* União de intervalos [ini, fim] sobrepostos ou encostados.
   Resolve os períodos ANINHADOS da Catapult (2tempo / 2tempo2 / 2tempo3),
   que terminam no mesmo instante e começam progressivamente mais tarde. */
function mesclarIntervalos(intervalos) {
  const ord = intervalos
    .filter(function (i) { return i && i.fim > i.ini; })
    .slice()
    .sort(function (a, b) { return a.ini - b.ini; });
  const out = [];
  for (const it of ord) {
    const ult = out[out.length - 1];
    if (ult && it.ini <= ult.fim) {
      ult.fim = Math.max(ult.fim, it.fim);
      if (it.dur > (ult.dur || 0)) ult.rotulo = it.rotulo; // rótulo do período mais longo
    } else {
      out.push({ ini: it.ini, fim: it.fim, rotulo: it.rotulo, dur: it.fim - it.ini });
    }
  }
  return out;
}

/* Ordena o stream por timestamp e mantém cada instante UMA vez só.
   Necessário porque um mesmo trecho pode chegar por mais de um período. */
function normalizarStream(pontos, hdopMax) {
  const lim = hdopMax === undefined ? CONFIG.HDOP_MAX : hdopMax;
  const vistos = new Set();
  const out = [];
  for (const p of pontos) {
    if (!p || p.ts == null || p.v == null) continue;
    if (p.hdop != null && lim && p.hdop > lim) continue;   // filtro de qualidade
    const t = +p.ts;
    if (vistos.has(t)) continue;
    vistos.add(t);
    out.push({ ts: t, v: +p.v });
  }
  out.sort(function (a, b) { return a.ts - b.ts; });
  return out;
}

// ── 1) Detecção de acelerações e desacelerações ───────────────────────────
/* a(t) = [v(t + J/2) − v(t − J/2)] / J, com J fixo em segundos.
   Resposta idêntica a 2, 5 ou 10 Hz — e a diferença central já filtra ruído. */
function derivarAceleracao(stream, janelaS) {
  const J = janelaS || CONFIG.JANELA_ACC_S;
  const meia = J / 2;
  const n = stream.length;
  const a = new Array(n).fill(0);
  let lo = 0, hi = 0;
  for (let i = 0; i < n; i++) {
    const t = stream[i].ts;
    while (lo + 1 < n && stream[lo + 1].ts <= t - meia) lo++;
    while (hi + 1 < n && stream[hi + 1].ts <= t + meia) hi++;
    const dt = stream[hi].ts - stream[lo].ts;
    a[i] = dt > 0 ? (stream[hi].v - stream[lo].v) / dt : 0;
  }
  return a;
}

/* Esforços de um sinal (+1 acelera, −1 desacelera), com histerese e mesclagem.
   Devolve [{ ts, dur }] — ts é o instante em que o esforço COMEÇA. */
function detectarEsforcos(stream, acc, sinal, limiar) {
  const abre = Math.abs(limiar);
  const segura = abre * CONFIG.HISTERESE;
  const brutos = [];
  let dentro = false, ini = 0, fim = 0, atingiuAbertura = false;

  for (let i = 0; i < stream.length; i++) {
    const val = sinal > 0 ? acc[i] : -acc[i];
    if (!dentro) {
      if (val >= abre) { dentro = true; atingiuAbertura = true; ini = stream[i].ts; fim = stream[i].ts; }
    } else {
      if (val >= segura) { fim = stream[i].ts; }
      else {
        if (atingiuAbertura) brutos.push({ ini: ini, fim: fim });
        dentro = false; atingiuAbertura = false;
      }
    }
  }
  if (dentro && atingiuAbertura) brutos.push({ ini: ini, fim: fim });

  // mesclagem: mesmo sinal separado por menos de MESCLA_S conta como um só
  const mesclados = [];
  for (const e of brutos) {
    const ult = mesclados[mesclados.length - 1];
    if (ult && e.ini - ult.fim < CONFIG.MESCLA_S) ult.fim = Math.max(ult.fim, e.fim);
    else mesclados.push({ ini: e.ini, fim: e.fim });
  }

  // duração com meia amostra de folga em cada ponta (correção documentada)
  const dtMedio = estimarDt(stream);
  return mesclados
    .map(function (e) { return { ts: e.ini, dur: (e.fim - e.ini) + dtMedio }; })
    .filter(function (e) { return e.dur >= CONFIG.DUR_MIN_ESFORCO_S; });
}

function estimarDt(stream) {
  if (stream.length < 2) return 0.1;
  const difs = [];
  for (let i = 1; i < stream.length && i < 200; i++) difs.push(stream[i].ts - stream[i - 1].ts);
  difs.sort(function (a, b) { return a - b; });
  const med = difs[Math.floor(difs.length / 2)];
  return med > 0 && med < 2 ? med : 0.1;
}

// ── 2) Janela de participação (recorte do tempo de banco) ─────────────────
/* O colete grava o reserva sentado. Detecta pelo próprio sinal (bins de 60 s
   com densidade perto de zero) e confere contra a duração oficial da Catapult:
   divergiu mais que a tolerância, a oficial manda, ancorando na ponta que o
   dado indica (entrou tarde → ancora no fim; saiu cedo → ancora no início). */
function janelaParticipacao(stream, bloco, duracaoOficialS) {
  const dentro = stream.filter(function (p) { return p.ts >= bloco.ini && p.ts <= bloco.fim; });
  if (!dentro.length) return null;

  const dt = estimarDt(dentro);
  const bins = new Map();
  for (const p of dentro) {
    const b = Math.floor((p.ts - bloco.ini) / 60);
    bins.set(b, (bins.get(b) || 0) + p.v * dt);   // metros no bin (aproximação basta aqui)
  }
  let primeiro = null, ultimo = null;
  for (const [b, m] of bins) {
    if (m >= CONFIG.BANCO_MMIN) {
      if (primeiro === null || b < primeiro) primeiro = b;
      if (ultimo === null || b > ultimo) ultimo = b;
    }
  }
  if (primeiro === null) return null;   // nunca se moveu: não jogou este bloco

  let ini = bloco.ini + primeiro * 60;
  let fim = Math.min(bloco.fim, bloco.ini + (ultimo + 1) * 60);

  // refino até a primeira/última amostra em movimento (> 2 km/h)
  for (const p of dentro) { if (p.ts >= ini && kmh(p.v) > 2) { ini = p.ts; break; } }
  for (let i = dentro.length - 1; i >= 0; i--) {
    const p = dentro[i];
    if (p.ts <= fim && kmh(p.v) > 2) { fim = p.ts; break; }
  }

  let conferencia = 'sem duração oficial';
  if (duracaoOficialS != null && duracaoOficialS > 0) {
    const detectada = fim - ini;
    const dif = detectada - duracaoOficialS;
    if (Math.abs(dif) <= CONFIG.TOLERANCIA_OFICIAL_S) {
      conferencia = 'confere';
    } else {
      conferencia = 'ajustado pela oficial (' + dif.toFixed(0) + ' s de diferença)';
      const entrouTarde = (ini - bloco.ini) > (bloco.fim - fim);
      if (entrouTarde) ini = fim - duracaoOficialS;   // ancora no fim
      else fim = ini + duracaoOficialS;               // ancora no início
    }
  }
  return { ini: ini, fim: fim, conferencia: conferencia };
}

// ── 3) Binagem em 1 s ─────────────────────────────────────────────────────
/* Cada bin de 1 s guarda: distância, distância ≥ HSR, distância ≥ sprint,
   esforços de aceleração e de desaceleração iniciados nele. */
function binar(stream, acc, janela) {
  const nBins = Math.max(1, Math.ceil(janela.fim - janela.ini));
  const b = {
    dist: new Float64Array(nBins),
    hsr: new Float64Array(nBins),
    sprint: new Float64Array(nBins),
    acel: new Float64Array(nBins),
    decel: new Float64Array(nBins),
    explosivo: new Float64Array(nBins),
  };
  // Distância por TRAPÉZIO sobre o intervalo real entre duas leituras.
  // Assim um buraco de sinal (leitura sem velocidade, descartada antes) não
  // vira um vão de distância: o tempo continua contando, com a velocidade
  // média das pontas. Buraco maior que VAO_MAX_S não é costurado — aí é
  // colete fora do ar, não corrida.
  for (let i = 0; i < stream.length - 1; i++) {
    const p = stream[i], q = stream[i + 1];
    if (p.ts < janela.ini || p.ts > janela.fim) continue;
    let dt = q.ts - p.ts;
    if (dt <= 0) continue;
    if (dt > CONFIG.VAO_MAX_S) dt = CONFIG.VAO_MAX_S;
    const vMed = (p.v + q.v) / 2;
    const m = vMed * dt;
    const kh = kmh(vMed);
    const k = Math.min(nBins - 1, Math.floor(p.ts - janela.ini));
    b.dist[k] += m;
    if (kh >= CONFIG.HSR_KMH) b.hsr[k] += m;
    if (kh >= CONFIG.SPRINT_KMH) b.sprint[k] += m;
  }
  const dentroJanela = stream.filter(function (p) { return p.ts >= janela.ini && p.ts <= janela.fim; });
  const accDentro = [];
  for (let i = 0; i < stream.length; i++) {
    const p = stream[i];
    if (p.ts >= janela.ini && p.ts <= janela.fim) accDentro.push(acc[i]);
  }
  for (const e of detectarEsforcos(dentroJanela, accDentro, +1, CONFIG.ACC_LIMIAR)) {
    const k = Math.min(nBins - 1, Math.floor(e.ts - janela.ini));
    if (k >= 0) b.acel[k] += 1;
  }
  for (const e of detectarEsforcos(dentroJanela, accDentro, -1, CONFIG.DEC_LIMIAR)) {
    const k = Math.min(nBins - 1, Math.floor(e.ts - janela.ini));
    if (k >= 0) b.decel[k] += 1;
  }
  // Esforços explosivos: aceleração acima de um limiar mais baixo que o de
  // acel, PORÉM só conta se o atleta chegar a uma velocidade relevante —
  // é o que separa "arrancada" de "ajuste de passo".
  for (const e of detectarEsforcos(dentroJanela, accDentro, +1, CONFIG.EXPL_ACC)) {
    let velMax = 0;
    for (const p of dentroJanela) {
      if (p.ts >= e.ts && p.ts <= e.ts + e.dur) velMax = Math.max(velMax, kmh(p.v));
    }
    if (velMax < CONFIG.EXPL_VEL_FIM_KMH) continue;
    const k = Math.min(nBins - 1, Math.floor(e.ts - janela.ini));
    if (k >= 0) b.explosivo[k] += 1;
  }
  b.nBins = nBins;
  return b;
}

// ── 4) Janela deslizante por soma de prefixos ─────────────────────────────
function prefixo(arr) {
  const p = new Float64Array(arr.length + 1);
  for (let i = 0; i < arr.length; i++) p[i + 1] = p[i] + arr[i];
  return p;
}

/* Devolve todas as janelas de W segundos do bloco: [{ inicioS, valor }] */
function janelasDeslizantes(bins, W, passo) {
  const pre = prefixo(bins);
  const n = bins.length;
  const out = [];
  if (n < W) return out;                       // bloco curto demais para a janela
  for (let s = 0; s + W <= n; s += (passo || CONFIG.PASSO_S)) {
    out.push({ inicioS: s, valor: pre[s + W] - pre[s] });
  }
  return out;
}

/* Contagem de janelas INDEPENDENTES acima de um corte.
   Guloso do maior para o menor, bloqueando tudo que se sobrepõe ao aceito.
   Sem isso, um único pico de 1 min geraria 60 janelas "acima de 90%". */
function janelasIndependentes(janelas, corte, W) {
  const acima = janelas.filter(function (j) { return j.valor >= corte && j.valor > 0; });
  acima.sort(function (a, b) { return b.valor - a.valor; });
  const aceitas = [];
  for (const j of acima) {
    let colide = false;
    for (const a of aceitas) {
      if (Math.abs(j.inicioS - a.inicioS) < W) { colide = true; break; }
    }
    if (!colide) aceitas.push(j);
  }
  aceitas.sort(function (a, b) { return a.inicioS - b.inicioS; });
  return aceitas;
}

// ── 5) Cálculo completo de um atleta em um jogo ───────────────────────────
/* blocos: [{ ini, fim, rotulo }] já mesclados (1tempo e 2tempo separados)
   duracoesOficiais: { rotulo: segundos } vindo do POST /stats
   Devolve { picos, repeticoes, minJogados, participacao, totais } */
function calcularAtleta(pontos, blocos, duracoesOficiais, opts) {
  opts = opts || {};
  const stream = normalizarStream(pontos, opts.hdopMax);
  if (stream.length < 10) return null;
  const acc = derivarAceleracao(stream, opts.janelaAccS);

  if (opts.config) Object.assign(CONFIG, opts.config);   // ajustes finos vindos da query

  const participacao = [];
  const binsPorBloco = [];
  let minJogados = 0;
  const totais = { dist: 0, hsr: 0, sprint: 0, acel: 0, decel: 0, explosivo: 0 };

  for (const bloco of blocos) {
    const oficial = duracoesOficiais ? duracoesOficiais[bloco.rotulo] : null;
    const jp = janelaParticipacao(stream, bloco, oficial);
    if (!jp) continue;
    participacao.push({
      periodo: bloco.rotulo,
      janelaPeriodoMin: +((bloco.fim - bloco.ini) / 60).toFixed(1),
      emCampoMin: +((jp.fim - jp.ini) / 60).toFixed(1),
      oficialMin: oficial != null ? +(oficial / 60).toFixed(1) : null,
      conferencia: jp.conferencia,
    });
    minJogados += (jp.fim - jp.ini) / 60;
    const b = binar(stream, acc, jp);
    binsPorBloco.push({ rotulo: bloco.rotulo, bins: b, offset: jp.ini });
    for (const v of VARIAVEIS) {
      for (let i = 0; i < b.nBins; i++) totais[v] += b[v][i];
    }
  }
  if (!binsPorBloco.length) return null;

  // picos e repetição, por janela × variável
  const picos = {};
  const repeticoes = {};
  for (const W of CONFIG.JANELAS_S) {
    picos[W] = {};
    repeticoes[W] = {};
    for (const v of VARIAVEIS) {
      // todas as janelas de todos os blocos (a janela NUNCA cruza período)
      let todas = [];
      for (const blk of binsPorBloco) {
        const js = janelasDeslizantes(blk.bins[v], W, CONFIG.PASSO_S);
        for (const j of js) todas.push({ inicioS: blk.offset + j.inicioS, valor: j.valor, periodo: blk.rotulo });
      }
      if (!todas.length) { picos[W][v] = null; repeticoes[W][v] = null; continue; }

      let melhor = todas[0];
      for (const j of todas) if (j.valor > melhor.valor) melhor = j;

      picos[W][v] = {
        absoluto: +melhor.valor.toFixed(2),
        porMinuto: +(melhor.valor / (W / 60)).toFixed(2),
        periodo: melhor.periodo,
        inicioUnix: melhor.inicioS,
      };

      const rep = {};
      for (const pct of CONFIG.CORTES_PCT) {
        const corte = melhor.valor * pct;
        const aceitas = janelasIndependentes(todas, corte, W);
        rep[Math.round(pct * 100)] = {
          n: aceitas.length,
          valores: aceitas.map(function (a) { return +a.valor.toFixed(2); }),
        };
      }
      repeticoes[W][v] = rep;
    }
  }

  const dtGlobal = estimarDt(stream);
  const referencia = totaisNoPeriodo(stream, acc, blocos);

  return {
    // números do período inteiro — só para bater com a Catapult, não entram no estudo
    referenciaPeriodoInteiro: referencia,
    pontosRecebidos: pontos.length,
    pontosUsados: stream.length,
    amostragemHz: dtGlobal > 0 ? +(1 / dtGlobal).toFixed(1) : null,
    minJogados: +minJogados.toFixed(1),
    participacao: participacao,
    totais: {
      dist: +totais.dist.toFixed(1),
      hsr: +totais.hsr.toFixed(1),
      sprint: +totais.sprint.toFixed(1),
      acel: Math.round(totais.acel),
      decel: Math.round(totais.decel),
      explosivo: Math.round(totais.explosivo),
    },
    picos: picos,
    repeticoes: repeticoes,
  };
}

/* Totais no PERÍODO INTEIRO, sem recortar o tempo de banco.
   Não entra no estudo: serve só para comparar com o /stats da Catapult, que
   calcula distância e contagens sobre o período todo, não sobre o tempo em
   jogo. Comparar o nosso número recortado com o dela era erro de régua. */
function totaisNoPeriodo(stream, acc, blocos) {
  let dist = 0, explosivo = 0;
  for (const bloco of blocos) {
    const b = binar(stream, acc, { ini: bloco.ini, fim: bloco.fim });
    for (let i = 0; i < b.nBins; i++) { dist += b.dist[i]; explosivo += b.explosivo[i]; }
  }
  return { dist: +dist.toFixed(1), explosivo: Math.round(explosivo) };
}

/* Varredura de calibração dos esforços explosivos.
   Detecta os esforços UMA vez por limiar de aceleração, guarda a velocidade
   máxima de cada um, e depois só filtra por velocidade — assim testar 20
   combinações custa quase o mesmo que testar uma.
   Conta sobre o PERÍODO INTEIRO, que é a régua da Catapult. */
function varrerExplosivos(pontos, blocos, limiaresAcc, limiaresVel) {
  const stream = normalizarStream(pontos);
  if (stream.length < 10) return null;
  const acc = derivarAceleracao(stream);
  const tabela = {};

  for (const la of limiaresAcc) {
    const velsDosEsforcos = [];
    for (const bloco of blocos) {
      const st = [], ac = [];
      for (let i = 0; i < stream.length; i++) {
        if (stream[i].ts >= bloco.ini && stream[i].ts <= bloco.fim) { st.push(stream[i]); ac.push(acc[i]); }
      }
      for (const e of detectarEsforcos(st, ac, +1, la)) {
        let velMax = 0;
        for (const p of st) if (p.ts >= e.ts && p.ts <= e.ts + e.dur) velMax = Math.max(velMax, kmh(p.v));
        velsDosEsforcos.push(velMax);
      }
    }
    tabela[la] = {};
    for (const lv of limiaresVel) {
      tabela[la][lv] = velsDosEsforcos.filter(v => v >= lv).length;
    }
  }
  return tabela;
}

/* Diagnóstico: mostra a cara da aceleração derivada do sinal real.
   Serve para descobrir por que uma contagem sai zerada, sem chutar limiar. */
function diagnosticoAceleracao(pontos, blocos, duracoesOficiais) {
  const stream = normalizarStream(pontos);
  if (stream.length < 10) return null;
  const acc = derivarAceleracao(stream);

  // só as amostras dentro da janela de participação
  const dentro = [];
  for (const bloco of blocos) {
    const jp = janelaParticipacao(stream, bloco, duracoesOficiais ? duracoesOficiais[bloco.rotulo] : null);
    if (!jp) continue;
    for (let i = 0; i < stream.length; i++) {
      if (stream[i].ts >= jp.ini && stream[i].ts <= jp.fim) dentro.push({ p: stream[i], a: acc[i] });
    }
  }
  if (!dentro.length) return null;

  const vals = dentro.map(d => d.a).sort((x, y) => x - y);
  const q = (f) => +vals[Math.min(vals.length - 1, Math.floor(f * vals.length))].toFixed(2);
  const st = dentro.map(d => d.p);
  const ac = dentro.map(d => d.a);

  const contagens = {};
  for (const lim of [1.5, 2.0, 2.5, 3.0, 3.5, 4.0]) {
    contagens[lim] = {
      acel: detectarEsforcos(st, ac, +1, lim).length,
      decel: detectarEsforcos(st, ac, -1, lim).length,
    };
  }

  // quanto tempo o sinal passa abaixo de -3 (sem exigir duração mínima)
  let amostrasAbaixo3 = 0, amostrasAcima3 = 0;
  for (const a of ac) { if (a <= -3) amostrasAbaixo3++; if (a >= 3) amostrasAcima3++; }

  return {
    amostras: dentro.length,
    aceleracaoMin: +Math.min(...ac).toFixed(2),
    aceleracaoMax: +Math.max(...ac).toFixed(2),
    percentis: { p1: q(0.01), p5: q(0.05), p50: q(0.50), p95: q(0.95), p99: q(0.99) },
    amostrasAcimaDe3: amostrasAcima3,
    amostrasAbaixoDeMenos3: amostrasAbaixo3,
    esforcosPorLimiar: contagens,
    duracaoMinimaAtual: CONFIG.DUR_MIN_ESFORCO_S,
    janelaDerivadaS: CONFIG.JANELA_ACC_S,
  };
}

const API = {
  CONFIG, VARIAVEIS,
  mesclarIntervalos, normalizarStream, derivarAceleracao, detectarEsforcos,
  janelaParticipacao, binar, janelasDeslizantes, janelasIndependentes,
  calcularAtleta, diagnosticoAceleracao, totaisNoPeriodo, varrerExplosivos,
};

export {
  CONFIG, VARIAVEIS,
  mesclarIntervalos, normalizarStream, derivarAceleracao, detectarEsforcos,
  janelaParticipacao, binar, janelasDeslizantes, janelasIndependentes,
  calcularAtleta, diagnosticoAceleracao, totaisNoPeriodo, varrerExplosivos,
};
export default API;
