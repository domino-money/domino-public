# Medição da faixa de publicação V4 — 21/09/2026

**A banda imutável continua não selecionada.** O usuário decidiu medir antes de
fixá-la. A coleta abaixo conclui a primeira medição de deriva dos pools e RPC;
não conclui a qualificação operacional do publicador. Nenhuma transação foi
enviada à mainnet, chave utilizada ou serviço financeiro ativado. Os contratos
de produção e seu freeze `7321c5bdefb27a29d15dfa2cdcbaae6cc9d9715b` não mudaram.

## Coleta real pelo RPC próprio

- Janela dos snapshots: **2026-09-21T18:10:40.659000+00:00 a 2026-09-21T18:20:39.885000+00:00**, duração observada **599.226 s**.
- **1.200 snapshots × 7 pools = 8.400 leituras de preço**, sem falhas ou ausências.
- Seis pools do catálogo e um candidato histórico; seleção não ponderada por volume nem representativa de toda a rede.
- As sete PoolKeys foram obtidas do PositionManager e seus hashes conferidos. Todas tinham liquidez inicial positiva. Os três runtimes externos coincidiram com os pins da release.
- Blocos **69,001,812–69,007,845**: 1,179 alturas distintas relidas ao final, nenhuma divergência e nenhum hash conflitante observado por altura.
- Cada snapshot usou o mesmo blockHash canônico para as sete leituras. Isso não cobre reorganizações posteriores nem eventos entre amostras.
- Rota: máquina de desenvolvimento → túnel SSH autenticado → loopback do nó próprio. Não é a rota VM de execução → HTTPS do RPC.

## Tempo de leitura e validade em blocos

| Medida | Mediana | p95 | p99 | Máximo |
| --- | ---: | ---: | ---: | ---: |
| RTT individual do header (ms) | 4.453 | 6.698 | 17.195 | 167.539 |
| Ciclo header + sete chamadas paralelas (ms) | 11.327 | 17.887 | 63.056 | 244.737 |

Os RTTs de cada pool estão no JSON de telemetria. O ciclo não inclui assinatura,
fila, publicação, inclusão pelo sequenciador, planejamento nem execução.
A média observada foi aproximadamente **0,10 s por bloco**, mas a chegada dos
heads variou. A primeira amostra pelo menos 256 blocos à frente apareceu entre
**15,000 e 36,998 s**, mediana **26,000 s**. São intervalos entre headers recebidos,
com resolução de aproximadamente 0,5 s; não são um prazo garantido on-chain.
Foram observados 1.148 cruzamentos; 52 referências do fim da coleta não tinham
horizonte suficiente e ficaram censuradas, sem serem tratadas como zero.

| Atraso solicitado | Pares por pool | Fonte no mesmo bloco | Idade ≥256 blocos | Fora da janela por idade |
| --- | ---: | ---: | ---: | ---: |
| 0.5 s | 1199 | 16 | 0 | 0.00% |
| 1 s | 1198 | 10 | 0 | 0.00% |
| 2 s | 1196 | 5 | 0 | 0.00% |
| 5 s | 1190 | 0 | 0 | 0.00% |
| 10 s | 1179 | 0 | 0 | 0.00% |
| 20 s | 1160 | 0 | 71 | 6.12% |
| 30 s | 1140 | 0 | 1050 | 92.11% |
| 60 s | 1080 | 0 | 1080 | 100.00% |

A condição é idade de **1 a 255 blocos**, além de validade temporal, hash e
demais limites. As contagens acima são iguais para os sete pools porque usam
os mesmos headers. Mesmo quando o preço permanece igual, a observação expira.
O aumento da banda não corrige esse problema. O timeout de 90 s do runner não
pode ser interpretado como validade da observação; são necessários atualização
da referência e novo planejamento dentro das condições atuais.

## Deriva de preço medida

O replay usa o primeiro snapshot global recebido após cada atraso solicitado;
não substitui leituras ausentes por uma leitura posterior bem-sucedida. Decisão
inteira idêntica ao guard: `abs(referencia - spotPosterior) * 10000 <= spotPosterior * banda`.
O denominador é o spot na publicação simulada. Atrasos efetivos e overshoot
estão registrados; os pares se sobrepõem e são correlacionados.

| Pool / rótulo de catálogo | Mudanças entre snapshots adjacentes | p99 da deriva sqrt em 20 s (bps) | Máximo sqrt em 20 s (bps) | Máximo de preço em 20 s (%) |
| --- | ---: | ---: | ---: | ---: |
| WETH/USDG | 83 | 3.685 | 5.072 | 0.10147% |
| USDG/MARLIN | 0 | 0.000 | 0.000 | 0.00000% |
| cbBTC/USDG (catalogue label) | 9 | 1.106 | 1.302 | 0.02605% |
| U/USDG (catalogue label) | 18 | 0.030 | 0.030 | 0.00059% |
| ETH/USDG (catalogue label) | 156 | 4.822 | 4.990 | 0.09977% |
| PONS/USDG (catalogue label) | 10 | 5.318 | 5.318 | 0.10638% |
| ETH/MARLIN | 0 | 0.000 | 0.000 | 0.00000% |

