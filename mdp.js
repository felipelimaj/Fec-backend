// =============================================================================
//  Fortaleza EC — Performance API
//  Endpoint: GET /api/mdp?date=DD/MM/YYYY
//  Extrai os Períodos Mais Exigentes (MDP) de 1, 3 e 5 min de um jogo.
//
//  Parâmetros:
//    ?date=DD/MM/YYYY   (obrigatório) data BRT do jogo
//    ?athlete=123       (opcional) roda um atleta só — use para testar
//    ?limite=N          (opcional) processa só os N primeiros atletas
//    ?csv=1             (opcional) devolve CSV em vez de JSON
//    ?conferencia=1     (opcional) MODO CONFERÊNCIA: roda 1 atleta e devolve um
//                       resumo em português dizendo se está tudo certo
//    ?catalogo=termo    (opcional) procura um slug no catálogo da Catapult
//                       (ex.: ?catalogo=explos)
//    ?explSlug=xxx      (opcional) slug dos esforços explosivos, para conferir
//                       o nosso número contra o da Catapult
//    ?explAcc=2.0&explVel=14.4  (opcional) ajuste fino da definição de explosivo
//    ?debug=1           (opcional) devolve períodos, atletas e validação, sem stream
//
//  Regras travadas (ver claude/mdp_estudo.md):
//    - jogo  = atividade com período contendo "1tempo" ou "2tempo"
//    - MDP   = janela deslizante de passo 1 s, que NUNCA cruza fronteira de período
//    - máxima de referência = do próprio atleta, naquele jogo
//    - cada variável tem seu próprio pico
//    - goleiros ("1goleiro"/"2goleiro") ficam FORA
// =============================================================================

import MDP from '../mdp.js';

const CATAPULT_BASE = 'https://connect-us.catapultsports.com/api/v6';
const SENSOR_PARAMETERS = 'ts,v,hdop,pq,ref';
const CONCURRENCY = 3;   // streams 10 Hz são pesados; 3 cabe no orçamento da Vercel

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

// Janela BRT com ±6h de folga — jogo noturno termina depois da meia-noite UTC
function brtDayWindow(dateStr) {
  const [d, m, y] = dateStr.split('/').map(Number);
  const meiaNoiteBRT = Math.floor(Date.UTC(y, m - 1, d, 3, 0, 0) / 1000);
  return { start: meiaNoiteBRT - 6 * 3600, end: meiaNoiteBRT + 30 * 3600 };
}

function unixToBrtDate(unixSeconds) {
  const dt = new Date((unixSeconds - 3 * 3600) * 1000);
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  return `${dd}/${mm}/${dt.getUTCFullYear()}`;
}

// Radical do jogo — CONTÉM, não começa com (cobre "SASHA 2tempo", "2tempo3")
function classifyPeriod(name) {
  const n = (name || '').trim().toLowerCase();
  if (n.includes('1tempo')) return 't1';
  if (n.includes('2tempo')) return 't2';
  return null;
}
// Radical do goleiro — isolado de propósito: nunca entra nas contas de linha
function isGoalkeeperPeriod(name) {
  const n = (name || '').trim().toLowerCase();
  return n.includes('1goleiro') || n.includes('2goleiro');
}

function parseAthleteName(athleteName) {
  const s = (athleteName || '').trim();
  const m = s.match(/^(F?)(\d+)\s+(.+)$/);
  return m ? { cadastroId: parseInt(m[2], 10), name: m[3] } : { cadastroId: null, name: s };
}

function extrairDadosSensor(responseData) {
  if (!responseData) return [];
  if (Array.isArray(responseData)) {
    for (const item of responseData) if (item && Array.isArray(item.data)) return item.data;
  }
  return [];
}

async function emLotes(itens, n, fn) {
  const out = [];
  for (let i = 0; i < itens.length; i += n) {
    out.push(...await Promise.all(itens.slice(i, i + n).map(fn)));
  }
  return out;
}

