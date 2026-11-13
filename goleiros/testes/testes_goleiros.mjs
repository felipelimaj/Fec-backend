// testes_goleiros.mjs — verificação offline do backend do Dashboard de Goleiros.
// Catapult e planilhas SIMULADAS (nenhum dado real). Rodar com:
//     node testes/testes_goleiros.mjs
//
// O que estes testes protegem, em ordem de gravidade:
//  1. A SESSÃO CERTA. Treino = só o bloco "goleiros"; jogo = 1goleiro + 2goleiro,
//     sem o aquecimento "Goleiros". Reserva em atividade de jogo não vira sessão.
//  2. NENHUM SLUG PENDENTE é pedido à Catapult (carga de mergulho e explosivos
//     só entram depois da conferência do Felipe).
//  3. PSE NO LUGAR CERTO. Tag é por atleta e por dia: dia duplo com uma linha
//     na Tag não recebe PSE em nenhuma das duas sessões.
//  4. DATAS DA TAG em M/D/AA e M/D/AAAA, com o desempate pelo "dd-mm" do ADV.
//  5. ORÇAMENTO DE CHAMADAS abaixo das ~70 que a Catapult tolera por varredura.

import { usarFetch } from '../lib/catapult.js';
import { usarFetchPlanilhas, dataTag, acharColunaPSE, lerTag, parseCSV, lerCadastro, normaliza } from '../lib/planilhas.js';
import { dados, sonda } from '../lib/handlers.js';
import { ehBlocoTreino, ehPeriodoJogoGoleiro, ehJogo, adversarioDe, idDoNome } from '../lib/goleiros.js';
import { PLANILHAS } from '../lib/config.js';

let ok = 0, falhas = 0;
function confere(cond, msg) {
  if (cond) { ok++; } else { falhas++; console.log('  ✗', msg); }
}
const perto = (a, b, tol = 1e-6) => a !== null && b !== null && Math.abs(a - b) <= tol;

// -----------------------------------------------------------------------------
//  Fixture (fictícia)
// -----------------------------------------------------------------------------
const unix = (iso, h) => Math.floor(Date.UTC(...iso.split('-').map((v, i) => (i === 1 ? v - 1 : +v)), h + 3, 0, 0) / 1000);
const P = (id, name) => ({ id, name });

const ATIVIDADES = [
  { id: 'A1', name: 'Treino 10/03', start_time: unix('2026-03-10', 9),
    periods: [P('p11', 'Aquecimento'), P('p12', 'Goleiros'), P('p13', 'Principal')] },
  { id: 'A2', name: 'Jogo x Ceará', start_time: unix('2026-03-12', 19),
    periods: [P('p21', 'Goleiros'), P('p22', '1goleiro'), P('p23', '2goleiro'), P('p24', '1tempo'), P('p25', '2tempo')] },
  { id: 'A3', name: 'Treino manhã', start_time: unix('2026-03-14', 8),
    periods: [P('p31', 'goleiros - finalização'), P('p32', 'Principal')] },
  { id: 'A4', name: 'Treino tarde', start_time: unix('2026-03-14', 16),
    periods: [P('p41', 'GOLEIROS'), P('p42', 'Principal')] },
  { id: 'A5', name: 'Regenerativo', start_time: unix('2026-03-13', 9),
    periods: [P('p51', 'Regenerativo')] },            // sem bloco de goleiro: não pode ir ao /stats
  { id: 'A6', name: 'Treino 20/03', start_time: unix('2026-03-20', 9),
    periods: [P('p61', 'Goleiros')] },
];

// [periodo_id, periodo, atleta, dur_s, dist, pl, mergulhos]
const LINHAS = [
  ['p11', 'Aquecimento', '11 JOÃO.R', 900, 800, 80, 2],
  ['p12', 'Goleiros', '11 JOÃO.R', 3000, 1900, 210, 30],
  ['p13', 'Principal', '11 JOÃO.R', 1800, 1200, 120, 4],
  ['p12', 'Goleiros', '31 L. SASHA', 2700, 1700, 190, 25],
  ['p12', 'Goleiros', '109 RODRIGUINHO', 0, 0, 0, 0],          // linha de jogador de linha
  ['p21', 'Goleiros', '11 JOÃO.R', 1200, 700, 60, 9],           // aquecimento no jogo: fica fora
  ['p22', '1goleiro', '11 JOÃO.R', 2880, 2200, 170, 2],
  ['p23', '2goleiro', '11 JOÃO.R', 3000, 2350, 175, 3],
  ['p21', 'Goleiros', '31 L. SASHA', 1200, 650, 55, 11],        // reserva: só aquecimento → sem sessão
  ['p31', 'goleiros - finalização', '31 L. SASHA', 2400, 1500, 160, 20],
  ['p41', 'GOLEIROS', '31 L. SASHA', 2100, 1400, 150, 18],
  ['p61', 'Goleiros', '31 L. SASHA', 3600, 2000, 220, 33],
];

