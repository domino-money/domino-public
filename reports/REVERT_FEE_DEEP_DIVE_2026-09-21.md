# Taxas por modo e estudo dos contratos Revert — 21/09/2026

**Decisão do usuário:** Auto-compound simples a **2%** e Domino-compound a
**4%**, ambos sobre novas taxas ganhas efetivamente consumidas, uma única vez.
A tarifa segue o modo escolhido em toda execução. O operador começa com ETH
abastecido manualmente pela empresa; o próximo serviço operacional será a
conversão e reposição limitadas usando receita já recebida pela tesouraria.

**Recomendação para swaps:** manter os swaps internos incluídos na tarifa do modo.
A cobrança adicional de 2% sobre o swap foi estudada, mas não foi ativada. Para
swaps assistidos de depósito/gestão manual, já existe política e implementação
separadas com teto de **0,65%**; a tarifa/versionamento concretos de produção ainda
precisam ser selecionados. Um aumento desse teto para 2% seria outra decisão
comercial e outra alteração de contrato.

## Pesquisa delegada e fontes

Foram investigados os repositórios oficiais `compoundor`, `lend`, `v3utils` e
`v4lend`, documentação atual e, de forma estática, o bundle público da Revert.
Os relatórios registram SHAs completos, funções e linhas permanentes:

- [AutoCompound, SelfCompoundor, AutoRange e AutoExit](revert-fees-2026-09-21/CONTRACTS.md).
- [Swaps assistidos, routers, cobrança, sobras e diferenças entre versões](revert-fees-2026-09-21/SWAPS_AND_PRICING.md).
- [Sensibilidade econômica com as novas tarifas](revert-fees-2026-09-21/RATE_SENSITIVITY.json).

Nenhum código externo foi executado, carteira conectada ou transação enviada
para pesquisar a Revert. Os testes do código Domino usam ambientes locais
isolados. Não se copiou implementação da Revert; diferenças de licença e de
contabilidade também impedem tratar essas fontes como componentes intercambiáveis.

## O que a Revert adotou

| Serviço | Comportamento no código inspecionado | Consequência para Domino |
| --- | --- | --- |
| **AutoCompound atual** | Recompensa inicial próxima de 2% sobre o que efetivamente foi adicionado à liquidez, depois do swap. A taxa global só pode diminuir. Recompensas ficam em saldo do protocolo para retirada. | Comparar a base, não apenas o percentual. Não há cálculo de reembolso exato de gas nem uma segunda cobrança Revert explícita pelo swap interno. |
| **SelfCompoundor** | A constante de recompensa está em zero no SHA revisado; o NFT e as sobras voltam na mesma transação. O remetente paga gas. | Contradiz uma leitura genérica da antiga documentação que anunciava 1%; não prova a configuração de todo contrato implantado. É um produto manual diferente do nosso compound automático simples. |
| **AutoRange/AutoExit** | O dono autoriza um teto e o executor escolhe uma recompensa dentro dele. A base pode ser só taxas ou incluir os ativos da posição, conforme a configuração. | Teto autorizado e gas efetivamente gasto são conceitos distintos. Esses fluxos podem mover principal; não devem ser copiados para a estratégia Domino financiada somente por taxas. |
| **Swaps assistidos via Utils** | As versões atuais verificam débitos/créditos e saída mínima, mas não fixam no helper a tabela comercial anunciada. A cobrança pode estar nos comandos do router. | Uma revisão precisa decodificar a cotação e a execução aninhada; o helper isolado não demonstra que o swap seja gratuito ou respeite sozinho o teto comercial. |
| **Compoundor antigo** | Split inicial de 1% para executor e 1% para protocolo, dentro da recompensa total; usa outra custódia e modelo de execução. | Não atribuir esse split automaticamente ao AutoCompound atual. |