// =============================================================================
export default async function handler(req, res) {
  setCORS(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const token = process.env.CATAPULT_TOKEN;
  if (!token) return res.status(500).json({ error: 'CATAPULT_TOKEN não configurado' });

  const { date, athlete, limite, csv, debug, conferencia, catalogo, explSlug, explAcc, explVel } = req.query;

  try {
    // ── Modo catálogo: procura um slug pelo nome, sem tocar em jogo nenhum ──
    if (catalogo) {
      const params = await catapultGET('/parameters', token);
      const termo = String(catalogo).toLowerCase();
      const achados = (params || [])
        .filter(p => (p.name || '').toLowerCase().includes(termo) || (p.slug || '').toLowerCase().includes(termo))
        .map(p => ({ nome: p.name, slug: p.slug, unidade: p.unit_type, agregacao: p.aggregation }));
      return res.status(200).json({ termo: catalogo, total: achados.length, parametros: achados });
    }

    if (!date) return res.status(400).json({ error: 'Parâmetro ?date=DD/MM/YYYY é obrigatório' });
    // 1. Achar a atividade do jogo naquela data BRT
    const { start, end } = brtDayWindow(date);
    const atividades = await catapultGET(`/activities?start_time=${start}&end_time=${end}`, token);

    const jogo = (atividades || []).find(a =>
      unixToBrtDate(a.start_time) === date &&
      (a.periods || []).some(p => classifyPeriod(p.name))
    );
    if (!jogo) return res.status(404).json({ error: `Nenhum jogo encontrado em ${date}` });

    // 2. Blocos de tempo — mesclagem resolve os períodos ANINHADOS
    const brutosT1 = [], brutosT2 = [];
    const duracoesOficiaisPorPeriodo = {};
    for (const p of (jogo.periods || [])) {
      const cls = classifyPeriod(p.name);
      if (!cls) continue;
      const it = { ini: p.start_time, fim: p.end_time, rotulo: cls === 't1' ? '1tempo' : '2tempo', dur: p.end_time - p.start_time };
      (cls === 't1' ? brutosT1 : brutosT2).push(it);
    }
    const blocos = MDP.mesclarIntervalos(brutosT1).concat(MDP.mesclarIntervalos(brutosT2));
    if (!blocos.length) return res.status(404).json({ error: 'Atividade sem período de jogo válido' });

    // 3. /stats por período × atleta: duração oficial (recorte de banco) +
    //    distância oficial (validação do stream)
    const paramsStats = ['total_duration', 'total_distance'];
    if (explSlug) paramsStats.push(explSlug);

    const stats = await catapultPOST('/stats', token, {
      filters: [{ name: 'activity_id', comparison: '=', values: [jogo.id] }],
      parameters: paramsStats,
      group_by: ['period', 'athlete'],
    });

    const porAtleta = new Map();
    for (const s of (stats || [])) {
      const nome = s.athlete_name || '';
      const id = s.athlete_id ?? s.athlete?.id ?? null;
      const chave = String(id ?? nome);
      if (!porAtleta.has(chave)) {
        const pn = parseAthleteName(nome);
        porAtleta.set(chave, {
          athleteId: id, nome: pn.name, cadastroId: pn.cadastroId,
          goleiro: false, duracoes: {}, distOficial: 0, minOficial: 0,
        });
      }
      const a = porAtleta.get(chave);
      if (isGoalkeeperPeriod(s.period_name)) { a.goleiro = true; continue; }
      const cls = classifyPeriod(s.period_name);
      if (!cls) continue;
      const rot = cls === 't1' ? '1tempo' : '2tempo';
      // períodos aninhados: fica a MAIOR duração do rótulo, não a soma
      a.duracoes[rot] = Math.max(a.duracoes[rot] || 0, s.total_duration || 0);

      a['dist_' + rot] = Math.max(a['dist_' + rot] || 0, s.total_distance || 0);
      if (explSlug) a['expl_' + rot] = Math.max(a['expl_' + rot] || 0, s[explSlug] || 0);
    }
    for (const a of porAtleta.values()) {
      a.minOficial = ((a.duracoes['1tempo'] || 0) + (a.duracoes['2tempo'] || 0)) / 60;
      a.distOficial = (a['dist_1tempo'] || 0) + (a['dist_2tempo'] || 0);
      a.explOficial = explSlug ? (a['expl_1tempo'] || 0) + (a['expl_2tempo'] || 0) : null;
    }

    let atletas = [...porAtleta.values()].filter(a => !a.goleiro && a.minOficial > 0 && a.athleteId);
    if (athlete) atletas = atletas.filter(a => String(a.athleteId) === String(athlete) || String(a.cadastroId) === String(athlete));
    if (limite) atletas = atletas.slice(0, parseInt(limite, 10));
    if (conferencia && !athlete) atletas = atletas.slice(0, 1);   // conferência = 1 atleta só

    if (debug) {
      return res.status(200).json({
        jogo: { id: jogo.id, nome: jogo.name, data: date },
        blocos: blocos.map(b => ({ rotulo: b.rotulo, min: +((b.fim - b.ini) / 60).toFixed(1) })),
        periodosBrutos: (jogo.periods || []).map(p => p.name),
        atletas: atletas.map(a => ({ id: a.athleteId, nome: a.nome, minOficial: +a.minOficial.toFixed(1), distOficial: +a.distOficial.toFixed(0) })),
        goleirosIgnorados: [...porAtleta.values()].filter(a => a.goleiro).map(a => a.nome),
      });
    }

    // 4. Stream 10 Hz por atleta — SEM downsample (decimação destrói acel/decel)
    const resultados = await emLotes(atletas, CONCURRENCY, async (a) => {
      try {
        const raw = await catapultGET(
          `/activities/${jogo.id}/athletes/${a.athleteId}/sensor?parameters=${SENSOR_PARAMETERS}&nulls=1`,
          token
        );
        const pontos = extrairDadosSensor(raw)
          .map(p => ({ ts: p.ts, v: p.v, hdop: p.hdop }))
          .filter(p => p.ts != null && p.v != null);

        const cfg = {};
        if (explAcc) cfg.EXPL_ACC = parseFloat(explAcc);
        if (explVel) cfg.EXPL_VEL_FIM_KMH = parseFloat(explVel);

        const calc = MDP.calcularAtleta(pontos, blocos, a.duracoes, { config: cfg });
        if (!calc) return { atleta: a.nome, erro: 'stream insuficiente' };

        const difDist = a.distOficial > 0
          ? ((calc.totais.dist - a.distOficial) / a.distOficial) * 100
          : null;

        return {
          athleteId: a.athleteId, cadastroId: a.cadastroId, atleta: a.nome,
          minJogados: calc.minJogados, minOficial: +a.minOficial.toFixed(1),
          participacao: calc.participacao,
          totais: calc.totais,
          validacao: {
            distStream: calc.totais.dist,
            distCatapult: +a.distOficial.toFixed(1),
            difPct: difDist == null ? null : +difDist.toFixed(2),
            ok: difDist == null ? null : Math.abs(difDist) <= 2,
            explosivoNosso: calc.totais.explosivo,
            explosivoCatapult: a.explOficial,
          },
          picos: calc.picos,
          repeticoes: calc.repeticoes,
        };
      } catch (e) {
        return { atleta: a.nome, erro: e.message };
      }
    });

    // ── Modo conferência: 1 atleta, resposta em português simples ───────────
    if (conferencia) {
      const r = resultados.find(x => !x.erro);
      if (!r) return res.status(200).json({ veredito: 'Nenhum atleta foi processado.', resultados });
      const v = r.validacao;
      const recados = [];
      recados.push(`Jogo encontrado: ${jogo.name} (${date}).`);
      recados.push(`Períodos juntados em ${blocos.length} bloco(s) — o esperado é 2 (1º e 2º tempo).`);
      recados.push(`Goleiros fora: ${[...porAtleta.values()].filter(x => x.goleiro).length}.`);
      recados.push(`Atleta conferido: ${r.atleta}, ${r.minJogados} min pelo nosso cálculo contra ${r.minOficial} min da Catapult.`);
      recados.push(v.ok === true
        ? `Distância bate com a Catapult (diferença de ${v.difPct}%). Pode rodar o jogo inteiro.`
        : `ATENÇÃO: distância difere ${v.difPct}% da Catapult. Acima de 2% não rode a amostra ainda.`);
      if (v.explosivoCatapult != null) {
        const dif = v.explosivoCatapult > 0 ? ((v.explosivoNosso - v.explosivoCatapult) / v.explosivoCatapult) * 100 : null;
        recados.push(`Esforços explosivos: ${v.explosivoNosso} pelo nosso critério contra ${v.explosivoCatapult} da Catapult` +
          (dif == null ? '.' : ` (${dif.toFixed(1)}% de diferença). Ajuste com &explAcc= e &explVel= até ficar perto.`));
      } else {
        recados.push('Esforços explosivos ainda sem comparação: rode com &explSlug=<slug> para conferir contra a Catapult.');
      }
      return res.status(200).json({ veredito: recados, detalhe: r });
    }

    if (csv) {
      const linhas = [[
        'data', 'jogo', 'atleta_id', 'atleta', 'min_jogados', 'janela_min', 'variavel',
        'pico_absoluto', 'pico_por_minuto', 'periodo_do_pico',
        'n_janelas_80', 'n_janelas_85', 'n_janelas_90',
        'total_jogo', 'validacao_dif_pct',
      ].join(';')];
      for (const r of resultados) {
        if (r.erro) continue;
        for (const W of [60, 180, 300]) {
          for (const v of MDP.VARIAVEIS) {
            const p = r.picos[W][v], rep = r.repeticoes[W][v];
            if (!p) continue;
            linhas.push([
              date, jogo.name, r.cadastroId ?? r.athleteId, r.atleta, r.minJogados,
              W / 60, v, p.absoluto, p.porMinuto, p.periodo,
              rep[80].n, rep[85].n, rep[90].n,
              r.totais[v], r.validacao.difPct,
            ].join(';'));
          }
        }
      }
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="mdp_${date.replace(/\//g, '-')}.csv"`);
      return res.status(200).send('\uFEFF' + linhas.join('\n'));
    }

    return res.status(200).json({
      jogo: { id: jogo.id, nome: jogo.name, data: date },
      config: {
        janelasMin: [1, 3, 5], passoS: MDP.CONFIG.PASSO_S,
        hsrKmh: MDP.CONFIG.HSR_KMH, sprintKmh: MDP.CONFIG.SPRINT_KMH,
        accLimiar: MDP.CONFIG.ACC_LIMIAR, decLimiar: MDP.CONFIG.DEC_LIMIAR,
        cortesPct: [80, 85, 90], referencia: 'máxima do próprio atleta no jogo',
        janelasIndependentes: true, goleiros: 'excluídos',
      },
      blocos: blocos.map(b => ({ rotulo: b.rotulo, min: +((b.fim - b.ini) / 60).toFixed(1) })),
      atletas: resultados,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
