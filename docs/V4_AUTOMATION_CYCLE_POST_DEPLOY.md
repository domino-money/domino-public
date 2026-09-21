# Demanda pós-deploy: ciclo automático Domino V4

Data: 21 de setembro de 2026.

Status: especificação de implementação para execução **após o deploy V4**.
Este documento não implementa nem ativa a automação. A inspeção do código usou
o candidato M1/M2/M3 `d048b4b8564a7939baff0fafdada5ba67660043e`.

## 1. Objetivo e limite da entrega

Implementar o serviço externo que acompanha as sequências autorizadas, identifica
oportunidades economicamente viáveis, publica uma referência de preço sob demanda,
prepara uma execução, envia a transação e reconcilia seu resultado.

Os contratos não executam tarefas por conta própria. O ciclo será iniciado por
um worker de backend. As chamadas financeiras principais já existem:

- A carteira publisher chama `DominoPriceGuardV4.publish(observation)`.
- A carteira operator chama `DominoVaultV4.execute(plan)` no vault autorizado.
- O vault e o engine executam coleta, eventual swap e reinvestimento, aplicando
  seus limites de custódia, preço, fonte de recursos e contabilidade.

**A implementação prevista é de backend e infraestrutura.** Não há necessidade
identificada de um novo contrato apenas para conectar essas etapas. Caso a
integração revele uma limitação contratual, registrar uma mudança separada, com
novo candidato e validação; não alterar silenciosamente o código congelado nem
presumir que um contrato já implantado possa ser atualizado.

Deploy, admissão dos endereços e ativação da automação são etapas distintas.
O deploy isolado não habilita o ciclo, não concede autorização de usuários e não
qualifica a fonte de preços.

## 2. O que existe e o que falta

| Componente | Situação encontrada | Trabalho necessário |
| --- | --- | --- |
| Planner econômico | `backend/execution_planner.py` calcula candidatos, inclusive espera, reinvestimento direto e caminhos com swap. Os callers encontrados são testes/vetores. | Criar o caller operacional, fornecer dados qualificados e consumir a decisão. |
| Observações e histórico | Modelos de observação, saldos, accruals e histórico existem. | Produzir snapshots canônicos e histórico persistente para o planner, preservando fonte, cobertura e validade. |
| Evidências de preço, profundidade, swap e gás | `Evidence`, `DestinationEvidence`, `SwapQuote` e `PlannerSettings` exigem entradas explícitas. | Implementar os adaptadores que as produzem e qualificam; não promover fixtures a defaults de produção. |
| Plano e persistência | `UnsignedExecutionStore.persist()` recebe um `ExecutionPlan` já construído. | Traduzir a decisão do planner para o plano tipado e persistir/reservar com concorrência e idempotência. |
| Signer e executor | `RestrictedSigner`, `ExecutionRunner` e CLI privada trabalham sobre intents existentes; revalidam estado, simulação, gás e saldo. | Integrar ao orquestrador, preservando os limites do signer e a recuperação de transações. |
| Publisher | O contrato possui `publish`, `revoke` e rotação. Não foi encontrado worker produtivo de publicação. | Implementar assinatura restrita, fila, nonce, persistência, envio e acompanhamento da publicação. |
| Identificador da âncora | O executor recebe `priceObservationId` por configuração/injeção. | Vincular a observação ao intent/ciclo de forma durável; evitar configuração global mutável compartilhada entre pools. |
| Reconciliação | Existem contratos de eventos, journal, ledger e testes de receipts/reorg. | Executar continuamente a reconciliação das duas pernas e alimentar a próxima avaliação. |
| Preview de swap assistido | Há integração própria com a Uniswap Trading API. | Manter a separação: ela não alimenta hoje o planner automático nem comprova o custo completo de automação. |

Essa avaliação é do repositório. Não representa inspeção de processos ou
configurações privadas que possam existir fora dele.

## 3. Regras de produto já aprovadas

1. Reinvestir fees comprovadas até o limite economicamente elegível. Não manter
   uma reserva percentual fixa nem reintroduzir o antigo teto de 15% de adição.
2. Usar somente recursos pertencentes à sequência e suas fontes rastreadas.
   Não retirar principal, puxar fundos da carteira, usar recursos de outro
   usuário ou tratar doações como fees.
