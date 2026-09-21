# Financiamento do gas V4 — estudo de 21/09/2026

**Recomendação:** lançar com ETH da tesouraria previamente distribuído entre
operador e publicador; evoluir para conversão e abastecimento automáticos usando
somente receita já recebida pela empresa. Manter abastecimento manual como
contingência. Sponsorship/paymaster é uma terceira opção real na rede, mas exige
uma integração maior e acrescenta despesas. O estudo não implementou nenhum dos
três serviços nem alterou tarifas ou ativou execução financeira.

O trabalho foi delegado em três frentes: [economia e modelo calculável](gas-funding-2026-09-21/ECONOMICS.md),
[arquitetura e controles](gas-funding-2026-09-21/OPTIONS_AND_CONTROLS.md) e
[provedores e compatibilidade](gas-funding-2026-09-21/ECOSYSTEM.md).
As medições complementares foram feitas com o nó próprio do projeto e transações
apenas em processos Anvil isolados. Nenhuma transação foi enviada à mainnet.

## Por que o RPC local não foi usado antes

O ensaio anterior foi iniciado explicitamente com `--public-rpc`. Essa opção
ignora a configuração local-first que o projeto já documentava. A seleção foi
inadequada: faltou consultar essa configuração e verificar o nó próprio antes
de apresentar a indisponibilidade do endpoint público como pendência de infraestrutura.
O checkout isolado não tinha um arquivo privado de providers; o checkout original
ainda tinha um arquivo v1 com Alchemy. Isso explica a ausência de configuração
local no processo, mas não a falta de investigação do serviço existente.

O acesso correto foi recuperado pelo alias SSH já configurado `domino-host`,
com verificação da chave do host e túnel temporário de loopback para o Nitro.
Nenhum token de RPC ou configuração do bot pessoal foi usado ou copiado. Não houve
alteração de nginx, firewall, serviços, permissões ou providers de produção.

- Nó Nitro `v3.11.4`, chain **4663**, sincronizado na consulta das **16:11:47 UTC**.
- Estado finalizado do bloco **68.919.532** disponível. Os três pins de Uniswap,
  os vínculos entre contratos, a canonicalidade e o teste compilado ArbSys passaram.
  [Preflight local](gas-funding-2026-09-21/local-finalized-preflight.json).
- O ensaio estreito de **20%**, antes incompleto no público, terminou em **15 s**:
  dois controles, quatro cenários com resultados válidos e cinco etapas de ciclo
  completo. As duas execuções após observação recusaram `InvalidPrice`; as duas
  que publicaram o preço já movido executaram. Isso demonstra a dependência da
  qualidade do publicador, não uma proteção universal contra manipulação.
  [Fork local](gas-funding-2026-09-21/local-fork-narrow-20pct.json).

O nó continua podado: esse sucesso comprova os estados consultados, não histórico
ilimitado. A configuração existente com local primeiro e fallback verificado
continua apropriada. As falhas antigas do público foram preservadas como evidência.

## Base das estimativas

A amostra local inicial foi **0,052694 gwei**. Sessenta e uma amostras de headers,
separadas por 600 blocos ao longo de 3.604 segundos, variaram de **0,049996 a
0,491854 gwei**, com mediana **0,051788**. São amostras de aproximadamente uma
hora, não uma distribuição de longo prazo nem teto de preço. A referência externa
é **US$ 2.748,79/ETH**, ticker Coinbase capturado às 16:10:48 UTC; não implica
paridade entre USDG e USD ou preço garantido de conversão.

Foram combinadas unidades de gas de transações no Anvil com preços e componentes
de publicação de dados consultados no Nitro. **São estimativas para planejamento,
não `eth_estimateGas` de uma execução Domino implantada na mainnet.** O mock ArbSys
do Anvil não reproduz integralmente o gas da precompile Nitro. O estado da posição,
tokens, ticks atravessados e saldos existentes também alteram o custo.

| Operação | Gas de execução observado no filho | Custo estimado da transação, sem rateios |
| --- | ---: | ---: |
| Reinvestir sem swap | 1.157.932–1.175.124 | US$ 0,168–0,187 |
| Reinvestir com swap | 1.440.762–1.497.579 | US$ 0,209–0,235 |
| Criar sucessor Domino (`MINT`) | 1.737.500–1.895.616 | US$ 0,252–0,292 |
| Publicar uma observação | 157.278 | US$ 0,023–0,031 |
| Desembrulhar WETH e transferir ETH, duas transações | 47.873 + 21.000 | US$ 0,010–0,018 por abastecimento |

