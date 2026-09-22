# Automação em tokens novos: estudo e proposta — 22/09/2026

Em 22/09 o owner recusou os gatilhos de calma propostos antes: preço até 1% da média
de 30 minutos e variação até 0,5% no último minuto. As razões foram três. Tokens novos
variam dezenas de por cento em minutos. O dono do vault responde pela própria posição.
Um ataque de manipulação contra o swap de um compound de taxas precisa valer muito a
pena. O owner aprovou slippage máxima de 1% e deixou o Chainlink de fora por ora.
Este estudo refaz a análise a partir do que os contratos exigem de fato e dos dados da
chain, e propõe como o ciclo deve operar em tokens voláteis.

Todos os dados vêm do nó próprio no clawber, por um túnel SSH até a porta local do RPC,
sem token de rota. São eventos `Swap`, `ModifyLiquidity` e `Initialize` do PoolManager
e leituras da StateView. Scripts e evidências estão em
[`new-token-automation-2026-09-22/`](new-token-automation-2026-09-22/).

## 1. O que os contratos exigem de fato

| Regra | Onde | Quem define |
| --- | --- | --- |
| O preço publicado fica a até 50 bps da raiz do spot do pool no bloco da publicação, cerca de 1% no preço | PriceGuard | Imutável |
| O bloco observado é anterior à publicação e à execução, e tem menos de 256 blocos, cerca de 25 s | PriceGuard e engine | Imutável |
| Na execução, o spot e os preços antes e depois do swap ficam dentro do impacto máximo em relação à âncora | Engine | Dono do vault, padrão do app 1% |
| O swap rende pelo menos a cotação na âncora menos a slippage máxima, com a taxa do pool dentro | Engine | Dono do vault, 1% aprovado |
| O spot na execução fica dentro da faixa do plano | Engine | Serviço, hoje cerca de ±0,5% por escolha minha |
| O pool não tem hook | Setup, read helper do vault e app | Imutável no V1 |

Fora o guard, que olha só o intervalo de cerca de meio segundo entre observar e
publicar, e a janela de 256 blocos, a tolerância a volatilidade é uma escolha do dono.
O que o serviço controla é a latência entre o bloco observado e a execução. A faixa do
plano mais estreita que o limite do dono é uma escolha minha e não tem motivo para
continuar.

## 2. O que o V1 alcança: pools sem hook

O Setup, o read helper do vault e o app recusam qualquer pool com hook, e isso é
imutável no V1. O censo lê todos os pools que o PoolManager já inicializou, 861.662
até hoje, e os 2,54 milhões de swaps do último dia. O volume é valorizado pelo lado
ETH, WETH ou USDG de cada pool, e pools sem nenhum desses tokens ficam fora da soma.

| Pools com swaps no último dia | Pools | Swaps | Volume |
| --- | ---: | ---: | ---: |
| Sem hook | 10.497 | 1.250.809, 49% | US$ 165 milhões, 31% |
| Com hook | 10.614 | 1.286.687, 51% | US$ 366 milhões, 69% |

Entre os pools criados no último dia, 4.464 sem hook negociaram US$ 60 milhões, e 1.173
com hook negociaram US$ 211 milhões. O volume com hook se concentra em poucos designs.
Um hook de lançamento com as permissões dos pools abaixo aparece em 7 pools com US$ 97
milhões no dia. Um único hook, usado por 5.056 pools, soma US$ 60 milhões.
O pool WETH/USDG mais profundo da chain também tem hook, com taxa dinâmica.

Os quatro pools de lançamento estudados usam hook. O endereço de cada hook termina em
`0xa80`, o que liga as permissões antes de adicionar liquidez, antes de remover e antes
do swap. A leitura de todos os `ModifyLiquidity` desde a criação mostra o seguinte:

