// GET /api/gps/stats?activity=ID — estatísticas agregadas (POST /stats Catapult)
// agrupadas por período + atleta, com slugs do tenant FEC (bandas, Gen2, FMP).
// Bandas do tenant na API: band5=14,4–19,8 | band6=19,8–25,2 | band7=≥25,2
// → HSR = band6+band7 · Sprint = band7 (equivale a B5+B6+B7 e B6+B7 da UI).
export const config = { maxDuration: 60 };

const BASE = process.env.CATAPULT_BASE || 'https://connect-us.catapultsports.com/api/v6';

const PARAMS = [
  'total_distance', 'total_duration', 'max_vel',
  'velocity_band6_total_distance', 'velocity_band7_total_distance',
  'gen2_acceleration_band7plus_total_effort_count',
  'gen2_acceleration_band1_total_effort_count',
  'gen2_acceleration_band2_total_effort_count',
  'mean_heart_rate', 'total_player_load',
  'fmp_dynamic_total_duration', 'fmp_dynamic_med_duration', 'fmp_dynamic_high_duration',
  'fmp_running_total_duration', 'fmp_running_med_duration', 'fmp_running_high_duration',
];

// Métrica personalizada do tenant: "Esforços Explosivos 2" — slug resolvido
// dinamicamente via GET /parameters (cacheado entre invocações da função).
let _explosivosSlug;   // undefined = ainda não buscado · null = não existe no tenant
async function slugExplosivos() {
  if (_explosivosSlug !== undefined) return _explosivosSlug;
  try {
    const r = await fetch(`${BASE}/parameters`, {
      headers: { Authorization: `Bearer ${process.env.CATAPULT_TOKEN}` } });
    const ps = r.ok ? await r.json() : [];
    const alvo = (Array.isArray(ps) ? ps : []).find(p =>
      /esfor\S*\s*explos/i.test(p.name || '') && /2/.test(p.name || ''));
    _explosivosSlug = alvo ? alvo.slug : null;
  } catch (e) { _explosivosSlug = null; }
  return _explosivosSlug;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  const activity = req.query.activity;
  if (!activity) return res.status(400).json({ error: 'Parâmetro obrigatório: activity' });
  try {
    const exSlug = await slugExplosivos();
    const params = exSlug ? [...PARAMS, exSlug] : PARAMS;
    let delay = 500, r = null;
    for (let i = 0; i < 4; i++) {
      r = await fetch(`${BASE}/stats`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.CATAPULT_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          filters: [{ name: 'activity_id', comparison: '=', values: [activity] }],
          parameters: params,
          group_by: ['period', 'athlete'],
        }),
      });
      if ([429, 500, 502, 503, 504].includes(r.status) && i < 3) {
        await new Promise(s => setTimeout(s, delay)); delay *= 2; continue;
      }
      break;
    }
    if (!r.ok) throw new Error(`Catapult ${r.status} em POST /stats`);
    const data = await r.json();
    const rows = (Array.isArray(data) ? data : []).map(x => {
      const o = {
        athlete_id: x.athlete_id, athlete_name: x.athlete_name,
        period_id: x.period_id, period_name: x.period_name,
      };
      for (const p of PARAMS) o[p] = x[p] != null ? Math.round(x[p] * 100) / 100 : null;
      if (exSlug) o.explosivos2 = x[exSlug] != null ? Math.round(x[exSlug] * 100) / 100 : null;
      return o;
    });
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
    res.status(200).json(rows);
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
}
