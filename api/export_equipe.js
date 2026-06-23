// =============================================================================
//  Fortaleza EC — Performance API
//  Endpoint: GET /api/export_equipe        → baixa CSV com FMP COLETIVO por jogo
//            GET /api/export_equipe?discover=1  → confirma os slugs e a amostra
//
//  VERSÃO COLETIVA (por equipe) do estudo do simpósio.
//  Diferença para /api/export (que é atleta × jogo):
//    - Soma o FMP de TODOS os atletas de cada jogo (sem corte de minutos)
//    - Gera UMA linha por jogo
//    - FMP absoluto (min) E relativo (%) para Dynamic e Running
//
//  Amostra: 27 jogos válidos (com xG disponível + SEM atleta expulso).
//  Mecânica de busca: idêntica ao export.js (POST /stats, group_by período+atleta).
// =============================================================================

const CATAPULT_BASE = 'https://connect-us.catapultsports.com/api/v6';

const CONCURRENCY = 5;  // jogos processados em paralelo por vez

// ── Amostra: 27 jogos válidos ─────────────────────────────────────────────────
// Mapa data DD/MM/YYYY → contexto do jogo
// [adversario, campeonato, resultado, xG_FEC, xG_ADV, GF, GC]
const CONTEXTO = {
  '11/01/2026': ['Ferroviário', 'Cearense',         'Empate',  0.89, 0.84, 1, 1],
  '15/01/2026': ['Quixadá',     'Cearense',         'Vitória', 2.97, 0.50, 3, 0],
  '18/01/2026': ['Maracanã',    'Cearense',         'Vitória', 1.05, 0.35, 2, 0],
  '22/01/2026': ['Horizonte',   'Cearense',         'Vitória', 0.06, 0.68, 1, 0],
  '26/01/2026': ['Floresta',    'Cearense',         'Vitória', 1.15, 0.15, 2, 0],
  '31/01/2026': ['Iguatu',      'Cearense',         'Empate',  2.38, 0.33, 1, 1],
  '08/02/2026': ['Ceará',       'Cearense',         'Empate',  0.32, 0.03, 0, 0],
  '14/02/2026': ['Ferroviário', 'Cearense',         'Vitória', 1.00, 1.00, 2, 1],
  '21/02/2026': ['Ferroviário', 'Cearense',         'Vitória', 0.53, 0.95, 1, 0],
  '24/02/2026': ['Maguary',     'Copa do Nordeste', 'Vitória', 1.50, 1.51, 2, 1],
  '01/03/2026': ['Ceará',       'Cearense',         'Empate',  1.85, 0.93, 1, 1],
  '08/03/2026': ['Ceará',       'Cearense',         'Empate',  0.46, 0.94, 0, 0],
  '17/03/2026': ['Nova Iguaçu', 'Copa do Brasil',   'Vitória', 0.31, 0.79, 1, 0],
  '24/03/2026': ['Ferroviário', 'Cearense',         'Vitória', 1.27, 0.44, 2, 0],
  '28/03/2026': ['Imperatriz',  'Copa do Nordeste', 'Vitória', 1.31, 0.62, 2, 1],
  '31/03/2026': ['Cuiabá',      'Série B',          'Empate',  0.35, 0.42, 1, 1],
  '08/04/2026': ['Ceará',       'Copa do Nordeste', 'Derrota', 1.74, 1.81, 1, 2],
  '19/04/2026': ['Criciúma',    'Série B',          'Vitória', 0.60, 0.46, 1, 0],
  '22/04/2026': ['CRB',         'Série B',          'Vitória', 0.46, 0.31, 1, 0],
  '29/04/2026': ['Sport',       'Série B',          'Vitória', 2.19, 0.71, 3, 1],
  '02/05/2026': ['Goiás',       'Série B',          'Vitória', 1.69, 0.85, 2, 0],
  '10/05/2026': ['Avaí',        'Série B',          'Empate',  1.99, 1.24, 2, 2],
  '14/05/2026': ['CRB',         'Copa do Nordeste', 'Empate',  1.29, 0.77, 1, 1],
  '17/05/2026': ['Ceará',       'Série B',          'Derrota', 1.03, 1.56, 0, 1],
  '20/05/2026': ['Sport',       'Série B',          'Derrota', 1.87, 2.05, 1, 2],
  '27/05/2026': ['Sport',       'Série B',          'Vitória', 0.71, 0.43, 1, 0],
  '30/05/2026': ['Athletic',    'Série B',          'Derrota', 0.32, 0.88, 0, 1],
};