Os extremos combinam as menores/maiores unidades observadas com as amostras
sem/com componente de dados, não são um intervalo de confiança. A cotação de
dados não nula usa o bloco **68.923.379** e o preço **0,052962 gwei** retornado
pelo NodeInterface. O componente apareceu zerado em outros snapshots; isso não
garante isenção futura. Não se deve acrescentá-lo novamente a uma estimativa
Nitro que já inclua execução e dados. A execução usa 0,052694 gwei; a parcela de
dados usa o custo em ETH da consulta histórica. Essa combinação de snapshots é
uma análise de sensibilidade, não uma cotação completa de um mesmo bloco.

Evidências: [medições iniciais](gas-funding-2026-09-21/gas-measurements.json),
[medições com sucessor](gas-funding-2026-09-21/gas-measurements-complete.json),
[cotação de dados não nula](gas-funding-2026-09-21/nonzero-data-quotes.json),
[script reproduzível](gas-funding-2026-09-21/measure_costs.py).

## Três opções

| Opção | Como funciona | Prós | Contras e viabilidade |
| --- | --- | --- | --- |
| **1. Tesouraria com abastecimento manual** | A empresa fornece ETH antes das operações e repõe operador/publicador. Realiza a receita em lotes quando necessário. | Compatível com o V4 atual; poucas dependências; não depende de vender um token ilíquido no momento da execução. | Precisa de capital inicial, acompanhamento e intervenção. Custo de trabalho manual não é zero. **Viável para começar**; estimativa de 2–4 dias de engenharia para controles e reconciliação. |
| **2. Conversão e abastecimento automáticos da tesouraria** | Receita de ETH abastece diretamente; WETH é convertido em ETH; outras moedas da empresa são vendidas em rotas aprovadas. Um serviço repõe as carteiras antes de atingirem o saldo mínimo. | Automatiza o ciclo receita → ETH → execução; mantém a tarifa aprovada; não exige alterar o vault para gastar receita já paga. | Novo signer de tesouraria, limites, reconciliação, gas de conversão e risco de token/rota. Precisa de ETH inicial e contingência. **Melhor alvo operacional**; estimativa de 8–15 dias adicionais para um serviço restrito, mais trabalho se houver contrato novo. |
| **3. Patrocínio com smart account/paymaster** | Um provedor patrocina as operações e cobra a empresa; alternativamente, a empresa mantém depósito em um paymaster. | Pode substituir parte do abastecimento de ETH por faturamento e políticas de gasto; suporte de mainnet confirmado. | Gas adicional de validação, tarifa/API do provedor, limites de crédito e dependência externa. O V4 atual usa EOA, transação tipo 2 e recibo direto: precisa de novo fluxo de admissão, assinatura e prova de UserOperation. **Viável após integração**, estimada em 15–30 dias para operador e publicador. |

Esses prazos são julgamento de engenharia, não compromisso de entrega, e excluem
esperas comerciais/revisão externa. Alchemy e Pimlico documentam patrocínio em
4663; isso não significa que uma conta Domino já tenha crédito, política ou perfil
habilitado. As tarifas publicadas e limitações estão no estudo de provedores.

### Custo total variável por execução bem-sucedida

O modelo abaixo usa o maior gas de execução observado, dez execuções elegíveis
por observação, um abastecimento a cada cem execuções e 5% de tentativas mineradas
revertidas, cada uma com metade do gas de execução e o mesmo custo de dados. Os
extremos variam publicação de dados e, onde aplicável, custo de conversão ou
smart account. **Essas premissas não são desempenho de produção já comprovado.**

| Opção | Sem swap | Com swap | Sucessor Domino |
| --- | ---: | ---: | ---: |
| 1. ETH já disponível na tesouraria | US$ 0,177–0,196 | US$ 0,225–0,245 | US$ 0,284–0,303 |
| 2. Conversão e abastecimento automáticos | US$ 0,177–0,196 | US$ 0,225–0,245 | US$ 0,284–0,304 |
| 3. Paymaster, API dentro da franquia | US$ 0,214–0,271 | US$ 0,266–0,325 | US$ 0,331–0,389 |

