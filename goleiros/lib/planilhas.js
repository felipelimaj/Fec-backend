// =============================================================================
//  Dashboard de Goleiros FEC — Planilhas publicadas (Cadastro e GRUPOS TAG)
// =============================================================================

import { INICIO_TEMPORADA, PSE_COLUNA } from './config.js';

let _fetch = (...a) => fetch(...a);
export function usarFetchPlanilhas(fn) { _fetch = fn; }

// "Posição" → "posicao"
export const normaliza = s => String(s ?? '').trim().toLowerCase()
  .normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ');

export function parseCSV(txt) {
  const linhas = [];
  let linha = [], cur = '', dentro = false;
  const s = String(txt).replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"') {
      if (dentro && s[i + 1] === '"') { cur += '"'; i++; } else dentro = !dentro;
    } else if (c === ',' && !dentro) { linha.push(cur); cur = ''; }
    else if ((c === '\n' || c === '\r') && !dentro) {
      if (c === '\r' && s[i + 1] === '\n') i++;
      linha.push(cur); linhas.push(linha); linha = []; cur = '';
    } else cur += c;
  }
  if (cur !== '' || linha.length) { linha.push(cur); linhas.push(linha); }
  return linhas.filter(l => l.some(c => String(c).trim() !== ''));
}

export async function baixarCSV(url, rotulo) {
  const r = await _fetch(url, { redirect: 'follow' });
  if (!r.ok) throw new Error(`${rotulo}: a planilha respondeu HTTP ${r.status}`);
  const txt = await r.text();
  if (!txt.trim() || /^\s*<(!doctype|html)/i.test(txt)) {
    throw new Error(`${rotulo}: a planilha não está publicada em CSV (Arquivo › Compartilhar › Publicar na web)`);
  }
  return parseCSV(txt);
}

// -----------------------------------------------------------------------------
//  Datas da Tag — mesma lógica do converter.js do Carga por Microciclo:
//  CSV publicado vem em M/D/AAAA (às vezes M/D/AA); o "dd-mm" no fim da
//  coluna ADV ("TREINO 09-10", "CEARÁ (F) 08-03") desempata.
// -----------------------------------------------------------------------------
const p2 = n => String(n).padStart(2, '0');
const iso = (y, m, d) => `${y}-${p2(m)}-${p2(d)}`;
function valida(y, m, d) {
  if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31 && y >= 2000)) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export function dataTag(v, adv, padrao = 'md') {
  if (typeof v !== 'string') return null;
  const p = v.trim().split(/[\/\-]/);
  if (p.length !== 3) return null;
  if (p[0].length === 4) return valida(+p[0], +p[1], +p[2]) ? iso(+p[0], +p[1], +p[2]) : null;
  const a = +p[0], b = +p[1];
  let y = +p[2];
  if (y < 100) y += 2000;
  const md = valida(y, a, b) ? iso(y, a, b) : null;
  const dm = valida(y, b, a) ? iso(y, b, a) : null;
  const m = String(adv || '').match(/(\d{2})-(\d{2})\s*$/);
  if (m) {
    const alvo = `-${m[2]}-${m[1]}`;
    if (md && md.slice(4) === alvo) return md;
    if (dm && dm.slice(4) === alvo) return dm;
  }
  if (md && dm) return padrao === 'dm' ? dm : md;
  return md || dm;
}

// PSE em texto: "3", "3,5", "3.5". Fora de 0–10 é descartada (e contada).
export function lerPSE(v) {
  const s = String(v ?? '').trim().replace(',', '.');
  if (!s) return { valor: null, invalida: false };
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0 || n > 10) return { valor: null, invalida: true };
  return { valor: n, invalida: false };
}

// -----------------------------------------------------------------------------
//  Cadastro: goleiros = POSIÇÃO contém "GOLEIR"
// -----------------------------------------------------------------------------
export function lerCadastro(linhas) {
  const iCab = linhas.findIndex(l => l.filter(c => String(c).trim()).length >= 3);
  if (iCab < 0) throw new Error('Cadastro: cabeçalho não encontrado');
  const cab = linhas[iCab].map(normaliza);
  const iId = cab.indexOf('id');
  const iNome = cab.indexOf('atleta');
  const iPos = cab.findIndex(c => c.startsWith('posi'));
  const iFoto = cab.indexOf('foto');
  const iStatus = cab.indexOf('status');
  if (iId < 0 || iPos < 0) throw new Error('Cadastro: faltam as colunas ID e POSIÇÃO');
  const goleiros = [];
  for (const l of linhas.slice(iCab + 1)) {
    const id = parseInt(String(l[iId] || '').trim(), 10);
    if (!id) continue;
    if (!/goleir/i.test(normaliza(l[iPos]))) continue;
    goleiros.push({
      id,
      nome: iNome >= 0 ? String(l[iNome] || '').trim() : `ID ${id}`,
      foto: iFoto >= 0 ? (String(l[iFoto] || '').trim() || null) : null,
      status: iStatus >= 0 ? (String(l[iStatus] || '').trim() || null) : null,
    });
  }
  return goleiros;
}

