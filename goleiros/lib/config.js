// =============================================================================
//  Dashboard de Goleiros FEC — Configuração central
//  Ponto único de verdade: slug, planilha, regra de sessão e início de temporada
//  só existem aqui. Nenhum outro arquivo redefine esses valores.
// =============================================================================

export const CATAPULT_BASE = 'https://connect-us.catapultsports.com/api/v6';

// Temporada 2026 começa na semana de 29/12/2025 (início do Carpini), a mesma
// referência da semana 1 do painel Carga por Microciclo.
export const INICIO_TEMPORADA = '2025-12-29';

// -----------------------------------------------------------------------------
//  PLANILHAS PUBLICADAS (mesmos links usados na Minutagem e no Carga por Microciclo)
// -----------------------------------------------------------------------------
export const PLANILHAS = {
  // CADASTRO_ATLETAS_PROFISSIONAL_FEC, aba "base": quem é goleiro (POSIÇÃO = GOLEIRO)
  cadastro: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vT2jaLvln5GbiUoNsczLHRMYt0gHjzDOEar1h9LLuKG-Xa4KJKZr2SS133l0pr8AgetsdYF5Ek2KU7Q/pub?gid=0&single=true&output=csv',
  // GRUPOS TAG, aba "Página1": ID, Data, Grupo, Dia Código, ADV, Nome Catapult, PSE
  tag: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vRH094U7lfAofo3Tn2NWZ0VHx7EACHOEFQaGePCLsP9fXgB4EMjc8cpwbG-4NJMsfA5u-_uaq_mdtjG/pub?gid=0&single=true&output=csv',
};

// Coluna da PSE na Página1. null = localizar pelo cabeçalho (ver lib/planilhas.js).
// Se a sonda mostrar que a coluna certa não foi achada, escreva aqui o nome exato
// do cabeçalho, ex.: PSE_COLUNA = 'PSE'.
export const PSE_COLUNA = null;

// -----------------------------------------------------------------------------
//  O QUE CONTA COMO SESSÃO DO GOLEIRO  (decisão do Felipe, 12/11/2026)
// -----------------------------------------------------------------------------
//  Jogo  = soma dos períodos 1goleiro + 2goleiro (aquecimento "Goleiros" fica fora).
//  Treino = soma dos períodos cujo nome contém "goleiros" (o bloco de goleiros).
//  Atividade é jogo quando tem período 1tempo/2tempo/1goleiro/2goleiro.
//  Numa atividade de jogo, goleiro sem 1goleiro/2goleiro (reserva) não gera sessão.
export const REGRAS_SESSAO = {
  periodoJogo: /^[12]\s*goleiro\s*\d*$/,      // 1goleiro, 2goleiro (nome sem acento, minúsculo)
  periodoJogoLinha: /^[12]\s*tempo\s*\d*$/,   // 1tempo, 2tempo (só para reconhecer que é jogo)
  periodoBlocoTreino: /goleiros/,             // "Goleiros", "goleiros - finalização"...
  // Corte mínimo de duração do bloco de treino, em minutos. 0 = desligado.
  // A dissertação usou 30 min; aqui fica desligado até o Felipe decidir.
  duracaoMinimaTreinoMin: 0,
};

// -----------------------------------------------------------------------------
//  MÉTRICAS DA CATAPULT
//  status: 'confirmado' entra no painel · 'pendente' fica fora até conferência.
//  Nenhum slug pendente é pedido à Catapult na rota /api/dados.
// -----------------------------------------------------------------------------
export const METRICAS_CATAPULT = {
  duracao: {
    slug: 'total_duration', status: 'confirmado', un: 's',
    nota: 'Duração do período (segundos).',
  },
  distancia: {
    slug: 'total_distance', status: 'confirmado', un: 'm',
    nota: 'Campo total_distance, nunca soma de bandas.',
  },
  player_load: {
    slug: 'total_player_load', status: 'confirmado', un: 'u.a.',
    nota: 'PlayerLoad nos 3 eixos.',
  },
  mergulhos: {
    slug: 'total_goalkeeping_dives', status: 'confirmado', un: 'n',
    nota: 'Componente da fórmula dos esforços explosivos; soma bateu na sonda de 26/09/2026.',
  },
  carga_mergulho: {
    slug: null, status: 'pendente', un: 'u.a.',
    nota: 'Slug ainda não identificado no tenant. Rodar /api/sonda e procurar "dive" em relacionados_no_tenant.',
    candidatos: [
      'total_goalkeeping_dive_load', 'goalkeeping_dive_load', 'total_dive_load', 'dive_load',
    ],
  },
  explosivos: {
    slug: null, status: 'pendente', un: 'n',
    nota: 'Duas métricas personalizadas no tenant. Felipe vai conferir no OpenField qual é a da dissertação.',
    candidatos: ['explosive_efforts_gk', 'esforços_explosivos_2'],
  },
};

// Slugs efetivamente pedidos na rota /api/dados (só os confirmados).
export function slugsConfirmados() {
  return Object.values(METRICAS_CATAPULT)
    .filter(m => m.status === 'confirmado' && m.slug)
    .map(m => m.slug);
}

// -----------------------------------------------------------------------------
//  LIMITES DA CATAPULT (medidos em 19/08/2026: ~70 chamadas por varredura)
// -----------------------------------------------------------------------------
export const LIMITES = {
  diasPorBlocoAtividades: 60,  // janela de cada GET /activities
  atividadesPorStats: 40,      // quantos activity_id vão num único POST /stats
  paralelo: 3,                 // POST /stats simultâneos
  maxChamadasStats: 20,        // trava: 20 × 40 = 800 atividades por carregamento
};
