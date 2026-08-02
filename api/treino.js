// api/treino.js
// Etapas 1 + 2 unificadas num único endpoint (limite de 12 funções do plano Hobby).
//
// USO:
//   /api/treino?tipo=sessoes                      -> lista sessões dos últimos 30 dias
//   /api/treino?tipo=sessoes&days=60              -> lista sessões dos últimos 60 dias (máx. 180)
//   /api/treino?tipo=stats&activity_id=UUID       -> métricas por atleta e bloco
//   /api/treino?tipo=stats&activity_id=UUID&debug=1  -> + chaves cruas do 1º registro
//   /api/treino?tipo=meujogo&token=XXX&activity_id=UUID -> recorte 1º+2º tempo do atleta
//   /api/treino?tipo=meu&token=XXX&days=180&limite=40  -> janela maior no seletor
//
// Sem ?tipo, o padrão é "sessoes".

import crypto from "node:crypto";

// tipo=historico e tipo=meu disparam várias chamadas à Catapult em paralelo.
export const config = { maxDuration: 60 };

const BASE_URL = "https://connect-us.catapultsports.com/api/v6";

// =============================================================================
// HELPERS COMPARTILHADOS
// =============================================================================

// Leitura defensiva: tenta vários nomes de campo, devolve null se ausente
function num(obj, ...nomes) {
  for (const n of nomes) {
    const v = obj?.[n];
    if (v !== undefined && v !== null && !Number.isNaN(Number(v))) return Number(v);
  }
  return null;
}

const soma = (...vals) => {
  const validos = vals.filter((v) => v !== null);
  return validos.length ? validos.reduce((a, b) => a + b, 0) : null;
};

const round1 = (v) => (v === null ? null : Math.round(v * 10) / 10);

// Ordena os blocos de um atleta na ordem em que aconteceram (start_time).
// Fallback alfabético só se a Catapult não mandar timestamp.
// Acrescenta `ordem` (1..n) e `rotulo`: quando o mesmo nome de bloco se repete
// na sessão (ex.: "Principal-JR_7x7+2_50x40" 2x), vira "Nome (1)" / "Nome (2)".
function ordenarPeriodos(regs) {
  const ordenados = [...regs].sort((a, b) => {
    if (a.inicio_unix !== null && b.inicio_unix !== null) {
      return a.inicio_unix - b.inicio_unix;
    }
    return String(a.periodo).localeCompare(String(b.periodo), "pt-BR");
  });

  const contagem = {};
  for (const r of ordenados) contagem[r.periodo] = (contagem[r.periodo] || 0) + 1;

  const vistos = {};
  return ordenados.map((r, i) => {
    const repete = contagem[r.periodo] > 1;
    vistos[r.periodo] = (vistos[r.periodo] || 0) + 1;
    return {
      ...r,
      ordem: i + 1,
      rotulo: repete ? `${r.periodo} (${vistos[r.periodo]})` : r.periodo,
    };
  });
}

// =============================================================================
// BLOCO A — SESSÕES (antigo api/sessions.js)
// =============================================================================

async function listarSessoes(req, res, TOKEN) {
  const days = Math.min(parseInt(req.query.days || "30", 10), 180);
  const endTime = Math.floor(Date.now() / 1000);
  const startTime = endTime - days * 86400;

  // Parâmetros em snake_case (padrão da API v6)
  const url = `${BASE_URL}/activities?start_time=${startTime}&end_time=${endTime}`;
  const resposta = await fetch(url, {
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: "application/json",
    },
  });

  if (!resposta.ok) {
    const texto = await resposta.text();
    return res.status(resposta.status).json({
      erro: "Falha na API da Catapult (/activities)",
      status: resposta.status,
      detalhe: texto.slice(0, 300),
    });
  }

  const activities = await resposta.json();

  // Formata cada sessão com data em horário de Fortaleza (BRT)
  const sessoes = (Array.isArray(activities) ? activities : [])
    .map((a) => {
      const inicio = new Date(a.start_time * 1000);
      return {
        id: a.id,
        nome: a.name || "Sessão sem nome",
        data: inicio.toLocaleDateString("pt-BR", { timeZone: "America/Fortaleza" }),
        hora: inicio.toLocaleTimeString("pt-BR", {
          timeZone: "America/Fortaleza",
          hour: "2-digit",
          minute: "2-digit",
        }),
        inicio_unix: a.start_time,
        fim_unix: a.end_time,
        periodos: (a.periods || []).map((p) => p.name),
        // Marcação simples: nomes com "JOGO" ou "x" tendem a ser partidas
        provavel_jogo: /jogo|\bx\b|vs/i.test(a.name || ""),
        // Marcação objetiva: existe período 1tempo/2tempo/1goleiro? (§BLOCO F)
        eh_jogo: ehSessaoDeJogo(a.periods),
      };
    })
    .sort((a, b) => b.inicio_unix - a.inicio_unix); // mais recentes primeiro

  return res.status(200).json({
    tipo: "sessoes",
    total: sessoes.length,
    periodo_dias: days,
    sessoes,
  });
}

// =============================================================================
// BLOCO B — STATS POR ATLETA E PERÍODO (antigo api/session-stats.js)
// =============================================================================

// Slugs Gen2 do tenant FEC.
// ATENÇÃO às convenções já validadas no projeto:
// - Acelerações (≥3 m/s²) vêm pré-somadas em band7plus
// - Desacelerações têm numeração INVERTIDA: band1 = Decel severa, band2 = Decel média
// - max_vel já chega em km/h (NUNCA multiplicar por 3.6)
// - B7/B8 existem no tenant (até 43,99 km/h). Precisam entrar no HSR e no sprint,
//   senão a corrida mais rápida é silenciosamente descartada. Se o tenant não
//   devolver os slugs, `soma` ignora os nulos e o resultado é o de antes.
const PARAMETROS = [
  "total_distance",
  "total_duration",
  "max_vel",
  "gen2_velocity_band1_total_distance",
  "gen2_velocity_band2_total_distance",
  "gen2_velocity_band3_total_distance",
  "gen2_velocity_band4_total_distance",
  "gen2_velocity_band5_total_distance",
  "gen2_velocity_band6_total_distance",
  "gen2_velocity_band7_total_distance",
  "gen2_velocity_band8_total_distance",
  "gen2_acceleration_band7plus_total_effort_count",
  "gen2_acceleration_band1_total_effort_count",
  "gen2_acceleration_band2_total_effort_count",
];

// Guarda contra dupla conversão: max_vel já vem em km/h;
// se algum valor chegar > 45, assumimos m/s convertido 2x e corrigimos.
function corrigirVmax(v) {
  if (v === null) return null;
  return v > 45 ? round1(v / 3.6) : round1(v);
}