const CADASTRO_CSV = [
  'ID,ATLETA,POSIÇÃO,STATUS,FOTO',
  '11,JOÃO RICARDO,GOLEIRO,ATIVO,https://exemplo.invalid/joao.png',
  '31,LUCAS SASHA,Goleiro,ATIVO,',
  '109,RODRIGUINHO,MEIA,ATIVO,',
].join('\n');

const TAG_CSV = [
  'Nome Catapult,ID,Data,Grupo,Dia Código,ADV,PSE,PSE Sessão',
  '11 JOÃO.R,11,3/10/26,g1,D_-2,TREINO 10-03,4,999',
  '31 L. SASHA,31,3/10/2026,g3,D_-2,TREINO 10-03,"3,5",',
  '11 JOÃO.R,11,3/12/26,g1,D_0,CEARÁ (C) 12-03,7,',
  '31 L. SASHA,31,3/12/26,g2,D_0,CEARÁ (C) 12-03,5,',
  '31 L. SASHA,31,3/14/26,g3,D_+2,TREINO 14-03,6,',      // 1 linha para 2 sessões no dia
  '31 L. SASHA,31,3/20/26,g3,D_-1,TREINO 20-03,12,',     // PSE inválida (fora de 0–10)
  '109 RODRIGUINHO,109,3/10/26,g1,D_-2,TREINO 10-03,5,',
].join('\n');

// -----------------------------------------------------------------------------
//  Catapult simulada
// -----------------------------------------------------------------------------
const log = [];
let modo = { comActivityId: true, recusaFiltroAtleta: false };
function resposta(corpo, status = 200) {
  return { ok: status < 400, status, json: async () => corpo, text: async () => JSON.stringify(corpo) };
}
async function catapultFake(url, opts = {}) {
  const u = new URL(url);
  const rota = u.pathname.replace('/api/v6', '');
  log.push({ rota, metodo: opts.method || 'GET', corpo: opts.body ? JSON.parse(opts.body) : null });
  if (rota === '/athletes') {
    return resposta([
      { id: 'cat-11', first_name: '11', last_name: 'JOÃO.R' },
      { id: 'cat-31', first_name: '31', last_name: 'L. SASHA' },
      { id: 'cat-109', first_name: '109', last_name: 'RODRIGUINHO' },
    ]);
  }
  if (rota === '/parameters') {
    return resposta(['total_duration', 'total_distance', 'total_player_load', 'total_goalkeeping_dives',
      'explosive_efforts_gk', 'esforços_explosivos_2'].map(s => ({ slug: s, name: s })));
  }
  if (rota === '/activities') {
    const s = Number(u.searchParams.get('start_time')), e = Number(u.searchParams.get('end_time'));
    return resposta(ATIVIDADES.filter(a => a.start_time >= s && a.start_time <= e));
  }
  if (rota === '/stats') {
    const corpo = JSON.parse(opts.body);
    const fA = corpo.filters.find(f => f.name === 'activity_id');
    const fT = corpo.filters.find(f => f.name === 'athlete_id');
    if (fT && modo.recusaFiltroAtleta) return resposta({ erro: 'filtro inválido' }, 422);
    if (modo.recusaGroupActivity && corpo.group_by.includes('activity')) return resposta({ erro: 'group_by inválido' }, 400);
    const desconhecido = corpo.parameters.find(p => !['total_duration', 'total_distance', 'total_player_load',
      'total_goalkeeping_dives', 'explosive_efforts_gk', 'esforços_explosivos_2'].includes(p));
    if (desconhecido) return resposta({ erro: `parâmetro ${desconhecido}` }, 400);
    const ids = new Set(fA.values);
    const periodoAtv = new Map(ATIVIDADES.flatMap(a => a.periods.map(p => [p.id, a.id])));
    const nomeCat = { 'cat-11': '11 JOÃO.R', 'cat-31': '31 L. SASHA', 'cat-109': '109 RODRIGUINHO' };
    const permitidos = fT ? new Set(fT.values.map(v => nomeCat[v])) : null;
    const rows = LINHAS.filter(l => ids.has(periodoAtv.get(l[0])) && (!permitidos || permitidos.has(l[2])))
      .map(l => {
        const r = { period_id: l[0], period_name: l[1], athlete_name: l[2], athlete_id: 'x' };
        if (modo.comActivityId && corpo.group_by.includes('activity')) r.activity_id = periodoAtv.get(l[0]);
        const vals = { total_duration: l[3], total_distance: l[4], total_player_load: l[5], total_goalkeeping_dives: l[6],
          explosive_efforts_gk: 99, 'esforços_explosivos_2': 77 };
        for (const p of corpo.parameters) r[p] = vals[p];
        return r;
      });
    return resposta(rows);
  }
  return resposta({ erro: 'rota não simulada' }, 404);
}
async function planilhaFake(url) {
  const txt = url === PLANILHAS.cadastro ? CADASTRO_CSV : url === PLANILHAS.tag ? TAG_CSV : null;
  return txt === null ? resposta('', 404) : { ok: true, status: 200, text: async () => txt };
}
usarFetch(catapultFake);
usarFetchPlanilhas(planilhaFake);