// -----------------------------------------------------------------------------
//  GRUPOS TAG (Página1)
// -----------------------------------------------------------------------------

// Localiza a coluna da PSE. Prioridade: PSE_COLUNA da config → cabeçalho
// exatamente "pse" ou "rpe" → único cabeçalho que começa com "pse"/"rpe" e não
// é a PSE da sessão (sessão, ×, min, total, carga). Mais de um candidato não é
// resolvido no chute: volta null e a lista vai para o diagnóstico.
export function acharColunaPSE(cabNormalizado) {
  if (PSE_COLUNA) {
    const i = cabNormalizado.indexOf(normaliza(PSE_COLUNA));
    return { indice: i, criterio: i >= 0 ? 'PSE_COLUNA (config)' : 'PSE_COLUNA não encontrada', candidatos: [] };
  }
  for (const exato of ['pse', 'rpe', 'pse (cr-10)', 'pse cr-10', 'pse cr10']) {
    const i = cabNormalizado.indexOf(exato);
    if (i >= 0) return { indice: i, criterio: `cabeçalho "${exato}"`, candidatos: [] };
  }
  const candidatos = cabNormalizado
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => /^(pse|rpe)\b/.test(c) && !/(sess|x|min|total|carga|u\.?a)/.test(c.replace(/^(pse|rpe)/, '')));
  if (candidatos.length === 1) {
    return { indice: candidatos[0].i, criterio: `único cabeçalho começando com PSE: "${candidatos[0].c}"`, candidatos: [] };
  }
  return {
    indice: -1,
    criterio: candidatos.length ? 'mais de uma coluna possível — defina PSE_COLUNA' : 'nenhuma coluna de PSE encontrada',
    candidatos: candidatos.map(x => x.c),
  };
}

// Devolve, para os IDs pedidos, as linhas da Tag por "id|data" (em ordem de
// aparição na planilha), além do diagnóstico de leitura.
export function lerTag(linhas, idsGoleiros) {
  const cabOriginal = linhas[0].map(c => String(c || '').trim());
  const cab = cabOriginal.map(normaliza);
  const iId = cab.indexOf('id');
  const iData = cab.indexOf('data');
  const iGrupo = cab.indexOf('grupo');
  const iCod = cab.indexOf('dia codigo');
  const iAdv = cab.indexOf('adv');
  if (iId < 0 || iData < 0) throw new Error('GRUPOS TAG: a Página1 precisa das colunas ID e Data');
  const pse = acharColunaPSE(cab);

  // Formato predominante das datas (desempate quando o ADV não ajuda)
  let votoMD = 0, votoDM = 0;
  for (const l of linhas.slice(1)) {
    const q = String(l[iData] || '').trim().split('/');
    if (q.length !== 3) continue;
    if (+q[0] > 12) votoDM++; else if (+q[1] > 12) votoMD++;
  }
  const padrao = votoDM > votoMD ? 'dm' : 'md';

  const alvo = new Set(idsGoleiros.map(String));
  const porChave = new Map();
  const diag = {
    cabecalho: cabOriginal,
    colunaPSE: pse.indice >= 0 ? cabOriginal[pse.indice] : null,
    criterioPSE: pse.criterio,
    candidatosPSE: pse.candidatos,
    colunaGrupo: iGrupo >= 0 ? cabOriginal[iGrupo] : null,
    colunaDiaCodigo: iCod >= 0 ? cabOriginal[iCod] : null,
    formatoDatas: padrao === 'md' ? 'M/D/AAAA' : 'D/M/AAAA',
    linhasGoleiros: 0,
    datasInvalidas: 0,
    pseInvalidas: 0,
    pseVazias: 0,
  };

  for (const l of linhas.slice(1)) {
    const id = String(l[iId] || '').trim().replace(/\.0$/, '');
    if (!alvo.has(id)) continue;
    const d = dataTag(String(l[iData] || ''), iAdv >= 0 ? l[iAdv] : '', padrao);
    if (!d) { diag.datasInvalidas++; continue; }
    if (d < INICIO_TEMPORADA) continue;
    diag.linhasGoleiros++;
    let pseValor = null;
    if (pse.indice >= 0) {
      const r = lerPSE(l[pse.indice]);
      pseValor = r.valor;
      if (r.invalida) diag.pseInvalidas++;
      else if (r.valor === null) diag.pseVazias++;
    }
    const chave = `${id}|${d}`;
    if (!porChave.has(chave)) porChave.set(chave, []);
    porChave.get(chave).push({
      grupo: iGrupo >= 0 ? (String(l[iGrupo] || '').trim().toUpperCase() || null) : null,
      diaCodigo: iCod >= 0 ? (String(l[iCod] || '').trim() || null) : null,
      pse: pseValor,
    });
  }
  return { porChave, diag };
}
