// ============================================================================
// api/export_equipe.js — Exportação de FMP COLETIVO (por equipe) por jogo
// ----------------------------------------------------------------------------
// Estudo do simpósio — versão coletiva.
//
// Diferença para o /api/export (que era por atleta):
//   - Aqui somamos o FMP de TODOS os atletas de cada jogo (sem filtro de min)
//   - Geramos UMA linha por jogo (não uma por atleta)
//   - Calculamos FMP em valor absoluto (min) E relativo (%) para Dynamic e Running
//
// Amostra: 27 jogos válidos (com xG disponível + SEM atleta expulso).
//
// USO (no navegador, já autenticado pelo token do servidor):
//   https://fec-backend-sigma.vercel.app/api/export_equipe
//   → baixa fmp_equipe_por_jogo.csv automaticamente
//
//   https://fec-backend-sigma.vercel.app/api/export_equipe?discover=1
//   → modo diagnóstico: lista o catálogo de parâmetros (não baixa CSV)
//
// Variáveis de ambiente (já configuradas no Vercel):
//   CATAPULT_TOKEN     — token Bearer da conta
//   CATAPULT_BASE_URL  — opcional; default abaixo
// ============================================================================

const DEFAULT_BASE_URL = 'https://connect-us.catapultsports.com/api/v6';
const CONCURRENCY = 5;  // jogos processados em paralelo por bloco

// ── Amostra: 27 jogos válidos ─────────────────────────────────────────────────
// [data_iso, adversario, campeonato, resultado, xG_FEC, xG_ADV, GF, GC]
// GF/GC = gols feitos / gols tomados pelo FEC
const JOGOS = [
  ['2026-01-11', 'Ferroviário', 'Cearense',         'Empate',  0.89, 0.84, 1, 1],
  ['2026-01-15', 'Quixadá',     'Cearense',         'Vitória', 2.97, 0.50, 3, 0],
  ['2026-01-18', 'Maracanã',    'Cearense',         'Vitória', 1.05, 0.35, 2, 0],
  ['2026-01-22', 'Horizonte',   'Cearense',         'Vitória', 0.06, 0.68, 1, 0],
  ['2026-01-26', 'Floresta',    'Cearense',         'Vitória', 1.15, 0.15, 2, 0],
  ['2026-01-31', 'Iguatu',      'Cearense',         'Empate',  2.38, 0.33, 1, 1],
  ['2026-02-08', 'Ceará',       'Cearense',         'Empate',  0.32, 0.03, 0, 0],
  ['2026-02-14', 'Ferroviário', 'Cearense',         'Vitória', 1.00, 1.00, 2, 1],
  ['2026-02-21', 'Ferroviário', 'Cearense',         'Vitória', 0.53, 0.95, 1, 0],
  ['2026-02-24', 'Maguary',     'Copa do Nordeste', 'Vitória', 1.50, 1.51, 2, 1],
  ['2026-03-01', 'Ceará',       'Cearense',         'Empate',  1.85, 0.93, 1, 1],
  ['2026-03-08', 'Ceará',       'Cearense',         'Empate',  0.46, 0.94, 0, 0],
  ['2026-03-17', 'Nova Iguaçu', 'Copa do Brasil',   'Vitória', 0.31, 0.79, 1, 0],
  ['2026-03-24', 'Ferroviário', 'Cearense',         'Vitória', 1.27, 0.44, 2, 0],
  ['2026-03-28', 'Imperatriz',  'Copa do Nordeste', 'Vitória', 1.31, 0.62, 2, 1],
  ['2026-03-31', 'Cuiabá',      'Série B',          'Empate',  0.35, 0.42, 1, 1],
  ['2026-04-08', 'Ceará',       'Copa do Nordeste', 'Derrota', 1.74, 1.81, 1, 2],
  ['2026-04-19', 'Criciúma',    'Série B',          'Vitória', 0.60, 0.46, 1, 0],
  ['2026-04-22', 'CRB',         'Série B',          'Vitória', 0.46, 0.31, 1, 0],
  ['2026-04-29', 'Sport',       'Série B',          'Vitória', 2.19, 0.71, 3, 1],
  ['2026-05-02', 'Goiás',       'Série B',          'Vitória', 1.69, 0.85, 2, 0],
  ['2026-05-10', 'Avaí',        'Série B',          'Empate',  1.99, 1.24, 2, 2],
  ['2026-05-14', 'CRB',         'Copa do Nordeste', 'Empate',  1.29, 0.77, 1, 1],
  ['2026-05-17', 'Ceará',       'Série B',          'Derrota', 1.03, 1.56, 0, 1],
  ['2026-05-20', 'Sport',       'Série B',          'Derrota', 1.87, 2.05, 1, 2],
  ['2026-05-27', 'Sport',       'Série B',          'Vitória', 0.71, 0.43, 1, 0],
  ['2026-05-30', 'Athletic',    'Série B',          'Derrota', 0.32, 0.88, 0, 1],
];

