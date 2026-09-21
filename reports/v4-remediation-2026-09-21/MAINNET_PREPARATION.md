# Preparação atual do V4 — Robinhood mainnet, 21/09/2026

As correções do domínio de blocos Nitro e da recuperação independente do Setup
estão implementadas. O freeze de produção é
`7321c5bdefb27a29d15dfa2cdcbaae6cc9d9715b`, incluindo 2% no modo simples e 4% no Domino.
Os [artifacts atuais](../revert-fees-2026-09-21/artifact-verification.json) e a
[validação da mudança](../REVERT_FEE_DEEP_DIVE_2026-09-21.md) substituem o freeze
anterior; o [relatório de correções](../V4_REMEDIATION_2026-09-21.md) preserva sua evidência histórica.
Nenhuma transação foi assinada ou enviada à mainnet.

O usuário já forneceu os cinco endereços públicos e selecionou **65 bps (0,65%)**
por swap assistido no Setup, separados dos swaps internos incluídos nos modos.
Operador e publicador foram abastecidos. O pacote local de oito transações foi
simulado com o saldo e nonce reais do fork, sem criar fundos artificiais.
A banda imutável continua **não selecionada**: o usuário decidiu medir a operação
antes de fixá-la. A [medição e seus limites](../PRICE_BAND_QUALIFICATION_2026-09-21.md)
distinguem deriva dos pools, RPC e replay local de um publicador em produção.

## Entradas necessárias para o pacote real

O [modelo de parâmetros públicos](public-deployment.template.json) deixa os dados
ainda não fornecidos como `null`. O gerador rejeita esse modelo incompleto.

- Endereços públicos do deployer, destinatário das taxas, operador, publicador e
  guardião. Deployer pode coincidir com destinatário das taxas; operador,
  publicador e guardião devem diferir entre si e do destinatário das taxas.
- Faixa de desvio do publicador, tarifa do Setup, versão e validade dos perfis.
- Nonce e saldo atuais do deployer, limites de gas por transação, teto de custo
  agregado e reserva. Esses dados dependem da carteira escolhida e de uma
  simulação da sequência exata. Nenhum valor de fixture é uma decisão de produção.

Os hashes esperados de PoolManager, PositionManager e StateView já estão no
modelo, com [qualificação independente](DEPENDENCY_QUALIFICATION.md) por registros
do Uniswap e Sourcify, reconstrução do runtime e comparação com a mainnet.

## Poderes e custódia dos papéis

| Papel | Autonomia |
| --- | --- |
| Deployer | Implanta os sete contratos e vincula a implementação uma vez. Depois disso não tem um poder administrativo sobre os cofres. O pacote exige EOA com ETH para as oito transações. |
| Destinatário das taxas | Recebe as taxas na moeda consumida. Isso não concede poder sobre cofres. Pode ser uma carteira de contrato; endereço imutável. |
| Operador | Executa planos dentro dos limites do dono do cofre e pode pausar. Não pode retirar ativos, mudar a política ou retomar um cofre pausado. O dono pode revogá-lo. |
| Publicador | Publica e revoga observações de preço. Uma observação pode atender várias execuções/cofres. Não movimenta fundos; sua falta de atividade interrompe a automação. |
| Guardião | Revoga observações e propõe outro publicador, que deve aceitar. Pode escolher a si próprio ou uma carteira sob seu controle; portanto pode adquirir o papel de publicador. Não controla cofres nem altera a faixa imutável. |
| Dono do cofre | É cada usuário: define política e limites, autoriza/revoga operador, pausa/retoma e retira suas posições e reservas. |

São suficientes quatro endereços distintos se deployer e destinatário das taxas
coincidirem. Cinco separam também implantação e tesouraria. Separar endereços não
prova custódia independente; a rotação do publicador exige duas chamadas, sem
aprovação obrigatória da chave antiga. Operador e publicador devem ter acessos
separados; o guardião deve ficar fora dos serviços automáticos.

## ETH para gas

O usuário paga a criação/configuração e as operações manuais que enviar. Nas
transações automatizadas, o operador paga usando ETH nativo que já está na sua
carteira. O publicador precisa de saldo próprio para publicar observações.

Nos testes históricos de automação, `anvil_setBalance` fornece ETH fictício às
contas; a simulação posterior da sequência de deploy usa os saldos do fork.
Não há receita vendida para obter esse ETH. Na implementação atual também não há serviço de
top-up automático: não se vendem automaticamente principal, reservas do usuário
nem ativos do destinatário das taxas para abastecer o operador. Saldo insuficiente
faz o signer recusar a execução. Os 2% no simples ou 4% no Domino sobre taxas ganhas e efetivamente consumidas
incluem a remuneração/custo operacional na política econômica, mas o recebimento
dessas taxas não abastece automaticamente a carteira que paga gas. O caminho
aprovado é abastecimento manual inicial; conversão e reposição automáticas da
tesouraria da empresa ficam para a implementação posterior. A taxa do modo
já inclui swaps internos; não foi adicionada cobrança extra de 2% sobre swaps.

## Sequência de implantação

1. Factory.
2. Read helper.
3. Routing helper.
4. Price guard.
5. Execution engine.
6. Implementação do vault.
7. Setup.
8. `factory.finalizeImplementation(implementation)`.

Endereços previstos dependem do deployer e do nonce inicial. Uma criação revertida
consome nonce; a ferramenta rejeita a adoção silenciosa de uma sequência deslocada.
Deploy não cria cofres de usuários, não concede aprovações e não ativa serviços.

O preflight preserva a distinção entre `latest` e `finalized`. Em 21/09, o nó
próprio foi verificado diretamente por SSH: serviu o estado finalizado do bloco
68.919.532, os três contratos Uniswap com os pins esperados e o teste compilado
ArbSys. A indisponibilidade anterior era do endpoint público; ela não demonstrava
um bloqueio no RPC do projeto. [Evidência local](../gas-funding-2026-09-21/local-finalized-preflight.json).
Essa qualificação não substitui os recibos finalizados e a comparação de bytecodes
depois do deploy, nem prova retenção ilimitada de histórico no nó podado.
Procedimento completo: [FINANCIAL_RELEASE](../../docs/FINANCIAL_RELEASE.md).

A rotação do publicador exige proposta do guardião e aceite da nova carteira.
Depois disso, `verify --price-publisher <novo-endereço>` admite explicitamente o
publicador atual no bloco finalizado e produz um novo perfil, preservando as oito
transações originais e a validade existente. O novo endereço deve ser EOA e
respeitar a separação de papéis. O manifesto original permanece intacto; a opção
não renova perfis vencidos nem ativa o serviço. Até configurar o perfil verificado,
o signer bloqueia a divergência de publicador.