Para a opção 2, conversão e abastecimento usam uma provisão hipotética de
200–500 mil gas por lote. Não existe cotação de rota que qualifique essa faixa.
Se a opção 1 também precisar vender tokens, incorre no mesmo custo de conversão;
a automação muda principalmente a operação e os controles. A opção 3 usa a
[tarifa publicada da Pimlico de 10%](https://docs.pimlico.io/guides/pricing) e
100–300 mil gas adicionais hipotéticos por UserOperation. Inclui patrocínio do
publicador. Depois da franquia de API, a carga de chamadas modelada acrescenta
cerca de **US$ 0,012 por execução bem-sucedida**. O preço real exige uma cotação
completa da conta e do provedor; deploy inicial da conta pode aumentar o custo.

As tabelas excluem custos fixos e trabalho humano. Por exemplo, US$ 50 mensais
hipotéticos adicionam US$ 0,05 por execução a mil execuções mensais ou US$ 0,005
a dez mil; isso não é uma medição das despesas atuais do projeto. Custos de DEX
e impacto ao realizar a receita reduzem a receita disponível: o modelo econômico
usa uma perda hipotética de 0,3%, sem assumir paridade de tokens com USD.

O abastecedor automático deve receber passivamente as taxas e converter em uma
transação posterior: o vault exige crédito exato ao destinatário durante a
cobrança. Uma carteira vazia de ETH não consegue iniciar seu próprio unwrap ou
swap. É necessário capital de giro para operador, publicador e abastecedor.

## Viabilidade econômica e decisão

Os **2% incidem sobre taxas ganhas e efetivamente consumidas**, não sobre TVL ou
principal. Depois de recebida legitimamente, essa receita pertence à tesouraria;
ela pode financiar operações sem vender reservas do usuário ou cobrar gas de novo.
Uma receita em token sem rota de venda não equivale a ETH disponível.

Para a opção escolhida, a receita realizável precisa cobrir execução, observações,
conversão/abastecimento rateados, tentativas revertidas, provedor e operação. O
buffer de custo aprovado de 15% é margem de estimativa, não tarifa extra. Um
paymaster muda a forma de pagar, mas não resolve receita insuficiente.

Ratear uma observação por dez execuções pressupõe dez operações elegíveis na
mesma pool e janela de validade. A janela é de 255 blocos L2, aproximadamente
25,5 segundos ao ritmo observado; não se pode espalhar esse custo arbitrariamente
por horas ou pools diferentes. Taxas de observações sem execução também pertencem
ao orçamento da empresa.

Uma publicação contínua a cada 25 segundos, mesmo sem trabalho pronto, custaria
aproximadamente **US$ 79–108 por pool por dia** nesses preços, antes de executar
qualquer reinvestimento. Essa frequência é um exemplo, não o comportamento atual
nem uma recomendação. A publicação deve acompanhar trabalho elegível pronto;
com apenas uma execução por observação, o custo central sem swap sobe de
US$ 0,196 para **US$ 0,224**.

No cenário central da opção 2, o custo é **US$ 0,196 / 0,245 / 0,303** para
reinvestimento direto, com swap e sucessor. Para a tarifa de 2% cobrir esse custo,
a perda de conversão de 0,3% e o buffer de 15%, é preciso consumir aproximadamente
**US$ 11,31 / 14,13 / 17,50 em novas taxas ganhas ainda não cobradas**. Isso destina
100% da receita líquida de serviço ao orçamento modelado; reservar metade para
outras despesas/lucro dobra o mínimo. Um sucessor que só usa lotes já cobrados
não gera essa receita novamente e exige outra justificativa de financiamento.

A **0,5 gwei**, mantendo a parcela histórica de dados, os custos centrais sobem
para **US$ 1,70 / 2,16 / 2,72**, exigindo cerca de **US$ 98 / 124 / 157** em novas
taxas consumidas. A amostra chegou a 0,491854 gwei: esse teste de sensibilidade
é relevante e não é um teto. Reavaliar o preço antes de assinar e aguardar quando
a execução deixa de ser econômica é parte essencial da solução.

Os custos completos, mínimos de taxas e cenários de pico estão no
[modelo econômico](gas-funding-2026-09-21/ECONOMICS.md). Esse mínimo de receita
é uma condição de sustentabilidade do operador, não prova de benefício para o
usuário. O planner deve manter a comparação entre reinvestir, fazer swap ou esperar.
Não se deve forçar uma execução ou criar swaps apenas para cobrar mais taxas.

O destinatário de taxas é imutável no deploy. Sua custódia precisa ser compatível
com a evolução desejada; escolher um contrato recebedor não qualifica por si só
suas permissões ou automação. Este estudo não selecionou carteiras nem autorizou
novas cobranças. Um escrow debitado do usuário além dos 2% mudaria a política
comercial e não é a opção recomendada aqui.

## Verificação e reprodução

O preflight local e os três novos ensaios de fork terminaram sem falhas no escopo
solicitado. Os JSONs foram validados; a reprodução offline gerou o mesmo modelo e
relatório econômico, exceto pelo timestamp de geração. Uma conferência independente
recalculou 102 valores das opções e dos limiares sem encontrar divergências.
`git diff --check` e a higiene do repositório passaram. Não foram alterados os
contratos, os serviços de produção ou os parâmetros de tarifa. O túnel SSH
temporário deste estudo foi encerrado.

```bash
python3 reports/gas-funding-2026-09-21/reproduce_economics.py \
  --out-dir /tmp/domino-gas-economics-reproduced
```

Essa reprodução não usa rede, carteiras ou assinaturas. Uma nova medição de fork
usa `measure_costs.py` com a URL loopback qualificada do nó; preços novos devem
originar outro conjunto de evidências, sem sobrescrever as amostras datadas.