function normalizar(r) {
  const duracaoS = num(r, "total_duration");
  const dist = num(r, "total_distance");

  const b1 = num(r, "gen2_velocity_band1_total_distance", "b1Dist", "dist_b1");
  const b2 = num(r, "gen2_velocity_band2_total_distance", "b2Dist", "dist_b2");
  const b3 = num(r, "gen2_velocity_band3_total_distance", "b3Dist", "dist_b3");
  const b4 = num(r, "gen2_velocity_band4_total_distance", "b4Dist", "dist_b4");
  const b5 = num(r, "gen2_velocity_band5_total_distance", "b5Dist", "dist_b5");
  const b6 = num(r, "gen2_velocity_band6_total_distance", "b6Dist", "dist_b6");
  const b7 = num(r, "gen2_velocity_band7_total_distance", "b7Dist", "dist_b7");
  const b8 = num(r, "gen2_velocity_band8_total_distance", "b8Dist", "dist_b8");

  const duracaoMin = duracaoS !== null ? duracaoS / 60 : null;

  return {
    atleta: r.athlete_name || r.athlete || "?",
    atleta_id: r.athlete_id || null,
    periodo: r.period_name || r.period || "?",
    periodo_id: r.period_id || null,
    // Timestamps do bloco — usados para ordenar cronologicamente.
    // Sem isso os blocos saem em ordem alfabética, o que inverte a leitura da sessão.
    inicio_unix: num(r, "start_time"),
    fim_unix: num(r, "end_time"),
    duracao_min: round1(duracaoMin),
    distancia_m: round1(dist),
    // Densidade da sessão/bloco (m/min)
    densidade_m_min:
      dist !== null && duracaoMin ? round1(dist / duracaoMin) : null,
    bandas_m: {
      b1: round1(b1), b2: round1(b2), b3: round1(b3), b4: round1(b4),
      b5: round1(b5), b6: round1(b6), b7: round1(b7), b8: round1(b8),
    },
    // HSR = TUDO acima de 19,80 km/h = B5+B6+B7+B8. NÃO inclui B4.
    hsr_m: round1(soma(b5, b6, b7, b8)),
    // Sprint = TUDO acima de 25,20 km/h = B6+B7+B8
    sprint_m: round1(soma(b6, b7, b8)),
    // Acelerações ≥3 m/s² (pré-somadas pela Catapult)
    aceleracoes: num(r, "gen2_acceleration_band7plus_total_effort_count"),
    // Desacelerações: band1 = Decel B3 (severa) + band2 = Decel B2 (média)
    desaceleracoes: soma(
      num(r, "gen2_acceleration_band1_total_effort_count"),
      num(r, "gen2_acceleration_band2_total_effort_count")
    ),
    vmax_kmh: corrigirVmax(num(r, "max_vel", "maximum_velocity")),
  };
}

// Agrega os períodos de um atleta no total da sessão
function agregarAtleta(registros) {
  const somaCampo = (fn) => soma(...registros.map(fn));
  const durMin = somaCampo((r) => r.duracao_min);
  const dist = somaCampo((r) => r.distancia_m);
  const vmaxs = registros.map((r) => r.vmax_kmh).filter((v) => v !== null);

  return {
    atleta: registros[0].atleta,
    atleta_id: registros[0].atleta_id,
    n_periodos: registros.length,
    duracao_min: round1(durMin),
    distancia_m: round1(dist),
    densidade_m_min: dist !== null && durMin ? round1(dist / durMin) : null,
    bandas_m: {
      b1: round1(somaCampo((r) => r.bandas_m.b1)),
      b2: round1(somaCampo((r) => r.bandas_m.b2)),
      b3: round1(somaCampo((r) => r.bandas_m.b3)),
      b4: round1(somaCampo((r) => r.bandas_m.b4)),
      b5: round1(somaCampo((r) => r.bandas_m.b5)),
      b6: round1(somaCampo((r) => r.bandas_m.b6)),
      b7: round1(somaCampo((r) => r.bandas_m.b7)),
      b8: round1(somaCampo((r) => r.bandas_m.b8)),
    },
    hsr_m: round1(somaCampo((r) => r.hsr_m)),
    sprint_m: round1(somaCampo((r) => r.sprint_m)),
    aceleracoes: somaCampo((r) => r.aceleracoes),
    desaceleracoes: somaCampo((r) => r.desaceleracoes),
    vmax_kmh: vmaxs.length ? Math.max(...vmaxs) : null,
  };
}

async function statsDaSessao(req, res, TOKEN) {
  const activityId = req.query.activity_id;
  if (!activityId) {
    return res.status(400).json({ erro: "Parâmetro obrigatório: activity_id" });
  }

  const resposta = await fetch(`${BASE_URL}/stats`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      filters: [
        { name: "activity_id", comparison: "=", values: [activityId] },
      ],
      parameters: PARAMETROS,
      group_by: ["athlete", "period"],
    }),
  });

  if (!resposta.ok) {
    const texto = await resposta.text();
    return res.status(resposta.status).json({
      erro: "Falha na API da Catapult (/stats)",
      status: resposta.status,
      detalhe: texto.slice(0, 300),
    });
  }

  const bruto = await resposta.json();
  const registros = (Array.isArray(bruto) ? bruto : []).map(normalizar);

  // Agrupa por atleta: períodos individuais + total da sessão
  const porAtleta = {};
  for (const r of registros) {
    (porAtleta[r.atleta] = porAtleta[r.atleta] || []).push(r);
  }

  const atletas = Object.values(porAtleta)
    .map((regs) => ({
      ...agregarAtleta(regs),
      periodos: ordenarPeriodos(regs),
    }))
    .sort((a, b) => a.atleta.localeCompare(b.atleta, "pt-BR"));

  // Modo debug: resposta ENXUTA para validar slugs sem despejar todos os atletas.
  // Devolve as chaves cruas do 1º registro + o registro cru + como ele foi normalizado.
  if (req.query.debug === "1") {
    const cru = bruto?.[0] || null;
    return res.status(200).json({
      tipo: "stats-debug",
      activity_id: activityId,
      total_registros_crus: Array.isArray(bruto) ? bruto.length : 0,
      total_atletas: atletas.length,
      // Quais dos slugs que pedimos realmente voltaram preenchidos
      slugs_pedidos: PARAMETROS,
      slugs_ausentes: cru ? PARAMETROS.filter((p) => !(p in cru)) : PARAMETROS,
      slugs_nulos: cru
        ? PARAMETROS.filter((p) => p in cru && (cru[p] === null || cru[p] === ""))
        : [],
      // Mede o quanto B7+B8 acrescentam ao HSR da sessão inteira.
      // Se vier 0, o tenant não usa essas bandas e a conta antiga já estava certa.
      impacto_b7_b8: (() => {
        const s = (fn) => round1(soma(...registros.map(fn)) ?? 0);
        const b78 = s((r) => soma(r.bandas_m.b7, r.bandas_m.b8));
        const hsr = s((r) => r.hsr_m);
        return {
          hsr_total_sessao_m: hsr,
          vindo_de_b7_b8_m: b78,
          percentual_do_hsr: hsr ? `${(b78 / hsr * 100).toFixed(1)}%` : "0%",
        };
      })(),
      chaves_primeiro_registro: cru ? Object.keys(cru) : [],
      primeiro_registro_cru: cru,
      primeiro_registro_normalizado: registros[0] || null,
    });
  }

  return res.status(200).json({
    tipo: "stats",
    activity_id: activityId,
    total_atletas: atletas.length,
    atletas,
  });
}