Fontes principais: [AutoCompound, cálculo e saldo de recompensa](https://github.com/revert-finance/lend/blob/7e85a81ac97663a3a731f6d6f07f14d774962a6e/src/transformers/AutoCompound.sol#L161-L187),
[SelfCompoundor, constantes](https://github.com/revert-finance/compoundor/blob/800d0a6462be0bf78a418f3d58dd407eeadef173/contracts/SelfCompoundor.sol#L18-L35),
[AutoRange, teto por posição](https://github.com/revert-finance/lend/blob/7e85a81ac97663a3a731f6d6f07f14d774962a6e/src/transformers/AutoRange.sol#L133-L162),
[política comercial de swaps](https://docs.revert.finance/revert/position-management).

No AutoCompound, ignorando arredondamento e sobras, 100 unidades disponíveis
resultam em aproximadamente 98,039216 reinvestidas e 1,960784 de recompensa:
`recompensa = adicionado × 2%`, com reserva `disponível / 1,02`. Portanto,
**2% sobre o adicionado equivale a cerca de 1,9608% sobre o bruto disponível**.
Domino cobra 2% ou 4% sobre o bruto ganho consumido, com rastreamento de origem.
A saída de um swap e um lote já cobrado não se tornam nova receita tributável.

A documentação Revert anuncia swaps dinâmicos até 0,65%, podendo chegar a 0,01%
em pares elegíveis. O código histórico examinado inclui uma alternativa de taxa
sobre saída e fixtures de fee de router; isso não estabelece a versão ou tarifa
live. O bundle público contém valores/fallbacks diferentes, mas não foi executado
nem transformado em cotação real. Endereços ainda publicados de AutoRange também
aparecem como antigos em um script de substituição do HEAD revisado. Assim,
**fonte fixada, documentação e bytecode/estado implantados são evidências distintas**.
Este estudo não afirma ter qualificado a tarifa de uma transação real da Revert.

## Cobrar mais 2% sobre o swap

A proposta tem duas interpretações, com efeitos diferentes:

1. **Swap assistido de capital do usuário:** o dono escolhe o orçamento e assina
   a troca. Já existe o teto de 0,65% no Setup. Em US$ 500 de orçamento de swap,
   0,65% custa US$ 3,25 e 2% custa US$ 10, antes dos custos do DEX. Os 2% são
   aproximadamente **3,08 vezes** o teto anunciado da Revert. O valor depositado
   sem passar pelo swap não deve entrar nessa base.
2. **Swap interno do compound:** adicionar 2% ao swap empilha um segundo serviço
   sobre a receita já sujeita ao modo de 2%/4%. Não foi encontrada evidência de
   que esse seja o modelo universal da Revert. Uma cobrança repetida sobre lotes
   convertidos ainda exigiria nova regra explícita de contabilidade e consentimento.

Exemplo de empilhamento, **não implementado**: US$ 100 de novas taxas consumidas;
a tarifa do modo é retirada primeiro; o orçamento bruto de swap é uma fração do
saldo restante e inclui a taxa extra de swap. Preço constante, sem gas/DEX/impacto:

| Fração do saldo pós-tarifa destinada ao swap | Total cobrado no simples | Total cobrado no Domino | Saldo do Domino após as duas cobranças |
| --- | ---: | ---: | ---: |
| 0% | US$ 2,00 | US$ 4,00 | US$ 96,00 |
| 25% | US$ 2,49 | US$ 4,48 | US$ 95,52 |
| 50% | US$ 2,98 | US$ 4,96 | US$ 95,04 |
| 100% | US$ 3,96 | US$ 5,92 | US$ 94,08 |

Fórmula: `cobrança total / F = f + 0,02 × q × (1 − f)`, onde `F` é a base
original consumida, `f` a tarifa do modo e `q` a parcela do saldo pós-tarifa
alocada ao swap. Outra definição de base muda os números; o produto precisa
sempre mostrar orçamento bruto, fee, entrada líquida no DEX e saída mínima líquida.

A tarifa de 4% já cria mais margem para o gas do Domino. Cobrar também sobre o
swap aumenta o custo quando o balanceamento é necessário e cria incentivo para
executar mais swaps. A recomendação é preservar **uma cobrança de serviço por
modo**, e avaliar preços competitivos separados apenas para swaps assistidos
solicitados pelo usuário. Benefício do dono e sustentabilidade do operador
continuam critérios independentes.

## Efeito dos 4% sobre sustentabilidade

Reutilizamos os custos centrais do [estudo anterior](GAS_FUNDING_STUDY_2026-09-21.md):
0,052694 gwei, ETH a US$ 2.748,79, dez execuções por observação válida, abastecimento
a cada cem execuções, 5% de tentativas revertidas com metade do compute, perda
hipotética de conversão de 0,3%, buffer de 15% e 100% da receita líquida disponível
para esse orçamento. Custos fixos estão excluídos. **É uma comparação de tarifa
com custos mantidos constantes, não uma nova medição do gas do runtime de 400 bps.**

| Execução | Custo central usado | Mínimo de novas taxas consumidas a 2% | Mínimo a 4% no Domino |
| --- | ---: | ---: | ---: |
| Reinvestir na posição | US$ 0,196 | US$ 11,31 | **US$ 5,65** |
| Reinvestir com swap | US$ 0,245 | US$ 14,13 | **US$ 7,06** |
| Criar sucessor | US$ 0,303 | US$ 17,50 no estudo antigo; não elegível no novo modo simples | **US$ 8,75** |

O mínimo com buffer é `1,15 × custo / (tarifa × 0,997)`. A 0,5 gwei, mantendo
os custos históricos de dados, os mínimos Domino são aproximadamente **US$ 49,10 /
62,24 / 78,41**, respectivamente. Reservar metade da receita para outras despesas
ou lucro dobra esses mínimos. Não são valores mínimos de depósito ou TVL.
Um sucessor que usa somente lotes já cobrados não gera a receita novamente.

Uma tarifa maior ajuda o operador, mas reduz o montante reinvestido pelo usuário.
Não autoriza antecipar operações sem benefício líquido demonstrável, cobrar
principal, cobrar gas outra vez ou publicar observações continuamente sem trabalho
pronto. A tesouraria ainda precisa de ETH inicial e reserva para falhas.

## Implementação e compatibilidade

A alteração mantém a tupla ABI de Policy. Os valores exatos de `serviceFeeBps`
representam o modo: **200 simples; 400 Domino**. Validação genérica de um teto de
400, isoladamente, seria insuficiente. As restrições precisam concordar:

- Contratos: políticas novas aceitam exatamente 200/400; simples tem
  `maxPositions=1` e somente a posição original, sem criar/financiar sucessores
  nem consumir fontes de outra posição. Domino usa suas regras de roteamento
  existentes e cobra 400 em todas as receitas, não só `MINT`.
- Planner, modelos e recibos: mesma seleção de modo, arredondamento por fonte e
  preservação dos lotes já cobrados. Leitura histórica de recibos não autoriza
  uma tarifa histórica arbitrária em uma política nova.
- SDK/UI: modo e tarifa aparecem antes da assinatura; alteração de modo é
  transação do dono, avança versão e invalida planos/revisões anteriores.
  Filhos ativos devem ser retirados antes de voltar ao modo simples; seus saldos
  restantes continuam recuperáveis pelo dono.
- Perfil de release: `serviceFeeBps: 200` e `dominoServiceFeeBps: 400`, ambos
  obrigatórios. O perfil antigo de taxa única não deve admitir o novo comportamento.
  Os novos fontes exigem novos artifacts/pins e atualização do freeze antes do deploy.

A política de swaps do Setup permanece em até 65 bps. Os relatórios e recibos
históricos não são reprecificados. A simulação antiga de compound simples continua
em 2%. Nenhum serviço de top-up nem execução financeira em mainnet foi ativado.

## Freeze e validação da implementação

Freeze de produção: `7321c5bdefb27a29d15dfa2cdcbaae6cc9d9715b`, com 13 fontes e
2.656 linhas. O [manifesto dos sete artifacts](revert-fees-2026-09-21/artifact-verification.json)
registra os hashes dos fontes, artifacts, criação e runtime, além do compilador e
dos limites. O loader verificou todos os hashes dos fontes de cada metadata
contra o checkout integrado. Vault: 23.694 bytes, com 882 bytes de margem;
engine: 21.899 bytes, com 2.677 bytes de margem. Todos os limites passaram.

Validações desta alteração:

- Solidity: **260/260 em 20 suítes**, zero skips. A baseline de gas contém
  241 entradas determinísticas extraídas dos mesmos resultados Forge; aumentos
  intencionais incluem as novas proteções e o deploy dos contratos nos testes.
  [Proveniência e comandos](revert-fees-2026-09-21/CORE_VALIDATION.md),
  [resultados por suíte](revert-fees-2026-09-21/suite-results.json) e
  [delta de gas](revert-fees-2026-09-21/gas-baseline-delta.json).

- Backend sem opt-ins: 2.225 testes descobertos, **1.657 executados com sucesso**
  e 568 omitidos pelos gates de PostgreSQL/EVM; não são 2.225 passes.
- Recibos V4 em Anvil: **9/9**. Inclui consumo real de uma reserva convertida já
  cobrada a 2%, depois da mudança para 4%, sem nova cobrança daquele saldo;
  somente receita original nova paga 4%.
- Runner e durabilidade com PostgreSQL/Anvil isolados: **25/25**.
- SDK em EVM: **64 verificações com ERC20/ERC20 e 64 com ETH/ERC20**,
  incluindo modo, troca, downgrade e invalidação de revisões anteriores.
- Deploy/verificação de release e transporte RPC: **12/12**, com oito transações
  reais em Anvil e admissão dos perfis de duas tarifas; zero envio à mainnet.
- Aplicação completa: **1.136/1.136**, incluindo os pins de contrato, docs e SDK.
  Navegador financeiro: **16/16**; renderização afetada: **2/2**;
  typecheck, lint e build de produção passaram.
- Parser de perfil no bridge: **3/3**; consumidor do contrato de recibos:
  **3/3**; exportação do contrato de API sem divergência.

A revisão independente do delta não encontrou caminho para usar a tarifa simples
e executar as funções exclusivas de Domino. Isso não substitui uma auditoria
externa. A evidência anterior de fork/Nitro e seus custos permanece datada;
não foi repetido um ensaio econômico completo do novo runtime na mainnet.
