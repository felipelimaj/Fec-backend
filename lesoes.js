/* ============================================================================
 lesoes.js — Extração minuto a minuto dos blocos "Lesão" da Catapult
 ----------------------------------------------------------------------------
 Fortaleza EC · Fisiologia · Estudo de demanda GPS pré-lesão

 Chamado pelo api/mdp.js quando a URL tem ?lesoes=...  (o projeto está no
 limite de 12 funções da Vercel Hobby, então este módulo NÃO é um arquivo novo
 dentro de api/ — mora na raiz, como o mdp.js, e é despachado por lá).

 Uso:
   /api/mdp?lesoes=lista              → só lista os blocos "Lesão" achados na
                                        nuvem e qual atleta foi atribuído a
                                        cada um (rápido, sem stream). RODE ANTES.
   /api/mdp?lesoes=1                  → extração completa em JSON
   /api/mdp?lesoes=1&csv=1            → extração completa em CSV (baixa arquivo)
   &periodo=<period_id>               → roda um bloco só (teste)
   &desde=DD/MM/YYYY                  → início da varredura (padrão 01/01/2024)
   &atleta=<period_id>:<athlete_id>   → força o atleta de um bloco (vírgula
                                        separa vários) quando o nome não casa
   &ancora=inicio                     → minutos contados a partir do início do
                                        bloco (padrão: a partir do FIM)

 Decisões:
   - Bloco = qualquer período cujo nome, sem acento e em minúsculas, contém
     "lesao". Não depende do nome da atividade.
   - Minuto a minuto SÓ existe no stream 10 Hz — o /stats da Catapult devolve
     o bloco inteiro. As métricas por minuto são calculadas aqui, com as mesmas
     regras do projeto (bandas confirmadas em 19/08, aceleração derivada em
     janela fixa de 0,6 s).
   - Colunas por minuto (26/09/2026, após revisão com o Felipe): distância
     total, B5–B7, HSR, sprint, acel ≥ 3, desacel ≤ −3 (duração mínima 0,6 s),
     vmax, Player Load. B1–B4 removidas pelo Felipe.
     Removidas por não terem sido aprovadas: explosivos_fec, cobertura_pct,
     esforços de HSR/sprint, acel/desacel ±2, FC, potência metabólica,
     ancora, ini/fim/duração da janela, colunas de validação no CSV e a
     linha "sobra". NÃO acrescentar coluna sem aprovação do Felipe.
   - Âncora no FIM do bloco: minuto −1 = os 60 s imediatamente antes do fim
     (momento da lesão), −5 = de 5 a 4 min antes. Os segundos iniciais que
     não fecham 1 min entram só no total da validação, não viram linha.
   - Acel/desacel são detectadas no bloco inteiro e atribuídas ao minuto em
     que COMEÇAM — um esforço que cruza a virada do minuto não é cortado.
   - Validação: soma do stream no bloco × /stats oficial do mesmo bloco
     (distância, Player Load, alta intensidade, sprint, vmax).
 ============================================================================ */

import MDP from './mdp.js';

const CATAPULT_BASE = 'https://connect-us.catapultsports.com/api/v6';
const CHUNK_DAYS = 60;           // a API trunca intervalos longos (~500 atividades)
const CONCURRENCY = 3;

// Bandas confirmadas no tenant (19/08/2026) — km/h, limite inferior de cada banda
const BANDAS = [
  { nome: 'B1', de: 0.5,   ate: 7.2 },
  { nome: 'B2', de: 7.2,   ate: 9.97 },
  { nome: 'B3', de: 9.97,  ate: 14.4 },
  { nome: 'B4', de: 14.4,  ate: 19.8 },
  { nome: 'B5', de: 19.8,  ate: 25.2 },
  { nome: 'B6', de: 25.2,  ate: 30.0 },
  { nome: 'B7', de: 30.0,  ate: Infinity },
];
const HSR_KMH = 19.8, SPRINT_KMH = 25.2;
const BANDAS_SAIDA = ['B5', 'B6', 'B7'];
const DUR_MIN_ACEL_S = 0.6;   // aprovado pelo Felipe em 26/09/2026

// Lesões já catalogadas na extração anterior (Lesoes_Catapult_Weberton.xlsx).
// Garante o atleta certo sem depender do nome do período e traz o contexto
// clínico. Blocos novos que não estão aqui são identificados pelo nome.
const CATALOGO = {
  '1c919d1a-2319-4a09-b2c6-a7e46430c1b5': { idLesao: 36, atleta: 'CALEBE',      athleteId: 'b261c372-fe3c-4d88-9e95-3e48fdf9fc65', dataLesao: '23/06/2024', momento: 'Jogo x ATL-MG (F)',       tipo: 'Muscular' },
  'b347c3a2-90d7-4546-a2cc-ad6ba22855e6': { idLesao: 18, atleta: 'MOISÉS',      athleteId: '3de70d11-cdbc-410e-a679-7400e0ed98ee', dataLesao: '14/09/2024', momento: 'Jogo x Athletico (F)',    tipo: 'Muscular' },
  '7302dc65-9c42-443d-b5f3-26f5a51ba9b1': { idLesao: 44, atleta: 'MARINHO',     athleteId: '2209b89d-306c-45af-9123-c318bcf175e0', dataLesao: '29/09/2024', momento: 'Jogo x Cuiabá (C)',       tipo: 'Muscular' },
  'cca81c9e-8502-43a7-9534-12c179c4b692': { idLesao: 26, atleta: 'TINGA',       athleteId: 'b65ee41d-16b2-4306-a99c-515ad96439f5', dataLesao: '29/03/2025', momento: 'Jogo x Fluminense',       tipo: 'Muscular' },
  '33bd78b2-5679-45b5-b8a3-3d8c5436f1c1': { idLesao: 1,  atleta: 'B.PACHECO',   athleteId: '41d71189-ecce-490a-a96f-ae0d09f899af', dataLesao: '27/09/2025', momento: 'Jogo x Sport (C)',        tipo: 'Muscular' },
  '81690054-3dca-48e4-8858-f5a51109569b': { idLesao: 31, atleta: 'ZÉ WELISON',  athleteId: '61509fa4-ddfd-4bf4-a714-4312d7cbeff3', dataLesao: '26/06/2024', momento: 'Jogo x Palmeiras (C)',    tipo: 'Muscular' },
  '18247736-5e47-44c0-bf4b-2c2e748b9ac4': { idLesao: 58, atleta: 'M. ROSSETTO', athleteId: 'f5b2d064-3c70-4246-8e6a-7235893346f7', dataLesao: '29/05/2025', momento: 'Jogo x Racing (F)',       tipo: 'Muscular' },
};

