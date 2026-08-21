// =============================================================================
//  Fortaleza EC — Performance API
//  Endpoint: GET /api/comparativo
//
//  Extração atleta × jogo para o painel de comparação de comissão técnica.
//  Mesmo modelo de dados do /api/match, porém para VÁRIOS jogos numa chamada.
//
//  MODOS
//    ?listar=1&ini=DD/MM/YYYY&fim=DD/MM/YYYY
//        Só varre /activities e devolve a lista de jogos (data, id, nome).
//        Barato: 1 chamada a cada 60 dias de janela. Use para montar a fila.
//
//    ?datas=DD/MM/YYYY,DD/MM/YYYY,...
//        Devolve os dados de atleta de cada data pedida.
//        Máximo de MAX_DATAS por chamada — o front pede em lotes.
//
//  POR QUE EM LOTES: a Catapult recusa a varredura inteira (HTTP 429) quando
//  passa de ~70 requisições numa mesma sequência. Uma temporada tem ~50 jogos,
//  e cada jogo custa 1 POST /stats. Pedindo em lotes de 12, com pausa entre
//  eles no front, a cota nunca estoura. Falha nunca é silenciosa: o que não
//  vier aparece em `falhas`.
//
//  BANDAS DE VELOCIDADE (tabela confirmada em 19/08/2026, sonda em dado real):
//    B5 = velocity_band5 (19,80–25,20) · B6 = band6 (25,20–30,00) · B7 = band7 (>30)
//    Alta Intensidade = B5+B6+B7   ·   Sprint = B6+B7
//
//  max_vel chega em km/h. NÃO multiplicar por 3.6.
// =============================================================================

const CATAPULT_BASE = 'https://connect-us.catapultsports.com/api/v6';

// Planilha CADASTRO_ATLETAS_PROFISSIONAL_FEC, publicada na web.
// Fonte da posição e do status de cada atleta — o registro da Catapult nem
// sempre traz posição, e não tem status nenhum. Sobrescreva por variável de
// ambiente se a planilha mudar de endereço.
const CADASTRO_CSV =
  process.env.CADASTRO_CSV_URL ||
  'https://docs.google.com/spreadsheets/d/e/2PACX-1vT2jaLvln5GbiUoNsczLHRMYt0gHjzDOEar1h9LLuKG-Xa4KJKZr2SS133l0pr8AgetsdYF5Ek2KU7Q/pub?output=csv';

const MAX_DATAS = 14;      // datas por chamada — mantém a cota da Catapult folgada
const CONCURRENCY = 4;     // jogos processados em paralelo dentro do lote
const CHUNK_DAYS = 60;     // janela máxima por chamada /activities

const PARAMETERS = [
  'total_distance',
  'total_duration',
  'velocity_band5_total_distance',
  'velocity_band6_total_distance',
  'velocity_band7_total_distance',
  'gen2_acceleration_band7plus_total_effort_count', // Acel B2+B3 (≥3 m/s², já somado)
  'gen2_acceleration_band1_total_effort_count',     // Decel B3 (severa)
  'gen2_acceleration_band2_total_effort_count',     // Decel B2 (média)
  'total_player_load',
  'percentage_max_heart_rate',
  'percentage_avg_heart_rate',
  'explosive_efforts_gk',
  'sprint_efforts',
  // FMP — chegam em SEGUNDOS. O percentual é calculado por nós:
  // tempo_na_banda / tempo_de_jogo. Somar o campo *_percentage dos dois tempos
  // daria um número matematicamente errado.
  'fmp_running_total_duration',
  'fmp_dynamic_total_duration',
];

// Auditoria: as oito bandas de velocidade e as oito de aceleração Gen2, somadas
// por jogo. Servem para a identidade soma(bandas) = distância total e para
// mostrar quais bandas de aceleração o tenant realmente popula. Sem isso, a
// escolha dos slugs é ato de fé.
const PARAMS_AUDITORIA = [];
for (let i = 1; i <= 8; i++) {
  PARAMS_AUDITORIA.push(`velocity_band${i}_total_distance`);
  PARAMS_AUDITORIA.push(`gen2_acceleration_band${i}_total_effort_count`);
}

