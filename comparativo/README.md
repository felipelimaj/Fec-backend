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

## Variáveis do painel

Distância Total, Alta Intensidade (B5+B6+B7, ≥ 19,80 km/h), Sprint (B6+B7, ≥ 25,20 km/h), Acelerações e Desacelerações (≥ 3 m/s²), Player Load, FMP Total Running e FMP Total Dynamic. Velocidade máxima foi retirada.

Os dois FMP chegam da Catapult em segundos (`fmp_running_total_duration`, `fmp_dynamic_total_duration`). Na escala absoluta aparecem como minutos somados da equipe; na escala por minuto viram % do tempo de jogo, sempre recalculado como tempo na banda ÷ tempo em campo. Somar o campo de percentual que a API devolve por período daria número errado.

Acelerações e desacelerações aparecem **por 10 minutos** na escala por minuto. Com uma casa decimal, `0,2/min` não distingue 0,18 de 0,24; por 10 min a mesma casa separa 1,8 de 2,4.

## Cadastro de atletas

Posição e status vêm da planilha `CADASTRO_ATLETAS_PROFISSIONAL_FEC`, publicada na web e lida pelo endpoint a cada carga. A URL está no topo do `api/comparativo.js` e pode ser trocada pela variável de ambiente `CADASTRO_CSV_URL`.

As colunas são reconhecidas pelo texto do cabeçalho, sem acento e sem depender da ordem: ID/CADASTRO/NÚMERO, NOME, POSIÇÃO, STATUS. Confira a leitura em `/api/comparativo?cadastro=1` — a resposta traz quais colunas foram reconhecidas, o total de atletas e quantos estão ativos. Se a planilha não puder ser lida, a extração continua com a posição da Catapult e o painel avisa na tela.

O filtro **Só ativos** vale para as abas Individual e Minutagem. Totais de equipe e recortes por posição usam todos que entraram em campo: remover de um jogo de março quem já saiu do clube faria a referência daquele jogo descrever uma partida que não aconteceu.

## Aba Auditoria

Confere as bandas contra o dado bruto, não contra a documentação. O endpoint devolve, por jogo, as oito bandas de velocidade e as oito de aceleração Gen2 somadas.

Quatro verificações automáticas:

- `soma(band1..band8)` reproduz a distância total, com resíduo abaixo de 1,5% — o resíduo é o deslocamento abaixo de 0,50 km/h, que não entra em banda nenhuma;
- `band8` zerada, confirmando que o tenant tem sete bandas;
- `band6` (25,20–30,00 km/h) com volume e somada na Alta Intensidade;
- %AI/DT entre 3% e 9%, faixa plausível para futebol profissional.

Nas acelerações, o painel confere se `band7plus` bate com `band7 + band8` e se `band1 + band2` — as desacelerações — têm volume comparável, o que é esperado num jogo.

Há ainda uma tabela de resíduo por jogo: resíduo alto num jogo isolado costuma indicar colete com falha de sinal, não erro de banda.
