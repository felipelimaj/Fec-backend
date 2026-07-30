// GET /api/gps/periods?activity=ID — períodos (1º tempo, 2º tempo, blocos)
const BASE = process.env.CATAPULT_BASE || 'https://connect-us.catapultsports.com/api/v6';

async function cat(path, params) {
  const url = new URL(`${BASE}/${path}`);
  for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, v);
  let delay = 500;
  for (let i = 0; i < 4; i++) {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${process.env.CATAPULT_TOKEN}` } });
    if ([429, 500, 502, 503, 504].includes(r.status) && i < 3) {
      await new Promise(s => setTimeout(s, delay)); delay *= 2; continue;
    }
    if (!r.ok) throw new Error(`Catapult ${r.status} em /${path}`);
    return r.json();
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  const activity = req.query.activity;
  if (!activity) return res.status(400).json({ error: 'Parâmetro obrigatório: activity' });
  try {
    const data = await cat(`activities/${activity}/periods`);
    const list = (Array.isArray(data) ? data : []).map(p => ({
      id: p.id,
      name: p.name,
      start_time: p.start_time,
      end_time: p.end_time,
    })).sort((x, y) => (x.start_time || 0) - (y.start_time || 0));
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
    res.status(200).json(list);
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
}
