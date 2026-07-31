// api/sessions.js
// Etapa 1 — Lista as sessões (activities) da Catapult Connect API v6
// Uso: /api/sessions            -> últimos 30 dias
//      /api/sessions?days=60    -> últimos 60 dias

export default async function handler(req, res) {
  // CORS básico (mesmo padrão dos demais endpoints)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const TOKEN = process.env.CATAPULT_TOKEN;

  // Conta FEC: região US (Customer ID 2101)
  const BASE_URL = "https://connect-us.catapultsports.com/api/v6";

  if (!TOKEN) {
    return res.status(500).json({ erro: "Token da Catapult não configurado no Vercel." });
  }

  try {
    // Janela de tempo: últimos N dias (padrão 30), em segundos Unix
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
        erro: "Falha na API da Catapult",
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
      total: sessoes.length,
      periodo_dias: days,
      sessoes,
    });
  } catch (erro) {
    return res.status(500).json({ erro: "Erro interno", detalhe: String(erro.message) });
  }
}
