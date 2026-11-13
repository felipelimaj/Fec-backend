# Registro técnico · Dashboard de Goleiros FEC

Fortaleza EC · Fisiologia · versão 1.0 · 12/11/2026

> **Regra do projeto:** nenhuma métrica, definição, limiar ou coluna entra no painel sem
> aprovação prévia do Felipe e validação de que o dado está correto. Toda decisão
> tomada por Claude está declarada na seção 6.

## 1. Objetivo

Acompanhar, sessão a sessão, a carga dos goleiros na temporada 2026, com poucas
métricas e leitura longitudinal, no modelo visual do painel "PSE Diária / PSE da
Sessão / Ações de Intensidade / Player Load" do Power BI.

## 2. Base na dissertação

*Monitoramento da carga e do desempenho neuromuscular de goleiros de futebol*
(PPGFisio/UFC, 2026). Três achados orientam o painel:

1. **Métricas específicas da posição primeiro.** Entre os dias de treino, o volume
   locomotor quase não variou; mergulhos e carga de mergulho é que diferenciaram o
   microciclo (menores no MD-1). Por isso a primeira aba é a de ações específicas.
2. **Jogo não é o teto da carga específica.** Os jogos tiveram a maior distância e a
   maior PSE, mas o menor número de mergulhos e esforços explosivos. O painel separa
   visualmente jogo e treino para que essa leitura seja imediata.
3. **Cada goleiro contra o próprio histórico.** A linha de referência e os cartões
   são do próprio goleiro, no período escolhido — nunca do grupo.

A distância acima de 19,8 km/h ficou de fora: na dissertação, a mediana foi 0 m em 19
de 21 combinações grupo × dia. A potência Keiser ficou de fora por decisão do Felipe
(só dados de GPS nesta versão). A classificação por MD e por status (titular, reserva,
não relacionado) também ficou de fora: o painel é só linha do tempo.

## 3. Arquitetura

- Código na pasta `goleiros/` do repositório `felipelimaj/Fec-backend`, publicado como
  projeto Vercel separado (`fec-goleiros`, Root Directory = `goleiros`), no modelo do
  Comparativo. Uma única função serverless (`api/index.js`) despacha as rotas; ela
  não conta no limite de 12 do projeto antigo.
- `GET /api/dados`: Cadastro → GRUPOS TAG → `/activities` da temporada em blocos de
  60 dias → só as atividades com bloco de goleiro → `POST /stats` em lotes de 40
  atividades → sessões prontas. ~15 chamadas à Catapult por carga.
- `GET /api/sonda`: diagnóstico (catálogo de slugs, leitura da Tag, períodos das
  atividades recentes, `/stats` de teste por goleiro).
- Cache: `s-maxage=1800, stale-while-revalidate=86400` na CDN; `localStorage` no
  navegador; botão **Atualizar dados** força nova busca.
- `/stats` tenta, nesta ordem: agrupamento atividade × período × atleta com filtro de
  atleta; o mesmo sem filtro; período × atleta (combinação já usada nos outros
  projetos), com a atividade recuperada pelo `period_id`. O agrupamento usado sai em
  `diagnostico.agrupamentoStats`.

## 4. Fontes e regras

| Item | Regra |
|---|---|
| Goleiros | Cadastro de Atletas, POSIÇÃO contendo "GOLEIR"; o seletor mostra só quem tem sessão na temporada |
| Atleta na Catapult | ID do Cadastro no nome ("11 JOÃO.R" → 11) |
| Temporada | de 29/12/2025 até hoje |
| Sessão de jogo | soma de `1goleiro` + `2goleiro`; o aquecimento "Goleiros" fica fora |
| Sessão de treino | soma dos períodos com "goleiros" no nome (sem acento, qualquer caixa) |
| Jogo × treino | jogo = atividade com período `1tempo`/`2tempo`/`1goleiro`/`2goleiro` |
| Grupo, Dia Código, PSE | GRUPOS TAG, Página1, por ID e data (datas M/D/AA ou M/D/AAAA, desempate pelo "dd-mm" do ADV, mesma lógica do `converter.js`) |
| PSE da sessão | PSE × duração da sessão do goleiro na Catapult (min) |

## 5. Métricas