3. Cobrar **2% no modo simples** e **4% no modo Domino**, por modo em todas as
   receitas. A cobrança incide uma única vez sobre fees originais consumidas.
   Saldos já tarifados não sofrem nova cobrança.
4. Swaps internos da automação estão incluídos nessa tarifa Domino. Não adicionar
   os 0,65% de Setup nem uma segunda taxa de swap. Custos reais da DEX e impacto
   continuam existindo e precisam entrar na avaliação econômica.
5. A tarifa de **0,65% para swaps assistidos de entrada/gestão manual**, versão 1,
   pertence ao fluxo separado de Setup.
6. O ETH de operator e publisher será abastecido **manualmente pela empresa**
   nesta primeira versão. Esta entrega não inclui venda automática de ativos,
   top-up automático nem acesso à chave da feeRecipient.
7. A banda escolhida do PriceGuard é **50 bps da raiz quadrada do preço**, imutável
   no contrato implantado. Ela corresponde aproximadamente a uma variação de
   −0,9975%/+1,0025% no preço comum; não representa slippage nem taxa de transferência.
8. A publicação de preço deve ocorrer **sob demanda de uma operação candidata**.
   Observar novos blocos e reavaliar condições não deve gerar uma transação por
   bloco, por leitura ou por usuário automaticamente.
9. Preservar as correções M1/M2/M3: payout de fees após o unlock; consumo integral
   da saída de cada swap na mesma ação/fonte/moeda; artefatos vinculados ao build
   e ao commit autenticados.

Referências normativas: [REINVESTMENT_POLICY.md](../REINVESTMENT_POLICY.md),
[PRICING_POLICY.md](../PRICING_POLICY.md) e
[remediação M1/M2/M3](../reports/V4_M123_REMEDIATION_2026-09-21.md).

## 4. Como a decisão deve variar

### 4.1 Saldo, quantidade e destino

Recalcular a partir dos saldos disponíveis, reservas de intents pendentes,
fees ainda não coletadas e condições atuais da posição. Comparar o maior
reinvestimento financiável e alternativas menores; não assumir que consumir
tudo maximiza o benefício econômico.

No modo simples, usar a posição raiz elegível. No modo Domino, respeitar a
política e a geometria existentes para reinvestir na própria posição, direcionar
fees a uma posição elegível ou criar uma sucessora. Não criar novas regras de
range, overlap, trigger ou máximo de posições neste serviço.

Deixar saldos esperando quando não forem utilizáveis com segurança ou vantagem
econômica. Registrar valor, moeda, fonte e motivo. Reavaliar depois de mudanças
relevantes sem reiniciar arbitrariamente o histórico de espera.

### 4.2 Gás e sustentabilidade

Usar custos recentes e qualificados do **caminho completo**, incluindo:

- Publicação da âncora, quando uma nova publicação for necessária.
- Coleta, reinvestimento/roteamento/criação e eventual swap.
- Componentes L2 e postagem de dados aplicáveis à Robinhood Chain.
- Margem de estimativa e caps de transação/ciclo configurados.

Manter o custo nativo em wei e sua conversão conservadora para a moeda de
cotação da sequência. Ausência de preço, decimals, componente de custo ou
cobertura qualificada não deve virar zero.

A receita realizável da tarifa deve cobrir esse custo com a margem configurada.
Gás mais alto pode fazer a decisão virar espera; gás menor pode tornar o mesmo
saldo viável. A tarifa de 2%/4% não muda em função do gás.

Essa verificação é econômica, não uma transferência de ETH entre carteiras.
Receber tokens na feeRecipient não abastece operator/publisher. Aplicar uma
estimativa conservadora de realização da receita, considerando liquidez e custos;
não equiparar automaticamente o valor nominal dos tokens a ETH disponível.

O gás pago pela empresa não deve ser descontado novamente do reinvestimento do
usuário como uma segunda cobrança. Falhas, substituições e publicações sem
execução posterior precisam entrar no orçamento operacional real. Não presumir
uma nova tarifa sobre saldos já cobrados. Uma operação sem receita nova deve
aguardar ou depender de uma política explícita e limitada de subsídio, caso essa
política venha a ser implementada; não introduzir subsídio implícito.

A política atual descreve margem de custo de 15%, mas `PlannerSettings` exige
configuração operacional explícita. Registrar o valor adotado e sua versão; não
inferir os demais parâmetros a partir dos exemplos de teste.

