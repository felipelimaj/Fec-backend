// GET /api/gps/sensor?activity=ID&athlete=ID[&period=ID][&each=2][&q=1]
// Stream 10 Hz do sensor (ts, lat, long, v, a, hr) em formato "slim" (arrays
// paralelos) com decimação — reduz o payload de ~8 MB para ~1 MB por atleta.
// each=1 → 10 Hz | each=2 → 5 Hz (padrão) | each=5 → 2 Hz
//
// q=1 acrescenta os campos de qualidade de sinal da Catapult:
//   hdop → horizontal dilution of precision (menor = melhor; > ~2,5 é suspeito)
//   pq   → positional quality em %
//   ref  → nº de satélites/referências no fix
// Custa ~30% de payload, por isso é opcional. Sem q=1 a resposta é idêntica
// à de antes — o gps2d.html em produção não muda.
export const config = { maxDuration: 60 };

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

const r7 = x => (x == null ? null : Math.round(x * 1e7) / 1e7);
const r2 = x => (x == null ? null : Math.round(x * 100) / 100);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  const { activity, athlete, period } = req.query;
  const each = Math.max(1, parseInt(req.query.each || '2', 10));
  if (!athlete || (!activity && !period))
    return res.status(400).json({ error: 'Parâmetros: athlete + (activity ou period)' });
  try {
    const path = period
      ? `periods/${period}/athletes/${athlete}/sensor`
      : `activities/${activity}/athletes/${athlete}/sensor`;
    const q = req.query.q === '1' || req.query.q === 'true';
    const params = q ? 'ts,lat,long,v,a,hr,hdop,pq,ref' : 'ts,lat,long,v,a,hr';
    const raw = await cat(path, { parameters: params, nulls: '1' });

    // Normaliza: v6 devolve [{athlete_id, data:[{ts,lat,long,v,a,hr},...]}]
    let samples = [];
    if (Array.isArray(raw)) {
      samples = (raw[0] && Array.isArray(raw[0].data)) ? raw.flatMap(b => b.data || []) : raw;
    } else if (raw && Array.isArray(raw.data)) {
      samples = raw.data;
    }

    const out = { n: 0, each, ts: [], lat: [], lon: [], v: [], a: [], hr: [] };
    if (q) { out.hdop = []; out.pq = []; out.ref = []; }
    for (let i = 0; i < samples.length; i += each) {
      const s = samples[i];
      if (!s) continue;
      const la = s.lat, lo = s.long != null ? s.long : s.lon;
      if (la == null || lo == null || (la === 0 && lo === 0)) continue; // sem fix GPS
      out.ts.push(s.ts);
      out.lat.push(r7(la));
      out.lon.push(r7(lo));
      out.v.push(r2(s.v));       // m/s
      out.a.push(r2(s.a));       // m/s²
      out.hr.push(s.hr == null ? null : Math.round(s.hr));
      if (q) {
        out.hdop.push(s.hdop == null ? null : Math.round(s.hdop * 10) / 10);
        out.pq.push(s.pq == null ? null : Math.round(s.pq));
        out.ref.push(s.ref == null ? null : Math.round(s.ref));
      }
    }
    out.n = out.ts.length;
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
    res.status(200).json(out);
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
}
