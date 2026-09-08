// =============================================================================
//  Fortaleza EC — Performance API
//  Endpoint: GET /api/mdp?date=DD/MM/YYYY
//  Extrai os Períodos Mais Exigentes (MDP) de 1, 3 e 5 min de um jogo.
//
//  Parâmetros:
//    ?date=DD/MM/YYYY   (obrigatório) data BRT do jogo
//    ?athlete=123       (opcional) roda um atleta só — use para testar
//    ?limite=N          (opcional) processa só os N primeiros atletas
//    ?minMin=75         (opcional) só atletas com pelo menos N minutos de jogo
//    ?hdopMax=3         (opcional) liga o filtro de qualidade de sinal (desligado
//                       por padrão — descartar ponto tira metros reais)
//    ?diag=1            (opcional) junta o raio-x da aceleração (para achar
//                       por que uma contagem sai zerada)
//    ?dist=1            (opcional) SONDA: calcula a distância de três formas
//                       (canal v, canal rv, deslocamento lat/long) e compara
//                       com o número oficial da Catapult
//    ?bruto=1           (opcional) SONDA: pede o stream de duas formas e conta
//                       quantos pontos vêm em cada uma (checa a frequência)
//    ?csv=1             (opcional) devolve CSV em vez de JSON
//    ?conferencia=1     (opcional) MODO CONFERÊNCIA: roda 1 atleta e devolve um
//                       resumo em português dizendo se está tudo certo
//    ?catalogo=termo    (opcional) procura um slug no catálogo da Catapult
//                       (ex.: ?catalogo=explos)
//    ?explSlug=xxx      (opcional) troca o slug dos esforços explosivos; o padrão
//                       já é o do tenant. ?explSlug=nenhum desliga a comparação
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
// ATENÇÃO ao `cs`: a Catapult manda `ts` em SEGUNDOS INTEIROS e o centésimo
// dentro do segundo vem separado, em `cs`. Sem pedir `cs`, as dez leituras de
// cada segundo chegam com o mesmo `ts` e a deduplicação por instante descarta
// nove delas — o stream vira 1 Hz sem avisar. Descoberto em 08/09/2026 com a
// sonda ?bruto=1, depois de a distância sair 5,5% curta.
const SENSOR_PARAMETERS = 'ts,cs,v,hdop,pq,ref';
// Slug dos esforços explosivos do tenant, confirmado em 08/09/2026 pela sonda
// GET /parameters (?catalogo=explos). Tem cedilha e til — por isso fica gravado
// aqui e nunca é digitado na barra de endereço, onde acento se embaralha.
const EXPL_SLUG_PADRAO = 'esforços_explosivos_2';

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

  const { date, athlete, limite, csv, debug, conferencia, catalogo, explSlug, explAcc, explVel, minMin, diag, bruto, hdopMax, dist } = req.query;

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
    // slug dos explosivos: o padrão do tenant, salvo se a query pedir outro.
    // ?explSlug=nenhum desliga a comparação de propósito.
    let slugExpl = explSlug ? String(explSlug) : EXPL_SLUG_PADRAO;
    if (slugExpl === 'nenhum') slugExpl = null;

    let avisoExpl = null;
    let stats;
    const pedirStats = (params) => catapultPOST('/stats', token, {
      filters: [{ name: 'activity_id', comparison: '=', values: [jogo.id] }],
      parameters: params,
      group_by: ['period', 'athlete'],
    });

    try {
      stats = await pedirStats(slugExpl ? ['total_duration', 'total_distance', slugExpl] : ['total_duration', 'total_distance']);
    } catch (e) {
      // A Catapult recusou o pedido — provavelmente por causa desse parâmetro.
      // Refaz sem ele: o estudo continua, só fica sem a comparação.
      if (!slugExpl) throw e;
      avisoExpl = `A Catapult não aceitou o parâmetro "${slugExpl}" no /stats (${e.message}). ` +
                  `O MDP foi calculado normalmente; só a conferência dos esforços explosivos ficou de fora.`;
      slugExpl = null;
      stats = await pedirStats(['total_duration', 'total_distance']);
    }

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
      if (slugExpl) a['expl_' + rot] = Math.max(a['expl_' + rot] || 0, s[slugExpl] || 0);
    }
    for (const a of porAtleta.values()) {
      a.minOficial = ((a.duracoes['1tempo'] || 0) + (a.duracoes['2tempo'] || 0)) / 60;
      a.distOficial = (a['dist_1tempo'] || 0) + (a['dist_2tempo'] || 0);
      a.explOficial = slugExpl ? (a['expl_1tempo'] || 0) + (a['expl_2tempo'] || 0) : null;
    }

    let atletas = [...porAtleta.values()].filter(a => !a.goleiro && a.minOficial > 0 && a.athleteId);
    if (athlete) atletas = atletas.filter(a => String(a.athleteId) === String(athlete) || String(a.cadastroId) === String(athlete));
    if (limite) atletas = atletas.slice(0, parseInt(limite, 10));
    // corte de minutos: evita calibrar ou estudar em cima de substituto
    if (minMin) atletas = atletas.filter(a => a.minOficial >= parseFloat(minMin));
    // conferência sem atleta escolhido pega o que MAIS jogou, não o primeiro da lista
    if (conferencia && !athlete) {
      atletas = atletas.slice().sort((x, y) => y.minOficial - x.minOficial).slice(0, 1);
    }

    if (debug) {
      return res.status(200).json({
        jogo: { id: jogo.id, nome: jogo.name, data: date },
        blocos: blocos.map(b => ({ rotulo: b.rotulo, min: +((b.fim - b.ini) / 60).toFixed(1) })),
        periodosBrutos: (jogo.periods || []).map(p => p.name),
        atletas: atletas.map(a => ({ id: a.athleteId, nome: a.nome, minOficial: +a.minOficial.toFixed(1), distOficial: +a.distOficial.toFixed(0) })),
        goleirosIgnorados: [...porAtleta.values()].filter(a => a.goleiro).map(a => a.nome),
      });
    }

    // ── Sonda de frequência: mesma requisição, dois conjuntos de campos ─────
    if (bruto) {
      const alvo = atletas.slice().sort((x, y) => y.minOficial - x.minOficial)[0];
      if (!alvo) return res.status(200).json({ error: 'nenhum atleta elegível' });

      const variantes = {
        reduzido: 'ts,v,hdop,pq,ref',
        completo: 'ts,lat,long,v,rv,a,hr,pl,xy,pq,hdop,ref,o,mp',
        semParametros: null,
      };
      const saida = {};
      for (const [nome, params] of Object.entries(variantes)) {
        try {
          const url = `/activities/${jogo.id}/athletes/${alvo.athleteId}/sensor` +
                      (params ? `?parameters=${params}&nulls=1` : '?nulls=1');
          const raw = await catapultGET(url, token);
          const dados = extrairDadosSensor(raw);
          const ts = dados.map(d => d.ts).filter(v => v != null).slice(0, 3000);
          const difs = [];
          for (let i = 1; i < ts.length; i++) difs.push(ts[i] - ts[i - 1]);
          difs.sort((a, b) => a - b);
          const mediana = difs.length ? difs[Math.floor(difs.length / 2)] : null;
          saida[nome] = {
            pontos: dados.length,
            intervaloMedianoS: mediana,
            frequenciaHz: mediana ? +(1 / mediana).toFixed(2) : null,
            comHdop: dados.filter(d => d.hdop != null).length,
            comVelocidade: dados.filter(d => d.v != null).length,
            primeirosRegistros: dados.slice(0, 3),
          };
        } catch (e) {
          saida[nome] = { erro: e.message };
        }
      }
      return res.status(200).json({
        atleta: alvo.nome,
        minutosOficiais: +alvo.minOficial.toFixed(1),
        esperadoSe10Hz: Math.round(alvo.minOficial * 60 * 10),
        variantes: saida,
      });
    }

    // ── Sonda de distância: de onde saem os metros? ────────────────────────
    if (dist) {
      const alvo = atletas.slice().sort((x, y) => y.minOficial - x.minOficial)[0];
      if (!alvo) return res.status(200).json({ error: 'nenhum atleta elegível' });

      const raw = await catapultGET(
        `/activities/${jogo.id}/athletes/${alvo.athleteId}/sensor?parameters=ts,cs,v,rv,lat,long,hdop&nulls=1`,
        token
      );
      const pts = extrairDadosSensor(raw)
        .map(p => ({ ts: p.cs != null ? p.ts + p.cs / 100 : p.ts, v: p.v, rv: p.rv, lat: p.lat, lon: p.long }))
        .filter(p => p.ts != null)
        .sort((a, b) => a.ts - b.ts);

      // mesma janela de participação usada no cálculo real
      const janelas = [];
      for (const bloco of blocos) {
        const jp = MDP.janelaParticipacao(
          MDP.normalizarStream(pts.filter(p => p.v != null)), bloco, alvo.duracoes[bloco.rotulo]
        );
        if (jp) janelas.push(jp);
      }
      const dentro = (p) => janelas.some(j => p.ts >= j.ini && p.ts <= j.fim);
      // mesma conta, sem o recorte de participação: período inteiro
      const dentroPeriodo = (p) => blocos.some(b => p.ts >= b.ini && p.ts <= b.fim);

      const R = 6371000;
      const rad = (g) => (g * Math.PI) / 180;
      let somaV = 0, somaRV = 0, somaGeo = 0, nGeo = 0, semV = 0, semRV = 0, semGeo = 0;
      let somaVPeriodo = 0;   // canal v, mas sem recortar o tempo de banco

      for (let i = 0; i < pts.length - 1; i++) {
        const p = pts[i], q = pts[i + 1];
        let dt = q.ts - p.ts;
        if (dt <= 0 || dt > 2) continue;

        if (dentroPeriodo(p) && p.v != null && q.v != null) {
          somaVPeriodo += ((p.v + q.v) / 2) * dt;
        }
        if (!dentro(p)) continue;

        if (p.v != null && q.v != null) somaV += ((p.v + q.v) / 2) * dt; else semV++;
        if (p.rv != null && q.rv != null) somaRV += ((p.rv + q.rv) / 2) * dt; else semRV++;

        if (p.lat != null && q.lat != null && p.lon != null && q.lon != null) {
          const dLat = rad(q.lat - p.lat);
          const dLon = rad(q.lon - p.lon) * Math.cos(rad((p.lat + q.lat) / 2));
          somaGeo += R * Math.sqrt(dLat * dLat + dLon * dLon);
          nGeo++;
        } else semGeo++;
      }

      const of = alvo.distOficial;
      const cmp = (x) => ({ metros: +x.toFixed(1), difPct: of > 0 ? +(((x - of) / of) * 100).toFixed(2) : null });

      return res.status(200).json({
        atleta: alvo.nome,
        minutosOficiais: +alvo.minOficial.toFixed(1),
        distanciaCatapult: +of.toFixed(1),
        porCanalV: cmp(somaV),
        porCanalRV: cmp(somaRV),
        porDeslocamentoGeo: cmp(somaGeo),
        canalV_semRecorteDeBanco: cmp(somaVPeriodo),
        minutosDoPeriodoInteiro: +(blocos.reduce((s, b) => s + (b.fim - b.ini), 0) / 60).toFixed(1),
        minutosRecortados: +(blocos.reduce((s, b) => s + (b.fim - b.ini), 0) / 60 - alvo.minOficial).toFixed(1),
        amostrasSemDado: { v: semV, rv: semRV, latlong: semGeo, paresGeoUsados: nGeo },
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
          .map(p => ({
            ts: p.cs != null ? p.ts + p.cs / 100 : p.ts,   // segundo + centésimo
            v: p.v,
            hdop: p.hdop,
          }))
          .filter(p => p.ts != null && p.v != null);

        const cfg = {};
        if (explAcc) cfg.EXPL_ACC = parseFloat(explAcc);
        if (explVel) cfg.EXPL_VEL_FIM_KMH = parseFloat(explVel);
        if (hdopMax) cfg.HDOP_MAX = parseFloat(hdopMax);

        const calc = MDP.calcularAtleta(pontos, blocos, a.duracoes, { config: cfg });
        if (!calc) return { atleta: a.nome, erro: 'stream insuficiente' };

        // A Catapult calcula sobre o período inteiro; comparamos com a mesma
        // régua. O estudo segue usando os números recortados.
        const difDist = a.distOficial > 0
          ? ((calc.referenciaPeriodoInteiro.dist - a.distOficial) / a.distOficial) * 100
          : null;

        return {
          diagnostico: diag ? MDP.diagnosticoAceleracao(pontos, blocos, a.duracoes) : undefined,
          athleteId: a.athleteId, cadastroId: a.cadastroId, atleta: a.nome,
          minJogados: calc.minJogados, minOficial: +a.minOficial.toFixed(1),
          amostragemHz: calc.amostragemHz,
          pontos: { recebidos: calc.pontosRecebidos, usados: calc.pontosUsados },
          participacao: calc.participacao,
          totais: calc.totais,
          validacao: {
            distStreamNoJogo: calc.totais.dist,
            distCatapult: +a.distOficial.toFixed(1),
            difPct: difDist == null ? null : +difDist.toFixed(2),
            ok: difDist == null ? null : Math.abs(difDist) <= 2,
            distStreamPeriodoInteiro: calc.referenciaPeriodoInteiro.dist,
            explosivoNoJogo: calc.totais.explosivo,
            explosivoNosso: calc.referenciaPeriodoInteiro.explosivo,
            explosivoCatapult: a.explOficial,
            nota: 'a conferência usa o período inteiro, régua da Catapult; o estudo usa o tempo em jogo',
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
      recados.push(r.amostragemHz && r.amostragemHz >= 8
        ? `Frequência do sinal: ${r.amostragemHz} Hz — resolução cheia, como deve ser.`
        : `ATENÇÃO: sinal chegando a ${r.amostragemHz} Hz. Abaixo de 8 Hz a contagem de esforços e a distância saem curtas.`);
      recados.push(v.ok === true
        ? `Distância bate com a Catapult na mesma régua (diferença de ${v.difPct}%). Pode rodar o jogo inteiro.`
        : `ATENÇÃO: distância difere ${v.difPct}% da Catapult. Acima de 2% não rode a amostra ainda.`);
      recados.push(`No estudo entram ${v.distStreamNoJogo} m — só o tempo em campo. ` +
        `Os ${v.distStreamPeriodoInteiro} m da conferência incluem o período inteiro, que é como a Catapult conta.`);
      if (v.explosivoCatapult != null) {
        const dif = v.explosivoCatapult > 0 ? ((v.explosivoNosso - v.explosivoCatapult) / v.explosivoCatapult) * 100 : null;
        recados.push(`Esforços explosivos: ${v.explosivoNosso} pelo nosso critério contra ${v.explosivoCatapult} da Catapult` +
          (dif == null ? '.' : ` (${dif.toFixed(1)}% de diferença). Ajuste com &explAcc= e &explVel= até ficar perto.`));
      } else {
        recados.push(avisoExpl || 'Esforços explosivos sem comparação nesta rodada.');
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
        slugExplosivos: slugExpl, explosivoConfirmado: MDP.CONFIG.EXPL_CONFIRMADO,
        janelasIndependentes: true, goleiros: 'excluídos',
      },
      blocos: blocos.map(b => ({ rotulo: b.rotulo, min: +((b.fim - b.ini) / 60).toFixed(1) })),
      avisoExplosivos: avisoExpl,
      atletas: resultados,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