// ── Rede ──────────────────────────────────────────────────────────────────
async function catapult(path, token, body) {
  let delay = 600;
  for (let i = 0; i < 4; i++) {
    const r = await fetch(`${CATAPULT_BASE}${path}`, body
      ? { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
      : { headers: { Authorization: `Bearer ${token}` } });
    if ([429, 500, 502, 503, 504].includes(r.status) && i < 3) {
      await new Promise(s => setTimeout(s, delay)); delay *= 2; continue;
    }
    if (!r.ok) throw new Error(`Catapult ${body ? 'POST' : 'GET'} ${path.split('?')[0]} → HTTP ${r.status}`);
    return r.json();
  }
}

async function emLotes(itens, n, fn) {
  const out = [];
  for (let i = 0; i < itens.length; i += n) out.push(...await Promise.all(itens.slice(i, i + n).map(fn)));
  return out;
}

// ── Utilidades ────────────────────────────────────────────────────────────
function semAcento(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}
function ehBlocoLesao(nome) { return semAcento(nome).includes('lesao'); }

function unixToBrtDate(u) {
  const dt = new Date((u - 3 * 3600) * 1000);
  return `${String(dt.getUTCDate()).padStart(2, '0')}/${String(dt.getUTCMonth() + 1).padStart(2, '0')}/${dt.getUTCFullYear()}`;
}
function brtParaUnix(ddmmyyyy) {
  const [d, m, y] = ddmmyyyy.split('/').map(Number);
  return Math.floor(Date.UTC(y, m - 1, d, 3, 0, 0) / 1000);
}
function parseAthleteName(s) {
  const t = (s || '').trim();
  const m = t.match(/^(F?)(\d+)\s+(.+)$/);
  return m ? { cadastroId: parseInt(m[2], 10), nome: m[3] } : { cadastroId: null, nome: t };
}
const r1 = x => (x == null || !isFinite(x) ? null : Math.round(x * 10) / 10);
const r2 = x => (x == null || !isFinite(x) ? null : Math.round(x * 100) / 100);

// ── 1) Varredura: todos os períodos "Lesão" da nuvem ─────────────────────
async function acharBlocos(token, desdeUnix) {
  const agora = Math.floor(Date.now() / 1000);
  const passo = CHUNK_DAYS * 86400;
  const chunks = [];
  for (let s = desdeUnix; s <= agora; s += passo) chunks.push({ s, e: Math.min(s + passo - 1, agora) });

  const listas = await emLotes(chunks, 4, c =>
    catapult(`/activities?start_time=${c.s}&end_time=${c.e}`, token).catch(e => ({ erro: e.message, c })));

  const falhas = listas.filter(l => l && l.erro);
  const vistas = new Map();
  for (const l of listas) if (Array.isArray(l)) for (const a of l) vistas.set(a.id, a);

  const blocos = [];
  for (const a of vistas.values()) {
    for (const p of (a.periods || [])) {
      if (!ehBlocoLesao(p.name)) continue;
      blocos.push({
        periodId: p.id, periodo: (p.name || '').trim(),
        ini: p.start_time, fim: p.end_time, durS: p.end_time - p.start_time,
        activityId: a.id, atividade: (a.name || '').trim(), data: unixToBrtDate(a.start_time),
      });
    }
  }
  blocos.sort((x, y) => x.ini - y.ini);
  return { blocos, nAtividades: vistas.size, falhas: falhas.map(f => f.erro) };
}

// ── 2) Quem é o atleta do bloco ──────────────────────────────────────────
/* O período vale para o time todo; o nome dele é que diz de quem é a lesão.
   Ordem: catálogo da extração anterior → ?atleta= forçado → nome do período. */
const PALAVRAS_IGNORADAS = new Set(['lesao', 'jogo', 'x', 'treino', 'de', 'do', 'da', 'e', 'c', 'f']);

function tokensAtleta(nomeCatapult) {
  return semAcento(parseAthleteName(nomeCatapult).nome).split(/[\s.\-_]+/).filter(t => t.length >= 2);
}
function tokensPeriodo(nomePeriodo) {
  return semAcento(nomePeriodo).split(/[\s.\-_()]+/).filter(t => t.length >= 2 && !PALAVRAS_IGNORADAS.has(t));
}

function atribuirAtleta(bloco, linhasStats, forcados) {
  const cat = CATALOGO[bloco.periodId];
  const candidatos = new Map();
  for (const s of linhasStats) {
    if (s.period_id !== bloco.periodId && (s.period_name || '').trim() !== bloco.periodo) continue;
    const id = s.athlete_id ?? s.athlete?.id;
    if (id && !candidatos.has(id)) candidatos.set(id, { athleteId: id, nomeCatapult: s.athlete_name || '', stats: s });
  }
  const lista = [...candidatos.values()];

  const idForcado = forcados[bloco.periodId] || (cat && cat.athleteId);
  if (idForcado) {
    const c = candidatos.get(idForcado);
    return {
      ...(c || { athleteId: idForcado, nomeCatapult: cat ? cat.atleta : '', stats: null }),
      como: forcados[bloco.periodId] ? 'forçado na URL' : 'catálogo da extração anterior',
      ok: true,
    };
  }

  const tp = tokensPeriodo(bloco.periodo);
  const achados = lista.filter(c => {
    const ta = tokensAtleta(c.nomeCatapult);
    return tp.some(t => ta.some(a => a === t || (t.length >= 4 && (a.startsWith(t) || t.startsWith(a)))));
  });
  if (achados.length === 1) return { ...achados[0], como: 'nome do período', ok: true };
  return {
    athleteId: null, nomeCatapult: null, stats: null, ok: false,
    como: achados.length ? 'nome ambíguo — use &atleta=' : 'nome não casou — use &atleta=',
    candidatos: (achados.length ? achados : lista).map(c => `${c.nomeCatapult} (${c.athleteId})`),
  };
}

// ── 3) Stream 10 Hz do bloco ─────────────────────────────────────────────
// Tenta com FC, Player Load e potência metabólica; se a Catapult recusar
// algum campo, cai para conjuntos menores. `cs` é obrigatório (sem ele o
// stream vira 1 Hz — achado de 08/09/2026).
// hdop/pq/ref confirmados pela sonda de 26/09/2026 (pq = GNSS Quality %, ref = nº de satélites).
const CONJUNTOS_SENSOR = ['ts,cs,v,pl,hdop,pq,ref', 'ts,cs,v,pl', 'ts,cs,v'];

function extrairPontos(raw) {
  if (Array.isArray(raw)) {
    if (raw[0] && Array.isArray(raw[0].data)) return raw.flatMap(b => b.data || []);
    return raw;
  }
  return raw && Array.isArray(raw.data) ? raw.data : [];
}

async function baixarStream(bloco, athleteId, token) {
  let ultimoErro = null;
  for (const campos of CONJUNTOS_SENSOR) {
    for (const rota of [
      `/periods/${bloco.periodId}/athletes/${athleteId}/sensor`,
      `/activities/${bloco.activityId}/athletes/${athleteId}/sensor`,
    ]) {
      try {
        const raw = await catapult(`${rota}?parameters=${campos}&nulls=1`, token);
        const pts = extrairPontos(raw)
          .map(p => ({
            ts: p.cs != null ? p.ts + p.cs / 100 : p.ts,
            v: p.v, pl: p.pl, hdop: p.hdop, pq: p.pq, ref: p.ref,
          }))
          .filter(p => p.ts != null && p.ts >= bloco.ini - 1 && p.ts <= bloco.fim + 1);
        if (pts.length) return { pontos: pts, campos, rota: rota.split('/')[1] };
      } catch (e) { ultimoErro = e; }
    }
  }
  throw ultimoErro || new Error('stream vazio para este atleta no bloco');
}

/* Ordena, tira instante repetido, mantém só leituras com velocidade. */
function normalizar(pontos) {
  const vistos = new Set(), out = [];
  for (const p of pontos.slice().sort((a, b) => a.ts - b.ts)) {
    if (p.v == null) continue;
    const k = Math.round(p.ts * 100);
    if (vistos.has(k)) continue;
    vistos.add(k);
    out.push({ ts: +p.ts, v: +p.v, pl: p.pl, hdop: p.hdop, pq: p.pq, ref: p.ref });
  }
  return out;
}

/* A Catapult pode mandar `pl` acumulado (sobe sempre) ou por amostra.
   Decide olhando o próprio dado e devolve o incremento de cada amostra. */
function incrementosPL(stream) {
  const vals = stream.map(p => (p.pl == null ? null : +p.pl));
  const validos = vals.filter(v => v != null);
  if (validos.length < 10) return { modo: 'ausente', inc: null };
  let naoNeg = 0, total = 0;
  for (let i = 1; i < vals.length; i++) {
    if (vals[i] == null || vals[i - 1] == null) continue;
    total++; if (vals[i] - vals[i - 1] >= -1e-9) naoNeg++;
  }
  const acumulado = total > 0 && naoNeg / total >= 0.98 && (validos[validos.length - 1] - validos[0]) > 0;
  const inc = new Array(stream.length).fill(0);
  if (acumulado) {
    for (let i = 1; i < vals.length; i++) {
      if (vals[i] == null || vals[i - 1] == null) continue;
      const d = vals[i] - vals[i - 1];
      if (d > 0) inc[i] = d;
    }
  } else {
    for (let i = 0; i < vals.length; i++) inc[i] = vals[i] || 0;
  }
  return { modo: acumulado ? 'acumulado' : 'por amostra', inc };
}

// ── 4) Minuto a minuto ───────────────────────────────────────────────────
function janelasMinuto(bloco, ancora) {
  const n = Math.floor(bloco.durS / 60 + 1e-6);
  const js = [];
  if (ancora === 'inicio') {
    for (let k = 0; k < n; k++) js.push({ rotulo: String(k + 1), ini: bloco.ini + 60 * k, fim: bloco.ini + 60 * (k + 1) });
    if (bloco.fim - (bloco.ini + 60 * n) > 0.5) js.push({ rotulo: 'sobra', ini: bloco.ini + 60 * n, fim: bloco.fim });
  } else {
    if ((bloco.fim - 60 * n) - bloco.ini > 0.5) js.push({ rotulo: 'sobra', ini: bloco.ini, fim: bloco.fim - 60 * n });
    for (let k = n; k >= 1; k--) js.push({ rotulo: String(-k), ini: bloco.fim - 60 * k, fim: bloco.fim - 60 * (k - 1) });
  }
  return js;
}

function agrVazio() { return { soma: 0, n: 0, min: Infinity, max: -Infinity }; }
function agrSoma(a, x) { if (x == null || !isFinite(x)) return; a.soma += +x; a.n++; if (x < a.min) a.min = +x; if (x > a.max) a.max = +x; }
function agrMedia(a) { return a.n ? a.soma / a.n : null; }
function agrMin(a) { return a.n ? a.min : null; }
function agrMax(a) { return a.n ? a.max : null; }

function metricasVazias() {
  const m = { dist: 0, hsr: 0, sprint: 0, vmax: 0, pl: 0, acel3: 0, decel3: 0,
    q: { hdop: agrVazio(), pq: agrVazio(), ref: agrVazio() }, comp: {} };
  for (const b of BANDAS) m['dist' + b.nome] = 0;
  return m;
}

function calcularBloco(pontosBrutos, bloco, ancora, explosivos) {
  const stream = normalizar(pontosBrutos);
  if (stream.length < 20) throw new Error(`stream com só ${stream.length} leituras no bloco`);

  const janelas = janelasMinuto(bloco, ancora).map(j => ({ ...j, m: metricasVazias() }));
  const qual = (ts) => {
    for (const j of janelas) if (ts >= j.ini && ts < j.fim) return j;
    const ult = janelas[janelas.length - 1];
    return ts >= ult.ini && ts <= ult.fim + 1e-6 ? ult : null;
  };

  const pl = incrementosPL(stream);

  // distância por trapézio (mesma regra do MDP), bandas pela velocidade média do trecho
  for (let i = 0; i < stream.length; i++) {
    const p = stream[i];
    const j = qual(p.ts);
    if (!j) continue;
    const m = j.m;
    const kh = p.v * 3.6;
    if (kh > m.vmax) m.vmax = kh;
    if (pl.inc) m.pl += pl.inc[i];
    agrSoma(m.q.hdop, p.hdop); agrSoma(m.q.pq, p.pq); agrSoma(m.q.ref, p.ref);

    const q = stream[i + 1];
    if (!q) continue;
    let dt = q.ts - p.ts;
    if (dt <= 0) continue;
    if (dt > MDP.CONFIG.VAO_MAX_S) dt = MDP.CONFIG.VAO_MAX_S;
    const vMed = (p.v + q.v) / 2, khMed = vMed * 3.6, metros = vMed * dt;
    m.dist += metros;
    if (khMed >= HSR_KMH) m.hsr += metros;
    if (khMed >= SPRINT_KMH) m.sprint += metros;
    for (const b of BANDAS) if (khMed >= b.de && khMed < b.ate) { m['dist' + b.nome] += metros; break; }
  }

  // esforços: detectados no bloco inteiro, contados no minuto em que começam
  const acc = MDP.derivarAceleracao(stream);
  const conta = (lista, campo) => { for (const ts of lista) { const j = qual(ts); if (j) j.m[campo]++; } };
  // Duração mínima de 0,6 s — definida pelo Felipe para esta extração
  // (26/09/2026). O MDP segue com 0,4 s; por isso o filtro é aplicado aqui.
  const longo = e => e.dur >= DUR_MIN_ACEL_S - 1e-9;
  conta(MDP.detectarEsforcos(stream, acc, +1, 3).filter(longo).map(e => e.ts), 'acel3');
  conta(MDP.detectarEsforcos(stream, acc, -1, -3).filter(longo).map(e => e.ts), 'decel3');

  // Componentes das métricas explosivas (eventos da Catapult com horário),
  // contados no minuto em que começam.
  if (explosivos) for (const ev of explosivos.eventos) {
    const j = qual(ev.ts); if (j) j.m.comp[ev.comp] = (j.m.comp[ev.comp] || 0) + 1;
  }
  const soma = (m, lista) => lista.reduce((a, c) => a + (m.comp[c] || 0), 0);

  const dtMed = (() => {
    const d = []; for (let i = 1; i < stream.length && i < 400; i++) d.push(stream[i].ts - stream[i - 1].ts);
    d.sort((a, b) => a - b); return d[Math.floor(d.length / 2)] || 0.1;
  })();

  // A "sobra" (segundos iniciais que não fecham 1 min) entra no total do bloco
  // para a validação, mas NÃO vira linha: o pedido é 5 minutos por lesão.
  const linhas = janelas.filter(j => j.rotulo !== 'sobra').map(j => {
    const m = j.m;
    const o = {
      minuto: j.rotulo,
      dist_m: r1(m.dist),
    };
    // B1–B4 removidas da saída por decisão do Felipe (26/09/2026)
    for (const b of BANDAS) if (BANDAS_SAIDA.includes(b.nome)) o['dist_' + b.nome + '_m'] = r1(m['dist' + b.nome]);
    Object.assign(o, {
      hsr_m: r1(m.hsr), sprint_m: r1(m.sprint),
      acel_3: m.acel3, desacel_3: m.decel3,
      vmax_kmh: r1(m.vmax),
      player_load: pl.inc ? r1(m.pl) : null,
      esforcos_explosivos_2: explosivos && explosivos.valido ? soma(m, FORMULAS_EXPL['Esforços Explosivos 2']) : null,
      explosive_efforts: explosivos && explosivos.valido ? soma(m, FORMULAS_EXPL['Explosive Efforts']) : null,
      hdop_medio: r2(agrMedia(m.q.hdop)), hdop_min: r2(agrMin(m.q.hdop)), hdop_max: r2(agrMax(m.q.hdop)),
      gnss_qualidade_media_pct: r1(agrMedia(m.q.pq)), gnss_qualidade_min_pct: r1(agrMin(m.q.pq)), gnss_qualidade_max_pct: r1(agrMax(m.q.pq)),
      satelites_medio: r1(agrMedia(m.q.ref)), satelites_min: agrMin(m.q.ref), satelites_max: agrMax(m.q.ref),
    });
    return o;
  });

  // total do bloco = soma de tudo (inclui a sobra) → validação contra /stats
  const tot = { dist: 0, pl: 0, hsr: 0, sprint: 0, vmax: 0, q: { hdop: agrVazio(), pq: agrVazio(), ref: agrVazio() } };
  for (const j of janelas) {
    tot.dist += j.m.dist; tot.pl += j.m.pl; tot.hsr += j.m.hsr; tot.sprint += j.m.sprint; tot.vmax = Math.max(tot.vmax, j.m.vmax);
    for (const k of ['hdop', 'pq', 'ref']) {
      const a = tot.q[k], b = j.m.q[k];
      a.soma += b.soma; a.n += b.n; a.min = Math.min(a.min, b.min); a.max = Math.max(a.max, b.max);
    }
  }
  return { linhas, tot, plModo: pl.modo, hz: r1(1 / dtMed), leituras: stream.length };
}

// ── 5) /stats oficial do bloco (validação) ───────────────────────────────
const SLUGS_VALIDACAO = [
  'total_distance', 'total_duration', 'total_player_load', 'max_vel',
  'velocity_band5_total_distance', 'velocity_band6_total_distance', 'velocity_band7_total_distance',
  // qualidade de sinal (sonda 26/09/2026)
  'average_hdop', 'min_hdop', 'max_hdop',
  'average_gnss_quality', 'min_gnss_quality', 'max_gnss_quality',
  'average_satellite_count', 'min_satellite_count', 'max_satellite_count',
];
// componentes e métricas explosivas (declarados abaixo)
const SLUGS_EXPLOSIVOS = () => ['esforços_explosivos_2', 'explosive_efforts_gk',
  ...Object.values(COMP_SLUG)];

async function statsDaAtividade(activityId, token) {
  const pedir = (params) => catapult('/stats', token, {
    filters: [{ name: 'activity_id', comparison: '=', values: [activityId] }],
    parameters: params, group_by: ['period', 'athlete'],
  });
  try { return await pedir([...SLUGS_VALIDACAO, ...SLUGS_EXPLOSIVOS()]); }
  catch (e) { /* segue */ }
  try { return await pedir(SLUGS_VALIDACAO); }
  catch (e) { return pedir(['total_distance', 'total_duration']); }
}


// ── 5b) Esforços Explosivos 2 e Explosive Efforts por minuto ─────────────
/* Métricas personalizadas do tenant (fórmulas mostradas pelo Felipe no
   OpenField, 26/09/2026). Slugs confirmados pela sonda no mesmo dia.
   Cada componente vem da Catapult com horário:
     - esforços de aceleração Gen2  → /efforts (campo band: 2, 3, -2, -3)
       band 2 = Accel B2 e band -2 = Decel B2 conferidos contra o /stats no
       bloco do Calebe (3 e 2). Band 3 / -3 = B3 por analogia — a TRAVA abaixo
       confere em cada lesão.
     - eventos IMA                  → /events (intensity, direction)
       A API não diz "High/Medium" nem "CoD Left/Right": a classificação usa
       IMA_PADRAO (valores padrão da Catapult, NÃO confirmados no tenant).
     - saltos                        → /events ima_jump (height)
       Sem limiares de altura: salto só é aceito quando o /stats diz que no
       bloco não houve salto nas bandas usadas (então todos contam zero).
     - mergulhos                     → só goleiro; aceito quando o /stats dá 0.
   TRAVA: as colunas só são preenchidas quando a soma do BLOCO de CADA
   componente é IGUAL ao /stats oficial. Se um único componente divergir, as
   duas colunas ficam vazias naquela lesão e o motivo sai no JSON. */
const COMP_SLUG = {
  acelB2: 'gen2_acceleration_band7_total_effort_count', acelB3: 'gen2_acceleration_band8_total_effort_count',
  desB2: 'gen2_acceleration_band2_total_effort_count', desB3: 'gen2_acceleration_band1_total_effort_count',
  imaAcelAlto: 'ima_band3_accel_count', imaDesAlto: 'ima_band3_decel_count',
  imaEsqAlto: 'ima_band3_left_count', imaDirAlto: 'ima_band3_right_count',
  imaAcelMed: 'ima_band2_accel_count', imaDesMed: 'ima_band2_decel_count',
  imaEsqMed: 'ima_band2_left_count', imaDirMed: 'ima_band2_right_count',
  saltoAlto: 'ima_band3_jump_count', salto4: 'ima_band4_jump_count', salto5: 'ima_band5_jump_count',
  salto6: 'ima_band6_jump_count', salto7: 'ima_band7_jump_count', mergulhos: 'total_goalkeeping_dives',
};
const SLUG_EE2 = 'esforços_explosivos_2', SLUG_EF = 'explosive_efforts_gk';
const FORMULAS_EXPL = {
  'Esforços Explosivos 2': ['acelB2', 'acelB3', 'desB2', 'desB3', 'imaDirAlto', 'imaEsqAlto', 'saltoAlto'],
  'Explosive Efforts': ['imaAcelAlto', 'imaDesAlto', 'imaEsqAlto', 'imaDirAlto', 'imaDesMed', 'imaAcelMed',
    'imaDirMed', 'imaEsqMed', 'salto4', 'salto5', 'salto6', 'salto7', 'mergulhos'],
};
const COMP_IMA = ['imaAcelAlto', 'imaDesAlto', 'imaEsqAlto', 'imaDirAlto', 'imaAcelMed', 'imaDesMed', 'imaEsqMed', 'imaDirMed'];
const COMP_SALTO = ['saltoAlto', 'salto4', 'salto5', 'salto6', 'salto7'];
const BAND_GEN2 = { '2': 'acelB2', '3': 'acelB3', '-2': 'desB2', '-3': 'desB3' };

// Padrão da Catapult — NÃO confirmado no tenant. Direção em "horas de relógio"
// (0–12, 12 = frente). Intensidade em m/s: Medium ≥ 2,5 · High ≥ 3,5.
const IMA_PADRAO = { medio: 2.5, alto: 3.5, giro: 0, espelho: false };

function classificarIMA(ev, cfg) {
  const i = +ev.intensity;
  if (!(i >= cfg.medio)) return null;
  let d = (((+ev.direction + cfg.giro) % 12) + 12) % 12;
  if (cfg.espelho) d = (12 - d) % 12;
  const setor = (d >= 10.5 || d < 1.5) ? 'Acel' : d < 4.5 ? 'Dir' : d < 7.5 ? 'Des' : 'Esq';
  return 'ima' + setor + (i >= cfg.alto ? 'Alto' : 'Med');
}

function cfgIMA(q) {
  const c = { ...IMA_PADRAO };
  if (q.imaMedio) c.medio = parseFloat(q.imaMedio);
  if (q.imaAlto) c.alto = parseFloat(q.imaAlto);
  if (q.imaGiro) c.giro = parseFloat(q.imaGiro);
  if (q.imaEspelho) c.espelho = String(q.imaEspelho) === '1';
  return c;
}

function listaDe(raw, chave) {
  const d = Array.isArray(raw) ? raw[0] : raw;
  return (d && d.data && Array.isArray(d.data[chave])) ? d.data[chave] : [];
}

async function baixarEventos(bloco, athleteId, token) {
  const base = `/periods/${bloco.periodId}/athletes/${athleteId}`;
  const [ef, ev] = await Promise.all([
    catapult(`${base}/efforts?effort_types=acceleration`, token),
    catapult(`${base}/events?event_types=ima_acceleration,ima_jump`, token),
  ]);
  const dentro = x => x.start_time >= bloco.ini && x.start_time < bloco.fim;
  return {
    gen2: listaDe(ef, 'acceleration_efforts').filter(dentro),
    ima: listaDe(ev, 'ima_acceleration').filter(dentro),
    saltos: listaDe(ev, 'ima_jump').filter(dentro),
  };
}

function montarExplosivos(brutos, linhaStats, cfg) {
  const eventos = [];
  for (const e of brutos.gen2) { const c = BAND_GEN2[String(e.band)]; if (c) eventos.push({ ts: e.start_time, comp: c }); }
  for (const e of brutos.ima) { const c = classificarIMA(e, cfg); if (c) eventos.push({ ts: e.start_time, comp: c }); }

  const nosso = {};
  for (const e of eventos) nosso[e.comp] = (nosso[e.comp] || 0) + 1;
  const oficial = k => (linhaStats && linhaStats[COMP_SLUG[k]] != null) ? +linhaStats[COMP_SLUG[k]] : null;

  const motivos = [];
  if (!linhaStats) motivos.push('sem /stats do bloco');
  const saltosOficiais = COMP_SALTO.reduce((a, k) => a + (oficial(k) || 0), 0);
  if (saltosOficiais > 0) motivos.push(`há ${saltosOficiais} salto(s) nas bandas usadas e faltam os limiares de altura do tenant`);
  if ((oficial('mergulhos') || 0) > 0) motivos.push('há mergulhos no bloco e o evento de mergulho não é lido');

  const conferencia = {};
  for (const k of Object.keys(COMP_SLUG)) {
    const n = COMP_SALTO.includes(k) || k === 'mergulhos' ? 0 : (nosso[k] || 0);
    conferencia[k] = { nosso: n, catapult: oficial(k), bate: oficial(k) === n };
    if (linhaStats && oficial(k) === null) motivos.push(`/stats sem ${COMP_SLUG[k]}`);
    else if (linhaStats && oficial(k) !== n) motivos.push(`${k}: ${n} contra ${oficial(k)} da Catapult`);
  }
  const ee2 = linhaStats ? linhaStats[SLUG_EE2] : null, ef = linhaStats ? linhaStats[SLUG_EF] : null;
  const somaF = nome => FORMULAS_EXPL[nome].reduce((a, k) => a + (oficial(k) || 0), 0);
  if (ee2 != null && +ee2 !== somaF('Esforços Explosivos 2')) motivos.push('Esforços Explosivos 2 do /stats ≠ soma dos componentes');
  if (ef != null && +ef !== somaF('Explosive Efforts')) motivos.push('Explosive Efforts do /stats ≠ soma dos componentes');

  return {
    eventos, valido: motivos.length === 0, motivos, conferencia,
    blocoCatapult: { esforcos_explosivos_2: ee2, explosive_efforts: ef },
    blocoNosso: { esforcos_explosivos_2: FORMULAS_EXPL['Esforços Explosivos 2'].reduce((a, k) => a + conferencia[k].nosso, 0),
                  explosive_efforts: FORMULAS_EXPL['Explosive Efforts'].reduce((a, k) => a + conferencia[k].nosso, 0) },
  };
}

/* ?lesoes=calibrar_ima — varre limiares/orientação do IMA e diz qual
   configuração reproduz EXATAMENTE os 8 contadores IMA do /stats em todas as
   lesões. Não muda nada na extração: só informa, para o Felipe aprovar. */
async function calibrarIMA(blocos, token) {
  const dados = [];
  for (const b of blocos) {
    if (!b.atribuicao.ok || !b.atribuicao.stats) continue;
    try { dados.push({ b, ev: await baixarEventos(b, b.atribuicao.athleteId, token), st: b.atribuicao.stats }); }
    catch (e) { dados.push({ b, erro: e.message }); }
  }
  const validos = dados.filter(d => !d.erro);
  const resultados = [];
  for (const medio of [1.5, 2.0, 2.5, 3.0])
    for (const alto of [2.5, 3.0, 3.5, 4.0, 4.5]) {
      if (alto <= medio) continue;
      for (const giro of [0, 3, 6, 9]) for (const espelho of [false, true]) {
        const cfg = { medio, alto, giro, espelho };
        let blocosOk = 0, erroTotal = 0;
        for (const d of validos) {
          const cont = {};
          for (const e of d.ev.ima) { const c = classificarIMA(e, cfg); if (c) cont[c] = (cont[c] || 0) + 1; }
          let ok = true;
          for (const k of COMP_IMA) {
            const dif = Math.abs((cont[k] || 0) - (+d.st[COMP_SLUG[k]] || 0));
            erroTotal += dif; if (dif) ok = false;
          }
          if (ok) blocosOk++;
        }
        resultados.push({ cfg, blocosQueBatem: blocosOk, de: validos.length, erroTotal });
      }
    }
  resultados.sort((a, b) => b.blocosQueBatem - a.blocosQueBatem || a.erroTotal - b.erroTotal);
  return {
    padraoAtual: IMA_PADRAO,
    padraoResultado: resultados.find(r => JSON.stringify(r.cfg) === JSON.stringify(IMA_PADRAO)),
    melhores: resultados.slice(0, 8),
    // Mais de uma configuração com o mesmo resultado no topo = os dados não
    // bastam para decidir; aí é preciso a configuração do OpenField.
    empatadosNoTopo: resultados.filter(r => r.blocosQueBatem === resultados[0].blocosQueBatem && r.erroTotal === resultados[0].erroTotal).length,
    falhas: dados.filter(d => d.erro).map(d => ({ periodo: d.b.periodo, erro: d.erro })),
  };
}

function difPct(nosso, oficial) {
  if (nosso == null || !oficial) return null;
  return r1((nosso - oficial) / oficial * 100);
}

// ── 6) Handler ───────────────────────────────────────────────────────────
export default async function handlerLesoes(req, res, token) {
  const q = req.query;
  const modoLista = String(q.lesoes) === 'lista';
  const ancora = q.ancora === 'inicio' ? 'inicio' : 'fim';
  const desde = q.desde ? brtParaUnix(String(q.desde)) : brtParaUnix('01/01/2024');
  const forcados = {};
  for (const par of String(q.atleta || '').split(',').filter(Boolean)) {
    const [pid, aid] = par.split(':'); if (pid && aid) forcados[pid.trim()] = aid.trim();
  }

  const varredura = await acharBlocos(token, desde);
  let blocos = varredura.blocos;
  if (q.periodo) blocos = blocos.filter(b => b.periodId === String(q.periodo));

  // /stats uma vez por atividade: serve para achar o atleta E para validar
  const porAtividade = {};
  await emLotes([...new Set(blocos.map(b => b.activityId))], CONCURRENCY, async id => {
    try { porAtividade[id] = await statsDaAtividade(id, token); }
    catch (e) { porAtividade[id] = { erro: e.message }; }
  });

  for (const b of blocos) {
    const st = porAtividade[b.activityId];
    b.atribuicao = Array.isArray(st) ? atribuirAtleta(b, st, forcados)
      : { ok: false, como: 'falhou o /stats da atividade: ' + (st && st.erro) };
    const cat = CATALOGO[b.periodId];
    b.catalogo = cat || null;
  }

  const catalogadosAusentes = Object.keys(CATALOGO)
    .filter(pid => !varredura.blocos.some(b => b.periodId === pid))
    .map(pid => CATALOGO[pid].atleta + ' ' + CATALOGO[pid].dataLesao);

  if (String(q.lesoes) === 'calibrar_ima') {
    return res.status(200).json(await calibrarIMA(blocos, token));
  }

  if (modoLista) {
    return res.status(200).json({
      atividadesVarridas: varredura.nAtividades,
      falhasNaVarredura: varredura.falhas,
      blocosEncontrados: blocos.length,
      catalogadosNaoEncontrados: catalogadosAusentes,
      blocos: blocos.map(b => ({
        data: b.data, atividade: b.atividade, periodo: b.periodo, periodId: b.periodId,
        duracao_s: r1(b.durS),
        atleta: b.atribuicao.nomeCatapult || null, athleteId: b.atribuicao.athleteId || null,
        identificadoPor: b.atribuicao.como, jaNoCatalogo: !!b.catalogo,
        candidatos: b.atribuicao.candidatos,
      })),
    });
  }

  const resultados = await emLotes(blocos, CONCURRENCY, async b => {
    const base = { bloco: b };
    if (!b.atribuicao.ok) return { ...base, erro: 'atleta não identificado — ' + b.atribuicao.como };
    try {
      const s = await baixarStream(b, b.atribuicao.athleteId, token);
      let explosivos = null;
      try {
        explosivos = montarExplosivos(await baixarEventos(b, b.atribuicao.athleteId, token), b.atribuicao.stats, cfgIMA(q));
      } catch (e) {
        explosivos = { eventos: [], valido: false, motivos: ['falha ao baixar eventos: ' + e.message] };
      }
      const calc = calcularBloco(s.pontos, b, ancora, explosivos);
      const of = b.atribuicao.stats;
      const oficial = of ? {
        dist: of.total_distance, pl: of.total_player_load, vmax: of.max_vel,
        hsr: of.velocity_band5_total_distance != null
          ? (of.velocity_band5_total_distance || 0) + (of.velocity_band6_total_distance || 0) + (of.velocity_band7_total_distance || 0) : null,
        sprint: of.velocity_band6_total_distance != null
          ? (of.velocity_band6_total_distance || 0) + (of.velocity_band7_total_distance || 0) : null,
      } : null;
      const validacao = oficial ? {
        dist: { stream: r1(calc.tot.dist), catapult: r1(oficial.dist), dif_pct: difPct(calc.tot.dist, oficial.dist) },
        player_load: { stream: calc.plModo === 'ausente' ? null : r1(calc.tot.pl), catapult: r1(oficial.pl), dif_pct: calc.plModo === 'ausente' ? null : difPct(calc.tot.pl, oficial.pl) },
        hsr: { stream: r1(calc.tot.hsr), catapult: r1(oficial.hsr), dif_pct: difPct(calc.tot.hsr, oficial.hsr) },
        sprint: { stream: r1(calc.tot.sprint), catapult: r1(oficial.sprint), dif_pct: difPct(calc.tot.sprint, oficial.sprint) },
        vmax: { stream: r1(calc.tot.vmax), catapult: r1(oficial.vmax) },
        qualidade: {
          hdop: { medio: [r2(agrMedia(calc.tot.q.hdop)), r2(of.average_hdop)], min: [agrMin(calc.tot.q.hdop), of.min_hdop], max: [agrMax(calc.tot.q.hdop), of.max_hdop] },
          gnss: { media: [r1(agrMedia(calc.tot.q.pq)), r1(of.average_gnss_quality)], min: [r1(agrMin(calc.tot.q.pq)), r1(of.min_gnss_quality)], max: [r1(agrMax(calc.tot.q.pq)), r1(of.max_gnss_quality)] },
          satelites: { medio: [r1(agrMedia(calc.tot.q.ref)), r1(of.average_satellite_count)], min: [agrMin(calc.tot.q.ref), of.min_satellite_count], max: [agrMax(calc.tot.q.ref), of.max_satellite_count] },
          leitura: '[nosso, catapult] — bloco inteiro',
        },
        explosivos: explosivos ? { preenchido: explosivos.valido, motivos: explosivos.motivos,
          bloco: { nosso: explosivos.blocoNosso, catapult: explosivos.blocoCatapult }, componentes: explosivos.conferencia } : null,
      } : null;
      return { ...base, calc, validacao, stream: { campos: s.campos, rota: s.rota, hz: calc.hz, leituras: calc.leituras, plModo: calc.plModo } };
    } catch (e) {
      return { ...base, erro: e.message };
    }
  });

  const ident = (b) => {
    const pn = parseAthleteName(b.atribuicao.nomeCatapult || '');
    return {
      id_lesao: b.catalogo ? b.catalogo.idLesao : '',
      atleta: b.catalogo ? b.catalogo.atleta : pn.nome,
      cadastro_id: pn.cadastroId ?? '',
      data: b.data, atividade: b.atividade, periodo: b.periodo,
      tipo: b.catalogo ? b.catalogo.tipo : '', momento: b.catalogo ? b.catalogo.momento : '',
    };
  };

  if (q.csv) {
    const linhas = [];
    let cab = null;
    for (const r of resultados) {
      if (r.erro) continue;
      for (const l of r.calc.linhas) {
        const row = {
          ...ident(r.bloco), ...l,
          period_id: r.bloco.periodId, activity_id: r.bloco.activityId, athlete_id: r.bloco.atribuicao.athleteId,
        };
        if (!cab) cab = Object.keys(row);
        linhas.push(cab.map(k => {
          const x = row[k];
          if (x == null) return '';
          if (typeof x === 'number') return String(x).replace('.', ',');   // Excel pt-BR
          const s = String(x);
          return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
        }).join(';'));
      }
    }
    const csv = '﻿' + [(cab || ['sem_dados']).join(';'), ...linhas].join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="lesoes_minuto_a_minuto.csv"');
    return res.status(200).send(csv);
  }

  return res.status(200).json({
    config: {
      ancora, bandasKmh: BANDAS.map(b => `${b.nome} ${b.de}–${b.ate === Infinity ? '…' : b.ate}`),
      hsrKmh: HSR_KMH, sprintKmh: SPRINT_KMH, acelLimiares: [2, 3], janelaAcelS: MDP.CONFIG.JANELA_ACC_S,
    },
    atividadesVarridas: varredura.nAtividades,
    blocosEncontrados: blocos.length,
    extraidos: resultados.filter(r => !r.erro).length,
    catalogadosNaoEncontrados: catalogadosAusentes,
    erros: resultados.filter(r => r.erro).map(r => ({ periodo: r.bloco.periodo, data: r.bloco.data, erro: r.erro })),
    lesoes: resultados.filter(r => !r.erro).map(r => ({
      ...ident(r.bloco), identificadoPor: r.bloco.atribuicao.como,
      stream: r.stream, validacao: r.validacao, minutos: r.calc.linhas,
    })),
  });
}


// ── 7) SONDA: métricas explosivas, HDOP e GNSS (26/09/2026) ──────────────
/* Pedido do Felipe: incluir "Explosive Efforts" e "Esforços Explosivos 2"
   (métricas personalizadas do tenant) e HDOP/GNSS vindos da Catapult.
   Nada disso entra na extração antes de ele ver este resultado. A sonda:
     1. procura os slugs no catálogo (/parameters);
     2. lê o valor do BLOCO no /stats e confere se a soma dos componentes
        (fórmula mostrada no OpenField) bate com a métrica personalizada;
     3. testa se a API entrega cada evento/esforço com horário — só assim dá
        para contar por minuto;
     4. testa quais campos de qualidade de sinal o stream aceita. */
const FORMULAS = {
  'Esforços Explosivos 2': [
    'Acceleration B2 Efforts (Gen 2)', 'Acceleration B3 Efforts (Gen 2)',
    'Deceleration B2 Efforts (Gen 2)', 'Deceleration B3 Efforts (Gen 2)',
    'IMA CoD Right High', 'IMA CoD Left High', 'IMA Jump Count High Band',
  ],
  'Explosive Efforts': [
    'IMA Accel High', 'IMA Decel High', 'IMA CoD Left High', 'IMA CoD Right High',
    'IMA Decel Medium', 'IMA Accel Medium', 'IMA CoD Right Medium', 'IMA CoD Left Medium',
    'IMA Jump Count Band 4', 'IMA Jump Count Band 5', 'IMA Jump Count Band 6', 'IMA Jump Count Band 7',
    'Total Dive Count',
  ],
};
const TERMOS_QUALIDADE = ['hdop', 'gnss', 'satel', 'positional quality', 'signal'];

async function tentar(fn) {
  try { return { ok: true, dado: await fn() }; } catch (e) { return { ok: false, erro: e.message }; }
}
function amostra(arr, n) { return Array.isArray(arr) ? arr.slice(0, n) : arr; }

export async function sondaExplosivos(req, res, token) {
  const q = req.query;
  const varredura = await acharBlocos(token, q.desde ? brtParaUnix(String(q.desde)) : brtParaUnix('01/01/2024'));
  const bloco = q.periodo
    ? varredura.blocos.find(b => b.periodId === String(q.periodo))
    : varredura.blocos.find(b => CATALOGO[b.periodId]);
  if (!bloco) return res.status(404).json({ erro: 'bloco não encontrado' });
  const athleteId = (q.atleta && String(q.atleta)) || (CATALOGO[bloco.periodId] || {}).athleteId;
  const saida = { bloco: { data: bloco.data, atividade: bloco.atividade, periodo: bloco.periodo, athleteId } };

  // 1) catálogo
  const params = await catapult('/parameters', token);
  const porNome = new Map((params || []).map(p => [semAcento(p.name), p]));
  saida.catalogo = {};
  for (const [metrica, comps] of Object.entries(FORMULAS)) {
    const alvo = porNome.get(semAcento(metrica));
    saida.catalogo[metrica] = {
      slug: alvo ? alvo.slug : null,
      componentes: comps.map(c => { const p = porNome.get(semAcento(c)); return { nome: c, slug: p ? p.slug : null }; }),
    };
  }
  saida.catalogo.qualidadeSinal = (params || [])
    .filter(p => TERMOS_QUALIDADE.some(t => semAcento(p.name).includes(t) || semAcento(p.slug).includes(t)))
    .map(p => ({ nome: p.name, slug: p.slug, unidade: p.unit_type, agregacao: p.aggregation }));

  // 2) /stats do bloco: métrica personalizada × soma dos componentes
  const slugs = [];
  for (const m of Object.values(saida.catalogo)) {
    if (!m || !m.componentes) continue;
    if (m.slug) slugs.push(m.slug);
    for (const c of m.componentes) if (c.slug) slugs.push(c.slug);
  }
  for (const qs of saida.catalogo.qualidadeSinal) slugs.push(qs.slug);
  const st = await tentar(() => catapult('/stats', token, {
    filters: [{ name: 'activity_id', comparison: '=', values: [bloco.activityId] }],
    parameters: [...new Set(slugs)], group_by: ['period', 'athlete'],
  }));
  if (st.ok) {
    const linha = (st.dado || []).find(r => (r.athlete_id ?? r.athlete?.id) === athleteId &&
      (r.period_id === bloco.periodId || (r.period_name || '').trim() === bloco.periodo));
    saida.statsDoBloco = {};
    for (const [metrica, m] of Object.entries(saida.catalogo)) {
      if (!m || !m.componentes) continue;
      const comps = m.componentes.map(c => ({ nome: c.nome, valor: linha && c.slug ? linha[c.slug] ?? null : null }));
      const soma = comps.reduce((a, c) => a + (+c.valor || 0), 0);
      saida.statsDoBloco[metrica] = {
        valor: linha && m.slug ? linha[m.slug] ?? null : null,
        somaDosComponentes: soma, componentes: comps,
      };
    }
    saida.statsDoBloco.qualidadeSinal = saida.catalogo.qualidadeSinal.map(qs => ({ slug: qs.slug, valor: linha ? linha[qs.slug] ?? null : null }));
  } else saida.statsDoBloco = { erro: st.erro };

  // 3) eventos/esforços com horário
  const base = `/activities/${bloco.activityId}/athletes/${athleteId}`;
  const basePer = `/periods/${bloco.periodId}/athletes/${athleteId}`;
  const rotas = [
    `${base}/events?event_types=ima_acceleration`,
    `${base}/events?event_types=ima_jump`,
    `${base}/events?event_types=ima_acceleration,ima_jump`,
    `${basePer}/events?event_types=ima_acceleration`,
    `${base}/efforts?effort_types=acceleration`,
    `${base}/efforts?effort_types=acceleration,velocity`,
    `${basePer}/efforts?effort_types=acceleration`,
    `${base}/events`,
    `${base}/efforts`,
  ];
  saida.eventosComHorario = [];
  for (const r of rotas) {
    const t = await tentar(() => catapult(r, token));
    if (!t.ok) { saida.eventosComHorario.push({ rota: r, ok: false, erro: t.erro }); continue; }
    const d = t.dado;
    const lista = Array.isArray(d) ? (d[0] && typeof d[0] === 'object' && !Array.isArray(d[0]) && Object.values(d[0]).some(Array.isArray)
      ? d[0] : d) : d;
    saida.eventosComHorario.push({
      rota: r, ok: true,
      tipo: Array.isArray(d) ? `array(${d.length})` : typeof d,
      chaves: d && typeof d === 'object' ? Object.keys(Array.isArray(d) ? (d[0] || {}) : d) : null,
      amostra: JSON.stringify(amostra(Array.isArray(d) ? d : [lista], 2)).slice(0, 1500),
    });
  }

  // 4) campos de qualidade no stream
  saida.streamQualidade = [];
  for (const campo of ['hdop', 'pq', 'ref', 'gnss', 'sat', 'satellites', 'nsat']) {
    const t = await tentar(() => catapult(`${basePer}/sensor?parameters=ts,cs,${campo}&nulls=1`, token));
    if (!t.ok) { saida.streamQualidade.push({ campo, aceito: false, erro: t.erro }); continue; }
    const pts = extrairPontos(t.dado).filter(p => p[campo] != null);
    saida.streamQualidade.push({ campo, aceito: true, leiturasComValor: pts.length, amostra: pts.slice(0, 3).map(p => p[campo]) });
  }
  return res.status(200).json(saida);
}

// exportado para o teste offline
export { calcularBloco, janelasMinuto, atribuirAtleta, incrementosPL, ehBlocoLesao };