// =============================================================================
// BLOCO C — HISTÓRICO: totais por atleta em várias sessões
// =============================================================================
// GET /api/treino?tipo=historico&activity_ids=uuid1,uuid2,...
// Faz uma chamada /stats por atividade EM PARALELO e devolve só os totais por
// atleta (group_by athlete, sem período). Uma ida do navegador em vez de N.
// Alimenta os gráficos de evolução das últimas sessões.

const MAX_SESSOES_HISTORICO = 12;

async function historico(req, res, TOKEN) {
  const ids = String(req.query.activity_ids || "")
    .split(",").map((s) => s.trim()).filter(Boolean)
    .slice(0, MAX_SESSOES_HISTORICO);

  if (!ids.length) {
    return res.status(400).json({
      erro: "Parâmetro obrigatório: activity_ids (UUIDs separados por vírgula)",
      maximo: MAX_SESSOES_HISTORICO,
    });
  }

  const umaSessao = async (id) => {
    try {
      const r = await fetch(`${BASE_URL}/stats`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          filters: [{ name: "activity_id", comparison: "=", values: [id] }],
          parameters: PARAMETROS,
          group_by: ["athlete"], // total da sessão direto, sem somar períodos
        }),
      });
      if (!r.ok) return { activity_id: id, erro: `HTTP ${r.status}`, atletas: {} };

      const bruto = await r.json();
      const atletas = {};
      for (const reg of Array.isArray(bruto) ? bruto : []) {
        const n = normalizar(reg);
        atletas[n.atleta] = {
          distancia_m: n.distancia_m,
          duracao_min: n.duracao_min,
          densidade_m_min: n.densidade_m_min,
          hsr_m: n.hsr_m,
          sprint_m: n.sprint_m,
          aceleracoes: n.aceleracoes,
          desaceleracoes: n.desaceleracoes,
          // usado direto no gráfico de evolução
          acel_decel: soma(n.aceleracoes, n.desaceleracoes),
          vmax_kmh: n.vmax_kmh,
        };
      }
      return { activity_id: id, atletas };
    } catch (e) {
      return { activity_id: id, erro: String(e.message), atletas: {} };
    }
  };

  const sessoes = await Promise.all(ids.map(umaSessao));

  return res.status(200).json({
    tipo: "historico",
    total_sessoes: sessoes.length,
    com_erro: sessoes.filter((s) => s.erro).map((s) => ({ activity_id: s.activity_id, erro: s.erro })),
    sessoes,
  });
}

// =============================================================================
// BLOCO D — RELATÓRIO DO ATLETA (link pessoal)
// =============================================================================
// GET /api/treino?tipo=meu&token=XXXX[&activity_id=UUID]
//
// PRINCÍPIO DE SIGILO: esconder o seletor no frontend não protege nada, porque a
// página é pública e a API é aberta. A proteção real é esta: este endpoint NUNCA
// devolve nome, id ou foto de outro atleta. Para o comparativo ele manda apenas
// valores soltos, sem identificação, e cada painel é ordenado de forma
// independente — não dá para cruzar "quem correu mais" com "quem sprintou mais".
//
// O token é um HMAC do ID do atleta com RELATORIO_SECRET. Não é possível
// adivinhar o link de outro nem forjar um. Nada precisa ser armazenado: o
// servidor recalcula o token de cada linha do cadastro e procura o que bate.
// Trocar RELATORIO_SECRET invalida todos os links de uma vez.

// Quantas atividades recentes varrer para descobrir de quais o atleta participou.
// Cada uma custa uma chamada /stats, por isso o padrão é modesto e o atleta pode
// pedir mais ("Ver mais sessões" na página, que manda &days=180&limite=40).
const N_SESSOES_ATLETA = 14;   // padrão
const MAX_SESSOES_ATLETA = 40; // teto absoluto
const LOTE_VARREDURA = 10;     // chamadas simultâneas à Catapult

function tokenDe(id, segredo){
  return crypto.createHmac("sha256", segredo)
    .update("atleta:" + String(id).trim())
    .digest("base64url")
    .slice(0, 20);
}

// Comparação em tempo constante: evita que diferenças de tempo de resposta
// revelem quantos caracteres do token estão corretos.
function tokensIguais(a, b){
  const x = Buffer.from(String(a || ""), "utf8");
  const y = Buffer.from(String(b || ""), "utf8");
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}

const baseDe = (req) =>
  `https://${req.headers["x-forwarded-host"] || req.headers.host}`;

// `/api/gps/sheets` guarda a resposta por 10 min no CDN. Isso é bom para o
// tráfego dos atletas, mas atrapalha na hora de conferir uma edição da planilha.
// Com semCache=true, um parâmetro descartável muda a chave de cache e força a
// releitura. Usado só pelo gerador de links, que é de uso esporádico.
async function carregarCadastro(req, semCache = false){
  const url = `${baseDe(req)}/api/gps/sheets?fonte=cadastro`
            + (semCache ? `&_=${Date.now()}` : "");
  const r = await fetch(url, semCache ? { cache: "no-store" } : undefined);
  if(!r.ok) throw new Error(`cadastro HTTP ${r.status}`);
  const j = await r.json();
  return j.rows || [];
}

// "96 PIERRE" -> "96"
const idNoNome = (n) => (String(n||"").trim().match(/^(\d+)\b/) || [])[1] || null;

// Totais de todos os atletas de uma atividade (group_by athlete)
async function totaisDaAtividade(id, TOKEN){
  const r = await fetch(`${BASE_URL}/stats`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, Accept: "application/json",
               "Content-Type": "application/json" },
    body: JSON.stringify({
      filters: [{ name: "activity_id", comparison: "=", values: [id] }],
      parameters: PARAMETROS,
      group_by: ["athlete"],
    }),
  });
  if(!r.ok) return [];
  const bruto = await r.json();
  return (Array.isArray(bruto) ? bruto : []).map(normalizar);
}

