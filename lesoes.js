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
     janela fixa de 0,6 s, explosivo pelo critério FEC).
   - Âncora no FIM do bloco: minuto −1 = os 60 s imediatamente antes do fim
     (momento da lesão), −5 = de 5 a 4 min antes. O que sobra no começo
     (blocos têm ~300–311 s) sai numa linha própria, "sobra", e não é
     misturado em nenhum minuto.
   - Esforços (acel/desacel/explosivo/HSR/sprint) são detectados no bloco
     inteiro e atribuídos ao minuto em que COMEÇAM — um esforço que cruza a
     virada do minuto não é cortado em dois.
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
const DUR_MIN_CORRIDA_S = 1.0;   // esforço de HSR/sprint precisa durar ≥ 1 s

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
const CONJUNTOS_SENSOR = ['ts,cs,v,hr,pl,mp', 'ts,cs,v,hr,pl', 'ts,cs,v,hr', 'ts,cs,v'];

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
            v: p.v, hr: p.hr, pl: p.pl, mp: p.mp,
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
    out.push({ ts: +p.ts, v: +p.v, hr: p.hr, pl: p.pl, mp: p.mp });
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

/* Esforços de corrida: entradas acima de um limiar de velocidade que duram
   pelo menos DUR_MIN_CORRIDA_S. Devolve os instantes de início. */
function esforcosCorrida(stream, limiarKmh) {
  const out = [];
  let ini = null;
  for (let i = 0; i < stream.length; i++) {
    const acima = stream[i].v * 3.6 >= limiarKmh;
    if (acima && ini === null) ini = stream[i].ts;
    if ((!acima || i === stream.length - 1) && ini !== null) {
      const fim = acima ? stream[i].ts : stream[i - 1].ts;
      if (fim - ini >= DUR_MIN_CORRIDA_S - 1e-6) out.push(ini);
      ini = null;
    }
  }
  return out;
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

function metricasVazias() {
  const m = { amostras: 0, dist: 0, hsr: 0, sprint: 0, vmax: 0, pl: 0, hrSoma: 0, hrN: 0, hrMax: 0, mpSoma: 0, mpN: 0,
    acel3: 0, decel3: 0, acel2: 0, decel2: 0, explosivos: 0, esfHsr: 0, esfSprint: 0 };
  for (const b of BANDAS) m['dist' + b.nome] = 0;
  return m;
}

function calcularBloco(pontosBrutos, bloco, ancora) {
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
    m.amostras++;
    const kh = p.v * 3.6;
    if (kh > m.vmax) m.vmax = kh;
    if (p.hr != null && p.hr > 30) { m.hrSoma += +p.hr; m.hrN++; if (p.hr > m.hrMax) m.hrMax = +p.hr; }
    if (p.mp != null && isFinite(p.mp)) { m.mpSoma += +p.mp; m.mpN++; }
    if (pl.inc) m.pl += pl.inc[i];

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
  conta(MDP.detectarEsforcos(stream, acc, +1, 3).map(e => e.ts), 'acel3');
  conta(MDP.detectarEsforcos(stream, acc, -1, -3).map(e => e.ts), 'decel3');
  conta(MDP.detectarEsforcos(stream, acc, +1, 2).map(e => e.ts), 'acel2');
  conta(MDP.detectarEsforcos(stream, acc, -1, -2).map(e => e.ts), 'decel2');
  const expl = MDP.detectarEsforcos(stream, acc, +1, MDP.CONFIG.EXPL_ACC).filter(e => {
    let vmax = 0;
    for (const p of stream) if (p.ts >= e.ts && p.ts <= e.ts + e.dur) vmax = Math.max(vmax, p.v * 3.6);
    return vmax >= MDP.CONFIG.EXPL_VEL_FIM_KMH;
  });
  conta(expl.map(e => e.ts), 'explosivos');
  conta(esforcosCorrida(stream, HSR_KMH), 'esfHsr');
  conta(esforcosCorrida(stream, SPRINT_KMH), 'esfSprint');

  const dtMed = (() => {
    const d = []; for (let i = 1; i < stream.length && i < 400; i++) d.push(stream[i].ts - stream[i - 1].ts);
    d.sort((a, b) => a - b); return d[Math.floor(d.length / 2)] || 0.1;
  })();

  const linhas = janelas.map(j => {
    const m = j.m, dur = j.fim - j.ini;
    const o = {
      minuto: j.rotulo,
      ini_rel_s: r1(j.ini - bloco.ini), fim_rel_s: r1(j.fim - bloco.ini), duracao_s: r1(dur),
      cobertura_pct: r1(Math.min(100, (m.amostras * dtMed) / dur * 100)),
      dist_m: r1(m.dist),
    };
    for (const b of BANDAS) o['dist_' + b.nome + '_m'] = r1(m['dist' + b.nome]);
    Object.assign(o, {
      hsr_m: r1(m.hsr), sprint_m: r1(m.sprint),
      esforcos_hsr: m.esfHsr, esforcos_sprint: m.esfSprint,
      acel_3: m.acel3, desacel_3: m.decel3, acel_2: m.acel2, desacel_2: m.decel2,
      explosivos_fec: m.explosivos,
      vmax_kmh: r1(m.vmax),
      player_load: pl.inc ? r1(m.pl) : null,
      fc_media: m.hrN ? Math.round(m.hrSoma / m.hrN) : null,
      fc_max: m.hrN ? Math.round(m.hrMax) : null,
      pot_metab_media_wkg: m.mpN ? r2(m.mpSoma / m.mpN) : null,
    });
    return o;
  });

  // total do bloco = soma de tudo (inclui a sobra) → validação contra /stats
  const tot = { dist: 0, pl: 0, hsr: 0, sprint: 0, vmax: 0 };
  for (const j of janelas) { tot.dist += j.m.dist; tot.pl += j.m.pl; tot.hsr += j.m.hsr; tot.sprint += j.m.sprint; tot.vmax = Math.max(tot.vmax, j.m.vmax); }
  return { linhas, tot, plModo: pl.modo, hz: r1(1 / dtMed), leituras: stream.length };
}

// ── 5) /stats oficial do bloco (validação) ───────────────────────────────
const SLUGS_VALIDACAO = [
  'total_distance', 'total_duration', 'total_player_load', 'max_vel',
  'velocity_band5_total_distance', 'velocity_band6_total_distance', 'velocity_band7_total_distance',
];

async function statsDaAtividade(activityId, token) {
  const pedir = (params) => catapult('/stats', token, {
    filters: [{ name: 'activity_id', comparison: '=', values: [activityId] }],
    parameters: params, group_by: ['period', 'athlete'],
  });
  try { return await pedir(SLUGS_VALIDACAO); }
  catch (e) { return pedir(['total_distance', 'total_duration']); }
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
      const calc = calcularBloco(s.pontos, b, ancora);
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
        const v = r.validacao || {};
        const row = {
          ...ident(r.bloco), ancora, ...l,
          val_dist_dif_pct: v.dist ? v.dist.dif_pct : '',
          val_pl_dif_pct: v.player_load ? v.player_load.dif_pct : '',
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
      explosivo: `FEC: aceleração ≥ ${MDP.CONFIG.EXPL_ACC} m/s² chegando a ≥ ${MDP.CONFIG.EXPL_VEL_FIM_KMH} km/h`,
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

// exportado para o teste offline
export { calcularBloco, janelasMinuto, atribuirAtleta, incrementosPL, ehBlocoLesao, esforcosCorrida };