| Pool | Hook | Adições de liquidez | Posições criadas | Donos distintos hoje |
| --- | --- | ---: | ---: | ---: |
| PKRT/WETH | sim | 1 | 1 | 1 |
| PGREM/WETH | sim | 1 | 1 | 1 |
| STPASS/WETH | sim | 1 | 1 | nenhum, posição retirada |
| EARLY/WETH | sim | 1 | 1 | nenhum, posição retirada |
| AD/ETH | não | 80 | 57 | 13 |
| HOODCATS/ETH | não | 31 | 24 | 10 |
| AI/USDG | não | 4.369 | 3.549 | 45 |
| META/USDG | não | 2.830 | 1.745 | 107 |
| WETH/USDG, o mais profundo | sim, taxa dinâmica | 31.709 | 2.286 pelo PositionManager | 128 |

Nos pools de lançamento, a única liquidez é a posição criada no lançamento. Nenhuma
outra posição apareceu, e em dois deles a posição única já saiu. Não verifiquei se o hook
recusa adições de fora, mas nenhuma aconteceu em milhares de swaps. Um hook não impede
LPs por si só: o pool WETH/USDG de taxa dinâmica tem 128 donos.

Para ver se isso vale em geral, contei as posições de todos os 21.038 pools criados
nas últimas 48 horas:

| Pools criados em 48 h e negociados | Uma posição | Duas a quatro | Cinco ou mais |
| --- | ---: | ---: | ---: |
| Sem hook, 8.283 pools | 86% | 9% | 5% |
| Com hook, 2.375 pools | 47% | 48% | 5% |

Posições distintas não são donos distintos, porque quem cria o pool pode abrir várias
faixas. Mesmo assim, a maioria dos pools novos sem hook só tem a posição de quem os
criou. Os tokens que sobrevivem atraem LPs: AD, com cinco dias, tem 13 donos, AI, com
19 dias, tem 45, e META tem 107. O mercado que o V1 alcança são os tokens novos sem
hook que passam das primeiras horas, e os próprios criadores, se quiserem automatizar
a posição de lançamento.

## 3. A latência decide, não a volatilidade de meia hora

Para cada pool, o estudo compara o preço no fim de um bloco com o preço alguns blocos
depois, a partir de pontos a cada dez blocos ao longo de 24 horas. A chain produziu
cerca de dez blocos por segundo.

| Pool | Guard na publicação, 0,5 s | Compound direto em 2 s, faixa 1% / 5% | Com swap em 2 s, faixa 1% / 5% | Compound direto em 5 s, faixa 1% / 5% | Com swap em 5 s, faixa 1% / 5% |
| --- | ---: | ---: | ---: | ---: | ---: |
| PKRT/WETH | 88% | 62% / 93% | 58% / 74% | 39% / 84% | 35% / 57% |
| PGREM/WETH | 89% | 66% / 93% | 63% / 77% | 44% / 84% | 41% / 61% |
| STPASS/WETH | 90% | 67% / 95% | 63% / 76% | 45% / 88% | 40% / 61% |
| EARLY/WETH | 93% | 80% / 97% | 78% / 86% | 68% / 92% | 65% / 78% |
| AD/ETH | 99,7% | 99% / 100% | 97% / 98% | 96% / 100% | 93% / 95% |
| HOODCATS/ETH | 99,4% | 97% / 100% | 97% / 98% | 94% / 100% | 93% / 95% |
| AI/USDG | 100% | 100% / 100% | 100% / 100% | 100% / 100% | 100% / 100% |
| META/USDG e WETH/USDG | 100% | 100% | 100% | 100% | 100% |

O swap assume slippage de 1% e desconta a taxa do pool e um impacto próprio pequeno.
Mesmo nos pools de lançamento, com o preço andando dezenas de por cento por minuto, um
ciclo de dois segundos passaria na maioria das tentativas. Nos tokens novos sem hook,
passaria em 93% das vezes ou mais até cinco segundos, com o limite padrão de 1%. Cada
tentativa recusada custa a publicação, cerca de dois centavos de dólar no gás de hoje.

## 4. O custo de manipular e o quanto o atacante leva

Mover o preço de um pool por uma fração e trazê-lo de volta custa ao atacante,
em taxas, cerca de taxa × profundidade × fração. A profundidade é a liquidez ativa vezes
a raiz do preço, em moeda de cotação. O ganho sobre o swap do compound é o tamanho do
swap vezes a mesma fração. Por isso o ataque só se paga quando o swap passa de
taxa × profundidade, qualquer que seja o tamanho do movimento.