async function meuRelatorio(req, res, TOKEN){
  const segredo = process.env.RELATORIO_SECRET;
  if(!segredo){
    return res.status(500).json({ erro: "RELATORIO_SECRET não configurado no Vercel." });
  }
  const token = req.query.token;
  if(!token) return res.status(400).json({ erro: "Link inválido." });

  // 1. Identifica o atleta pelo token
  const cadastro = await carregarCadastro(req);
  const linha = cadastro.find((l) => tokensIguais(tokenDe(l["ID"], segredo), token));
  if(!linha) return res.status(403).json({ erro: "Link inválido ou expirado." });

  const meuId = String(linha["ID"]).trim();
  const atleta = {
    nome: (linha["ATLETA"] || "").trim(),
    posicao: (linha["POSIÇÃO"] || "").trim(),
    foto: (linha["FOTO"] || "").trim(),
  };

  // 2. Sessões recentes
  const dias = Math.min(Math.max(parseInt(req.query.days || "60", 10), 1), 180);
  const limite = Math.min(Math.max(parseInt(req.query.limite || String(N_SESSOES_ATLETA), 10), 1),
                          MAX_SESSOES_ATLETA);
  const fim = Math.floor(Date.now() / 1000);
  const ini = fim - dias * 86400;
  const rAct = await fetch(`${BASE_URL}/activities?start_time=${ini}&end_time=${fim}`, {
    headers: { Authorization: `Bearer ${TOKEN}`, Accept: "application/json" },
  });
  if(!rAct.ok){
    return res.status(rAct.status).json({ erro: "Falha ao listar sessões." });
  }
  const activities = await rAct.json();
  const todasAsSessoes = (Array.isArray(activities) ? activities : [])
    .map((a) => ({
      id: a.id,
      nome: a.name || "Sessão sem nome",
      data: new Date(a.start_time * 1000)
        .toLocaleDateString("pt-BR", { timeZone: "America/Fortaleza" }),
      inicio_unix: a.start_time,
      provavel_jogo: /jogo|\bx\b|vs/i.test(a.name || ""),
      // Critério objetivo (§BLOCO F): tem 1tempo/2tempo? Então é jogo, e o
      // frontend libera a aba de jogo. `provavel_jogo` continua só para o rótulo.
      eh_jogo: ehSessaoDeJogo(a.periods),
    }))
    .sort((a, b) => b.inicio_unix - a.inicio_unix);

  // Se a sessão pedida existe mas está além do limite, ela entra assim mesmo:
  // o atleta não pode pedir uma sessão pelo seletor e receber outra.
  const sessoes = todasAsSessoes.slice(0, limite);
  if (req.query.activity_id && !sessoes.some((s) => s.id === req.query.activity_id)) {
    const extra = todasAsSessoes.find((s) => s.id === req.query.activity_id);
    if (extra) sessoes.push(extra);
  }

  // 3. Em quais delas o atleta participou. Em lotes: 40 chamadas simultâneas à
  //    Catapult é pedir para tomar limite de taxa.
  const varredura = [];
  for (let i = 0; i < sessoes.length; i += LOTE_VARREDURA) {
    const lote = sessoes.slice(i, i + LOTE_VARREDURA);
    varredura.push(...await Promise.all(
      lote.map(async (s) => ({ s, regs: await totaisDaAtividade(s.id, TOKEN) }))
    ));
  }
  const minhas = varredura
    .map(({ s, regs }) => {
      const meu = regs.find((r) => idNoNome(r.atleta) === meuId);
      return meu ? { ...s, meu } : null;
    })
    .filter(Boolean);

  if(!minhas.length){
    return res.status(200).json({
      tipo: "meu", atleta, sessao: null, sessoes_disponiveis: [],
      janela: { dias, limite, sessoes_no_periodo: todasAsSessoes.length, tem_mais: dias < 180 },
      aviso: `Nenhuma sessão sua nos últimos ${dias} dias.`,
    });
  }

  // 4. Sessão escolhida: a pedida (se for dele) ou a mais recente
  const pedida = req.query.activity_id
    ? minhas.find((m) => m.id === req.query.activity_id) : null;
  const alvo = pedida || minhas[0];

  // 5. Detalhe da sessão escolhida: blocos dele + totais de todos (sem nome)
  const rStats = await fetch(`${BASE_URL}/stats`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, Accept: "application/json",
               "Content-Type": "application/json" },
    body: JSON.stringify({
      filters: [{ name: "activity_id", comparison: "=", values: [alvo.id] }],
      parameters: PARAMETROS,
      group_by: ["athlete", "period"],
    }),
  });
  if(!rStats.ok){
    return res.status(rStats.status).json({ erro: "Falha ao carregar a sessão." });
  }
  const registros = ((await rStats.json()) || []).map(normalizar);

  const porAtleta = {};
  for(const r of registros) (porAtleta[r.atleta] = porAtleta[r.atleta] || []).push(r);

  let meusDados = null;
  const todos = [];
  for(const [nome, regs] of Object.entries(porAtleta)){
    const agregado = agregarAtleta(regs);
    todos.push(agregado);
    if(idNoNome(nome) === meuId){
      meusDados = { ...agregado, periodos: ordenarPeriodos(regs) };
      delete meusDados.atleta_id;
    }
  }
  if(meusDados) delete meusDados.atleta;

  // 6. Comparativo anônimo. Cada painel é ordenado por conta própria; assim as
  //    métricas de um mesmo colega não podem ser reconectadas entre painéis.
  const meuIndiceEmTodos = todos.findIndex((t) => idNoNome(t.atleta) === meuId);
  function painel(pegar){
    // guarda o índice original para achar a minha linha DEPOIS de ordenar —
    // comparar os arrays por referência não funcionaria
    const linhas = todos.map((t, i) => ({ v: pegar(t), i }));
    linhas.sort((a, b) => b.v[0] - a.v[0]);
    const idx = linhas.findIndex((x) => x.i === meuIndiceEmTodos);
    return { valores: linhas.map((x) => x.v), meu_indice: idx, posicao: idx + 1 };
  }
  const comparativo = {
    total_atletas: todos.length,
    distancia:    painel((t) => [t.distancia_m ?? 0]),
    intensidade:  painel((t) => [t.hsr_m ?? 0, t.sprint_m ?? 0]),
    acel_decel:   painel((t) => [t.aceleracoes ?? 0, t.desaceleracoes ?? 0]),
  };

  // 7. Evolução: só as sessões dele, da mais antiga para a mais recente
  const evolucao = minhas.slice(0, 7).reverse().map((m) => ({
    data: m.data,
    nome: m.nome,
    provavel_jogo: m.provavel_jogo,
    // o rodapé do gráfico mostra o adversário quando é jogo; a marcação segue o
    // mesmo critério objetivo do resto (tem 1tempo/2tempo?), não o nome
    eh_jogo: m.eh_jogo,
    atual: m.id === alvo.id,
    distancia_m: m.meu.distancia_m,
    hsr_m: m.meu.hsr_m,
    acel_decel: soma(m.meu.aceleracoes, m.meu.desaceleracoes),
  }));

  res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=1800");
  return res.status(200).json({
    tipo: "meu",
    atleta,
    sessao: { id: alvo.id, nome: alvo.nome, data: alvo.data,
              provavel_jogo: alvo.provavel_jogo, eh_jogo: alvo.eh_jogo },
    sessoes_disponiveis: minhas.map((m) =>
      ({ id: m.id, nome: m.nome, data: m.data,
         provavel_jogo: m.provavel_jogo, eh_jogo: m.eh_jogo })),
    // Alimenta o botão "Ver mais sessões": diz o que foi varrido e se ainda há
    // o que buscar (a janela máxima da Catapult aqui é 180 dias).
    janela: {
      dias, limite,
      sessoes_no_periodo: todasAsSessoes.length,
      sessoes_varridas: sessoes.length,
      tem_mais: dias < 180 || todasAsSessoes.length > sessoes.length,
    },
    dados: meusDados,
    comparativo,
    evolucao,
  });
}

// =============================================================================
// BLOCO E — GERADOR DE LINKS (uso interno)
// =============================================================================
// GET /api/treino?tipo=links&chave=<RELATORIO_SECRET>[&todos=1]
// Protegido: sem isso qualquer pessoa geraria os links de todo o elenco.

