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
1. Exporte o `Jogos_CTR_2026.xlsx` da Catapult, como já faz para a Minutagem.
2. Abra `/atualizar.html`, solte o export e clique em **Buscar Tag publicada**. Se a busca falhar, envie o arquivo GRUPOS TAG.
3. Clique em **Gerar base** e confira os itens (datas no futuro, sessões sem grupo, regressão).
4. Clique em **Baixar dados.js** e troque no GitHub, ou use **Enviar ao GitHub** com um token fine-grained (Contents: read/write). O Vercel republica sozinho.

## Regras de cálculo
- Fonte: só a linha `Session` (o total do dia do atleta, incluindo o jogo). Descarta as linhas com distância 0 e as linhas idênticas repetidas.
- Datas: mesmas correções da Minutagem (tipos misturados, conferência pelo Day Name, desempate pela ordem das linhas).
- Grupo: por atleta e por dia (ID do `Player Name` = ID da Tag). Atleta-dia sem Tag vira `SEM TAG`.
- Barra: soma semanal de cada atleta e depois a média entre os atletas com pelo menos uma sessão no filtro. Com um atleta selecionado, a barra é a soma dele.
- HSR = Velocity Band 5 + 6 + 7. A banda 8 não existe no tenant nem no export e entra como 0. As colunas "(Set 2)" não são usadas.
- Acel./Desacel. = Acceleration / Deceleration B2-3 Total Efforts (Gen 2).
- Sessões da semana: em cada dia, o número de sessões feito pela maioria dos atletas do filtro (dia com dois períodos = 2), somado na semana.
- Jogos: dias com `Dia Código = D_0` na Tag.

Referência (base de 09/10/2026): 6.150 sessões-atleta, 68 atletas, 60 jogos, 41 semanas. Na semana 41, o G1 tem 12.829 m de média, com 13 atletas.