### 4.3 Swap de equilíbrio e benefício do usuário

Comparar reinvestimento direto, diferentes quantidades de swap admitidas e
espera. A proporção necessária depende do preço e da faixa da posição; não usar
um balanceamento fixo de 50/50.

Considerar fees da DEX, impacto, output mínimo, arredondamento, exposição, custo
completo de gás e oportunidade de ganho adicional em horizonte limitado. Não
somar slippage novamente quando ele já estiver refletido no output conservador.
Não usar APR perpétuo ou dados insuficientes para justificar uma troca.

Exigir duas condições distintas: benefício líquido conservador para o usuário e
sustentabilidade para o operador. Cobrir o gás não prova benefício do usuário.
Preservar o ranking atual do planner: benefício líquido primeiro, quantidade
produtiva depois, reinvestimento direto em caso de empate exato.

**M2 exige consumir toda a saída real do swap na mesma execução, sob a mesma
fonte e moeda de saída.** Não introduzir tolerância arbitrária de dust nem usar
outra fonte para satisfazer esse piso. Pisos antigos continuam obrigatórios.
Uma cotação com buffer pode conflitar com alocações antigas exatas; nesses casos,
recalcular o swap/adição, escolher outro candidato ou aguardar. O mínimo cotado
não é o output real. Simulação e execução devem validar o plano efetivo.

## 5. Fluxo operacional a implementar

### Etapa A — admissão após o deploy

- Verificar receipts finalizados, chain ID 4663, endereços, hashes de código,
  construtores, vínculos e manifesto do candidato realmente implantado.
- Criar perfis de admissão reais com validade explícita. Não reutilizar perfis
  de Anvil, exemplos, contratos pessoais ou a proposta anterior de initcode.
- Conferir autorização do usuário para o operator em cada vault; a existência
  de uma carteira global de operação não concede essa autorização.
- Configurar endpoints privados apropriados, priorizando o RPC próprio, e
  estabelecer condições para indisponibilidade, divergência e recuperação.

### Etapa B — observar e produzir evidências

- Ler dados ancorados em número/hash de bloco canônico. Preservar chain, pool,
  vault, owner, identidade da sequência, policy/limits, checkpoints e nonces.
- Reconciliar eventos canônicos com ledger, saldos disponíveis e reservas antes
  de oferecer recursos ao planner.
- Produzir histórico de fees e liquidez com cobertura e proveniência. Falhas de
  leitura não podem fabricar fees, APR, liquidez ou reiniciar toda a medição.
- Qualificar preços e condições de profundidade/exposição no horizonte usado.
  Um snapshot atual, sozinho, não prova os limites futuros desses modelos.
- Qualificar tokens e trajetos efetivamente usados. Taxas de transferência,
  bloqueios e retornos anormais não são absorvidos pela banda do publisher.
  Recusar trajetos incompatíveis com os checks exatos dos contratos.

### Etapa C — avaliar sem transacionar

- Construir `MeasurementHistory`, `Evidence`, `DestinationEvidence`, `SwapQuote`
  e `PlannerSettings` com versões/IDs e datas de validade explícitos.
- Gerar cotações tipadas para rotas admitidas pelo engine. Não reutilizar calldata
  livre de router/Trading API como autorização de automação.
- Estimar inicialmente o ciclo completo, incluindo publicação, antes de gastar
  ETH com uma âncora que não tenha execução preliminarmente viável.
- Executar o planner e persistir a razão da decisão. Se decidir esperar, não
  publicar nem executar. Reavaliar por eventos e intervalos controlados.

### Etapa D — preparar e reservar

- Construir o `ExecutionPlan` a partir do candidato, mantendo fontes, lotes,
  cobranças já realizadas, budgets, floors, destination, versões e limites.
- Implementar a ligação ausente entre `Candidate/Decision` e plano persistível.
  O retorno do planner não é uma autorização de broadcast.
- Usar a store existente para reserva, identidade e controle de concorrência.
  Impedir dois workers de reservar/gastar os mesmos saldos.
- Persistir um registro durável do ciclo antes da publicação: contexto canônico,
  candidato/reserva, orçamento, versões, fingerprint e estado da publicação.
  Definir a finalização/reconstrução do plano após a âncora sem quebrar os
  compromissos imutáveis da store; não alterar um intent persistido, mesmo ainda
  não assinado. Uma mudança de plano/snapshot exige novo contexto/intent e o
  tratamento correto das reservas anteriores.