async function gerarLinks(req, res){
  const segredo = process.env.RELATORIO_SECRET;
  if(!segredo){
    return res.status(500).json({ erro: "RELATORIO_SECRET não configurado no Vercel." });
  }
  if(!tokensIguais(req.query.chave, segredo)){
    return res.status(403).json({ erro: "Chave inválida." });
  }
  // sempre fresco: esta lista existe justamente para conferir a planilha
  const cadastro = await carregarCadastro(req, true);
  const base = baseDe(req);
  const somenteAtivos = req.query.todos !== "1";

  const lista = cadastro
    .filter((l) => String(l["ID"] || "").trim())
    .filter((l) => !somenteAtivos || (l["STATUS"] || "").toUpperCase() === "ATIVO")
    .map((l) => ({
      id: String(l["ID"]).trim(),
      atleta: (l["ATLETA"] || "").trim(),
      email: (l["EMAIL"] || "").trim() || null,
      link: `${base}/meu_relatorio.html?t=${tokenDe(l["ID"], segredo)}`,
    }));

  // Página clicável (padrão). JSON só com &formato=json, para uso programático.
  if (req.query.formato !== "json") {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(200).send(paginaDeLinks(lista, somenteAtivos));
  }

  return res.status(200).json({
    tipo: "links",
    filtro: somenteAtivos ? "somente ATIVOS" : "todos",
    total: lista.length,
    com_email: lista.filter((l) => l.email).length,
    sem_email: lista.filter((l) => !l.email).map((l) => l.atleta),
    links: lista,
  });
}

const escapaHtml = (s) => String(s ?? "").replace(/[&<>"]/g,
  (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function paginaDeLinks(lista, somenteAtivos){
  const semEmail = lista.filter((l) => !l.email).length;
  const linhas = lista.map((l) => `
    <tr>
      <td class="n">${escapaHtml(l.id)}</td>
      <td class="a">${escapaHtml(l.atleta)}</td>
      <td class="e ${l.email ? "" : "falta"}">${escapaHtml(l.email || "sem email na planilha")}</td>
      <td><a href="${escapaHtml(l.link)}" target="_blank" rel="noopener">abrir relatório</a></td>
      <td><button data-link="${escapaHtml(l.link)}"
            ${l.email ? `data-nome="${escapaHtml(l.atleta)}"` : ""}>copiar link</button></td>
    </tr>`).join("");

  return `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Links pessoais — Fortaleza EC</title>
<style>
  :root{--azul-escuro:#071A3E;--azul:#003087;--laranja:#E8360A;--dourado:#C4952A;--linha:#DDE2EA}
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Helvetica Neue',Arial,sans-serif;background:#F2F4F8;color:var(--azul-escuro);padding:24px}
  .caixa{max-width:1000px;margin:0 auto;background:#fff;border:1px solid var(--linha);border-radius:10px;overflow:hidden}
  header{background:var(--azul-escuro);color:#fff;padding:18px 22px;border-bottom:4px solid var(--laranja)}
  header h1{font-size:18px}
  header p{color:#9FB0CC;font-size:12.5px;margin-top:5px}
  .alerta{background:#FFF4F1;border-left:4px solid var(--laranja);color:#8A2205;
    padding:12px 16px;font-size:13px;margin:16px 22px;border-radius:6px;line-height:1.5}
  table{width:100%;border-collapse:collapse;font-size:13.5px}
  th{text-align:left;padding:10px 12px;font-size:10.5px;text-transform:uppercase;letter-spacing:.8px;
    color:#5A6577;border-bottom:2px solid var(--azul-escuro)}
  td{padding:9px 12px;border-bottom:1px solid var(--linha);vertical-align:middle}
  tr:hover{background:#F7F9FC}
  td.n{color:#8A94A6;font-variant-numeric:tabular-nums;width:44px}
  td.a{font-weight:700}
  td.e{color:#5A6577;font-size:12.5px}
  td.e.falta{color:var(--laranja);font-style:italic}
  a{color:var(--azul);font-weight:700;text-decoration:none}
  a:hover{text-decoration:underline}
  button{background:#fff;border:1.5px solid var(--azul);color:var(--azul);border-radius:6px;
    padding:5px 11px;font-size:12px;font-weight:700;cursor:pointer;font-family:inherit;white-space:nowrap}
  button:hover{background:#EEF2FA}
  button.ok{background:var(--azul);color:#fff;border-color:var(--azul)}
  footer{padding:14px 22px;font-size:12px;color:#5A6577;background:#F7F9FC;border-top:1px solid var(--linha);line-height:1.6}
</style></head><body>
<div class="caixa">
  <header>
    <h1>Links pessoais dos atletas</h1>
    <p>${lista.length} atletas (${somenteAtivos ? "somente ATIVOS" : "todos"}) ·
       ${lista.length - semEmail} com email cadastrado</p>
  </header>
  <div class="alerta">
    Cada link abre <b>apenas</b> o relatório daquele atleta e é permanente — envie uma vez só.
    Não publique esta página nem compartilhe capturas de tela dela: quem tiver um link, abre aquele relatório.
  </div>
  <table>
    <thead><tr><th>ID</th><th>Atleta</th><th>Email</th><th>Testar</th><th></th></tr></thead>
    <tbody>${linhas}</tbody>
  </table>
  <footer>
    Para incluir os inativos, acrescente <b>&amp;todos=1</b> ao endereço.
    Para a versão em dados, <b>&amp;formato=json</b>.<br>
    Fortaleza EC — Departamento de Fisiologia.
  </footer>
</div>
<script>
document.querySelectorAll("button[data-link]").forEach(function(b){
  b.addEventListener("click", function(){
    var texto = b.dataset.link;
    navigator.clipboard.writeText(texto).then(function(){
      var antes = b.textContent;
      b.textContent = "copiado!"; b.classList.add("ok");
      setTimeout(function(){ b.textContent = antes; b.classList.remove("ok"); }, 1600);
    });
  });
});
</script>
</body></html>`;
}

// =============================================================================
// BLOCO F — DIAGNÓSTICO: comparação das duas famílias de slug de banda
// =============================================================================
// Existem dois esquemas de numeração e eles divergem em 1:
//   gen2_velocity_bandN  → numeração FEC (band1 = 0,50–7,20 km/h)
//   velocity_bandN       → numeração da API (band1 = 0–0,50 km/h)
// Confundi-los faz o HSR incluir ou excluir a faixa 14,40–19,80 km/h por engano.
// Este endpoint soma as duas famílias na MESMA atividade e revela o deslocamento.

const N_BANDAS = [1, 2, 3, 4, 5, 6, 7, 8];
const SLUGS_GEN2 = N_BANDAS.map((n) => `gen2_velocity_band${n}_total_distance`);
const SLUGS_API = N_BANDAS.map((n) => `velocity_band${n}_total_distance`);

async function compararBandas(req, res, TOKEN) {
  const activityId = req.query.activity_id;
  if (!activityId) {
    return res.status(400).json({ erro: "Parâmetro obrigatório: activity_id" });
  }

  const resposta = await fetch(`${BASE_URL}/stats`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      filters: [{ name: "activity_id", comparison: "=", values: [activityId] }],
      parameters: ["total_distance", "max_vel", ...SLUGS_GEN2, ...SLUGS_API],
      group_by: ["athlete", "period"],
    }),
  });

  if (!resposta.ok) {
    const texto = await resposta.text();
    return res.status(resposta.status).json({
      erro: "Falha na API da Catapult (/stats)",
      status: resposta.status,
      detalhe: texto.slice(0, 300),
    });
  }

  const bruto = await resposta.json();
  const regs = Array.isArray(bruto) ? bruto : [];
  const cru = regs[0] || {};

  // Soma cada slug sobre TODOS os registros (um registro isolado pode ser só zeros)
  const somar = (slug) =>
    round1(regs.reduce((acc, r) => acc + (num(r, slug) ?? 0), 0));

  const gen2 = {}, api = {};
  N_BANDAS.forEach((n, i) => {
    gen2[`band${n}`] = somar(SLUGS_GEN2[i]);
    api[`band${n}`] = somar(SLUGS_API[i]);
  });

  const ausentes = [...SLUGS_GEN2, ...SLUGS_API].filter((s) => !(s in cru));

  // Para cada banda da API, procura a banda gen2 com a mesma distância somada
  const correspondencia = [];
  for (const n of N_BANDAS) {
    const alvo = api[`band${n}`];
    if (!alvo) continue; // banda vazia não distingue nada
    let melhor = null;
    for (const m of N_BANDAS) {
      const d = Math.abs(gen2[`band${m}`] - alvo);
      if (melhor === null || d < melhor.diferenca_m) {
        melhor = { equivale_a: `gen2_velocity_band${m}`, diferenca_m: round1(d), _m: m };
      }
    }
    correspondencia.push({
      slug_api: `velocity_band${n}`,
      distancia_m: alvo,
      ...melhor,
      identicas: melhor.diferenca_m <= 0.5,
    });
  }

  // Deslocamento = (índice gen2) − (índice api), quando as somas batem
  const pares = correspondencia.filter((c) => c.identicas);
  const deslocs = [...new Set(pares.map((c) => c._m - Number(c.slug_api.match(/\d+/)[0])))];
  pares.forEach((c) => delete c._m);
  correspondencia.forEach((c) => delete c._m);

  let veredito;
  if (!pares.length) {
    veredito =
      "As duas famílias não coincidem em nenhuma banda. Ou a API não expõe os slugs " +
      "`velocity_bandN` neste tenant (ver `ausentes`), ou os limiares são diferentes. " +
      "Conferir manualmente antes de mexer no GPS 2D.";
  } else if (deslocs.length === 1 && deslocs[0] === -1) {
    veredito =
      "CONFIRMADO: a numeração da API está deslocada em 1 (velocity_bandN = gen2_band(N-1)), " +
      "porque a API conta a faixa 0–0,50 km/h como band1. Logo, com os slugs `velocity_bandN`: " +
      "HSR (>19,8 km/h) = band6+band7+band8 e Sprint (>25,2 km/h) = band7+band8. " +
      "Se o GPS 2D estiver somando band5+6+7+8 no HSR, ele está INCLUINDO a faixa " +
      "14,40–19,80 km/h e SUPERESTIMANDO o HSR histórico.";
  } else if (deslocs.length === 1 && deslocs[0] === 0) {
    veredito =
      "As duas famílias são idênticas banda a banda (deslocamento 0). A numeração é a mesma " +
      "nos dois conjuntos de slug e o GPS 2D pode usar a mesma regra deste endpoint.";
  } else {
    veredito =
      `Deslocamento inconsistente entre as bandas (valores observados: ${deslocs.join(", ")}). ` +
      "Conferir a tabela `correspondencia` linha a linha antes de concluir.";
  }

  return res.status(200).json({
    tipo: "bandas-comparacao",
    activity_id: activityId,
    total_registros: regs.length,
    distancia_total_m: somar("total_distance"),
    soma_gen2_band1a8_m: round1(N_BANDAS.reduce((a, n) => a + gen2[`band${n}`], 0)),
    soma_api_band1a8_m: round1(N_BANDAS.reduce((a, n) => a + api[`band${n}`], 0)),
    gen2_velocity_band: gen2,
    velocity_band: api,
    slugs_ausentes: ausentes,
    correspondencia,
    veredito,
  });
}