// ── Janela BRT → UTC (mesma lógica do export.js, ±6h de buffer) ───────────────
function brtDayWindow(dateISO) {
  const [y, m, d] = dateISO.split('-').map(Number);
  const start = Math.floor(Date.UTC(y, m - 1, d - 1, 18, 0, 0) / 1000);
  const end   = Math.floor(Date.UTC(y, m - 1, d + 1, 6,  0, 0) / 1000);
  return { start, end };
}

// ── Cliente HTTP Catapult ──────────────────────────────────────────────────────
async function catapultGET(path, token, baseUrl) {
  const res = await fetch(`${baseUrl}${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} em ${path} — ${body.slice(0, 120)}`);
  }
  return res.json();
}

// ── Executa promessas em blocos limitados (evita estourar a API) ─────────────
async function runInChunks(items, size, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += size) {
    const chunk = items.slice(i, i + size);
    out.push(...await Promise.all(chunk.map(fn)));
  }
  return out;
}

// ── Descobre os slugs de FMP no catálogo ──────────────────────────────────────
async function discoverFmpSlugs(activityId, token, baseUrl) {
  const params = await catapultGET(`/activities/${activityId}/parameters`, token, baseUrl);
  const find = (mustHave) => {
    const hit = params.find(p => {
      const n = (p.name || '').toLowerCase();
      return mustHave.every(w => n.includes(w));
    });
    return hit ? hit.slug : null;
  };
  const dynSlug = find(['fmp', 'dynamic', 'duration']);
  const runSlug = find(['fmp', 'running', 'duration']);
  return { dynSlug, runSlug, catalog: params };
}

// ── Processa um jogo: encontra atividade, soma FMP da equipe ─────────────────
async function processGame(jogo, activities, token, baseUrl, slugs) {
  const [dateISO, adversario, campeonato, resultado, xgFec, xgAdv, gf, gc] = jogo;
  const { dynSlug, runSlug } = slugs;
  const { start, end } = brtDayWindow(dateISO);

  // Filtra atividades dentro da janela do jogo, com 1tempo+2tempo
  const dayActs = activities.filter(act => {
    const t = act.start_time || act.startTime || 0;
    if (t < start || t > end) return false;
    const periods = (act.periods || []).map(p => (p.name || '').toLowerCase());
    const has1 = periods.some(p => p.includes('1tempo') || p.includes('1 tempo'));
    const has2 = periods.some(p => p.includes('2tempo') || p.includes('2 tempo'));
    return has1 && has2;
  });

  const base = {
    data_iso: dateISO, adversario, campeonato, resultado,
    xG_FEC: xgFec, xG_ADV: xgAdv, GF: gf, GC: gc,
    saldo_gols: gf - gc,
  };

  if (dayActs.length === 0) {
    return { ...base, n_atletas: '', fmp_dynamic_min: '', fmp_dynamic_pct: '',
             fmp_running_min: '', fmp_running_pct: '', total_player_min: '',
             activity_name: '(jogo não encontrado)' };
  }

  const activity = dayActs[0];

  // Busca todos os atletas com os parâmetros FMP + duração
  const athletes = await catapultGET(
    `/activities/${activity.id}/athletes?parameters=${dynSlug},${runSlug},total_duration`,
    token, baseUrl
  );

  // Agrega a equipe
  let dynMin = 0, runMin = 0, gameMin = 0, n = 0;
  for (const ath of (athletes || [])) {
    const p = ath.parameters || {};
    const dur = Number(p['total_duration'] ?? 0);
    if (dur <= 0) continue;
    dynMin  += Number(p[dynSlug] ?? 0);
    runMin  += Number(p[runSlug] ?? 0);
    gameMin += dur;
    n++;
  }

  if (gameMin === 0) {
    return { ...base, n_atletas: 0, fmp_dynamic_min: '', fmp_dynamic_pct: '',
             fmp_running_min: '', fmp_running_pct: '', total_player_min: 0,
             activity_name: activity.name || '' };
  }

  return {
    ...base,
    n_atletas:        n,
    total_player_min: +gameMin.toFixed(2),
    fmp_dynamic_min:  +dynMin.toFixed(2),
    fmp_dynamic_pct:  +((dynMin / gameMin) * 100).toFixed(2),
    fmp_running_min:  +runMin.toFixed(2),
    fmp_running_pct:  +((runMin / gameMin) * 100).toFixed(2),
    activity_name:    activity.name || '',
  };
}

