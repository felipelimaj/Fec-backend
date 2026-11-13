// =============================================================================
//  Dashboard de Goleiros FEC — Rotas
//    GET /api/dados            → temporada inteira dos goleiros (sessões prontas)
//    GET /api/sonda            → diagnóstico: slugs, colunas da Tag, períodos
//    GET /api/sonda?activity_id=UUID → + valores dos candidatos numa atividade
// =============================================================================

import {
  INICIO_TEMPORADA, PLANILHAS, METRICAS_CATAPULT, LIMITES, slugsConfirmados, REGRAS_SESSAO,
} from './config.js';
import {
  catapultGET, buscarAtividades, statsDoLote, emGrupos, parametrosDoTenant,
  hojeIsoBRT, unixParaIsoBRT, contador,
} from './catapult.js';
import { baixarCSV, lerCadastro, lerTag } from './planilhas.js';
import {
  montarSessoes, aplicarTag, atividadeRelevante, idDoNome, ehJogo, ehPeriodoJogoGoleiro, ehBlocoTreino,
} from './goleiros.js';

// IDs da Catapult dos goleiros (para o filtro de atleta no /stats)
async function idsCatapultDosGoleiros(token, idsCadastro) {
  try {
    const lista = await catapultGET('/athletes', token);
    const alvo = new Set(idsCadastro);
    return (Array.isArray(lista) ? lista : [])
      .filter(a => alvo.has(idDoNome(a.first_name ? `${a.first_name} ${a.last_name || ''}` : a.name).id))
      .map(a => a.id)
      .filter(Boolean);
  } catch {
    return []; // sem a lista, o /stats vai sem filtro de atleta e o recorte é pelo nome
  }
}

// Resumo das métricas para o painel saber o que mostrar e o que está pendente
function estadoDasMetricas() {
  const out = {};
  for (const [k, m] of Object.entries(METRICAS_CATAPULT)) {
    out[k] = { slug: m.slug, status: m.status, un: m.un, nota: m.nota };
  }
  out.pse = { slug: null, status: 'planilha', un: 'CR-10', nota: 'GRUPOS TAG, Página1' };
  out.spse = { slug: null, status: 'calculada', un: 'u.a.', nota: 'PSE × duração da sessão do goleiro (min)' };
  return out;
}