// =============================================================================
// BLOCO F — RECORTE DE JOGO (1º e 2º tempos)
// =============================================================================
// GET /api/treino?tipo=meujogo&token=XXXX[&activity_id=UUID][&temporada=1]
//
// POR QUE EXISTE: numa sessão de jogo o total inclui aquecimento, aquecimento do
// intervalo e o trabalho dos suplentes na lateral. Para o atleta, o número que
// importa é o do jogo em si. Este endpoint devolve o mesmo relatório recortado
// nos períodos de jogo, mais o split 1º x 2º tempo.
//
// COMO SE RECONHECE UM PERÍODO DE JOGO — validado em 20 jogos reais (180 dias):
//   "1tempo", "1tempo1", "2tempo", "2Tempo", "2tempo1".."2tempo4"  -> linha
//   "1goleiro", "2goleiro"                                         -> goleiro
//
// Dois fatos medidos nos dados que mudam a leitura:
//
//  (a) Os NUMERADOS NÃO SÃO PARTES SEQUENCIAIS DO TEMPO. São janelas de entrada
//      de reserva: quem entrou no meio do 2º tempo aparece só em "2tempo2" ou
//      "2tempo3". Cada atleta costuma ter UM período por tempo. Somar todos os
//      períodos de jogo do atleta dá o tempo em campo dele — não o do jogo.
//
//  (b) O GOLEIRO TITULAR NÃO TEM "1tempo"/"2tempo". Ele aparece exclusivamente em
//      "1goleiro"/"2goleiro" (conferido no jogo x Botafogo SP: 11 JOÃO.R, 48 +
//      53,2 min, nenhum registro em 1tempo). Sem incluir essa família, a aba de
//      jogo do goleiro sairia zerada.
//
// FICAM DE FORA, por não casarem com a regex: Aquecimento*, Suplentes*,
// "Goleiros" (aquecimento dos goleiros, no plural), Treino Físico, Posse,
// Complemento Técnico, Intermitente.
//
// A caixa varia na digitação da comissão ("2Tempo", "2Tempo3"), por isso a regex
// é case-insensitive. Espaços sobrando também são tolerados.
const RE_PERIODO_JOGO = /^\s*([12])\s*(tempo|goleiro)\s*\d*\s*$/i;

const ehPeriodoJogo = (nome) => RE_PERIODO_JOGO.test(String(nome ?? ""));

// 1 = primeiro tempo, 2 = segundo tempo, null = não é período de jogo
const tempoDoPeriodo = (nome) => {
  const m = String(nome ?? "").match(RE_PERIODO_JOGO);
  return m ? Number(m[1]) : null;
};

// Uma sessão é jogo quando tem período de jogo — critério do DADO, não do nome.
// O regex de nome ("jogo", "x", "vs") continua existindo como `provavel_jogo`,
// mas erra: "Jogo Específico" é bloco de treino e "Clássico" seria jogo sem
// casar. Aqui a pergunta é objetiva: existe 1tempo/2tempo nessa atividade?
const ehSessaoDeJogo = (periodos) =>
  (periodos ?? []).some((p) => ehPeriodoJogo(typeof p === "string" ? p : p?.name));

// Quantos jogos da temporada varrer, no máximo. Cada um custa uma chamada à
// Catapult; o teto existe para não estourar o maxDuration de 60 s.
const MAX_JOGOS_TEMPORADA = 40;
const LOTE_TEMPORADA = 6;      // chamadas simultâneas
const ORCAMENTO_MS = 42000;    // para de disparar lotes novos depois disso

