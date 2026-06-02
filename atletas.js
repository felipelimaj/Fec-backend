// =============================================================================
//  Endpoint: GET /api/atletas
//  Retorna lista de atletas da Catapult com ID do Cadastro extraído do nome
// =============================================================================

const CATAPULT_BASE = 'https://connect-us.catapultsports.com/api/v6';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const token = process.env.CATAPULT_TOKEN;
  if (!token) return res.status(500).json({ error: 'CATAPULT_TOKEN não configurado' });

  try {
    const r = await fetch(`${CATAPULT_BASE}/athletes`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!r.ok) return res.status(r.status).json({ error: `Catapult HTTP ${r.status}` });

    const atletas = await r.json();

    const mapped = atletas
      .filter(a => !a.is_deleted)
      .map(a => {
        const fn = (a.first_name || '').trim();
        let cadastroId = null;
        if (/^\d+$/.test(fn)) cadastroId = parseInt(fn, 10);
        else if (/^F\d+$/.test(fn)) cadastroId = parseInt(fn.slice(1), 10);
        return {
          catapult_id: a.id,
          cadastro_id: cadastroId,
          first_name: fn,
          last_name: a.last_name,
          team_id: a.current_team_id,
          position: a.position_name,
        };
      });

    return res.status(200).json({ count: mapped.length, atletas: mapped });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
