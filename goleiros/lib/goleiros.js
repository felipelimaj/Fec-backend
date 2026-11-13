// =============================================================================
//  Dashboard de Goleiros FEC — Montagem das sessões (lógica pura, sem rede)
//  Tudo que decide "o que é uma sessão do goleiro" mora aqui e é testado em
//  testes/testes_goleiros.mjs com a Catapult simulada.
// =============================================================================

import { REGRAS_SESSAO, METRICAS_CATAPULT } from './config.js';
import { normaliza } from './planilhas.js';
import { unixParaIsoBRT } from './catapult.js';

// A Catapult guarda o ID do Cadastro no nome: "11 JOÃO.R" → 11
export function idDoNome(nomeCatapult) {
  const m = String(nomeCatapult || '').trim().match(/^F?(\d+)\s+(.+)$/);
  return m ? { id: parseInt(m[1], 10), nome: m[2].trim() } : { id: null, nome: String(nomeCatapult || '').trim() };
}

const nomePeriodo = n => normaliza(n).replace(/\s+/g, ' ');
export const ehPeriodoJogoGoleiro = n => REGRAS_SESSAO.periodoJogo.test(nomePeriodo(n));
export const ehPeriodoJogoLinha = n => REGRAS_SESSAO.periodoJogoLinha.test(nomePeriodo(n));
export const ehBlocoTreino = n => REGRAS_SESSAO.periodoBlocoTreino.test(nomePeriodo(n))
  && !ehPeriodoJogoGoleiro(n);

// Jogo = a atividade tem 1tempo/2tempo/1goleiro/2goleiro em algum período.
export function ehJogo(nomesPeriodos) {
  return (nomesPeriodos || []).some(n => ehPeriodoJogoGoleiro(n) || ehPeriodoJogoLinha(n));
}

// Atividade com algum período que pode virar sessão de goleiro.
// Serve para não pedir /stats de atividade que não tem bloco de goleiro.
export function atividadeRelevante(atividade) {
  const nomes = (atividade.periods || []).map(p => p.name);
  if (!nomes.length) return true; // sem lista de períodos: não dá para descartar
  return nomes.some(n => ehPeriodoJogoGoleiro(n) || ehBlocoTreino(n));
}

// "Jogo x Botafogo SP" → "Botafogo SP"
export function adversarioDe(nome) {
  const s = String(nome || '').trim();
  const limpo = s.replace(/^(jogo|fortaleza|fec)?\s*(x|vs\.?|×)(?=\s|$)\s*/i, '').trim();
  return limpo || s;
}

const r0 = v => (v === null ? null : Math.round(v));
const r1 = v => (v === null ? null : Math.round(v * 10) / 10);

function somaCampo(atual, valor) {
  const n = valor === undefined || valor === null || valor === '' ? null : Number(valor);
  if (n === null || !Number.isFinite(n)) return atual;
  return (atual ?? 0) + n;
}

