# Dashboard de Goleiros · Fortaleza EC

Painel de acompanhamento longitudinal dos goleiros na temporada 2026, com dados da
Catapult (API) e da GRUPOS TAG (Grupo, Dia Código e PSE).

Mora na pasta `goleiros/` do repositório `felipelimaj/Fec-backend` e é publicado como
**projeto Vercel separado** com Root Directory = `goleiros` — o mesmo modelo do
Comparativo (`claude_deploy_vercel_projeto_isolado.md`). Assim a função dele não conta
no limite de 12 do projeto antigo.

## O que tem no painel

| Aba | Gráficos | Fonte |
|---|---|---|
| Ações específicas | Mergulhos · Carga de mergulho · Esforços explosivos | Catapult |
| Carga interna | PSE (CR-10) · PSE da sessão (PSE × min) | GRUPOS TAG + Catapult |
| Contexto locomotor | Distância total · PlayerLoad | Catapult |

Na barra lateral: goleiro, período (4, 6 ou 12 semanas, temporada ou datas livres),
filtro de sessões (todas, treinos, jogos), referência (média ou mediana do período) e
os cartões com o valor de referência de cada gráfico da aba. Passar o mouse sobre
qualquer gráfico mostra a sessão inteira (todas as métricas da aba, duração, Grupo e
Dia Código). O botão **Tabela** lista as sessões e baixa o CSV.

**Carga de mergulho** e **Esforços explosivos** aparecem como *pendente* até os slugs
serem conferidos (passo 7 abaixo).

## Arquivos (dentro de `goleiros/`)

```
index.html            painel (HTML + JS puro, sem build)
escudo.png            escudo do clube
api/index.js          função serverless única (rotas /api/dados e /api/sonda)
lib/config.js         slugs, planilhas, regras de sessão — ponto único de verdade
lib/catapult.js       chamadas à Catapult (retry, datas em Brasília, lotes)
lib/planilhas.js      Cadastro e GRUPOS TAG (CSV publicado)
lib/goleiros.js       montagem das sessões do goleiro
lib/handlers.js       rotas
testes/               testes offline com a Catapult simulada
vercel.json · package.json · .vercelignore
REGISTRO_TECNICO.md   decisões, regras e pendências
```

## Como publicar (passo a passo)

**1. Testar (opcional).** No Terminal, dentro da pasta `goleiros`:
`node testes/testes_goleiros.mjs` → deve terminar com `0 falha(s)`.

**2. Subir a pasta no GitHub.** `github.com/felipelimaj/Fec-backend` (raiz) →
**Add file → Upload files** → arraste **a pasta `goleiros` inteira**, não os arquivos
soltos. Commit.
✅ Na lista abaixo da área de upload, **todos** os caminhos começam com `goleiros/`
(ex.: `goleiros/api/index.js`, `goleiros/lib/config.js`).
⚠️ Se algum arquivo cair na pasta `api/` da raiz, o projeto antigo ganha uma 13ª
função e o deploy dele falha. Plano B: **Add file → Create new file** e digitar o
caminho completo com as barras (`goleiros/api/index.js`).

**3. Conferir o repositório.** Na raiz do Fec-backend aparece a pasta `goleiros` ao
lado de `carga` e `comparativo`, e `goleiros/api/index.js` existe. A pasta `api/` da
raiz continua igual.

**4. Criar o projeto na Vercel.** `vercel.com` → **Add New → Project** → importar o
**Fec-backend** (o aviso de que o repositório já está em uso é esperado). Antes do
Deploy:
- **Project Name:** `fec-goleiros`
- **Framework Preset:** Other
- **Root Directory:** Edit → `goleiros` ← este é o passo que separa os projetos
- **Include source files outside of the Root Directory:** desmarcado

**5. Token.** Ainda na tela de configuração, **Environment Variables** → `CATAPULT_TOKEN`
com o mesmo valor do Fec-backend (projeto antigo → Settings → Environment Variables →
⋯ → revelar/copiar). **Deploy**. Se a variável for colocada depois, faça **Redeploy**.

**6. Conferir a API.** Abra `https://<domínio do projeto>/api` → lista de rotas.
`CATAPULT_TOKEN não configurado` = variável não salva ou sem Redeploy.

**7. Rodar a sonda.** `https://<domínio do projeto>/api/sonda`. Confira:

| Campo da resposta | O que deve aparecer |
|---|---|
| `tag.colunaPSE` | o nome da coluna de PSE da Página1 (se vier `null`, ver `tag.cabecalho` e preencher `PSE_COLUNA` em `lib/config.js`) |
| `parametros.metricas.mergulhos.slug_existe_no_tenant` | `true` |
| `parametros.relacionados_no_tenant` | procure o slug da **carga de mergulho** (algo com "dive") |
| `parametros.metricas.explosivos.candidatos_que_existem` | `explosive_efforts_gk` e/ou `esforços_explosivos_2` |
| `atividades_recentes[].contariam_para_goleiro` | treinos com o bloco "Goleiros"; jogos com `1goleiro`, `2goleiro` |
| `stats_teste.por_goleiro` | valores por período de cada goleiro numa atividade — compare com o OpenField |

Para uma atividade específica: `/api/sonda?activity_id=UUID`. Com o slug confirmado,
em `lib/config.js` troque `slug: null` pelo slug e `status: 'pendente'` por
`status: 'confirmado'` em `carga_mergulho` e `explosivos`.

**8. Abrir o painel** na raiz do domínio do projeto. A primeira carga leva de 10 a
30 s (temporada inteira). Depois o painel abre com o último carregamento salvo no
navegador; o botão **Atualizar dados** busca de novo.

## Efeitos colaterais (iguais aos do Comparativo)

- `fec-backend-sigma.vercel.app/goleiros/` também passa a mostrar a página, mas sem
  API: ela avisa que o endereço certo é o do projeto de goleiros. Para esconder, um
  `.vercelignore` na raiz do Fec-backend com a linha `goleiros`.
- Cada commit no Fec-backend republica os dois projetos. Esperado.

## Atualizar um arquivo depois

No GitHub, entre na pasta (`goleiros/lib`, por exemplo) e use **Add file → Upload
files** de dentro dela: o arquivo arrastado substitui o de mesmo nome naquela pasta.

## Atualização dos dados

Não há rotina: o painel lê a Catapult e a GRUPOS TAG publicada quando alguém clica em
**Atualizar dados**. A Vercel guarda a resposta por 30 minutos para quem abrir o link
sem clicar. Cada carga usa cerca de 15 chamadas à Catapult (o limite medido é ~70 por
varredura).
