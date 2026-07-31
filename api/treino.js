// api/treino.js
// Etapas 1 + 2 unificadas num único endpoint (limite de 12 funções do plano Hobby).
//
// USO:
//   /api/treino?tipo=sessoes                      -> lista sessões dos últimos 30 dias
//   /api/treino?tipo=sessoes&days=60              -> lista sessões dos últimos 60 dias (máx. 180)
//   /api/treino?tipo=stats&activity_id=UUID       -> métricas por atleta e bloco
//   /api/treino?tipo=stats&activity_id=UUID&debug=1  -> + chaves cruas do 1º registro
//
// Sem ?tipo, o padrão é "sessoes".

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
// - Acelerações (B2+B3) vêm pré-somadas em band7plus
// - Desacelerações têm numeração INVERTIDA: band1 = Decel B3 (severa), band2 = Decel B2 (média)
// - max_vel já chega em km/h (NUNCA multiplicar por 3.6)
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
      b1: round1(b1), b2: round1(b2), b3: round1(b3),
      b4: round1(b4), b5: round1(b5), b6: round1(b6),
    },
    // HSR = B5+B6 (≥19,80 km/h) — definição do projeto, NÃO inclui B4
    hsr_m: round1(soma(b5, b6)),
    // Sprint = B6 (≥25,20 km/h, sem teto no tenant)
    sprint_m: round1(b6),
    // Acelerações B2+B3 (pré-somadas pela Catapult)
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
    return res.status(400).json({
      erro: `tipo desconhecido: "${tipo}"`,
      tipos_validos: ["sessoes", "stats"],
      exemplos: [
        "/api/treino?tipo=sessoes&days=7",
        "/api/treino?tipo=stats&activity_id=UUID&debug=1",
      ],
    });
  } catch (erro) {
    return res.status(500).json({ erro: "Erro interno", detalhe: String(erro.message) });
  }
}