// ── Handler principal ──────────────────────────────────────────────────────────
export default async function handler(req, res) {
  try {
    const token   = process.env.CATAPULT_TOKEN;
    const baseUrl = process.env.CATAPULT_BASE_URL || DEFAULT_BASE_URL;

    if (!token) {
      return res.status(500).json({ error: 'CATAPULT_TOKEN não configurado no servidor' });
    }

    // Janela cobrindo toda a temporada (1 só chamada de /activities)
    const windows = JOGOS.map(j => brtDayWindow(j[0]));
    const start = Math.min(...windows.map(w => w.start));
    const end   = Math.max(...windows.map(w => w.end));
    const activities = await catapultGET(`/activities?start_time=${start}&end_time=${end}`, token, baseUrl);

    // Descobre slugs FMP a partir da primeira atividade disponível
    let slugs = { dynSlug: null, runSlug: null };
    for (const act of activities) {
      const found = await discoverFmpSlugs(act.id, token, baseUrl);
      if (found.dynSlug && found.runSlug) {
        slugs = found;
        break;
      }
    }

    // Modo diagnóstico
    if (req.query && req.query.discover) {
      return res.status(200).json({
        slugs_encontrados: slugs,
        total_atividades: activities.length,
        dica: 'Se os slugs vierem null, me envie este JSON para ajustarmos a busca.',
      });
    }

    if (!slugs.dynSlug || !slugs.runSlug) {
      return res.status(500).json({
        error: 'Slugs de FMP não encontrados',
        dica: 'Rode /api/export_equipe?discover=1 e me envie o resultado.',
      });
    }

    // Processa os 27 jogos em blocos paralelos
    const rows = await runInChunks(JOGOS, CONCURRENCY, jogo =>
      processGame(jogo, activities, token, baseUrl, slugs)
        .catch(err => {
          const [dateISO, adversario, campeonato, resultado, xgFec, xgAdv, gf, gc] = jogo;
          return {
            data_iso: dateISO, adversario, campeonato, resultado,
            xG_FEC: xgFec, xG_ADV: xgAdv, GF: gf, GC: gc, saldo_gols: gf - gc,
            n_atletas: '', total_player_min: '',
            fmp_dynamic_min: '', fmp_dynamic_pct: '',
            fmp_running_min: '', fmp_running_pct: '',
            activity_name: `(erro: ${err.message})`,
          };
        })
    );

    // Ordena por data
    rows.sort((a, b) => a.data_iso.localeCompare(b.data_iso));

    // Monta CSV (vírgula, decimal ponto, UTF-8 com BOM para abrir certo no Excel)
    const headers = [
      'data_iso', 'adversario', 'campeonato', 'resultado',
      'GF', 'GC', 'saldo_gols', 'xG_FEC', 'xG_ADV',
      'n_atletas', 'total_player_min',
      'fmp_dynamic_min', 'fmp_dynamic_pct',
      'fmp_running_min', 'fmp_running_pct',
      'activity_name',
    ];
    const esc = (v) => {
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