// Início da temporada: 1º de janeiro do ano corrente (horário de Fortaleza).
// Sobrescrevível com &desde=AAAA-MM-DD.
function inicioDaTemporada(req) {
  const p = String(req.query.desde || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(p)) return Math.floor(Date.parse(p + "T00:00:00-03:00") / 1000);
  const ano = new Date().getUTCFullYear();
  return Math.floor(Date.parse(ano + "-01-01T00:00:00-03:00") / 1000);
}

// Registros (já normalizados) -> agregado no formato de agregarAtleta, ou null.
function recorte(regs) {
  if (!regs.length) return null;
  const a = agregarAtleta(regs);
  delete a.atleta;
  delete a.atleta_id;
  return { ...a, periodos: ordenarPeriodos(regs).map((p) => ({ ...p, atleta: undefined, atleta_id: undefined })) };
}

// Todos os registros de uma atividade, normalizados e agrupados por atleta.
async function registrosPorAtleta(activityId, TOKEN, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(`${BASE_URL}/stats`, {
      method: "POST",
      signal: ctrl.signal,
      headers: { Authorization: `Bearer ${TOKEN}`, Accept: "application/json",
                 "Content-Type": "application/json" },
      body: JSON.stringify({
        filters: [{ name: "activity_id", comparison: "=", values: [activityId] }],
        parameters: PARAMETROS,
        group_by: ["athlete", "period"],
      }),
    });
    if (!r.ok) return null;
    const bruto = await r.json();
    const porAtleta = {};
    for (const reg of Array.isArray(bruto) ? bruto : []) {
      const n = normalizar(reg);
      (porAtleta[n.atleta] = porAtleta[n.atleta] || []).push(n);
    }
    return porAtleta;
  } catch (e) {
    return null;
  } finally {
    clearTimeout(t);
  }
}

async function meuJogo(req, res, TOKEN) {
  const segredo = process.env.RELATORIO_SECRET;
  if (!segredo) {
    return res.status(500).json({ erro: "RELATORIO_SECRET não configurado no Vercel." });
  }
  if (!req.query.token) return res.status(400).json({ erro: "Link inválido." });

  // 1. Identifica o atleta pelo token (mesmo mecanismo do tipo=meu)
  const cadastro = await carregarCadastro(req);
  const linha = cadastro.find((l) => tokensIguais(tokenDe(l["ID"], segredo), req.query.token));
  if (!linha) return res.status(403).json({ erro: "Link inválido ou expirado." });
  const meuId = String(linha["ID"]).trim();
  const atleta = {
    nome: (linha["ATLETA"] || "").trim(),
    posicao: (linha["POSIÇÃO"] || "").trim(),
    foto: (linha["FOTO"] || "").trim(),
  };

  // 2. Todos os jogos da temporada (pela composição de períodos, não pelo nome)
  const ini = inicioDaTemporada(req);
  const fim = Math.floor(Date.now() / 1000);
  const rAct = await fetch(`${BASE_URL}/activities?start_time=${ini}&end_time=${fim}`, {
    headers: { Authorization: `Bearer ${TOKEN}`, Accept: "application/json" },
  });
  if (!rAct.ok) return res.status(rAct.status).json({ erro: "Falha ao listar sessões." });

  const jogos = (await rAct.json() || [])
    .filter((a) => ehSessaoDeJogo(a.periods))
    .map((a) => ({
      id: a.id,
      nome: a.name || "Jogo",
      data: new Date(a.start_time * 1000)
        .toLocaleDateString("pt-BR", { timeZone: "America/Fortaleza" }),
      inicio_unix: a.start_time,
    }))
    .sort((a, b) => b.inicio_unix - a.inicio_unix);

  if (!jogos.length) {
    return res.status(200).json({ tipo: "meujogo", atleta, jogo: null,
      aviso: "Nenhum jogo encontrado na temporada." });
  }

  // 3. Jogo alvo: o pedido (se for jogo) ou o mais recente.
  //    Se o pedido não está na janela da temporada (um jogo de dezembro aberto em
  //    janeiro, por exemplo), procura numa janela larga em vez de cair calado no
  //    jogo mais recente — devolver os números de OUTRA partida sem avisar seria
  //    o pior desfecho possível aqui.
  let alvo = (req.query.activity_id && jogos.find((j) => j.id === req.query.activity_id)) || null;
  let foraDaTemporada = false;

  if (!alvo && req.query.activity_id) {
    const r2 = await fetch(
      `${BASE_URL}/activities?start_time=${fim - 400 * 86400}&end_time=${fim}`,
      { headers: { Authorization: `Bearer ${TOKEN}`, Accept: "application/json" } });
    if (r2.ok) {
      const achada = (await r2.json() || []).find((a) => a.id === req.query.activity_id);
      if (achada && ehSessaoDeJogo(achada.periods)) {
        foraDaTemporada = true;
        alvo = {
          id: achada.id,
          nome: achada.name || "Jogo",
          data: new Date(achada.start_time * 1000)
            .toLocaleDateString("pt-BR", { timeZone: "America/Fortaleza" }),
          inicio_unix: achada.start_time,
        };
      }
    }
    if (!alvo) {
      return res.status(200).json({ tipo: "meujogo", atleta, jogo: null, jogo_todo: null,
        aviso: "Esta sessão não é um jogo." });
    }
  }
  if (!alvo) alvo = jogos[0];

  // 4. Detalhe do jogo alvo
  const porAtleta = await registrosPorAtleta(alvo.id, TOKEN);
  if (!porAtleta) return res.status(502).json({ erro: "Falha ao carregar o jogo." });

  let meusRegs = null;
  const todosJogo = [];   // agregados de jogo de quem entrou em campo (anônimos)
  for (const [nome, regs] of Object.entries(porAtleta)) {
    const deJogo = regs.filter((r) => ehPeriodoJogo(r.periodo));
    if (idNoNome(nome) === meuId) meusRegs = regs;
    if (deJogo.length) todosJogo.push(agregarAtleta(deJogo));
  }

  if (!meusRegs) {
    return res.status(200).json({
      tipo: "meujogo", atleta,
      jogo: { id: alvo.id, nome: alvo.nome, data: alvo.data },
      jogo_todo: null,
      aviso: "Você não foi relacionado neste jogo.",
    });
  }

  const meusDeJogo = meusRegs.filter((r) => ehPeriodoJogo(r.periodo));
  const jogoTodo = recorte(meusDeJogo);
  const primeiro = recorte(meusDeJogo.filter((r) => tempoDoPeriodo(r.periodo) === 1));
  const segundo  = recorte(meusDeJogo.filter((r) => tempoDoPeriodo(r.periodo) === 2));

  // Contraste com o total da sessão: quanto do dia foi jogo de fato.
  const sessaoToda = recorte(meusRegs);
  if (sessaoToda) delete sessaoToda.periodos;

  // 5. Comparativo anônimo — SÓ com os períodos de jogo, e só entre quem jogou.
  //    Mesmo princípio do tipo=meu (§7.1): nenhum nome sai daqui e cada painel é
  //    ordenado por conta própria, para que as métricas de um mesmo colega não
  //    possam ser reconectadas entre painéis.
  //    Os painéis "por minuto" existem porque quem entrou aos 30' do 2º tempo
  //    sempre teria menos volume absoluto: normalizados, os dois são comparáveis.
  let comparativo = null;
  if (jogoTodo && todosJogo.length > 1) {
    const meuIdx = todosJogo.findIndex((t) => idNoNome(t.atleta) === meuId);
    const painel = (pegar) => {
      const linhas = todosJogo.map((t, i) => ({ v: pegar(t), i }));
      linhas.sort((a, b) => b.v[0] - a.v[0]);
      const idx = linhas.findIndex((x) => x.i === meuIdx);
      return { valores: linhas.map((x) => x.v), meu_indice: idx, posicao: idx + 1 };
    };
    const porMin = (v, t) => (v === null || !t ? 0 : round1(v / t));
    comparativo = {
      total_atletas: todosJogo.length,
      minutagem:   painel((t) => [t.duracao_min ?? 0]),
      distancia:   painel((t) => [t.distancia_m ?? 0]),
      intensidade: painel((t) => [t.hsr_m ?? 0, t.sprint_m ?? 0]),
      acel_decel:  painel((t) => [t.aceleracoes ?? 0, t.desaceleracoes ?? 0]),
      por_minuto:  painel((t) => [t.densidade_m_min ?? 0, porMin(t.hsr_m, t.duracao_min)]),
    };
  }

  const resposta = {
    tipo: "meujogo",
    atleta,
    jogo: { id: alvo.id, nome: alvo.nome, data: alvo.data, fora_da_temporada: foraDaTemporada },
    jogos_disponiveis: jogos.slice(0, 20).map((j) => ({ id: j.id, nome: j.nome, data: j.data })),
    jogo_todo: jogoTodo,
    sessao_toda: sessaoToda,
    tempos: { primeiro, segundo },
    comparativo,
  };

  // 6. Temporada (opcional, mais cara): minutagem somada e evolução em jogos.
  //    Uma chamada /stats por jogo, em lotes, com orçamento de tempo. Se o tempo
  //    acabar ou alguma chamada falhar, devolve o que deu e marca `parcial`.
  //    Otimização possível no futuro: mandar vários activity_id no mesmo filtro
  //    (o campo `values` é array) — não testado contra o tenant, por isso aqui vai
  //    o formato já validado em produção, uma atividade por chamada.
  if (req.query.temporada === "1") {
    const t0 = Date.now();
    const alvos = jogos.slice(0, MAX_JOGOS_TEMPORADA);
    const resultados = [];
    let parcial = false;

    for (let i = 0; i < alvos.length; i += LOTE_TEMPORADA) {
      if (Date.now() - t0 > ORCAMENTO_MS) { parcial = true; break; }
      const lote = alvos.slice(i, i + LOTE_TEMPORADA);
      const r = await Promise.all(lote.map(async (j) => {
        const pa = await registrosPorAtleta(j.id, TOKEN, 12000);
        if (!pa) return { jogo: j, erro: true };
        const entrada = Object.entries(pa).find(([nome]) => idNoNome(nome) === meuId);
        if (!entrada) return { jogo: j, meu: null };
        const deJogo = entrada[1].filter((x) => ehPeriodoJogo(x.periodo));
        if (!deJogo.length) return { jogo: j, meu: null };
        const ag = agregarAtleta(deJogo);
        return { jogo: j, meu: ag,
                 t1: deJogo.filter((x) => tempoDoPeriodo(x.periodo) === 1).length > 0 };
      }));
      resultados.push(...r);
    }

    if (resultados.some((r) => r.erro)) parcial = true;

    const jogados = resultados.filter((r) => r.meu);
    const minutos = round1(soma(...jogados.map((r) => r.meu.duracao_min)) ?? 0);

    resposta.temporada = {
      desde: new Date(ini * 1000).toLocaleDateString("pt-BR", { timeZone: "America/Fortaleza" }),
      jogos_no_periodo: jogos.length,
      jogos_varridos: resultados.length,
      jogos_com_minutos: jogados.length,
      minutos_total: minutos,
      minutos_media: jogados.length ? round1(minutos / jogados.length) : null,
      titular: jogados.filter((r) => r.t1).length,
      distancia_total_m: round1(soma(...jogados.map((r) => r.meu.distancia_m)) ?? 0),
      hsr_total_m: round1(soma(...jogados.map((r) => r.meu.hsr_m)) ?? 0),
      sprint_total_m: round1(soma(...jogados.map((r) => r.meu.sprint_m)) ?? 0),
      parcial,
      // Só os jogos em que ele teve minutos, do mais antigo para o mais recente
      evolucao: jogados.slice(0, 8).reverse().map((r) => ({
        data: r.jogo.data,
        nome: r.jogo.nome,
        atual: r.jogo.id === alvo.id,
        minutos: r.meu.duracao_min,
        distancia_m: r.meu.distancia_m,
        hsr_m: r.meu.hsr_m,
        sprint_m: r.meu.sprint_m,
        densidade_m_min: r.meu.densidade_m_min,
      })),
    };
  }

  // Jogo encerrado não muda mais: cache mais longo que o do tipo=meu.
  res.setHeader("Cache-Control", "s-maxage=1800, stale-while-revalidate=86400");
  return res.status(200).json(resposta);
}