| Pool | Swap de equilíbrio, mediana | Custo para mover 1% e voltar | Ganho máximo pós-observação num swap de US$ 1.000 | Num swap de US$ 10.000 |
| --- | ---: | ---: | ---: | ---: |
| PKRT/WETH | US$ 552 | US$ 5,52 | US$ 2,91 | US$ 61 |
| PGREM/WETH | US$ 441 | US$ 4,41 | US$ 3,63 | US$ 62 |
| STPASS/WETH | US$ 666 | US$ 6,66 | US$ 2,17 | US$ 61 |
| EARLY/WETH | US$ 332 | US$ 3,32 | US$ 4,35 | US$ 63 |
| AD/ETH | US$ 75 | US$ 0,75 | US$ 6,11 | US$ 66 |
| HOODCATS/ETH | US$ 65 | US$ 0,65 | US$ 6,17 | US$ 66 |
| AI/USDG | US$ 10.420 | US$ 104 | nenhum | nenhum |
| META/USDG | US$ 241.080 | US$ 2.411 | nenhum | nenhum |

Isso corrige parte da premissa: mover um pool raso é barato. No AD, mover 1% e voltar
custa menos de um dólar em taxas. O que protege o compound é a proporção. Depois da
observação, o piso de saída do engine limita o que o atacante tira a cerca de 0,65% do
swap, então num swap de mil dólares o ganho máximo fica em poucos dólares, antes do
risco de estoque num token volátil e da corrida contra um ciclo de segundos. Antes da
observação o piso não limita, porque a âncora já nasce deslocada. Mesmo assim, com o
swap até taxa × profundidade, o ataque perde dinheiro só em taxas.

## 5. Os swaps de rebalanceamento são pequenos

Para uma posição com 1% da liquidez ativa, o estudo soma a taxa de LP que ela receberia
em cada token, por intervalo, e estima o swap que igualaria o valor dos dois lados.

| Pool | Taxas por hora, mediana | Swap de rebalanceamento por hora, p90 | Intervalos de 5, 30 e 60 min abaixo do equilíbrio |
| --- | ---: | ---: | ---: |
| Lançamento, quatro pools | US$ 55 a US$ 122 | US$ 21 a US$ 34 | 100% |
| AD/ETH e HOODCATS/ETH | US$ 0,34 a US$ 0,68 | até US$ 0,03 | 100% |
| AI/USDG | US$ 6,72 | US$ 1,12 | 100% |
| META/USDG | US$ 6,33 | US$ 3,37 | 100% |

As taxas chegam nos dois tokens porque o fluxo tem compras e vendas. O swap necessário
fica muito abaixo do equilíbrio em todos os pools, mesmo compondo de hora em hora.

## 6. Proposta

1. **Sem gatilho de volatilidade.** O ciclo age sempre que o planner vê economia. A
   âncora é o spot do bloco observado mais recente. Não há média, referência externa
   nem período de aquecimento além do histórico de taxas que o planner já exige.
2. **Latência como requisito.** O alvo é no máximo cinco segundos entre o bloco
   observado e a execução, e idealmente dois. A avaliação pesada fica pronta antes. No
   momento de agir, o ciclo relê só o estado do pool e do vault, publica na hora e
   executa logo após a inclusão da publicação. A latência real é medida e registrada
   em cada ciclo desde o primeiro passe manual.
3. **Faixas do dono.** A faixa do plano passa a ser o impacto máximo do dono, sem banda
   mais estreita do serviço. A slippage padrão é 1%. O dono de um token volátil pode
   aumentar o impacto máximo, porque o risco da posição é dele.
4. **Proteção por proporção, não por gatilho.** O swap dos compounds de um pool,
   somado numa janela de 256 blocos entre todos os vaults, não passa de
   taxa × profundidade, calculado a cada ciclo tick a tick. Pelos dados, esse teto não
   restringe o rebalanceamento em nenhum pool estudado. Quando restringir, o excedente
   espera o próximo ciclo e a adição direta segue sem limite.
