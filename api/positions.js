// =============================================================================
//  Fortaleza EC — Performance API
//  Endpoint: GET /api/positions
//  Retorna o stream de dados de sensor (GPS 10Hz) de UM atleta numa atividade.
//
//  A conversão GPS→campo e a detecção de esforços acontecem no FRONTEND
//  (módulo campo2d.js). Este endpoint apenas faz a ponte com a Catapult.
//
//  Parâmetros:
//    ?activityId=ABC   (obrigatório, ou periodId)
//    ?periodId=XYZ     (alternativa: stream de um período específico, ex. 1tempo)
//    ?athleteId=123    (obrigatório)
//    ?downsample=N     (opcional: 1 a cada N pontos — alivia jogo inteiro / muitos atletas)
//
//  Resposta:
//    { freqHz, total, pontos: [ { ts, lat, lon, v, a, hdop, hr, pl }, ... ] }
//  v = velocidade em m/s (multiplicar por 3.6 para km/h).
// =============================================================================

const CATAPULT_BASE = 'https://connect-us.catapultsports.com/api/v6';

// Parâmetros de sensor pedidos à Catapult (mesmos do modelo de referência).
const SENSOR_PARAMETERS = 'ts,lat,long,v,rv,a,hr,pl,xy,pq,hdop,ref,o,mp';

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

// Parsing da resposta de sensor: lista → primeiro item com array `data`.
function extrairDadosSensor(responseData) {
  if (!responseData) return [];
  if (Array.isArray(responseData)) {
    for (const item of responseData) {
      if (item && typeof item === 'object' && Array.isArray(item.data)) return item.data;
    }
  }
  return [];
}

function numOrNull(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// =============================================================================
// MAIN HANDLER
// =============================================================================
export default async function handler(req, res) {
  setCORS(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const token = process.env.CATAPULT_TOKEN;
  if (!token) return res.status(500).json({ error: 'CATAPULT_TOKEN não configurado' });

  const { activityId, athleteId, periodId, downsample } = req.query;
  if (!athleteId || (!activityId && !periodId)) {
    return res.status(400).json({
      error: 'Parâmetros obrigatórios: athleteId e (activityId ou periodId)',
    });
  }

  // Path: por atividade (jogo inteiro) ou por período (tempo específico).
  const path = periodId
    ? `/periods/${encodeURIComponent(periodId)}/athletes/${encodeURIComponent(athleteId)}/sensor`
    : `/activities/${encodeURIComponent(activityId)}/athletes/${encodeURIComponent(athleteId)}/sensor`;

  const query = `?parameters=${encodeURIComponent(SENSOR_PARAMETERS)}&nulls=1`;

  try {
    const raw = await catapultGET(`${path}${query}`, token);

    // Extrai e normaliza para o formato consumido pelo campo2d.js.
    // A Catapult usa 'long' para longitude; renomeamos para 'lon'.
    const pontos = extrairDadosSensor(raw).map(p => ({
      ts: numOrNull(p.ts),
      lat: numOrNull(p.lat),
      lon: numOrNull(p.long != null ? p.long : p.lon),
      v: numOrNull(p.v),     // velocidade em m/s
      a: numOrNull(p.a),     // aceleração
      hdop: numOrNull(p.hdop),
      hr: numOrNull(p.hr),
      pl: numOrNull(p.pl),   // player load
    }));

    // Mantém só pontos com GPS válido (lat/lon não nulos).
    const comGps = pontos.filter(p => p.lat != null && p.lon != null);

    // Downsample opcional.
    const ds = parseInt(downsample, 10);
    const saida = ds && ds > 1 ? comGps.filter((_p, i) => i % ds === 0) : comGps;

    if (saida.length === 0) {
      return res.status(200).json({
        warning: 'Nenhum ponto GPS real (lat/lon) encontrado. O sensor pode não ter obtido lock GPS durante a sessão.',
        freqHz: 10,
        total: 0,
        pontos: [],
      });
    }

    return res.status(200).json({
      freqHz: ds && ds > 1 ? 10 / ds : 10,
      total: saida.length,
      pontos: saida,
    });
  } catch (err) {
    console.error('Erro /api/positions:', err);
    return res.status(500).json({ error: err.message });
  }
}