### Etapa E — publicar sob demanda

- Criar signer restrito do publisher: somente chain/guard/função/dados admitidos,
  orçamento e nonce autorizados. Ele não recebe envelopes ou calldata arbitrários.
- Persistir a transação assinada antes de enviá-la. Recuperar o mesmo envio após
  timeout/restart; não gerar publicações duplicadas como estratégia de retry.
- Publicar uma observação qualificada em bloco anterior ainda admissível,
  acompanhar inclusão/canonicalidade e extrair/conferir `PriceObserved` e seu ID.
- Deduplicar por contexto completo. Compartilhar uma observação entre operações
  só quando pool, bloco/hash e demais requisitos forem compatíveis. Não reutilizar
  simplesmente porque o preço parece próximo. Contabilizar o custo sem duplicar
  receita nem presumir amortização que ainda não aconteceu.
- Respeitar revogação, rotação, expiração e o limite de idade em blocos do guard.
  Não converter a janela de blocos em um prazo fixo de relógio por aproximação.

### Etapa F — revalidar e executar

- Associar duravelmente o `priceObservationId` ao contexto/intent, isolando pools
  e workers. Adaptar a injeção atual do signer sem um ID global sujeito a races.
- Preservar a correspondência exata de pool, bloco/hash, timestamp e
  `sqrtPriceX96` entre a observação publicada e a `Observation` vinculada ao plano.
  O signer confere o timestamp com o header real e limita a expiração da âncora
  a `observation.timestamp + 3600`, além dos limites de idade do guard/policy.
  Não atualizar esses campos para o último bloco sem reconstruir o contexto.
  Uma referência econômica externa pode qualificar os dados, mas não substituir
  arbitrariamente o preço exigido por esse vínculo.
- Revalidar permissões, estado, quotes, budgets, benefício, gás e saldo ETH.
  Simular a calldata completa contra o estado canônico aplicável, já com a
  âncora real. O signer continua reconstruindo e conferindo a transação.
- Se o contexto deixar de ser válido, abandonar/replanejar com limites explícitos.
  Uma nova observação pode exigir outra publicação e outro custo; não criar um
  ciclo ilimitado de publicação seguida de descarte.
- Acionar o `ExecutionRunner` existente para assinatura restrita, persistência
  antes de broadcast, envio, replacement quando permitido e acompanhamento.
- O teto do envelope assinado e a estimativa econômica são números distintos;
  ambos precisam caber nos limites. Não afrouxar caps porque a estimativa caiu.

### Etapa G — reconciliar e continuar

- Conferir receipts, canonicalidade, eventos e efeitos esperados. Distinguir
  envio, inclusão, confirmação e reconciliação concluída.
- Atualizar consumo de lotes, cobranças, conversões, liquidez e checkpoints de
  forma idempotente, preservando fontes e o modo de tarifação.
- Liberar reservas somente no estado correto. Uma transação pendente ou incerta
  não pode liberar saldo para um segundo gasto.
- Reverter projeções de blocos órfãos e reconstruir a partir da cadeia canônica.
  Nunca executar novamente só porque houve timeout na resposta de broadcast.
- Atualizar histórico/custos e agendar a próxima avaliação conforme policy,
  mudanças relevantes e backoff. Não usar polling irrestrito ou laço ocupado.

## 6. Papéis, carteiras e controles

| Papel | Uso no ciclo |
| --- | --- |
| Operator | Global como identidade de serviço, mas autorizado por vault. Assina `execute` e paga seu gás. |
| Publisher | Publica observações qualificadas e paga o gás de publicação. Deve permanecer separado do operator. |
| Guardian | Operação de emergência/rotação do publisher e revogação de observações. Não participa do loop diário. |
| feeRecipient | Recebe a tarifa. O loop inicial não precisa de sua chave nem vende seus ativos. |
| Deployer | Não deve ser o signer cotidiano do ciclo. |

Chaves permanecem fora do repositório, de logs, mensagens e artefatos de teste.
Usar configuração privada e a fronteira de assinatura restrita existente.
Workers de leitura/planejamento não precisam acessar as chaves.