// -----------------------------------------------------------------------------
//  Linhas do /stats (atividade × período × atleta) → sessões por goleiro
// -----------------------------------------------------------------------------
export function montarSessoes({ atividades, linhas, goleiros }) {
  const M = METRICAS_CATAPULT;
  const idsGK = new Set(goleiros.map(g => g.id));
  const porId = new Map(atividades.map(a => [a.id, a]));
  const periodoParaAtividade = new Map();
  for (const a of atividades) for (const p of a.periods || []) if (p?.id) periodoParaAtividade.set(p.id, a.id);

  // Nomes de período por atividade: da lista de /activities ou, na falta, das linhas
  const nomesPorAtividade = new Map();
  for (const a of atividades) nomesPorAtividade.set(a.id, (a.periods || []).map(p => p.name));

  const diag = {
    linhasRecebidas: linhas.length,
    linhasDeGoleiros: 0,
    linhasSemAtividade: 0,
    linhasForaDoBloco: 0,
    periodosContados: {},     // nome do período → quantas linhas entraram
    periodosDescartados: {},  // nome do período → quantas linhas ficaram de fora
    sessoesAbaixoDoCorte: 0,
  };

  const acc = new Map(); // "atividade|gk" → acumulador
  for (const l of linhas) {
    const { id: gk } = idDoNome(l.athlete_name);
    if (!idsGK.has(gk)) continue;
    diag.linhasDeGoleiros++;
    const aid = l.activity_id || periodoParaAtividade.get(l.period_id) || null;
    if (!aid || !porId.has(aid)) { diag.linhasSemAtividade++; continue; }

    let nomes = nomesPorAtividade.get(aid);
    if (!nomes || !nomes.length) {
      nomes = linhas.filter(x => (x.activity_id || periodoParaAtividade.get(x.period_id)) === aid).map(x => x.period_name);
      nomesPorAtividade.set(aid, nomes);
    }
    const jogo = ehJogo(nomes);
    const entra = jogo ? ehPeriodoJogoGoleiro(l.period_name) : ehBlocoTreino(l.period_name);
    const rotulo = String(l.period_name || '(sem nome)');
    if (!entra) {
      diag.linhasForaDoBloco++;
      diag.periodosDescartados[rotulo] = (diag.periodosDescartados[rotulo] || 0) + 1;
      continue;
    }
    diag.periodosContados[rotulo] = (diag.periodosContados[rotulo] || 0) + 1;

    const chave = `${aid}|${gk}`;
    if (!acc.has(chave)) {
      acc.set(chave, {
        aid, gk, jogo, periodos: [],
        dur_s: null, dist: null, pl: null, mergulhos: null, carga_mergulho: null, explosivos: null,
      });
    }
    const a = acc.get(chave);
    a.periodos.push(rotulo);
    a.dur_s = somaCampo(a.dur_s, l[M.duracao.slug]);
    a.dist = somaCampo(a.dist, l[M.distancia.slug]);
    a.pl = somaCampo(a.pl, l[M.player_load.slug]);
    if (M.mergulhos.status === 'confirmado') a.mergulhos = somaCampo(a.mergulhos, l[M.mergulhos.slug]);
    if (M.carga_mergulho.status === 'confirmado') a.carga_mergulho = somaCampo(a.carga_mergulho, l[M.carga_mergulho.slug]);
    if (M.explosivos.status === 'confirmado') a.explosivos = somaCampo(a.explosivos, l[M.explosivos.slug]);
  }

  const corte = REGRAS_SESSAO.duracaoMinimaTreinoMin || 0;
  const sessoes = [];
  for (const a of acc.values()) {
    if (!(a.dur_s > 0)) continue;
    const durMin = a.dur_s / 60;
    if (!a.jogo && corte > 0 && durMin < corte) { diag.sessoesAbaixoDoCorte++; continue; }
    const at = porId.get(a.aid);
    const inicio = Number(at.start_time || at.start || 0);
    sessoes.push({
      atividade_id: a.aid,
      gk: a.gk,
      data: unixParaIsoBRT(inicio),
      inicio,
      tipo: a.jogo ? 'jogo' : 'treino',
      atividade: at.name || '',
      adversario: a.jogo ? adversarioDe(at.name) : null,
      periodos: a.periodos,
      dur_min: r1(durMin),
      dist: r0(a.dist),
      pl: r1(a.pl),
      mergulhos: r0(a.mergulhos),
      carga_mergulho: r1(a.carga_mergulho),
      explosivos: r0(a.explosivos),
      pse: null,
      spse: null,
      grupo: null,
      dia_codigo: null,
      aviso_pse: null,
    });
  }
  sessoes.sort((x, y) => x.inicio - y.inicio || x.gk - y.gk);
  return { sessoes, diag };
}

// -----------------------------------------------------------------------------
//  GRUPOS TAG → Grupo, Dia Código e PSE de cada sessão
//  A Tag é por atleta e por dia. Regras de pareamento:
//   - 1 linha na Tag e 1 sessão no dia → a PSE vai para a sessão.
//   - N linhas e N sessões → pareadas na ordem (planilha × horário de início).
//   - 1 linha e 2+ sessões → PSE não é atribuída (não há como saber de qual
//     sessão ela é) e a sessão leva aviso_pse; Grupo e Dia Código vão para todas.
//  PSE da sessão = PSE × duração da sessão do goleiro (min), como na dissertação.
// -----------------------------------------------------------------------------
export function aplicarTag(sessoes, tagPorChave) {
  const diag = { sessoesComTag: 0, sessoesSemTag: 0, sessoesComPSE: 0, pseAmbigua: 0 };
  const porDia = new Map();
  for (const s of sessoes) {
    const k = `${s.gk}|${s.data}`;
    if (!porDia.has(k)) porDia.set(k, []);
    porDia.get(k).push(s);
  }
  for (const [k, lista] of porDia) {
    lista.sort((a, b) => a.inicio - b.inicio);
    const tags = tagPorChave.get(k) || [];
    if (!tags.length) { diag.sessoesSemTag += lista.length; continue; }
    diag.sessoesComTag += lista.length;
    lista.forEach((s, i) => {
      const t = tags.length === lista.length ? tags[i] : tags[0];
      s.grupo = t.grupo;
      s.dia_codigo = t.diaCodigo;
      if (tags.length === lista.length) {
        s.pse = t.pse;
      } else if (lista.length > 1) {
        s.aviso_pse = `A Tag tem ${tags.length} linha(s) para ${lista.length} sessões neste dia — PSE não atribuída`;
        diag.pseAmbigua++;
      } else {
        s.pse = tags[0].pse; // várias linhas para 1 sessão: vale a primeira
        if (tags.some(x => x.pse !== tags[0].pse)) s.aviso_pse = `A Tag tem ${tags.length} linhas neste dia; usada a primeira`;
      }
      if (s.pse !== null && s.dur_min) {
        s.spse = Math.round(s.pse * s.dur_min * 10) / 10;
        diag.sessoesComPSE++;
      }
    });
  }
  return diag;
}