A tabela descreve todos os pares com preços disponíveis, inclusive os que já
estavam fora da janela de blocos. Identidades são chain/address/PoolKey no JSON;
os rótulos não comprovam identidade de ativo nem permitem inferir decimais.
As bandas **25, 50, 100, 200 e 2.000 sqrt-bps** tiveram **zero rejeições por preço**
nos atrasos de 0,5/1/2/5/10/20/30/60 s desta amostra. Isso não significa zero
rejeições de publicação: a tabela de idade mostra recusas mesmo com banda ampla.
Dois pools não mudaram; isso pode refletir inatividade. Dez minutos não cobrem
volatilidade extrema, congestionamento, caudas raras nem integridade de uma
fonte independente. Portanto a amostra não fundamenta escolher 25 ou 50 bps
como parâmetro permanente.

## Comportamento do contrato e lacuna operacional

O replay isolado no Anvil executou o bytecode atual e passou **197 verificações**:
187 decisões de publicação e 10 checagens de observação persistida aos 255/256
blocos. Foram conferidos fontes, metadados, pins, runtime e imutáveis. Mocks
de StateView e ArbSys são explícitos; isso comprova as bordas testadas e a
fidelidade do analisador, sem medir inclusão real. [Detalhes do replay](price-band-2026-09-21/GUARD_REPLAY.md).

A [revisão do fluxo](price-band-2026-09-21/PIPELINE_SCOPE.md) encontrou aquisição/
planejamento, signer e runner como componentes separados. **Não existe neste
checkout um publicador contínuo com renovação de observações conectado ao executor.**
O signer recebe um ID de observação fixo. As publicações nos testes usam o spot
do próprio pool; referências externas existentes estão explicitamente não
qualificadas. A banda não detecta manipulação já presente antes de observar o pool.

Para fechar a escolha, falta definir/qualificar a origem do preço por par e
conectar um publicador que renove observações ao planejamento e à execução.
Esse fluxo deve primeiro ser medido sem envios reais no ambiente de execução,
com atrasos/falhas/replanejamento, e em janelas mais longas com atividade de mercado.
Incluir assinatura, fila e inclusão real continuará exigindo uma etapa própria;
nenhum termo desconhecido foi assumido como zero. A recomendação atual é
**manter `priceGuardDeviationBps: null` e não assinar a proposta de 50 bps**.
Não houve alteração de lógica de produção para contornar essas pendências.

## Evidência e reprodução

- [Amostras completas](price-band-2026-09-21/LIVE_SAMPLES.json), SHA-256 `ba8f5d543d2427e19852e5881286d216a8b176472ac8d2ae1daf23f5f0e264fe`.
- [Análise por pool/atraso/banda](price-band-2026-09-21/ANALYSIS.json), [telemetria](price-band-2026-09-21/TELEMETRY.json) e [replay do bytecode](price-band-2026-09-21/guard-replay-results.json), todos vinculados ao mesmo SHA de amostras.
- O coletor efetivamente executado é o de `b76fb7e173123be0e5e79fc0bd5b9b163e267f23`; seu SHA está nas amostras e foi conferido contra o Git.
- A versão seguinte preserva todos os hashes observados por altura ao conferir canonicalidade, evitando que um hash posterior oculte um anterior. Nesta coleta houve zero conflitos em todas as amostras; a auditoria offline completa fecha essa limitação da versão inicial. A correção tem três regressões passando.
- Analisador: 15 testes passando. Higiene do repositório sem achados. Os testes amplos de contratos/app da release anterior permanecem evidência histórica; não foram repetidos porque não houve alteração de produção.

```sh
python3 reports/price-band-2026-09-21/analyze.py reports/price-band-2026-09-21/LIVE_SAMPLES.json --out /tmp/domino-analysis.json
python3 reports/price-band-2026-09-21/telemetry.py reports/price-band-2026-09-21/LIVE_SAMPLES.json --out /tmp/domino-telemetry.json
python3 -m unittest discover -s reports/price-band-2026-09-21 -p test_analyze.py
node --test reports/price-band-2026-09-21/canonicality.test.mjs
# Exige as dependências e artifacts atuais descritos no pacote de auditoria:
node reports/price-band-2026-09-21/replay_guard.mjs
```

`collect.mjs` é reutilizável para uma nova janela com o SSH do projeto e RPC
próprio; sobrescreve `LIVE_SAMPLES.json`, então a evidência anterior deve ser
preservada antes. A duração padrão é 600 s, configurável de 30 a 1.800 s via
`DOMINO_BAND_SAMPLE_SECONDS`. Os scripts não ativam monitoramento recorrente.