// -----------------------------------------------------------------------------
//  GET /api/dados
// -----------------------------------------------------------------------------
export async function dados(req, res, token) {
  contador.zerar();
  const avisos = [];
  const fim = hojeIsoBRT();

  // 1. Planilhas (não dependem da Catapult)
  const goleiros = lerCadastro(await baixarCSV(PLANILHAS.cadastro, 'Cadastro de Atletas'));
  if (!goleiros.length) throw new Error('Nenhum goleiro no Cadastro (POSIÇÃO = GOLEIRO).');
  let tag = { porChave: new Map(), diag: null };
  try {
    tag = lerTag(await baixarCSV(PLANILHAS.tag, 'GRUPOS TAG'), goleiros.map(g => g.id));
    if (!tag.diag.colunaPSE) avisos.push(`PSE: ${tag.diag.criterioPSE}. Os gráficos de PSE ficam vazios até isso ser resolvido.`);
  } catch (e) {
    avisos.push(`GRUPOS TAG indisponível (${e.message}). Sem PSE, Grupo e Dia Código nesta carga.`);
  }

  // 2. Atividades da temporada
  const { atividades, falhas } = await buscarAtividades(INICIO_TEMPORADA, fim, token, LIMITES.diasPorBlocoAtividades);
  if (falhas.length) avisos.push(`${falhas.length} bloco(s) de /activities falharam; parte da temporada pode estar faltando.`);
  const relevantes = atividades
    .filter(atividadeRelevante)
    .sort((a, b) => (a.start_time || 0) - (b.start_time || 0));

  // 3. /stats em lotes
  const lotes = [];
  for (let i = 0; i < relevantes.length; i += LIMITES.atividadesPorStats) {
    lotes.push(relevantes.slice(i, i + LIMITES.atividadesPorStats).map(a => a.id));
  }
  if (lotes.length > LIMITES.maxChamadasStats) {
    avisos.push(`Temporada com ${relevantes.length} atividades: carregadas só as ${LIMITES.maxChamadasStats * LIMITES.atividadesPorStats} mais recentes.`);
    lotes.splice(0, lotes.length - LIMITES.maxChamadasStats);
  }
  const athleteIds = await idsCatapultDosGoleiros(token, goleiros.map(g => g.id));
  // Slug inexistente dentro do POST pode derrubar a chamada inteira: cruza com
  // /parameters antes. Se o catálogo não responder, segue com a lista da config.
  let parametros = slugsConfirmados();
  try {
    const catalogo = new Set((await parametrosDoTenant(token)).map(p => p.slug));
    const faltando = parametros.filter(s => !catalogo.has(s));
    if (faltando.length) {
      avisos.push(`Slug(s) confirmados que o tenant não declara mais: ${faltando.join(', ')} — ficaram fora desta carga.`);
      parametros = parametros.filter(s => catalogo.has(s));
    }
  } catch { /* segue com a config */ }
  let filtroAtleta = null;
  const agrupamentos = new Set();
  const respostas = await emGrupos(lotes, LIMITES.paralelo, async ids => {
    const r = await statsDoLote(ids, parametros, token, athleteIds);
    filtroAtleta = filtroAtleta === null ? r.filtroAtleta : (filtroAtleta && r.filtroAtleta);
    agrupamentos.add(r.groupBy);
    return r.rows;
  });
  const linhas = respostas.flat();

  // 4. Sessões + Tag
  const { sessoes, diag } = montarSessoes({ atividades: relevantes, linhas, goleiros });
  const diagTag = aplicarTag(sessoes, tag.porChave);
  if (diag.linhasSemAtividade) avisos.push(`${diag.linhasSemAtividade} linha(s) do /stats sem atividade identificada — rode /api/sonda.`);
  if (diagTag.pseAmbigua) avisos.push(`${diagTag.pseAmbigua} sessão(ões) em dia duplo sem PSE atribuída (a Tag tem uma linha por dia).`);

  // Só goleiros que têm sessão na temporada vão para o seletor
  const comSessao = new Set(sessoes.map(s => s.gk));
  const lista = goleiros.filter(g => comSessao.has(g.id)).map(g => ({
    ...g, sessoes: sessoes.filter(s => s.gk === g.id).length,
  }));

  res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=86400');
  return res.status(200).json({
    atualizado_em: new Date().toISOString(),
    temporada: { inicio: INICIO_TEMPORADA, fim },
    metricas: estadoDasMetricas(),
    goleiros: lista,
    sessoes,
    avisos,
    diagnostico: {
      chamadasCatapult: contador.chamadas,
      atividadesNaTemporada: atividades.length,
      atividadesComBlocoDeGoleiro: relevantes.length,
      lotesStats: lotes.length,
      filtroDeAtletaAceito: filtroAtleta,
      agrupamentoStats: [...agrupamentos],
      sessoes: diag,
      tag: { ...tag.diag, ...diagTag },
      goleirosNoCadastro: goleiros.map(g => ({ id: g.id, nome: g.nome })),
    },
  });
}

