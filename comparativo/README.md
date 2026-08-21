# FEC — Comparativo de Bloco de Jogos

Painel de comparação entre blocos de jogos da temporada, com dados da Catapult Connect API.
Departamento de Fisiologia do Esporte — Adriano Lima e Felipe Lima.

## Conteúdo

```
api/comparativo.js   1 Serverless Function
index.html           o painel (arquivo estático, não conta no limite da Vercel)
vercel.json          maxDuration de 60 s para a função
package.json         type: module (o endpoint usa export default)
```

Uma função só. O plano gratuito da Vercel permite 12 por deployment, então este projeto usa 1/12.

## Publicando

1. Suba estes arquivos para um repositório (novo, ou uma pasta dentro de um existente).
2. Na Vercel: **Add New → Project**, escolha o repositório.
3. Se os arquivos estiverem numa subpasta, abra **Root Directory** e aponte para ela. É isso que impede a Vercel de enxergar as funções do resto do repositório.
4. Em **Environment Variables**, crie `CATAPULT_TOKEN` com o mesmo token Bearer usado no Fec-backend.
5. Deploy.

O painel abre na raiz do domínio. `BACKEND` está vazio no `index.html`, ou seja, mesma origem — não precisa configurar nada.

## Conferindo

- `/api/comparativo?listar=1&ini=01/01/2026` — só a lista de jogos. Barato, confirma que o token responde.
- `/api/comparativo?datas=19/08/2026,15/08/2026` — os atletas de dois jogos.
- Abrindo o painel, o botão **Exemplo** preenche tudo com números inventados e faixa vermelha no topo. Serve para conferir layout, nada mais.

## Alternativa: rota dentro de um despachante

Se preferir não criar projeto novo, o arquivo também exporta `rotaComparativo`, com a mesma assinatura `(req, res)`. Num projeto que já use o padrão `api/index.js` — como o Fec-performance — basta importar e acrescentar o caso na tabela de rotas. Nenhuma função nova é criada.

```js
import { rotaComparativo } from './comparativo.js';
// ...
if (rota === 'comparativo') return rotaComparativo(req, res);
```

Nesse caminho, ajuste `BACKEND` no topo do `<script>` do `index.html` para a URL desse projeto, caso o painel fique hospedado em outro domínio.