const SAMPLE_DATES = Object.keys(CONTEXTO);

// Slugs FMP travados (idênticos ao export.js, confirmados na conta)
const FMP_SLUGS = [
  'fmp_dynamic_total_duration', // FMP Total Dynamic Duration (segundos)
  'fmp_running_total_duration', // FMP Total Running Duration (segundos)
];

// ----------------------------------------------------------------------------
// Helpers (copiados do export.js — exatamente os mesmos)
// ----------------------------------------------------------------------------
function setCORS(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
async function catapultGET(path, token) {
  const r = await fetch(`${CATAPULT_BASE}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`Catapult GET ${path} → HTTP ${r.status}`);
  return r.json();
}
async function catapultPOST(path, token, body) {
  const r = await fetch(`${CATAPULT_BASE}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`Catapult POST ${path} → HTTP ${r.status}`);
  return r.json();
}
function classifyPeriod(name) {
  const n = (name || '').trim().toLowerCase();
  if (n.includes('1tempo')) return 't1';
  if (n.includes('2tempo')) return 't2';
  return null;
}
function brtDayWindow(dateStr) {
  const [d, m, y] = dateStr.split('/').map(Number);
  const midnightBRT = Math.floor(Date.UTC(y, m - 1, d, 3, 0, 0) / 1000);
  return { start: midnightBRT - 6 * 3600, end: midnightBRT + 24 * 3600 + 6 * 3600 };
}
function unixToBrtDate(unixSeconds) {
  const dt = new Date((unixSeconds - 3 * 3600) * 1000);
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  return `${dd}/${mm}/${dt.getUTCFullYear()}`;
}
function parseAthleteName(athleteName) {
  const s = (athleteName || '').trim();
  const m = s.match(/^(F?)(\d+)\s+(.+)$/);
  if (m) return { cadastroId: parseInt(m[2], 10), name: m[3] };
  return { cadastroId: null, name: s };
}
function round(v, d) { const f = Math.pow(10, d); return Math.round((v || 0) * f) / f; }

// ----------------------------------------------------------------------------
// Processa UM jogo: soma o FMP de TODA a equipe (uma linha por jogo)
// ----------------------------------------------------------------------------
async function processGame(date, activities, token, fmpSlugs) {
  const ctx = CONTEXTO[date];
  const [adversario, campeonato, resultado, xgFec, xgAdv, gf, gc] = ctx;

  const base = {
    data: date,
    adversario, campeonato, resultado,
    GF: gf, GC: gc, saldo_gols: gf - gc,
    xG_FEC: xgFec, xG_ADV: xgAdv,
  };

  // Encontra a atividade do jogo (mesma lógica do export.js)
  const game = (activities || []).find(a =>
    unixToBrtDate(a.start_time || a.start) === date &&
    (a.periods || []).some(p => classifyPeriod(p.name) !== null)
  );
  if (!game) {
    return { ...base, jogo_nome: '(jogo não encontrado na Catapult)',
             n_atletas: '', total_player_min: '',
             fmp_dynamic_min: '', fmp_dynamic_pct: '',
             fmp_running_min: '', fmp_running_pct: '' };
  }

  // Mesma chamada POST /stats que já funciona
  const params = ['total_duration', ...fmpSlugs];
  const stats = await catapultPOST('/stats', token, {
    filters: [{ name: 'activity_id', comparison: '=', values: [game.id] }],
    parameters: params,
    group_by: ['period', 'athlete'],
  });

  // Agrega por atleta somando períodos 1tempo + 2tempo
  const byAth = {};
  for (const s of stats) {
    if (!classifyPeriod(s.period_name)) continue;       // ignora aquecimento/suplentes
    const { cadastroId, name } = parseAthleteName(s.athlete_name);
    const key = cadastroId != null ? `id:${cadastroId}` : `nm:${name}`;
    if (!byAth[key]) byAth[key] = { dur: 0, fmp: {} };
    byAth[key].dur += (s.total_duration || 0);
    for (const slug of fmpSlugs) byAth[key].fmp[slug] = (byAth[key].fmp[slug] || 0) + (s[slug] || 0);
  }

  // Soma a EQUIPE (todos os atletas, SEM corte de minutos)
  let dynSec = 0, runSec = 0, durSec = 0, n = 0;
  for (const a of Object.values(byAth)) {
    if (a.dur <= 0) continue;
    durSec += a.dur;
    dynSec += (a.fmp['fmp_dynamic_total_duration'] || 0);
    runSec += (a.fmp['fmp_running_total_duration'] || 0);
    n++;
  }

  if (durSec === 0) {
    return { ...base, jogo_nome: game.name,
             n_atletas: 0, total_player_min: 0,
             fmp_dynamic_min: '', fmp_dynamic_pct: '',
             fmp_running_min: '', fmp_running_pct: '' };
  }

  const durMin = durSec / 60;
  const dynMin = dynSec / 60;
  const runMin = runSec / 60;

  return {
    ...base,
    jogo_nome:        game.name,
    n_atletas:        n,
    total_player_min: round(durMin, 1),
    fmp_dynamic_min:  round(dynMin, 2),
    fmp_dynamic_pct:  round((dynMin / durMin) * 100, 2),
    fmp_running_min:  round(runMin, 2),
    fmp_running_pct:  round((runMin / durMin) * 100, 2),
  };
}

// roda em blocos de CONCURRENCY para não estourar tempo/limites
async function runInChunks(items, size, fn) {
  const results = [];
  for (let i = 0; i < items.length; i += size) {
    const chunk = items.slice(i, i + size);
    const r = await Promise.all(chunk.map(fn));
    results.push(...r);
  }
  return results;
}

// ----------------------------------------------------------------------------
// MAIN
// ----------------------------------------------------------------------------
export default async function handler(req, res) {
  setCORS(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const token = process.env.CATAPULT_TOKEN;
  if (!token) return res.status(500).json({ error: 'CATAPULT_TOKEN não configurado' });

  try {
    const fmpSlugs = FMP_SLUGS;

    // Confirmação rápida (sem rodar os jogos)
    if (req.query.discover) {
      return res.status(200).json({
        slugs_usados: fmpSlugs,
        observacao: 'FMP coletivo: soma de todos os atletas (1tempo+2tempo), sem corte de minutos.',
        n_jogos_validos: SAMPLE_DATES.length,
        criterio: 'Jogos com xG disponível e SEM atleta expulso.',
      });
    }

    // UMA chamada /activities cobrindo toda a temporada
    const all = SAMPLE_DATES.map(d => brtDayWindow(d));
    const start = Math.min(...all.map(w => w.start));
    const end = Math.max(...all.map(w => w.end));
    const activities = await catapultGET(`/activities?start_time=${start}&end_time=${end}`, token);

    // Processa os jogos em blocos paralelos
    const rows = await runInChunks(SAMPLE_DATES, CONCURRENCY, d =>
      processGame(d, activities, token, fmpSlugs).catch(err => {
        const ctx = CONTEXTO[d];
        const [adversario, campeonato, resultado, xgFec, xgAdv, gf, gc] = ctx;
        return {
          data: d, adversario, campeonato, resultado,
          GF: gf, GC: gc, saldo_gols: gf - gc, xG_FEC: xgFec, xG_ADV: xgAdv,
          jogo_nome: `(erro: ${err.message})`,
          n_atletas: '', total_player_min: '',
          fmp_dynamic_min: '', fmp_dynamic_pct: '',
          fmp_running_min: '', fmp_running_pct: '',
        };
      })
    );

    // Ordena por data real (DD/MM/YYYY → YYYYMMDD para comparar)
    rows.sort((a, b) => {
      const pa = a.data.split('/').reverse().join('');
      const pb = b.data.split('/').reverse().join('');
      return pa.localeCompare(pb);
    });

    // Monta CSV (vírgula, decimal ponto, UTF-8 com BOM)
    const headers = [
      'data', 'adversario', 'campeonato', 'resultado',
      'GF', 'GC', 'saldo_gols', 'xG_FEC', 'xG_ADV',
      'n_atletas', 'total_player_min',
      'fmp_dynamic_min', 'fmp_dynamic_pct',
      'fmp_running_min', 'fmp_running_pct',
      'jogo_nome',
    ];
    const esc = v => {
      if (v == null) return '';
      const s = String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [headers.join(',')];
    for (const r of rows) lines.push(headers.map(h => esc(r[h])).join(','));
    const csv = '\uFEFF' + lines.join('\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="fmp_equipe_por_jogo.csv"');
    return res.status(200).send(csv);
  } catch (err) {
    console.error('export_equipe:', err);
    return res.status(500).json({ error: err.message });
  }
}