// -----------------------------------------------------------------------------
//  GET /api/sonda[?activity_id=UUID][&dias=30]
//  Responde, antes de confiar num número novo:
//   1. quais slugs de goleiro o tenant declara (/parameters);
//   2. como a Página1 da GRUPOS TAG foi lida (coluna da PSE, datas);
//   3. que períodos aparecem nas atividades recentes e quais contariam;
//   4. se o /stats em lote com filtro de atleta funciona e devolve a atividade;
//   5. com activity_id: o total de cada candidato por goleiro nessa atividade,
//      para comparar com o OpenField.
// -----------------------------------------------------------------------------
export async function sonda(req, res, token) {
  contador.zerar();
  const saida = { gerado_em: new Date().toISOString() };

  // 1. Catálogo de parâmetros
  let catalogo = null;
  try {
    catalogo = await parametrosDoTenant(token);
    const RE = /dive|goalkeep|keeper|explos|esfor|jump|salto/i;
    saida.parametros = {
      total: catalogo.length,
      relacionados_no_tenant: catalogo.filter(p => RE.test(p.slug) || RE.test(p.name))
        .map(p => ({ slug: p.slug, nome: p.name })).sort((a, b) => a.slug.localeCompare(b.slug)),
      metricas: Object.fromEntries(Object.entries(METRICAS_CATAPULT).map(([k, m]) => {
        const tem = s => catalogo.some(p => p.slug === s);
        return [k, {
          status: m.status,
          slug: m.slug,
          slug_existe_no_tenant: m.slug ? tem(m.slug) : null,
          candidatos_que_existem: (m.candidatos || []).filter(tem),
        }];
      })),
    };
  } catch (e) {
    saida.parametros = { erro: e.message };
  }

  // 2. Planilhas
  let goleiros = [];
  try {
    goleiros = lerCadastro(await baixarCSV(PLANILHAS.cadastro, 'Cadastro de Atletas'));
    saida.cadastro = { goleiros: goleiros.map(g => ({ id: g.id, nome: g.nome, foto: !!g.foto })) };
  } catch (e) { saida.cadastro = { erro: e.message }; }
  try {
    const t = lerTag(await baixarCSV(PLANILHAS.tag, 'GRUPOS TAG'), goleiros.map(g => g.id));
    const ultimas = [...t.porChave.entries()].sort((a, b) => (a[0].split('|')[1] < b[0].split('|')[1] ? 1 : -1)).slice(0, 10);
    saida.tag = { ...t.diag, ultimas_linhas_de_goleiros: ultimas.map(([k, v]) => ({ chave: k, linhas: v })) };
  } catch (e) { saida.tag = { erro: e.message }; }

  // 3. Períodos das atividades recentes
  const dias = Math.min(Math.max(parseInt(req.query.dias, 10) || 21, 1), 60);
  const fim = hojeIsoBRT();
  const iniDate = new Date(Date.parse(fim) - dias * 864e5).toISOString().slice(0, 10);
  let recentes = [];
  try {
    const r = await buscarAtividades(iniDate, fim, token, 60);
    recentes = r.atividades.sort((a, b) => (b.start_time || 0) - (a.start_time || 0));
    saida.atividades_recentes = recentes.map(a => {
      const nomes = (a.periods || []).map(p => p.name);
      const jogo = ehJogo(nomes);
      return {
        id: a.id,
        data: unixParaIsoBRT(a.start_time || a.start),
        nome: a.name,
        tipo: jogo ? 'jogo' : 'treino',
        periodos: nomes,
        contariam_para_goleiro: nomes.filter(n => (jogo ? ehPeriodoJogoGoleiro(n) : ehBlocoTreino(n))),
        periodos_tem_id: (a.periods || []).every(p => !!p.id),
      };
    });
  } catch (e) { saida.atividades_recentes = { erro: e.message }; }

  // 4 e 5. /stats numa atividade (a pedida ou a mais recente com bloco de goleiro)
  const alvo = req.query.activity_id
    || (recentes.find(atividadeRelevante) || {}).id;
  if (alvo) {
    const candidatos = Object.values(METRICAS_CATAPULT)
      .flatMap(m => [m.slug, ...(m.candidatos || [])]).filter(Boolean);
    const pedir = catalogo ? candidatos.filter(s => catalogo.some(p => p.slug === s)) : candidatos;
    const athleteIds = await idsCatapultDosGoleiros(token, goleiros.map(g => g.id));
    try {
      const { rows, filtroAtleta, groupBy } = await statsDoLote([alvo], [...new Set(pedir)], token, athleteIds);
      const primeira = rows[0] || {};
      const porGK = {};
      for (const l of rows) {
        const { id, nome } = idDoNome(l.athlete_name);
        if (!goleiros.some(g => g.id === id)) continue;
        const k = `${id} ${nome}`;
        porGK[k] = porGK[k] || { periodos: [] };
        porGK[k].periodos.push({
          periodo: l.period_name,
          ...Object.fromEntries(pedir.map(s => [s, l[s] ?? null])),
        });
      }
      saida.stats_teste = {
        activity_id: alvo,
        filtro_de_atleta_aceito: filtroAtleta,
        agrupamento_aceito: groupBy,
        linhas: rows.length,
        campos_da_primeira_linha: Object.keys(primeira),
        traz_activity_id: 'activity_id' in primeira,
        traz_period_id: 'period_id' in primeira,
        slugs_pedidos: pedir,
        por_goleiro: porGK,
      };
    } catch (e) {
      saida.stats_teste = { activity_id: alvo, erro: e.message, detalhe: e.detalhe || null };
    }
  }

  saida.regras = {
    inicio_temporada: INICIO_TEMPORADA,
    jogo: '1goleiro + 2goleiro',
    treino: 'períodos com "goleiros" no nome',
    corte_minimo_treino_min: REGRAS_SESSAO.duracaoMinimaTreinoMin,
  };
  saida.chamadas_catapult = contador.chamadas;
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json(saida);
}