Prever pausa global de novas operações, suspensão por pool/sequência e retomada
controlada. Pausar a admissão de trabalho não pode interromper a reconciliação de
transações já enviadas nem alterar direitos de retirada do usuário.

## 7. Parâmetros operacionais a fechar na implementação

Registrar uma configuração versionada, validada e rastreável. Não pedir novamente
decisões já aprovadas na seção 3. Valores ainda não definidos não podem ser
substituídos silenciosamente pelos das fixtures.

| Grupo | Definições necessárias |
| --- | --- |
| Evidência | Fontes de preço admitidas, fallback, cobertura, freshness e tratamento de divergência. Ler o spot do próprio pool não cria uma referência independente nem protege contra manipulação anterior à observação. |
| Histórico | Quantidade mínima de amostras, duração/cobertura, idade máxima e política de recuperação. |
| Economia | Horizonte máximo, haircut de projeção, benefício mínimo, realização conservadora da receita e margem de custo. |
| Busca | Frações de liquidez e opções de overlap, dentro dos limites do owner; cotas de quotes e RPC. |
| Gás | Caps por transação/ciclo/período; gasto com falhas, replacement e publicações não utilizadas; limites e alertas de ETH por signer. |
| Agendamento | Gatilhos, intervalos/backoff, concorrência, leases, orçamento de leituras e limites de admissão. |
| Finalização | Confirmações/canonicalidade para cada etapa, janelas de recuperação e validade dos perfis. |
| Ativação | Escopo inicial controlado, critérios de expansão, pausa e responsáveis operacionais. |

## 8. Falhas que precisam ter comportamento definido

| Situação | Comportamento esperado |
| --- | --- |
| Gás alto ou receita realizável insuficiente | Esperar com motivo explícito; não publicar por tentativa especulativa. |
| Saldo ETH baixo em um signer | Suspender novos ciclos que dependam dele, manter reconciliação e sinalizar abastecimento manual. |
| Dados/quotes ausentes, antigos ou incoerentes | Recusar elegibilidade; nunca preencher com zero ou dados sintéticos. |
| Âncora expirada, revogada, órfã ou de outro pool/contexto | Recusar execução e replanejar conforme orçamento. |
| Preço muda após publicação | Revalidar. Executar somente se o mesmo contexto/plano continuar qualificado; caso contrário descartar/reconstruir. |
| Swap não cabe no reinvestimento integral | Redimensionar/re-cotar, escolher alternativa ou esperar; não contornar M2. |
| Token cobra taxa em uma etapa incompatível | Recusar a rota e registrar a etapa; não alargar a banda de preço para esconder a diferença. |
| Broadcast devolve timeout | Recuperar hash/nonce/transação persistidos antes de decidir qualquer retry. |
| Processo cai após publicação ou execução | Retomar pelo journal e reconciliar; não duplicar publicação, coleta ou gasto. |
| Dois workers disputam a mesma sequência | Apenas um detém lease/fence e reservas válidas; o outro não assina nem envia. |
| Execução reverte depois da publicação | Registrar custo real, ausência de efeitos financeiros canônicos, motivo e backoff. |
| Reorg | Invalidar evidência/efeitos afetados, preservar histórico auditável e reconstituir estado canônico. |
| Owner pausa, revoga ou altera policy | Recusar a assinatura/execução incompatível, mesmo que a decisão anterior fosse elegível. |

## 9. Testes e critérios de aceite

### Decisão econômica e construção do plano

- O mesmo saldo deve poder esperar com gás alto e se tornar elegível com gás
  menor, sem modificar a tarifa nem fabricar benefício do usuário.
- Cobrir saldo insuficiente, reinvestimento parcial, reinvestimento direto,
  swap benéfico, swap menor melhor que um maior e swap que perde para esperar.
- Cobrir 2%/4%, todas as receitas elegíveis, saldos já cobrados e custeio sem
  dupla cobrança. Testar a ausência de receita nova explicitamente.
- Preservar arredondamento por fonte, budgets/floors antigos, M2 e fontes que
  recebam conversão. Comparar o plano construído com o resultado efetivo.
- Validar que custo de publicação + execução, componentes L2 e buffer entram
  na decisão, inclusive quando publicar não leva a uma execução bem-sucedida.
