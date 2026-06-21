// =============================================================================
//  Fortaleza EC — Performance API
//  Endpoint: GET /api/match?date=DD/MM/YYYY
//  Retorna o relatório de jogo daquela data, com dados da Catapult Connect API
// =============================================================================

const CATAPULT_BASE = 'https://connect-us.catapultsports.com/api/v6';

// Parâmetros que vamos pedir à Catapult em cada chamada /stats
const PARAMETERS = [
  'total_distance',
  'total_duration',
  'max_vel',
  'velocity_band5_total_distance',
  'velocity_band6_total_distance',
  'velocity_band7_total_distance',
  'gen2_acceleration_band7plus_total_effort_count', // = Acel B2-3 (já somado pela Catapult)
  'gen2_acceleration_band1_total_effort_count',     // = Decel B3 (severa)
  'gen2_acceleration_band2_total_effort_count',     // = Decel B2 (média)
  'total_player_load',
  'player_load_per_minute',
  'meterage_per_minute',
  'percentage_max_heart_rate',
  'percentage_avg_heart_rate',
  'mean_heart_rate',
  'explosive_efforts_gk',
  'sprint_efforts',
];

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

async function catapultPOST(path, token, body) {
  const r = await fetch(`${CATAPULT_BASE}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`Catapult POST ${path} → HTTP ${r.status}`);
  return r.json();
}

// Converte "27/05/2026" em timestamps Unix do dia inteiro
function dateToUnixRange(dateStr) {
  const [d, m, y] = dateStr.split('/').map(Number);
  const start = Math.floor(new Date(y, m - 1, d, 0, 0, 0).getTime() / 1000);
  const end = Math.floor(new Date(y, m - 1, d, 23, 59, 59).getTime() / 1000);
  return { start, end };
}

// Identifica se um período é parte do 1° ou 2° tempo.
// REGRA (Felipe): conta o período se o nome CONTÉM o radical "1tempo" ou "2tempo"
// em qualquer posição — cobre subdivisões ("1tempo1") e períodos de entrada de
// substitutos nomeados fora do padrão ("SASHA 2tempo", "entrada 2tempo").
function classifyPeriod(name) {
  const n = (name || '').trim().toLowerCase();
  if (n.includes('1tempo')) return 't1';
  if (n.includes('2tempo')) return 't2';
  return null;
}

// Extrai o ID do Cadastro a partir do athlete_name no formato "96 PIERRE"
function parseAthleteName(athleteName) {
  const s = (athleteName || '').trim();
  const m = s.match(/^(F?)(\d+)\s+(.+)$/);
  if (m) return { cadastroId: parseInt(m[2], 10), name: m[3] };
  return { cadastroId: null, name: s };
}

// =============================================================================
// MAIN HANDLER
// =============================================================================
export default async function handler(req, res) {
  setCORS(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const token = process.env.CATAPULT_TOKEN;
  if (!token) return res.status(500).json({ error: 'CATAPULT_TOKEN não configurado' });

  const date = req.query.date; // ex: "27/05/2026"
  if (!date) return res.status(400).json({ error: 'Parâmetro ?date=DD/MM/YYYY é obrigatório' });

  try {
    // 1. Buscar atividades do dia
    const { start, end } = dateToUnixRange(date);
    const activities = await catapultGET(`/activities?start_time=${start}&end_time=${end}`, token);

    // 2. Encontrar a atividade que é JOGO (tem período 1tempo OU 2tempo)
    const game = activities.find(a =>
      (a.periods || []).some(p => classifyPeriod(p.name) !== null)
    );
    if (!game) return res.status(404).json({ error: `Nenhum jogo encontrado em ${date}` });

    // 3. Buscar stats do jogo (por período × atleta)
    const stats = await catapultPOST('/stats', token, {
      filters: [{ name: 'activity_id', comparison: '=', values: [game.id] }],
      parameters: PARAMETERS,
      group_by: ['period', 'athlete'],
    });

    // 3b. MODO DIAGNÓSTICO (?debug=1): despeja tudo sem filtrar, para investigar
    //     por que um atleta entrou ou saiu da lista. Não altera a saída normal.
    if (req.query.debug) {
      const periodsSeen = {};
      const byAth = {};
      for (const s of stats) {
        const pn = (s.period_name || '').trim();
        const cls = classifyPeriod(pn);
        if (!(pn in periodsSeen)) periodsSeen[pn] = cls;
        const an = (s.athlete_name || '').trim();
        if (!byAth[an]) byAth[an] = { athlete_name: an, periodos: [] };
        byAth[an].periodos.push({
          period: pn,
          classificado: cls,           // 't1' | 't2' | null (null = ignorado)
          dur_min: round((s.total_duration || 0) / 60, 1),
          dist: round(s.total_distance || 0, 1),
          pl: round(s.total_player_load || 0, 1),
        });
      }
      const athletes = Object.values(byAth).map(a => {
        let durJogo = 0, distJogo = 0;
        a.periodos.forEach(p => { if (p.classificado) { durJogo += p.dur_min; distJogo += p.dist; } });
        a.min_jogo = round(durJogo, 1);     // soma só dos períodos classificados como 1tempo/2tempo
        a.dist_jogo = round(distJogo, 1);
        a.entraria_na_lista = durJogo > 0;  // como o filtro atual (mins > 0) decidiria
        return a;
      }).sort((x, y) => y.min_jogo - x.min_jogo);

      return res.status(200).json({
        date,
        game: { id: game.id, name: game.name, periodCount: (game.periods || []).length },
        n_records: stats.length,
        periodos_distintos: Object.entries(periodsSeen).map(([name, cls]) => ({ name, classificado: cls })),
        atletas: athletes,
      });
    }

    // 4. Agregar: somar 1tempo+1tempo1+1tempo2... por atleta, idem 2tempo
    const byAthlete = {}; // chave = cadastroId ou athlete_name

    for (const s of stats) {
      const half = classifyPeriod(s.period_name);
      if (!half) continue; // ignora Aquecimento, Suplentes etc.

      const { cadastroId, name } = parseAthleteName(s.athlete_name);
      const key = cadastroId ?? `name:${name}`;

      if (!byAthlete[key]) {
        byAthlete[key] = {
          cadastroId,
          atleta: name,
          t1: emptyHalf(),
          t2: emptyHalf(),
        };
      }
      const acc = byAthlete[key][half];
      acc.dur += s.total_duration || 0;
      acc.dist += s.total_distance || 0;
      acc.b5 += s.velocity_band5_total_distance || 0;
      acc.b6 += s.velocity_band6_total_distance || 0;
      acc.b7 += s.velocity_band7_total_distance || 0;
      acc.accB23 += s.gen2_acceleration_band7plus_total_effort_count || 0;
      acc.decB3 += s.gen2_acceleration_band1_total_effort_count || 0;
      acc.decB2 += s.gen2_acceleration_band2_total_effort_count || 0;
      acc.pl += s.total_player_load || 0;
      acc.expl += s.explosive_efforts_gk || 0;
      acc.sprints += s.sprint_efforts || 0;
      acc.maxVel = Math.max(acc.maxVel, s.max_vel || 0);
      acc.hrMaxPct = Math.max(acc.hrMaxPct, s.percentage_max_heart_rate || 0);
      // FC média ponderada pela duração
      const dur = s.total_duration || 0;
      acc.hrAvgSum += (s.percentage_avg_heart_rate || 0) * dur;
      acc.hrAvgDur += dur;
    }

    // 5. Construir resposta no formato esperado pelo dashboard
    const players = Object.values(byAthlete)
      .map(a => finalizePlayer(a))
      .filter(p => p.mins > 0)
      .sort((a, b) => b.dist - a.dist);

    return res.status(200).json({
      date,
      game: { id: game.id, name: game.name, periodCount: (game.periods || []).length },
      params_used: PARAMETERS,
      n_records: stats.length,
      n_players: players.length,
      players,
    });
  } catch (err) {
    console.error('Erro:', err);
    return res.status(500).json({ error: err.message });
  }
}

function emptyHalf() {
  return {
    dur: 0, dist: 0, b5: 0, b6: 0, b7: 0,
    accB23: 0, decB2: 0, decB3: 0,
    pl: 0, expl: 0, sprints: 0,
    maxVel: 0, hrMaxPct: 0, hrAvgSum: 0, hrAvgDur: 0,
  };
}

function finalizePlayer(a) {
  const t1DurMin = a.t1.dur / 60;
  const t2DurMin = a.t2.dur / 60;
  const totalMin = t1DurMin + t2DurMin;
  const safeMin = totalMin || 1;

  // Totais combinados
  const distTotal = a.t1.dist + a.t2.dist;
  const altIntTotal = a.t1.b5 + a.t1.b6 + a.t1.b7 + a.t2.b5 + a.t2.b6 + a.t2.b7;
  const sprintTotal = a.t1.b6 + a.t1.b7 + a.t2.b6 + a.t2.b7;
  const accTotal = a.t1.accB23 + a.t2.accB23;
  const decTotal = a.t1.decB2 + a.t1.decB3 + a.t2.decB2 + a.t2.decB3;
  const explTotal = a.t1.expl + a.t2.expl;
  const plTotal = a.t1.pl + a.t2.pl;
  const maxVelMS = Math.max(a.t1.maxVel, a.t2.maxVel);

  // Densidades por tempo
  const dens = (val, durSec) => durSec > 0 ? val / (durSec / 60) : 0;

  return {
    cadastro_id: a.cadastroId,
    atleta_catapult: a.atleta,
    mins: round(totalMin, 1),
    dist: round(distTotal, 1),
    altInt: round(altIntTotal, 1),
    sprintDist: round(sprintTotal, 1),
    accN: accTotal,
    decN: decTotal,
    expl: explTotal,
    pload: round(plTotal, 1),
    vmax: round(maxVelMS * 3.6, 1),    // m/s → km/h
    hrPct: round(a.t1.hrAvgSum / (a.t1.hrAvgDur || 1), 1),
    // Densidades agregadas
    distMin: round(distTotal / safeMin, 2),
    altMin: round(altIntTotal / safeMin, 3),
    accMin: round(accTotal / safeMin, 3),
    decMin: round(decTotal / safeMin, 3),
    // Por tempo
    has_t1: t1DurMin > 0,
    has_t2: t2DurMin > 0,
    t1_dur: round(t1DurMin, 1),
    t2_dur: round(t2DurMin, 1),
    t1_dist: round(a.t1.dist, 1),
    t2_dist: round(a.t2.dist, 1),
    t1_altInt: round(a.t1.b5 + a.t1.b6 + a.t1.b7, 1),
    t2_altInt: round(a.t2.b5 + a.t2.b6 + a.t2.b7, 1),
    t1_expl: a.t1.expl,
    t2_expl: a.t2.expl,
    t1_distMin: round(dens(a.t1.dist, a.t1.dur), 2),
    t2_distMin: round(dens(a.t2.dist, a.t2.dur), 2),
    t1_altMin:  round(dens(a.t1.b5 + a.t1.b6 + a.t1.b7, a.t1.dur), 3),
    t2_altMin:  round(dens(a.t2.b5 + a.t2.b6 + a.t2.b7, a.t2.dur), 3),
    t1_accMin:  round(dens(a.t1.accB23, a.t1.dur), 3),
    t2_accMin:  round(dens(a.t2.accB23, a.t2.dur), 3),
    t1_decMin:  round(dens(a.t1.decB2 + a.t1.decB3, a.t1.dur), 3),
    t2_decMin:  round(dens(a.t2.decB2 + a.t2.decB3, a.t2.dur), 3),
  };
}

function round(v, d) {
  const f = Math.pow(10, d);
  return Math.round(v * f) / f;
}