function resFake() {
  return {
    headers: {}, code: null, body: null,
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.code = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

// -----------------------------------------------------------------------------
console.log('1. Regras de período');
confere(ehBlocoTreino('Goleiros') && ehBlocoTreino('goleiros - finalização') && ehBlocoTreino('GOLEIROS'), 'bloco "goleiros" em qualquer caixa');
confere(!ehBlocoTreino('1goleiro') && !ehBlocoTreino('Principal'), '1goleiro/Principal não são bloco de treino');
confere(ehPeriodoJogoGoleiro('1goleiro') && ehPeriodoJogoGoleiro('2 goleiro') && !ehPeriodoJogoGoleiro('Goleiros'), '1goleiro/2goleiro reconhecidos, "Goleiros" não');
confere(ehJogo(['Goleiros', '1goleiro']) && ehJogo(['1tempo']) && !ehJogo(['Goleiros', 'Principal']), 'atividade de jogo');
confere(adversarioDe('Jogo x Ceará') === 'Ceará' && adversarioDe('Jogo Xavantes') === 'Jogo Xavantes', 'adversário pelo nome');
confere(idDoNome('11 JOÃO.R').id === 11 && idDoNome('F7 MARIA').id === 7 && idDoNome('SEM ID').id === null, 'ID do Cadastro no nome da Catapult');

console.log('2. Datas e PSE da Tag');
confere(dataTag('3/10/26', 'TREINO 10-03') === '2026-03-10', 'M/D/AA com ADV');
confere(dataTag('3/10/2026', '') === '2026-03-10', 'M/D/AAAA sem ADV (padrão md)');
confere(dataTag('10/3/2026', 'TREINO 10-03', 'md') === '2026-03-10', 'ADV desempata D/M');
confere(dataTag('25/3/2026', '') === '2026-03-25', 'dia > 12 só cabe em D/M');
confere(dataTag('lixo', '') === null, 'data inválida');
const cab = h => h.map(normaliza);
confere(acharColunaPSE(cab(['ID', 'Data', 'PSE', 'PSE Sessão'])).indice === 2, 'escolhe "PSE" e não "PSE Sessão"');
confere(acharColunaPSE(cab(['ID', 'PSE (CR-10)'])).indice === 1, 'aceita "PSE (CR-10)"');
confere(acharColunaPSE(cab(['ID', 'PSE Sessão'])).indice === -1, 'só "PSE Sessão" não vira PSE');
confere(acharColunaPSE(cab(['ID', 'PSE Treino', 'PSE Jogo'])).indice === -1, 'dois candidatos: não chuta');
const tag = lerTag(parseCSV(TAG_CSV), [11, 31]);
confere(tag.diag.colunaPSE === 'PSE', 'coluna PSE detectada na Tag simulada');
confere(tag.diag.pseInvalidas === 1, 'PSE 12 descartada e contada');
confere(tag.porChave.get('31|2026-03-10')[0].pse === 3.5, 'PSE com vírgula decimal');
confere(!tag.porChave.has('109|2026-03-10'), 'linha de jogador de linha não entra');
const gks = lerCadastro(parseCSV(CADASTRO_CSV));
confere(gks.length === 2 && gks.every(g => [11, 31].includes(g.id)), 'Cadastro: só goleiros');

async function rodarDados(m) {
  modo = m; log.length = 0;
  const res = resFake();
  await dados({ query: {}, url: '/api/dados' }, res, 'token-fake');
  return res;
}

for (const cenario of [
  { nome: 'com activity_id e filtro de atleta', comActivityId: true, recusaFiltroAtleta: false },
  { nome: 'sem activity_id (mapa por period_id) e filtro recusado', comActivityId: false, recusaFiltroAtleta: true },
  { nome: 'group_by com atividade recusado (cai para período × atleta)', comActivityId: true, recusaFiltroAtleta: true, recusaGroupActivity: true },
]) {
  console.log(`3. /api/dados — ${cenario.nome}`);
  const res = await rodarDados(cenario);
  confere(res.code === 200, `HTTP 200 (veio ${res.code}: ${JSON.stringify(res.body).slice(0, 200)})`);
  const b = res.body;
  const S = (gk, aid) => b.sessoes.find(s => s.gk === gk && s.atividade_id === aid);

  const t1 = S(11, 'A1');
  confere(t1 && t1.tipo === 'treino' && t1.dur_min === 50 && t1.dist === 1900 && t1.mergulhos === 30,
    'treino: só o bloco Goleiros (50 min, 1900 m, 30 mergulhos)');
  confere(t1 && t1.periodos.join() === 'Goleiros', 'treino: períodos contados');
  const j1 = S(11, 'A2');
  confere(j1 && j1.tipo === 'jogo' && perto(j1.dur_min, 98) && j1.dist === 4550 && j1.mergulhos === 5,
    'jogo: 1goleiro + 2goleiro, sem aquecimento (98 min, 4550 m, 5 mergulhos)');
  confere(j1 && j1.adversario === 'Ceará', 'jogo: adversário');
  confere(!S(31, 'A2'), 'reserva no jogo (só aquecimento) não gera sessão');
  confere(!b.sessoes.some(s => s.atividade_id === 'A5'), 'atividade sem bloco de goleiro fora');
  confere(!b.sessoes.some(s => s.gk === 109), 'jogador de linha fora');

  const pedidos = log.filter(l => l.rota === '/stats').flatMap(l => l.corpo.filters.find(f => f.name === 'activity_id').values);
  confere(!pedidos.includes('A5'), 'A5 (sem bloco) não foi pedida ao /stats');
  const params = log.filter(l => l.rota === '/stats').flatMap(l => l.corpo.parameters);
  confere(!params.includes('explosive_efforts_gk') && !params.includes('esforços_explosivos_2'), 'explosivos pendentes não pedidos');
  confere(b.sessoes.every(s => s.explosivos === null && s.carga_mergulho === null), 'métricas pendentes ficam null');
  confere(b.metricas.explosivos.status === 'pendente' && b.metricas.carga_mergulho.status === 'pendente', 'estado das métricas no payload');

  // PSE e Tag
  confere(t1 && t1.pse === 4 && perto(t1.spse, 200) && t1.grupo === 'G1' && t1.dia_codigo === 'D_-2', 'PSE 4 × 50 min = 200; grupo e Dia Código');
  confere(j1 && j1.pse === 7 && perto(j1.spse, 686), 'jogo: PSE 7 × 98 min = 686');
  const d1 = S(31, 'A3'), d2 = S(31, 'A4');
  confere(d1 && d2 && d1.pse === null && d2.pse === null && d1.aviso_pse && d2.aviso_pse, 'dia duplo com 1 linha na Tag: sem PSE e com aviso');
  confere(d1 && d2 && d1.dia_codigo === 'D_+2' && d2.grupo === 'G3', 'dia duplo: Grupo e Dia Código nas duas');
  const inval = S(31, 'A6');
  confere(inval && inval.pse === null && inval.spse === null, 'PSE inválida não vira número');
  confere(b.goleiros.length === 2 && b.goleiros.find(g => g.id === 31).sessoes === 4, 'seletor: 2 goleiros, Sasha com 4 sessões');
  confere(b.diagnostico.chamadasCatapult < 70, `orçamento de chamadas (${b.diagnostico.chamadasCatapult})`);
  confere(b.diagnostico.filtroDeAtletaAceito === !cenario.recusaFiltroAtleta, 'diagnóstico do filtro de atleta');
  confere(b.diagnostico.agrupamentoStats.join() === (cenario.recusaGroupActivity ? 'period×athlete' : 'activity×period×athlete'), `agrupamento usado (${b.diagnostico.agrupamentoStats})`);
  confere(b.sessoes.every((s, i, a) => i === 0 || a[i - 1].inicio <= s.inicio), 'sessões em ordem cronológica');
  confere(res.headers['Cache-Control'] && /s-maxage/.test(res.headers['Cache-Control']), 'cache de CDN ligado');
}

console.log('4. /api/sonda');
{
  modo = { comActivityId: true, recusaFiltroAtleta: false };
  const res = resFake();
  await sonda({ query: { activity_id: 'A2' }, url: '/api/sonda' }, res, 'token-fake');
  const b = res.body;
  confere(res.code === 200, 'HTTP 200');
  confere(b.parametros.metricas.explosivos.candidatos_que_existem.length === 2, 'sonda acha os 2 candidatos de explosivos');
  confere(b.tag.colunaPSE === 'PSE', 'sonda mostra a coluna de PSE');
  confere(b.stats_teste && b.stats_teste.slugs_pedidos.includes('explosive_efforts_gk'), 'sonda pede os candidatos no /stats');
  confere(b.stats_teste && Object.keys(b.stats_teste.por_goleiro).length === 2, 'sonda separa por goleiro');
}

console.log(`\n${ok} verificações ok, ${falhas} falha(s).`);
process.exit(falhas ? 1 : 0);