- Testar que configuração incompleta, preços sem qualificação e dados de preview
  assistido não são promovidos a evidência econômica de automação.

### Ciclo completo em ambiente descartável

- Executar observação → decisão → reserva → publicação real no fork → inclusão
  → plano/simulação final → assinatura/envio → receipt → reconciliação.
- Incluir simples, Domino na própria posição, destino existente, sucessora,
  swap e caminho nativo NET, conforme elegibilidade real de cada cenário.
- Usar banda de 50 bps e contratos/dependências do release admitido.
- Exercitar restart em cada transição, dois workers concorrentes, publication
  retry, replacement, expiração, revogação, falta de ETH, revert e reorg.
- Provar ausência de publicação quando o resultado é espera e ausência de
  execução quando apenas a publicação foi confirmada, mas o plano perdeu validade.
- Conferir efeito financeiro canônico uma única vez, sem repetir cobrança,
  gastar reservas de outro intent ou perder a atribuição de fonte.

### Operação e observabilidade

- Expor estados e razões de espera, validade da evidência, idade do histórico,
  saldo ETH, intents pendentes, publicação sem consumo, custo previsto/real,
  falhas e tempo até reconciliação, sem expor segredos.
- Fornecer comandos de iniciar/parar/status, pausa, recuperação e abastecimento
  manual; instalação e configuração reprodutíveis no host escolhido.
- Manter perfis/capabilities desativados até haver deployment real verificado e
  evidência do ciclo completo. `available` não pode ser ativado por um mock.
- Reexecutar as suítes pertinentes de backend/PostgreSQL/EVM e os gates de
  contratos/release quando alterados; atualizar interfaces públicas se necessário.
- Registrar a evidência do escopo inicial controlado e critérios objetivos de
  expansão, sem tratar testes locais como receipts de produção.

## 10. Entregáveis

1. Produtor de observações/histórico e adaptadores de evidência econômica.
2. Integração do planner com construção, reserva e persistência do plano.
3. Worker e signer restrito do publisher, com journal e associação da âncora ao ciclo.
4. Orquestrador ligando publicação ao executor/reconciliador existentes.
5. Configuração versionada, instalação, limites, métricas, alertas e runbook.
6. Testes integrados, evidência de fork, relatório de limitações e ativação controlada.

Critério de conclusão: uma sequência realmente autorizada consegue percorrer o
ciclo completo com dados qualificados e decisões dinâmicas, enquanto cenários
inelegíveis esperam sem transacionar, e falhas/restarts não causam efeitos
financeiros duplicados. Antes disso, descrever separadamente biblioteca, integração
testada e serviço ativo; não chamar as três coisas de automação pronta.

## 11. Arquivos de referência para iniciar a implementação

- [`execution_planner.py`](../backend/execution_planner.py): modelos econômicos,
  histórico, rotas, candidatos e decisão; não constrói `ExecutionPlan`.
- [`execution_models.py`](../backend/execution_models.py) e
  [`execution_store.py`](../backend/execution_store.py): plano, validação,
  persistência e reservas.
- [`execution_v4_adapter.py`](../backend/execution_v4_adapter.py): adaptação V4 e
  qualificação da observação publicada.
- [`execution_signer.py`](../backend/execution_signer.py),
  [`execution_runner.py`](../backend/execution_runner.py) e
  [`execution_cli.py`](../backend/execution_cli.py): fronteira de assinatura,
  execução de intents e comandos privados existentes.
- [`DominoPriceGuardV4.sol`](../contracts/src/DominoPriceGuardV4.sol),
  [`DominoVaultV4.sol`](../contracts/src/DominoVaultV4.sol) e
  [`DominoExecutionEngineV4.sol`](../contracts/src/DominoExecutionEngineV4.sol):
  interfaces e restrições on-chain.
- [`FINANCIAL_RELEASE.md`](FINANCIAL_RELEASE.md): build autenticado, deploy,
  verificação e admissão dos endereços.
- [`test_execution_planner.py`](../backend/tests/test_execution_planner.py),
  [`test_execution_runner_v4_evm.py`](../backend/tests/test_execution_runner_v4_evm.py)
  e [`test_execution_v4_receipts_evm.py`](../backend/tests/test_execution_v4_receipts_evm.py):
  pontos de partida para regressões e integração, sem promover seus parâmetros
  sintéticos a configuração de produção.