5. **Momento imprevisível.** As avaliações têm intervalo com variação aleatória, para
   que ninguém saiba quando o ciclo vai observar.
6. **Falhas baratas e contidas.** Uma recusa do guard ou do engine custa só a
   publicação. Depois de algumas falhas seguidas num pool, o ciclo espera mais antes de
   tentar de novo, e o custo esperado das tentativas entra na conta do operador.
7. **Hooks são decisão de produto.** O V1 serve pools sem hook: metade dos swaps e um
   terço do volume do último dia, com milhares de tokens novos por dia. Os lançamentos
   maiores usam launchpads com hook. Alcançá-los exige uma nova versão dos contratos,
   com uma lista de designs de hook revisados um a um. Isso só faz sentido nos designs
   que aceitam liquidez de terceiros, e os de lançamento estudados não tiveram nenhuma.

## 7. O que muda no código, após aprovação

- **Configuração:** sai a seção de referências Chainlink. Entram o multiplicador do
  teto de swap, o alvo de latência, a variação aleatória do intervalo e o backoff por
  falhas.
- **Evidência:** o preço vem do spot do bloco observado. O gás é convertido 1:1 em
  pools cotados em ETH ou WETH, e pelo pool WETH/USDG nos cotados em USDG. As cotações
  de swap respeitam o teto por pool e janela.
- **Plano:** a faixa de preço vem do impacto máximo do dono.
- **Ciclo:** caminho rápido para agir, variação aleatória, backoff e registro de
  latência em cada ciclo.
- **Banco:** uma migration com o consumo do teto por pool e janela, compartilhado entre
  os vaults.
- **App:** slippage padrão de 1%. Essa parte é de outra frente de trabalho.
- **Spec:** a linha de evidência passa a registrar a decisão do owner e a regra de
  proporção no lugar da referência independente.

## 8. O que este estudo não estabelece

- A latência real do pipeline no nó e no sequencer. O estudo mostra o que acontece em
  cada latência, e a medição vem no primeiro passe manual.
- A política de ordenação do sequencer da Robinhood Chain.
- Vinte e quatro horas são uma janela curta. Tokens novos mudam de regime em horas,
  como mostram as duas posições de lançamento já retiradas.
- O rebalanceamento foi estimado para uma posição com 1% da liquidez ativa e composição
  meio a meio. Posições maiores escalam em proporção.
- Se os hooks de lançamento recusam liquidez de terceiros. O estudo só mostra que
  ninguém adicionou.
- Quantos donos distintos têm os pools novos com várias posições. O censo de 48 horas
  conta posições, não donos.
- Se as posições de lançamento dos pools sem hook ficam com o criador ou presas num
  contrato de trava, o que decide se o criador poderia automatizá-las.

## 9. Implementação, 22/09/2026

O owner aprovou a proposta sem os hooks. O
[adendo do registro do ciclo](AUTOMATION_CYCLE_2026-09-21.md#addendum-22-september-2026-the-new-token-proposal-implemented)
descreve o que mudou no código. Três pontos diferem do texto acima:

- **Faixa de valoração.** O planner avalia o outro token no spot com uma margem pequena
  e explícita, `pricing.valuationBandBps`, e não na faixa de impacto do dono. Com a faixa
  de impacto, cada swap contaria como perda cerca de duas vezes o impacto do seu valor, e
  quem alarga o limite num token volátil teria os swaps recusados. O que a execução pode
  encontrar continua limitado pelo impacto e pela slippage do dono, no engine.
- **Profundidade.** O teto usa a menor média acumulada de L × √P entre o spot e o limite
  de impacto, e não a menor liquidez pontual. É a condição exata de equilíbrio: empurrar
  até um ponto só se paga se o swap passar de taxa × a profundidade média do caminho.
  Uma lacuna de liquidez colada no spot zera o teto; uma lacuna distante o reduz em
  proporção.
- **Custo esperado das tentativas.** A conta do operador multiplica o gás da publicação
  por (tentativas pagas + 1) / (conclusões + 1), nas últimas 20 tentativas da sequência.

A parte do app, slippage padrão de 1%, foi feita junto.

