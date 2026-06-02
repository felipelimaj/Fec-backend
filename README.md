# FEC Performance — Backend API

Backend serverless que integra Catapult Connect API ao painel de controle de carga.

## Endpoints

- `GET /api/atletas` — Lista de atletas Catapult com ID do Cadastro extraído.
- `GET /api/match?date=DD/MM/YYYY` — Relatório de jogo da data informada.

## Configuração

Necessária 1 variável de ambiente na Vercel:

- `CATAPULT_TOKEN` — Token Bearer da Catapult Connect API.

## Stack

- Node.js 20+ (built-in fetch)
- Vercel Serverless Functions
- Zero dependências