// ----------------------------------------------------------------------------
// Infra
// ----------------------------------------------------------------------------
function setCORS(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Repete em 429 e 5xx com espera crescente. Erro de autenticação não repete —
// insistir num token inválido só gasta cota.
async function catapultFetch(path, token, init = {}, tentativas = 3) {
  let ultimoErro;
  for (let i = 0; i < tentativas; i++) {
    const r = await fetch(`${CATAPULT_BASE}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...(init.headers || {}),
      },
    });
    if (r.ok) return r.json();
    if (r.status === 401 || r.status === 403) {
      throw new Error(`Catapult ${path} → HTTP ${r.status} (token)`);
    }
    ultimoErro = new Error(`Catapult ${path} → HTTP ${r.status}`);
    if (![429, 500, 502, 503, 504].includes(r.status)) throw ultimoErro;
    await sleep(400 * Math.pow(2, i));
  }
  throw ultimoErro;
}

const catapultGET = (path, token) => catapultFetch(path, token, {});
const catapultPOST = (path, token, body) =>
  catapultFetch(path, token, { method: 'POST', body: JSON.stringify(body) });

// ----------------------------------------------------------------------------
// Datas — tudo em horário de Brasília (BRT = UTC−3)
// ----------------------------------------------------------------------------
function parseDataBR(s) {
  const p = (s || '').trim().split('/').map(Number);
  if (p.length !== 3 || p.some(isNaN)) return null;
  return { d: p[0], m: p[1], y: p[2] };
}

function meiaNoiteBRT(y, m, d) {
  return Math.floor(Date.UTC(y, m - 1, d, 3, 0, 0) / 1000);
}

// Jogo noturno começa ~22h UTC e termina depois da virada do dia UTC. Uma janela
// de 1 dia UTC exato perderia esses jogos — daí a folga de 6h em cada ponta.
function janelaDia(dataStr) {
  const p = parseDataBR(dataStr);
  const zero = meiaNoiteBRT(p.y, p.m, p.d);
  return { start: zero - 6 * 3600, end: zero + 24 * 3600 + 6 * 3600 };
}

function unixParaDataBR(unix) {
  const dt = new Date((unix - 3 * 3600) * 1000);
  const d = String(dt.getUTCDate()).padStart(2, '0');
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  return `${d}/${m}/${dt.getUTCFullYear()}`;
}

// ----------------------------------------------------------------------------
// Regras de negócio do clube
// ----------------------------------------------------------------------------
// Um período é jogo se o nome CONTÉM 1tempo ou 2tempo. `includes` e não
// `startsWith`: substituto entra às vezes como "SASHA 2tempo" ou "entrada 2tempo".
function classificarPeriodo(nome) {
  const n = (nome || '').trim().toLowerCase();
  if (n.includes('1tempo')) return 't1';
  if (n.includes('2tempo')) return 't2';
  return null;
}

// A Catapult guarda o ID do Cadastro no início do nome do atleta: "96 PIERRE".
function lerNomeAtleta(bruto) {
  const s = (bruto || '').trim();
  const m = s.match(/^[A-Za-z]{0,2}(\d{1,3})[\s.\-_]+(.+)$/);
  if (m) return { cadastroId: Number(m[1]), nome: m[2].trim() };
  return { cadastroId: null, nome: s };
}

const semAcento = s =>
  (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().trim();

// Vocabulários das duas fontes (Catapult e planilha de cadastro) num só grupo.
// Comparação sem acento e em caixa alta — "CENTROAVANTE" não casa com sigla.
function grupoPosicional(posicao) {
  const p = semAcento(posicao);
  if (!p) return null;
  if (p.includes('GOLEIRO') || p === 'GK') return 'Goleiros';
  if (p.includes('ZAGUEIRO')) return 'Zagueiros';
  if (p.includes('LATERAL')) return 'Laterais';
  if (p.includes('VOLANTE') || p.includes('MEIA') || p.includes('MEIO')) return 'Meias';
  if (p.includes('EXTREMO') || p.includes('CENTROAVANTE') || p.includes('ATACANTE')) return 'Atacantes';
  return null;
}

const round = (v, c = 1) => {
  if (v == null || !isFinite(v)) return 0;
  const f = Math.pow(10, c);
  return Math.round(v * f) / f;
};

// ----------------------------------------------------------------------------
// Cadastro publicado — posição e status
// ----------------------------------------------------------------------------
// Divide uma linha de CSV respeitando aspas. Nome de atleta com vírgula
// ("SILVA, J.") quebraria um split ingênuo.
function linhaCSV(linha) {
  const out = [];
  let campo = '';
  let aspas = false;
  for (let i = 0; i < linha.length; i++) {
    const c = linha[i];
    if (c === '"') {
      if (aspas && linha[i + 1] === '"') { campo += '"'; i++; }
      else aspas = !aspas;
    } else if (c === ',' && !aspas) { out.push(campo); campo = ''; }
    else campo += c;
  }
  out.push(campo);
  return out.map(v => v.trim());
}

// Acha a coluna pelo texto do cabeçalho, sem acento e sem depender da ordem.
function acharColuna(cabecalho, candidatos) {
  for (const cand of candidatos) {
    const i = cabecalho.findIndex(h => semAcento(h) === cand);
    if (i >= 0) return i;
  }
  for (const cand of candidatos) {
    const i = cabecalho.findIndex(h => semAcento(h).includes(cand));
    if (i >= 0) return i;
  }
  return -1;
}

let cacheCadastro = null; // sobrevive entre invocações na mesma lambda quente

async function carregarCadastro() {
  if (cacheCadastro) return cacheCadastro;
  const vazio = { porId: {}, total: 0, ativos: 0, colunas: null, erro: null };
  try {
    const r = await fetch(CADASTRO_CSV, { redirect: 'follow' });
    if (!r.ok) throw new Error(`HTTP ${r.status} ao ler a planilha de cadastro`);
    const texto = await r.text();
    const linhas = texto.split(/\r?\n/).filter(l => l.trim().length);
    if (linhas.length < 2) throw new Error('planilha de cadastro veio vazia');

    const cab = linhaCSV(linhas[0]);
    const cId = acharColuna(cab, ['ID', 'CADASTRO', 'ID CADASTRO', 'NUMERO', 'NUM', 'CODIGO']);
    const cNome = acharColuna(cab, ['NOME', 'ATLETA', 'NOME CURTO']);
    const cPos = acharColuna(cab, ['POSICAO', 'POS', 'FUNCAO']);
    const cSt = acharColuna(cab, ['STATUS', 'SITUACAO', 'ATIVO']);
    if (cId < 0) throw new Error(`coluna de ID não encontrada. Cabeçalho: ${cab.join(' | ')}`);

    const porId = {};
    let ativos = 0;
    for (let i = 1; i < linhas.length; i++) {
      const col = linhaCSV(linhas[i]);
      const id = parseInt(String(col[cId] || '').replace(/\D/g, ''), 10);
      if (!isFinite(id)) continue;
      const status = cSt >= 0 ? semAcento(col[cSt]) : '';
      const reg = {
        cadastroId: id,
        nome: (cNome >= 0 ? col[cNome] : '') || '',
        posicao: (cPos >= 0 ? col[cPos] : '') || '',
        status: status || 'SEM STATUS',
        ativo: status ? status.startsWith('ATIV') : true,
      };
      porId[id] = reg;
      if (reg.ativo) ativos++;
    }
    cacheCadastro = {
      porId,
      total: Object.keys(porId).length,
      ativos,
      colunas: { id: cab[cId], nome: cab[cNome] || null, posicao: cab[cPos] || null, status: cab[cSt] || null },
      erro: null,
    };
    return cacheCadastro;
  } catch (e) {
    // Falha aqui não derruba a extração: o painel segue com a posição da
    // Catapult e avisa na tela que o status não pôde ser lido.
    return { ...vazio, erro: e.message };
  }
}

// ----------------------------------------------------------------------------
// Elenco — nome e posição vêm da própria Catapult
// ----------------------------------------------------------------------------
async function carregarElenco(token) {
  let lista = [];
  try {
    lista = await catapultGET('/athletes', token);
  } catch (e) {
    return { porId: {}, porNome: {}, erro: e.message };
  }
  const porId = {};
  const porNome = {};
  for (const a of lista || []) {
    const { cadastroId, nome } = lerNomeAtleta(a.first_name || a.name || '');
    const posicao =
      a.position_name || a.position || (a.positions && a.positions[0] && a.positions[0].name) || '';
    const reg = {
      catapultId: a.id ?? null,
      cadastroId,
      nome: nome || (a.last_name || '').trim() || String(a.id),
      posicao,
      grupo: grupoPosicional(posicao),
    };
    if (cadastroId != null) porId[cadastroId] = reg;
    porNome[semAcento(reg.nome)] = reg;
  }
  return { porId, porNome, erro: null };
}

// ----------------------------------------------------------------------------
// Um jogo
// ----------------------------------------------------------------------------
function meioTempoVazio() {
  return {
    dur: 0, dist: 0, b5: 0, b6: 0, b7: 0,
    acc: 0, decB2: 0, decB3: 0, pl: 0,
    expl: 0, sprintEf: 0, hrMax: 0,
    hrSoma: 0, hrDur: 0, fmpRun: 0, fmpDyn: 0,
  };
}
function auditoriaVazia() {
  const o = { dist: 0 };
  for (let i = 1; i <= 8; i++) { o['vb' + i] = 0; o['ab' + i] = 0; }
  o.accBand7plus = 0;
  return o;
}

async function processarJogo(data, atividades, token, elenco, cadastro) {
  const jogo = atividades.find(
    a =>
      unixParaDataBR(a.start_time || a.start) === data &&
      (a.periods || []).some(p => classificarPeriodo(p.name) !== null)
  );
  if (!jogo) throw new Error(`nenhum jogo encontrado em ${data}`);

  const stats = await catapultPOST('/stats', token, {
    filters: [{ name: 'activity_id', comparison: '=', values: [jogo.id] }],
    parameters: PARAMETERS.concat(PARAMS_AUDITORIA),
    group_by: ['period', 'athlete'],
  });

  const aud = auditoriaVazia();

  const porAtleta = {};
  for (const s of stats || []) {
    const meio = classificarPeriodo(s.period_name);
    if (!meio) continue; // Aquecimento, Suplentes, etc.

    const { cadastroId, nome } = lerNomeAtleta(s.athlete_name);
    const chave = cadastroId != null ? `id:${cadastroId}` : `nm:${semAcento(nome)}`;
    if (!porAtleta[chave]) {
      porAtleta[chave] = { cadastroId, nome, t1: meioTempoVazio(), t2: meioTempoVazio() };
    }
    const acc = porAtleta[chave][meio];
    const dur = s.total_duration || 0;

    acc.dur += dur;
    acc.dist += s.total_distance || 0;
    acc.b5 += s.velocity_band5_total_distance || 0;
    acc.b6 += s.velocity_band6_total_distance || 0;
    acc.b7 += s.velocity_band7_total_distance || 0;
    acc.acc += s.gen2_acceleration_band7plus_total_effort_count || 0;
    acc.decB3 += s.gen2_acceleration_band1_total_effort_count || 0;
    acc.decB2 += s.gen2_acceleration_band2_total_effort_count || 0;
    acc.pl += s.total_player_load || 0;
    acc.expl += s.explosive_efforts_gk || 0;
    acc.sprintEf += s.sprint_efforts || 0;
    acc.fmpRun += s.fmp_running_total_duration || 0;
    acc.fmpDyn += s.fmp_dynamic_total_duration || 0;
    acc.hrMax = Math.max(acc.hrMax, s.percentage_max_heart_rate || 0);
    acc.hrSoma += (s.percentage_avg_heart_rate || 0) * dur;
    acc.hrDur += dur;

    aud.dist += s.total_distance || 0;
    aud.accBand7plus += s.gen2_acceleration_band7plus_total_effort_count || 0;
    for (let i = 1; i <= 8; i++) {
      aud['vb' + i] += s[`velocity_band${i}_total_distance`] || 0;
      aud['ab' + i] += s[`gen2_acceleration_band${i}_total_effort_count`] || 0;
    }
  }
  Object.keys(aud).forEach(k => { aud[k] = round(aud[k], 1); });

  // Todo período visto na atividade, classificado ou não. Serve para auditar
  // contagem de atletas: um substituto some da lista quando o período dele foi
  // nomeado sem o radical 1tempo/2tempo.
  const periodosVistos = {};
  for (const s of stats || []) {
    const pn = (s.period_name || '').trim();
    if (!(pn in periodosVistos)) periodosVistos[pn] = classificarPeriodo(pn);
  }

  const atletas = [];
  const ignorados = [];
  for (const a of Object.values(porAtleta)) {
    const t1Min = a.t1.dur / 60;
    const t2Min = a.t2.dur / 60;
    const min = t1Min + t2Min;
    if (min <= 0) {
      ignorados.push({ nome: a.nome, id: a.cadastroId, motivo: 'sem minutos em 1tempo/2tempo' });
      continue;
    }

    const reg =
      (a.cadastroId != null && elenco.porId[a.cadastroId]) ||
      elenco.porNome[semAcento(a.nome)] ||
      null;
    // O cadastro publicado manda na posição e é a única fonte de status.
    // A Catapult entra só quando o atleta não está na planilha.
    const cad = (a.cadastroId != null && cadastro.porId[a.cadastroId]) || null;
    const posicao = (cad && cad.posicao) || (reg && reg.posicao) || '';

    const hrDur = a.t1.hrDur + a.t2.hrDur;
    atletas.push({
      id: a.cadastroId,
      nome: a.nome || (cad && cad.nome) || (reg && reg.nome) || '',
      posicao: posicao,
      grupo: grupoPosicional(posicao),
      status: cad ? cad.status : 'FORA DO CADASTRO',
      ativo: cad ? cad.ativo : null,
      min: round(min, 1),
      t1Min: round(t1Min, 1),
      t2Min: round(t2Min, 1),
      dist: round(a.t1.dist + a.t2.dist, 0),
      altInt: round(a.t1.b5 + a.t1.b6 + a.t1.b7 + a.t2.b5 + a.t2.b6 + a.t2.b7, 0),
      sprint: round(a.t1.b6 + a.t1.b7 + a.t2.b6 + a.t2.b7, 0),
      acc: round(a.t1.acc + a.t2.acc, 0),
      dec: round(a.t1.decB2 + a.t1.decB3 + a.t2.decB2 + a.t2.decB3, 0),
      pl: round(a.t1.pl + a.t2.pl, 0),
      // FMP em minutos. O % sai no painel, dividindo pelos minutos jogados.
      fmpRun: round((a.t1.fmpRun + a.t2.fmpRun) / 60, 2),
      fmpDyn: round((a.t1.fmpDyn + a.t2.fmpDyn) / 60, 2),
      hrMax: round(Math.max(a.t1.hrMax, a.t2.hrMax), 1),
      hrMed: round(hrDur > 0 ? (a.t1.hrSoma + a.t2.hrSoma) / hrDur : 0, 1),
      expl: round(a.t1.expl + a.t2.expl, 0),
      sprintEf: round(a.t1.sprintEf + a.t2.sprintEf, 0),
      // Por tempo — permite ler queda de intensidade sem nova chamada
      t1Dist: round(a.t1.dist, 0),
      t2Dist: round(a.t2.dist, 0),
      t1AltInt: round(a.t1.b5 + a.t1.b6 + a.t1.b7, 0),
      t2AltInt: round(a.t2.b5 + a.t2.b6 + a.t2.b7, 0),
    });
  }

  // Atleta que aparece no /stats só em Aquecimento ou Suplentes nunca chega aqui:
  // o laço de agregação já descartou o período. Registramos os nomes vistos para
  // a conferência de elenco do painel.
  const vistosNoJogo = {};
  for (const s of stats || []) {
    const { nome } = lerNomeAtleta(s.athlete_name);
    if (!vistosNoJogo[nome]) vistosNoJogo[nome] = [];
    const pn = (s.period_name || '').trim();
    if (vistosNoJogo[nome].indexOf(pn) < 0) vistosNoJogo[nome].push(pn);
  }
  const naLista = {};
  atletas.forEach(a => { naLista[a.nome] = 1; });
  Object.keys(vistosNoJogo).forEach(nome => {
    if (naLista[nome]) return;
    if (ignorados.some(i => i.nome === nome)) return;
    ignorados.push({ nome, motivo: 'só em ' + vistosNoJogo[nome].join(', ') });
  });

  atletas.sort((x, y) => y.min - x.min);
  return {
    data, id: jogo.id, nome: (jogo.name || '').trim(), atletas, ignorados, auditoria: aud,
    periodos: Object.keys(periodosVistos).map(n => ({ nome: n, classificado: periodosVistos[n] })),
  };
}

async function emLotes(itens, tamanho, fn) {
  const saida = [];
  for (let i = 0; i < itens.length; i += tamanho) {
    const r = await Promise.all(itens.slice(i, i + tamanho).map(fn));
    saida.push(...r);
  }
  return saida;
}

// ----------------------------------------------------------------------------
// Handler
// ----------------------------------------------------------------------------
export default async function handler(req, res) {
  setCORS(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const token = process.env.CATAPULT_TOKEN;
  if (!token) return res.status(500).json({ error: 'CATAPULT_TOKEN não configurado' });

  try {
    // --- Modo lista: só descobre quais jogos existem no período -------------
    if (req.query.listar) {
      const ini = parseDataBR(req.query.ini) || { d: 1, m: 1, y: new Date().getUTCFullYear() };
      const fimQ = parseDataBR(req.query.fim);
      const hoje = new Date(Date.now() - 3 * 3600 * 1000);
      const fim = fimQ || {
        d: hoje.getUTCDate() + 1,
        m: hoje.getUTCMonth() + 1,
        y: hoje.getUTCFullYear(),
      };

      const de = meiaNoiteBRT(ini.y, ini.m, ini.d);
      const ate = meiaNoiteBRT(fim.y, fim.m, fim.d);
      if (ate <= de) return res.status(400).json({ error: '?fim precisa ser depois de ?ini' });

      const blocos = [];
      for (let s = de; s < ate; s += CHUNK_DAYS * 24 * 3600) {
        blocos.push({ start: s, end: Math.min(s + CHUNK_DAYS * 24 * 3600 - 1, ate) });
      }
      const listas = await Promise.all(
        blocos.map(b => catapultGET(`/activities?start_time=${b.start}&end_time=${b.end}`, token))
      );

      const vistos = new Set();
      const jogos = [];
      for (const lista of listas) {
        for (const a of lista || []) {
          if (!a || a.id == null || vistos.has(a.id)) continue;
          vistos.add(a.id);
          const temTempo = (a.periods || []).some(p => classificarPeriodo(p.name) !== null);
          if (!temTempo) continue;
          jogos.push({
            data: unixParaDataBR(a.start_time || a.start),
            id: a.id,
            nome: (a.name || '').trim(),
          });
        }
      }
      jogos.sort((a, b) => {
        const ka = a.data.split('/').reverse().join('');
        const kb = b.data.split('/').reverse().join('');
        return kb.localeCompare(ka);
      });
      return res.status(200).json({ total: jogos.length, jogos });
    }

    // --- Modo cadastro: confere a leitura da planilha ------------------------
    if (req.query.cadastro) {
      const c = await carregarCadastro();
      return res.status(200).json({
        origem: CADASTRO_CSV,
        colunas_reconhecidas: c.colunas,
        total: c.total,
        ativos: c.ativos,
        erro: c.erro,
        atletas: Object.values(c.porId).sort((a, b) => a.cadastroId - b.cadastroId),
      });
    }

    // --- Modo dados: um lote de datas --------------------------------------
    const datas = String(req.query.datas || '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);

    if (!datas.length) {
      return res.status(400).json({
        error: 'Informe ?datas=DD/MM/YYYY,... ou use ?listar=1',
        max_datas_por_chamada: MAX_DATAS,
      });
    }
    if (datas.length > MAX_DATAS) {
      return res.status(400).json({
        error: `Máximo de ${MAX_DATAS} datas por chamada (recebidas ${datas.length}). Peça em lotes.`,
      });
    }
    for (const d of datas) {
      if (!parseDataBR(d)) return res.status(400).json({ error: `Data inválida: ${d}` });
    }

    // Uma varredura de /activities cobrindo todas as datas do lote
    const janelas = datas.map(janelaDia);
    const start = Math.min(...janelas.map(j => j.start));
    const end = Math.max(...janelas.map(j => j.end));

    const blocos = [];
    for (let s = start; s < end; s += CHUNK_DAYS * 24 * 3600) {
      blocos.push({ start: s, end: Math.min(s + CHUNK_DAYS * 24 * 3600 - 1, end) });
    }
    const listas = await Promise.all(
      blocos.map(b => catapultGET(`/activities?start_time=${b.start}&end_time=${b.end}`, token))
    );
    const vistos = new Set();
    const atividades = [];
    for (const lista of listas) {
      for (const a of lista || []) {
        if (a && a.id != null && !vistos.has(a.id)) {
          vistos.add(a.id);
          atividades.push(a);
        }
      }
    }

    const [elenco, cadastro] = await Promise.all([carregarElenco(token), carregarCadastro()]);

    const falhas = [];
    const resultados = await emLotes(datas, CONCURRENCY, d =>
      processarJogo(d, atividades, token, elenco, cadastro).catch(err => {
        falhas.push({ data: d, motivo: err.message });
        return null;
      })
    );

    return res.status(200).json({
      gerado_em: new Date().toISOString(),
      parametros: PARAMETERS,
      bandas: {
        alta_intensidade: 'B5+B6+B7 (≥ 19,80 km/h)',
        sprint: 'B6+B7 (≥ 25,20 km/h)',
        confirmado_em: '19/08/2026',
      },
      fmp: 'fmp_running_total_duration e fmp_dynamic_total_duration, convertidos para minutos',
      elenco_erro: elenco.erro,
      cadastro: {
        total: cadastro.total, ativos: cadastro.ativos,
        colunas: cadastro.colunas, erro: cadastro.erro,
      },
      jogos: resultados.filter(Boolean),
      falhas,
    });
  } catch (err) {
    console.error('comparativo:', err);
    return res.status(500).json({ error: err.message });
  }
}

// Nome adicional, para quem quiser plugar esta rota num despachante
// (padrão api/index.js, usado no Fec-performance) em vez de publicar como
// função própria. A assinatura é a mesma: (req, res).
export { handler as rotaComparativo };
