// =============================================================================
//  Dashboard de Goleiros FEC — Ponte com a Catapult Connect API v6
// =============================================================================

import { CATAPULT_BASE } from './config.js';

// Status que valem nova tentativa: limite de taxa e indisponibilidade passageira.
// Erro de autenticação ou requisição malformada não repete — repetir não ajuda.
const REPETIVEL = new Set([429, 500, 502, 503, 504]);
const TENTATIVAS = 3;
const espera = ms => new Promise(r => setTimeout(r, ms));

// Permite trocar o fetch nos testes offline (Catapult simulada).
let _fetch = (...a) => fetch(...a);
export function usarFetch(fn) { _fetch = fn; }

// Contador de chamadas por carregamento: o limite medido é ~70 por varredura.
export const contador = { chamadas: 0, zerar() { this.chamadas = 0; } };

async function comRetry(rotulo, fn) {
  let ultimo;
  for (let i = 0; i < TENTATIVAS; i++) {
    try {
      contador.chamadas++;
      const r = await fn();
      if (r.ok) return r.json();
      const corpo = await r.text().catch(() => '');
      const err = new Error(`Catapult ${rotulo} → HTTP ${r.status}`);
      err.status = r.status;
      err.detalhe = corpo.slice(0, 300);
      throw err;
    } catch (e) {
      ultimo = e;
      const vale = e.status ? REPETIVEL.has(e.status) : true; // erro de rede também repete
      if (!vale || i === TENTATIVAS - 1) throw e;
      await espera(400 * 2 ** i);
    }
  }
  throw ultimo;
}

export function catapultGET(path, token) {
  return comRetry(`GET ${path.split('?')[0]}`, () => _fetch(`${CATAPULT_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  }));
}

export function catapultPOST(path, token, body) {
  return comRetry(`POST ${path}`, () => _fetch(`${CATAPULT_BASE}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  }));
}

// -----------------------------------------------------------------------------
//  Datas — tudo em horário de Brasília (UTC-3)
// -----------------------------------------------------------------------------

// "2026-03-14" → unix da meia-noite em Brasília
export function isoParaUnixBRT(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return Math.floor(Date.UTC(y, m - 1, d, 3, 0, 0) / 1000);
}

// unix → "2026-03-14" no dia de Brasília
export function unixParaIsoBRT(unix) {
  const dt = new Date((Number(unix) - 3 * 3600) * 1000);
  const p = n => String(n).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${p(dt.getUTCMonth() + 1)}-${p(dt.getUTCDate())}`;
}

export function hojeIsoBRT() {
  return unixParaIsoBRT(Math.floor(Date.now() / 1000));
}

// -----------------------------------------------------------------------------
//  Atividades e /stats
// -----------------------------------------------------------------------------

// GET /activities em janelas de N dias (a Catapult não devolve a temporada
// inteira de uma vez). Bloco que falha não pode virar "sem atividade" calado:
// se todos falharem, sobe como erro; se só alguns, volta em `falhas`.
export async function buscarAtividades(inicioIso, fimIso, token, diasPorBloco) {
  const ini = isoParaUnixBRT(inicioIso);
  const fim = isoParaUnixBRT(fimIso) + 30 * 3600; // inclui o dia final inteiro (+ jogo noturno)
  const passo = diasPorBloco * 24 * 3600;
  const blocos = [];
  for (let s = ini; s < fim; s += passo) blocos.push({ s, e: Math.min(s + passo - 1, fim) });

  const falhas = [];
  const listas = [];
  for (const b of blocos) {
    try {
      listas.push(await catapultGET(`/activities?start_time=${b.s}&end_time=${b.e}`, token));
    } catch (e) {
      falhas.push(e.message);
      listas.push([]);
    }
  }
  if (blocos.length && falhas.length === blocos.length) {
    const err = new Error(`A Catapult não respondeu em nenhum dos ${blocos.length} blocos de /activities: ${falhas[0]}`);
    err.status = 502;
    throw err;
  }
  const vistos = new Set();
  const todas = [];
  for (const l of listas) {
    for (const a of Array.isArray(l) ? l : []) {
      if (a?.id && !vistos.has(a.id)) { vistos.add(a.id); todas.push(a); }
    }
  }
  return { atividades: todas, falhas };
}

// POST /stats para um lote de atividades, agrupado por atividade × período × atleta.
// Com athleteIds, tenta restringir aos goleiros; se a Catapult recusar o filtro
// de atleta (4xx), repete sem ele e o recorte é feito pelo nome (ID do Cadastro).
//
// Tentativas, da mais enxuta para a mais segura. Só um 4xx (requisição recusada)
// passa para a próxima; 429 e 5xx sobem como erro (o retry já foi feito).
//   1. group_by atividade × período × atleta, com filtro de atleta
//   2. o mesmo, sem filtro de atleta
//   3. group_by período × atleta (a combinação já usada nos outros projetos);
//      a atividade sai do period_id, casado com a lista de /activities
export async function statsDoLote(activityIds, parametros, token, athleteIds) {
  const filtroAtividade = { name: 'activity_id', comparison: '=', values: activityIds };
  const filtroAtleta = { name: 'athlete_id', comparison: '=', values: athleteIds || [] };
  const tentativas = [
    { group_by: ['activity', 'period', 'athlete'], filters: [filtroAtividade, filtroAtleta], comAtleta: true },
    { group_by: ['activity', 'period', 'athlete'], filters: [filtroAtividade], comAtleta: false },
    { group_by: ['period', 'athlete'], filters: [filtroAtividade], comAtleta: false },
  ].filter(t => !t.comAtleta || (athleteIds && athleteIds.length));
  let ultimo;
  for (const t of tentativas) {
    try {
      const rows = await catapultPOST('/stats', token, {
        parameters: parametros, group_by: t.group_by, filters: t.filters,
      });
      return { rows: Array.isArray(rows) ? rows : [], filtroAtleta: t.comAtleta, groupBy: t.group_by.join('×') };
    } catch (e) {
      ultimo = e;
      if (!(e.status >= 400 && e.status < 500) || e.status === 429) throw e;
    }
  }
  throw ultimo;
}

// Executa em grupos de `tam` simultâneos
export async function emGrupos(itens, tam, fn) {
  const out = [];
  for (let i = 0; i < itens.length; i += tam) {
    out.push(...await Promise.all(itens.slice(i, i + tam).map(fn)));
  }
  return out;
}

// GET /parameters → [{ slug, name }]. Formato tolerante (string ou objeto).
export async function parametrosDoTenant(token) {
  const j = await catapultGET('/parameters', token);
  const lista = Array.isArray(j) ? j : (j?.parameters || []);
  return lista.map(p => (typeof p === 'string'
    ? { slug: p, name: p }
    : { slug: String(p.slug || p.name || p.parameter || ''), name: String(p.name || p.slug || '') }))
    .filter(p => p.slug);
}
