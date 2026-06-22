// =============================================================================
//  Fortaleza EC — Performance API
//  Endpoint: GET /api/export        → baixa CSV com os dados do estudo FMP
//            GET /api/export?discover=1  → mostra os parâmetros FMP descobertos
//
//  Extração atleta × jogo para análise estatística.
//  Bandas: Total Dynamic e Total Running (tempo total + % do tempo de jogo).
//  Inclui: minutos jogados (covariável) por atleta.
//  Filtro: apenas atletas com (1tempo + 2tempo) > 75 min.
//  Amostra: as 40 datas da planilha Jogos_Simpo_sio.xlsx (lista abaixo).
// =============================================================================

const CATAPULT_BASE = 'https://connect-us.catapultsports.com/api/v6';

// As 40 datas da amostra (planilha do simpósio), formato DD/MM/YYYY
const SAMPLE_DATES = [
  '11/01/2026','15/01/2026','18/01/2026','22/01/2026','26/01/2026','31/01/2026',
  '08/02/2026','14/02/2026','21/02/2026','24/02/2026','01/03/2026','08/03/2026',
  '11/03/2026','17/03/2026','21/03/2026','24/03/2026','28/03/2026','31/03/2026',
  '04/04/2026','08/04/2026','12/04/2026','16/04/2026','19/04/2026','22/04/2026',
  '26/04/2026','29/04/2026','02/05/2026','07/05/2026','10/05/2026','14/05/2026',
  '17/05/2026','20/05/2026','23/05/2026','27/05/2026','30/05/2026','02/06/2026',
  '06/06/2026','09/06/2026','16/06/2026','21/06/2026',
];

const MIN_MINUTES = 75;        // corte de minutos jogados
const CONCURRENCY = 5;         // jogos processados em paralelo por vez

// ----------------------------------------------------------------------------
// Helpers (mesmos do match.js)
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
// Descoberta dos parâmetros FMP no catálogo da conta
// ----------------------------------------------------------------------------
// Tenta achar um campo "slug" no objeto do parâmetro (a forma exata varia por tenant)
function paramSlug(p) {
  return p.slug || p.parameter || p.name || p.id || p.key || p.parameter_slug || null;
}
function paramLabel(p) {
  return p.display_name || p.name || p.title || p.label || paramSlug(p) || '';
}
// Seleciona parâmetros de DURAÇÃO ligados a Dynamic/Running
function pickFmpDurationParams(catalog) {
  const out = [];
  for (const p of catalog || []) {
    const blob = JSON.stringify(p).toLowerCase();
    const isFmp = blob.includes('dynamic') || blob.includes('running');
    const isDuration = blob.includes('dur') || blob.includes('time') || blob.includes('second');
    const slug = paramSlug(p);
    if (isFmp && isDuration && slug) out.push({ slug, label: paramLabel(p) });
  }
  return out;
}

// ----------------------------------------------------------------------------
// Processa UM jogo: retorna linhas (atleta × jogo) já filtradas por minutos
// ----------------------------------------------------------------------------
async function processGame(date, activities, token, fmpSlugs) {
  const game = (activities || []).find(a =>
    unixToBrtDate(a.start_time || a.start) === date &&
    (a.periods || []).some(p => classifyPeriod(p.name) !== null)
  );
  if (!game) return [{ data: date, jogo_nome: '(jogo não encontrado na Catapult)', _missing: true }];

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
    if (!byAth[key]) byAth[key] = { cadastroId, name, dur: 0, fmp: {} };
    byAth[key].dur += (s.total_duration || 0);
    for (const slug of fmpSlugs) byAth[key].fmp[slug] = (byAth[key].fmp[slug] || 0) + (s[slug] || 0);
  }

  const rows = [];
  for (const a of Object.values(byAth)) {
    const minJogados = a.dur / 60;
    if (minJogados <= MIN_MINUTES) continue;            // corte > 75 min
    const row = {
      data: date,
      jogo_nome: game.name,
      atleta_id: a.cadastroId,
      atleta_nome: a.name,
      min_jogados: round(minJogados, 1),
    };
    for (const slug of fmpSlugs) {
      const min = (a.fmp[slug] || 0) / 60;
      row[`${slug}__min`] = round(min, 2);
      row[`${slug}__pct`] = round(minJogados > 0 ? (min / minJogados) * 100 : 0, 2);
    }
    rows.push(row);
  }
  return rows;
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
    // 1. Catálogo de parâmetros → descobre os slugs FMP
    let catalog = [];
    try {
      const cat = await catapultGET('/parameters', token);
      catalog = Array.isArray(cat) ? cat : (cat.data || cat.parameters || []);
    } catch (e) {
      catalog = [{ _erro_parameters: e.message }];
    }
    const fmp = pickFmpDurationParams(catalog);
    const fmpSlugs = fmp.map(f => f.slug);

    // MODO DESCOBERTA: só mostra o que foi encontrado, para conferência
    if (req.query.discover) {
      const todosDynRun = (catalog || []).filter(p => {
        const b = JSON.stringify(p).toLowerCase();
        return b.includes('dynamic') || b.includes('running');
      });
      return res.status(200).json({
        total_parametros_no_catalogo: catalog.length,
        amostra_bruta_catalogo: catalog.slice(0, 3),       // mostra a forma do objeto
        candidatos_dynamic_running: todosDynRun,           // todos os params Dynamic/Running
        selecionados_para_extracao_duracao: fmp,           // os que a extração usaria
      });
    }

    if (!fmpSlugs.length) {
      return res.status(500).json({
        error: 'Nenhum parâmetro FMP de duração (Dynamic/Running) encontrado no catálogo.',
        dica: 'Rode /api/export?discover=1 para inspecionar o catálogo e me envie o resultado.',
      });
    }

    // 2. UMA chamada /activities cobrindo toda a temporada (evita 40 chamadas)
    const all = SAMPLE_DATES.map(d => brtDayWindow(d));
    const start = Math.min(...all.map(w => w.start));
    const end = Math.max(...all.map(w => w.end));
    const activities = await catapultGET(`/activities?start_time=${start}&end_time=${end}`, token);

    // 3. Processa os 40 jogos (em blocos paralelos)
    const nested = await runInChunks(SAMPLE_DATES, CONCURRENCY, d =>
      processGame(d, activities, token, fmpSlugs).catch(err => [{ data: d, jogo_nome: `(erro: ${err.message})`, _missing: true }])
    );
    const rows = nested.flat();

    // 4. Monta CSV (separador vírgula, decimal ponto, UTF-8 com BOM)
    const headers = ['data', 'jogo_nome', 'atleta_id', 'atleta_nome', 'min_jogados'];
    for (const slug of fmpSlugs) { headers.push(`${slug}__min`, `${slug}__pct`); }
    const esc = v => {
      if (v == null) return '';
      const s = String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [headers.join(',')];
    for (const r of rows) lines.push(headers.map(h => esc(r[h])).join(','));
    const csv = '\uFEFF' + lines.join('\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="export_fmp_fec.csv"');
    return res.status(200).send(csv);
  } catch (err) {
    console.error('export:', err);
    return res.status(500).json({ error: err.message });
  }
}
