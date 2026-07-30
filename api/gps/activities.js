// GET /api/gps/activities — lista de atividades (jogos/treinos) da Catapult
// Token fixo via env CATAPULT_TOKEN (já configurado no projeto Vercel).
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
  try {
    const data = await cat('activities', { page_size: '500' });
    const list = (Array.isArray(data) ? data : []).map(a => ({
      id: a.id,
      name: a.name,
      start_time: a.start_time,
      end_time: a.end_time,
      tags: a.tags || a.tag_list || [],
    })).sort((x, y) => (y.start_time || 0) - (x.start_time || 0));
    const limit = parseInt(req.query.limit || '0', 10);
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
    res.status(200).json(limit > 0 ? list.slice(0, limit) : list);
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
}