// =============================================================================
// ROTEADOR
// =============================================================================

export default async function handler(req, res) {
  // CORS básico (mesmo padrão dos demais endpoints)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const TOKEN = process.env.CATAPULT_TOKEN;
  if (!TOKEN) {
    return res.status(500).json({ erro: "Token da Catapult não configurado no Vercel." });
  }

  // Aceita variações de escrita para reduzir atrito
  const tipo = String(req.query.tipo || "sessoes").toLowerCase();

  try {
    if (tipo === "sessoes" || tipo === "sessions") {
      return await listarSessoes(req, res, TOKEN);
    }
    if (tipo === "stats" || tipo === "session-stats" || tipo === "estatisticas") {
      return await statsDaSessao(req, res, TOKEN);
    }
    if (tipo === "historico") {
      return await historico(req, res, TOKEN);
    }
    if (tipo === "meu") {
      return await meuRelatorio(req, res, TOKEN);
    }
    if (tipo === "meujogo" || tipo === "jogo") {
      return await meuJogo(req, res, TOKEN);
    }
    if (tipo === "links") {
      return await gerarLinks(req, res);
    }
    if (tipo === "bandas") {
      return await compararBandas(req, res, TOKEN);
    }
    return res.status(400).json({
      erro: `tipo desconhecido: "${tipo}"`,
      tipos_validos: ["sessoes", "stats", "historico", "meu", "meujogo", "links", "bandas"],
      exemplos: [
        "/api/treino?tipo=sessoes&days=7",
        "/api/treino?tipo=stats&activity_id=UUID&debug=1",
        "/api/treino?tipo=historico&activity_ids=UUID1,UUID2",
        "/api/treino?tipo=meu&token=TOKEN",
        "/api/treino?tipo=meujogo&token=TOKEN&activity_id=UUID&temporada=1",
        "/api/treino?tipo=bandas&activity_id=UUID",
      ],
    });
  } catch (erro) {
    return res.status(500).json({ erro: "Erro interno", detalhe: String(erro.message) });
  }
}
