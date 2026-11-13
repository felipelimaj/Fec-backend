// =============================================================================
//  Dashboard de Goleiros FEC — Função serverless ÚNICA
//  Todas as rotas passam por aqui (limite de 12 funções do plano Hobby).
//  Rota nova = entrada nova no mapa ROTAS, nunca arquivo novo em /api.
// =============================================================================

import { dados, sonda } from '../lib/handlers.js';

export const config = { maxDuration: 60 };

const ROTAS = { dados, sonda };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const rota = (req.url.split('?')[0] || '').replace(/^\/api\/?/, '').replace(/\/+$/, '');

  if (!rota || rota === 'index') {
    return res.status(200).json({
      servico: 'Dashboard de Goleiros FEC',
      rotas: {
        '/api/dados': 'temporada dos goleiros (usado pelo painel)',
        '/api/sonda': 'diagnóstico de slugs, Tag e períodos',
        '/api/sonda?activity_id=UUID': 'valores dos candidatos numa atividade',
      },
    });
  }

  const fn = ROTAS[rota];
  if (!fn) return res.status(404).json({ erro: `Rota "${rota}" não existe.`, rotas: Object.keys(ROTAS) });

  const token = process.env.CATAPULT_TOKEN;
  if (!token) {
    return res.status(500).json({ erro: 'CATAPULT_TOKEN não configurado nas variáveis de ambiente da Vercel.' });
  }

  try {
    return await fn(req, res, token);
  } catch (err) {
    console.error(`erro em /api/${rota}:`, err);
    return res.status(err.status && err.status >= 400 ? err.status : 500)
      .json({ erro: err.message, detalhe: err.detalhe || null, rota });
  }
}
