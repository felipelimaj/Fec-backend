// =============================================================================
//  Fortaleza EC — Performance API
//  Endpoint: GET /api/games
//  Retorna a lista de TODOS os jogos disponíveis na Catapult Connect API.
//  Um "jogo" é uma atividade que tem pelo menos um período "1tempo" ou "2tempo".
//
//  Parâmetros opcionais:
//    ?from=DD/MM/YYYY   data inicial da varredura (default: 01/01/2024)
//    ?to=DD/MM/YYYY     data final da varredura  (default: hoje)
//
//  Resposta:
//    {
//      from, to, total,
//      games: [ { date, id, name, adv, hasT1, hasT2, periodCount }, ... ]
//    }
//  Ordenado da data mais recente para a mais antiga.
// =============================================================================

const CATAPULT_BASE = 'https://connect-us.catapultsports.com/api/v6';

// Janela máxima por chamada à Catapult, em dias.
// A API limita o tamanho do intervalo; varremos em blocos deste tamanho.
const CHUNK_DAYS = 60;

// CORS — permite que o dashboard chame esta API do navegador
function setCORS(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

async function catapultGET(path, token) {
  const r = await fetch(`${CATAPULT_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new Error(`Catapult GET ${path} → HTTP ${r.status}`);
  return r.json();
}

// Identifica se um período pertence ao 1° ou 2° tempo (mesma regra do match.js)
function classifyPeriod(name) {
  const n = (name || '').trim();
  if (n.startsWith('1tempo')) return 't1';
  if (n.startsWith('2tempo')) return 't2';
  return null;
}

// "DD/MM/YYYY 00:00 BRT" → timestamp Unix (UTC). BRT = UTC-3.
function brtMidnightToUnix(y, m, d) {
  return Math.floor(Date.UTC(y, m - 1, d, 3, 0, 0) / 1000);
}

// Converte um timestamp de início de atividade (Unix, UTC) na data BRT "DD/MM/YYYY"
function unixToBrtDate(unixSeconds) {
  // BRT = UTC-3, então subtraímos 3h antes de extrair a data
  const dt = new Date((unixSeconds - 3 * 3600) * 1000);
  const d = String(dt.getUTCDate()).padStart(2, '0');
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const y = dt.getUTCFullYear();
  return `${d}/${m}/${y}`;
}

// Parse de "DD/MM/YYYY" → {y, m, d}. Retorna null se inválido.
function parseDateBR(s) {
  const parts = (s || '').split('/').map(Number);
  if (parts.length !== 3 || parts.some(isNaN)) return null;
  const [d, m, y] = parts;
  return { y, m, d };
}

// Gera os blocos [start,end] em Unix cobrindo de fromUnix até toUnix
function buildChunks(fromUnix, toUnix) {
  const chunks = [];
  const chunkSec = CHUNK_DAYS * 24 * 3600;
  let s = fromUnix;
  while (s < toUnix) {
    const e = Math.min(s + chunkSec - 1, toUnix);
    chunks.push({ start: s, end: e });
    s = e + 1;
  }
  return chunks;
}

// Tenta extrair o nome do adversário a partir do nome da atividade.
// Os nomes na Catapult variam, então isto é um "melhor esforço": devolve
// o nome cru da atividade se não conseguir limpar nada.
function guessOpponent(activityName) {
  return (activityName || '').trim();
}

// =============================================================================
// MAIN HANDLER
// =============================================================================
export default async function handler(req, res) {
  setCORS(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const token = process.env.CATAPULT_TOKEN;
  if (!token) return res.status(500).json({ error: 'CATAPULT_TOKEN não configurado' });

  // Intervalo de varredura (com defaults)
  const fromParsed = parseDateBR(req.query.from) || { y: 2024, m: 1, d: 1 };
  let toParsed = parseDateBR(req.query.to);
  if (!toParsed) {
    const now = new Date();
    // "hoje" em BRT: somamos 1 dia para incluir jogos de hoje por inteiro
    const brtNow = new Date(now.getTime() - 3 * 3600 * 1000);
    toParsed = {
      y: brtNow.getUTCFullYear(),
      m: brtNow.getUTCMonth() + 1,
      d: brtNow.getUTCDate() + 1,
    };
  }

  const fromUnix = brtMidnightToUnix(fromParsed.y, fromParsed.m, fromParsed.d);
  const toUnix = brtMidnightToUnix(toParsed.y, toParsed.m, toParsed.d);

  if (toUnix <= fromUnix) {
    return res.status(400).json({ error: 'Intervalo inválido: ?to deve ser depois de ?from' });
  }

  try {
    const chunks = buildChunks(fromUnix, toUnix);

    // Busca cada bloco em paralelo
    const results = await Promise.all(
      chunks.map(c =>
        catapultGET(`/activities?start_time=${c.start}&end_time=${c.end}`, token)
      )
    );

    // Junta todas as atividades e remove duplicatas por id
    const seen = new Set();
    const allActivities = [];
    for (const list of results) {
      for (const a of list || []) {
        if (a && a.id != null && !seen.has(a.id)) {
          seen.add(a.id);
          allActivities.push(a);
        }
      }
    }

    // Filtra só os jogos (têm período 1tempo ou 2tempo) e monta a saída enxuta
    const games = [];
    for (const a of allActivities) {
      const periods = a.periods || [];
      const halves = periods.map(p => classifyPeriod(p.name)).filter(Boolean);
      if (halves.length === 0) continue; // não é jogo → ignora

      // start_time da atividade define a data do jogo
      const startUnix = a.start_time || a.start || null;
      const date = startUnix ? unixToBrtDate(startUnix) : null;

      games.push({
        date,
        id: a.id,
        name: a.name || '',
        adv: guessOpponent(a.name),
        hasT1: halves.includes('t1'),
        hasT2: halves.includes('t2'),
        periodCount: periods.length,
        start_time: startUnix,
      });
    }

    // Ordena do mais recente para o mais antigo
    games.sort((x, y) => (y.start_time || 0) - (x.start_time || 0));

    return res.status(200).json({
      from: `${String(fromParsed.d).padStart(2, '0')}/${String(fromParsed.m).padStart(2, '0')}/${fromParsed.y}`,
      to: `${String(toParsed.d).padStart(2, '0')}/${String(toParsed.m).padStart(2, '0')}/${toParsed.y}`,
      chunks: chunks.length,
      total: games.length,
      games,
    });
  } catch (err) {
    console.error('Erro /api/games:', err);
    return res.status(500).json({ error: err.message });
  }
}
