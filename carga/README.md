# Carga por Microciclo 2026 · Fortaleza EC

Endereço: https://fec-backend-sigma.vercel.app/carga/ · fica na pasta `carga/` do repositório `felipelimaj/Fec-backend`.

Painel estático (sem servidor) com a carga semanal (segunda a domingo) desde o primeiro treino da temporada, com filtro por grupo da GRUPOS TAG.

## Arquivos
| Arquivo | Função |
|---|---|
| `index.html` | painel |
| `dados.js` | base gerada (não editar à mão) |
| `atualizar.html` | gera um novo `dados.js` no navegador e, se quiser, envia direto ao GitHub |
| `converter.js` | motor de leitura, usado pelo `atualizar.html` e pelo `gerar_base.js` |
| `gerar_base.js` | alternativa em Node: `node gerar_base.js Jogos_CTR_2026.xlsx "GRUPOS TAG.xlsx"` |

## Rotina de atualização
1. Exporte o `Jogos_CTR_2026.xlsx` da Catapult.
2. Abra `/atualizar.html` e solte o export.
3. GRUPOS TAG: clique em **Buscar Tag publicada**, ou envie o arquivo .xlsx. O arquivo é necessário quando há jogo novo ou troca de treinador, porque a aba Jogos 2026 não vem pelo link.
4. Cadastro: clique em **Buscar Cadastro** (lista de goleiros). Se pular esta etapa, ficam os goleiros da base atual.
5. Clique em **Gerar base** e confira os itens: datas, sessões sem grupo, treinadores, goleiros excluídos e regressão.
6. Para publicar, clique em **Baixar dados.js** e troque o arquivo em `carga/` no GitHub, ou use **Enviar ao GitHub**. Gerar a base não publica nada: os dados só aparecem no link depois que o `dados.js` novo chega ao GitHub.

## Recursos do painel
- **Aba Semanal:** grade 2×2 com Distância, HSR, Sprint e Acel./Desacel. (barras agrupadas), uma barra por semana. Tem faixas por treinador, rótulos girados dentro das barras, tooltip com sessões e CSV por gráfico.
- **Aba Dia a dia:** 1, 2 ou 4 semanas, navegando com ◀ ▶. A grade 2×2 mostra a média do grupo por dia, com o atleta buscado em losango dourado. Abaixo, um mapa de calor atleta × dia por variável, com CSV.
- **Filtros:** grupo (vários), Dia Código (vários), busca de atleta por digitação, Acumulado ou Média por sessão, e o método de cálculo (A ou B).
- **Cartões:** a média das semanas das 5 variáveis e o valor da semana selecionada.

## Regras de cálculo
- **Fonte:** só a linha `Session`, que é o total do dia do atleta, incluindo o jogo. Descarta as linhas com distância 0 e as linhas idênticas repetidas.
- **Goleiros** (POSIÇÃO = GOLEIRO no Cadastro de Atletas) são removidos da base: não entram em nenhuma soma, média ou contagem.
- **Datas:** mesmas correções da Minutagem.
- **Grupo e Dia Código:** vêm da Tag, por atleta e por dia. Atleta-dia sem Tag vira `SEM TAG` com código `—`.
- **Média do dia:** soma dos atletas presentes ÷ número de atletas presentes.
- **Método B (médias diárias):** acumulado = soma das médias dos dias da semana; média por sessão = acumulado ÷ sessões da semana.
- **Método A (somas individuais):** acumulado = média, entre os atletas que apareceram, das somas semanais de cada um. Média por sessão = média, entre os atletas, de (soma do atleta ÷ sessões dele).
- **Sessões da semana:** em cada dia, o número de sessões que a maioria dos atletas do filtro fez (dia com dois períodos = 2), somado na semana.
- **HSR** = Velocity Band 5 + 6 + 7 (≥ 19,8 km/h). **Sprint** = Velocity Band 6 + 7 (≥ 25,2 km/h). A banda 8 não existe no tenant. As colunas "(Set 2)" não são usadas.
- **Acel./Desacel.** = esforços B2-3 (Gen 2).
- **Treinador:** cada dia pertence ao treinador do próximo jogo (coluna CODIGO da aba Jogos 2026). A semana leva a cor do treinador com mais dias nela.

Referência (base de 09/10/2026, sem goleiros): 5.350 sessões-atleta. Semana 37, filtro G1 + D_0, Distância: método B = 19.815 m acumulado e 9.907 m por sessão; método A = 14.154 m e 9.840 m.
