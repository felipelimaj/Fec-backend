// GET /api/gps/sheets?fonte=cadastro | jogos
// Proxy das planilhas publicadas do clube (evita CORS no navegador).
// cadastro → CADASTRO_ATLETAS_PROFISSIONAL_FEC, aba "base"
// jogos    → GRUPOS TAG, aba "Jogos 2026" (contexto: adversário, placar, posse, xG…)
export const config = { maxDuration: 30 };

const FONTES = {
  cadastro: {
    pub: '2PACX-1vT2jaLvln5GbiUoNsczLHRMYt0gHjzDOEar1h9LLuKG-Xa4KJKZr2SS133l0pr8AgetsdYF5Ek2KU7Q',
    gid: '0',
  },
  jogos: {
    pub: '2PACX-1vRH094U7lfAofo3Tn2NWZ0VHx7EACHOEFQaGePCLsP9fXgB4EMjc8cpwbG-4NJMsfA5u-_uaq_mdtjG',
    gid: '629069564',
  },
};

function parseCSV(txt) {
  const linhas = [];
  let linha = [], cur = '', dentro = false;
  for (let i = 0; i < txt.length; i++) {
    const c = txt[i];
    if (c === '"') {
      if (dentro && txt[i + 1] === '"') { cur += '"'; i++; } else dentro = !dentro;
    } else if (c === ',' && !dentro) { linha.push(cur); cur = ''; }
    else if ((c === '\n' || c === '\r') && !dentro) {
      if (c === '\r' && txt[i + 1] === '\n') i++;
      linha.push(cur); linhas.push(linha); linha = []; cur = '';
    } else cur += c;
  }
  if (cur !== '' || linha.length) { linha.push(cur); linhas.push(linha); }
  return linhas.filter(l => l.some(c => c.trim() !== ''));
}

// "1/11/2026" (M/D/YYYY, formato da planilha) → "11/01/2026"
function dataBR(mdy) {
  const m = String(mdy || '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  return `${m[2].padStart(2, '0')}/${m[1].padStart(2, '0')}/${m[3]}`;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  const fonte = FONTES[req.query.fonte];
  if (!fonte) return res.status(400).json({ error: 'fonte deve ser cadastro ou jogos' });
  try {
    const url = `https://docs.google.com/spreadsheets/d/e/${fonte.pub}/pub?gid=${fonte.gid}&single=true&output=csv`;
    const r = await fetch(url, { redirect: 'follow' });
    if (!r.ok) throw new Error(`Sheets ${r.status}`);
    const txt = await r.text();
    if (txt.trim().startsWith('<')) throw new Error('planilha não publicada em CSV');
    const linhas = parseCSV(txt);
    // localiza a linha de cabeçalho (primeira com ≥3 células não vazias)
    const iCab = linhas.findIndex(l => l.filter(c => c.trim()).length >= 3);
    if (iCab < 0) throw new Error('cabeçalho não encontrado');
    const cab = linhas[iCab].map(c => c.trim());
    const rows = linhas.slice(iCab + 1).map(l => {
      const o = {};
      cab.forEach((c, i) => { if (c) o[c] = (l[i] || '').trim(); });
      return o;
    }).filter(o => Object.values(o).some(v => v !== ''));
    if (req.query.fonte === 'jogos') {
      for (const o of rows) if (o['Data']) o['DataBR'] = dataBR(o['Data']);
    }
    res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=3600');
    res.status(200).json({ cab, n: rows.length, rows });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
}