| Métrica | Slug | Situação |
|---|---|---|
| Duração | `total_duration` | confirmado |
| Distância total | `total_distance` | confirmado |
| PlayerLoad | `total_player_load` | confirmado |
| Mergulhos | `total_goalkeeping_dives` | confirmado pela sonda de 26/09/2026 (componente das fórmulas de esforços explosivos) |
| Carga de mergulho | — | **pendente**: slug não identificado; procurar "dive" em `/api/sonda` |
| Esforços explosivos | `explosive_efforts_gk` ou `esforços_explosivos_2` | **pendente**: Felipe confere no OpenField qual é a da dissertação |
| PSE | coluna da Página1 | localizada pelo cabeçalho; conferir `tag.colunaPSE` na sonda |

Slug pendente nunca é pedido à Catapult; o gráfico mostra o motivo no lugar dos dados.
Antes de cada carga os slugs confirmados são cruzados com `/parameters`: slug que
sumir do tenant sai da chamada e vira aviso, em vez de derrubar o `/stats` inteiro.

## 6. Decisões tomadas por Claude (para aprovar ou trocar)

| # | Decisão | Onde mudar |
|---|---|---|
| 1 | Início da temporada em 29/12/2025 (semana 1 do Carga por Microciclo) | `INICIO_TEMPORADA` em `lib/config.js` |
| 2 | **Sem** corte mínimo de duração no bloco de treino (a dissertação usou ≥30 min) | `duracaoMinimaTreinoMin` |
| 3 | Goleiro em atividade de jogo sem `1goleiro`/`2goleiro` (reserva) não gera sessão | `lib/goleiros.js` |
| 4 | Mais de um período "goleiros" na mesma atividade: somados numa sessão | `lib/goleiros.js` |
| 5 | Duas atividades no mesmo dia = duas sessões (como na dissertação). A Tag é diária: N linhas para N sessões são pareadas na ordem; 1 linha para 2 sessões → PSE não atribuída a nenhuma, com aviso. Grupo e Dia Código vão para todas | `aplicarTag()` |
| 6 | PSE da sessão calculada com a duração do bloco na Catapult, não com uma coluna de PSE da sessão da Tag | `aplicarTag()` |
| 7 | PSE fora de 0–10 descartada e contada no diagnóstico | `lerPSE()` |
| 8 | Coluna de PSE: cabeçalho exatamente "PSE", "RPE" ou "PSE (CR-10)"; senão, o único que começa com PSE e não é de sessão; dois candidatos → nenhum (sem chute) | `PSE_COLUNA` |
| 9 | Linha de referência e cartões = **média** do período visível (como no print), com botão para **mediana** (a estatística da dissertação) | painel |
| 10 | Jogo em vermelho com losango, treino em azul com círculo — tipo da sessão, não classificação por MD | painel |
| 11 | Valor em todos os pontos (como no print) quando cada sessão tem ≥22 px; abaixo disso, só maior, menor e último (o resto na dica e na tabela) | `MIN_PX_ROTULO` |
| 12 | Janela inicial: 6 semanas até a última sessão do goleiro | painel |
| 13 | Duração da sessão só na dica e na tabela (não virou gráfico) | painel |
| 14 | Foto do Cadastro (coluna FOTO) no crachá da barra lateral | painel |
| 15 | Cores de série validadas para daltonismo no fundo azul-noite (`#2F8EF5` treino, `#F2552C` jogo) | `:root` do painel |

## 7. Testes

`node testes/testes_goleiros.mjs` — 94 verificações com Catapult e planilhas simuladas:
regras de período, datas da Tag, coluna de PSE, sessões de treino e de jogo, reserva
sem sessão, slugs pendentes não pedidos, pareamento da PSE em dia duplo, PSE inválida,
os três modos de `/stats` e a sonda. Uma sabotagem proposital da regra do bloco de
treino derruba 16 verificações.

## 8. Pendências

1. Rodar `/api/sonda` no ar e conferir os itens do README (passo 5).
2. Slug da carga de mergulho.
3. Qual métrica de esforços explosivos é a da dissertação.
4. Aprovar ou trocar as decisões da seção 6.
5. Validar uma semana do painel contra o OpenField e a Tag antes de mostrar à comissão.
