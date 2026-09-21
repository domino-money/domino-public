# Taxas de QUOTRON/HASH e contabilização de reinvestimento V4

Qualificação de 21 de setembro de 2026, usando o RPC próprio por SSH, fontes
com runtime correspondente e um fork Anvil isolado. Nenhuma transação foi
enviada à mainnet e nenhuma chave privada foi usada. As taxas de automação
continuam **2% simples / 4% Domino**, com swaps internos incluídos na tarifa
Domino; custos reais de negociação do pool continuam reduzindo a saída.

## O que os dois tokens cobram

| Token / pool | Mecanismo encontrado | Consequência para a automação atual |
| --- | --- | --- |
| QUOTRON `0x5a86828efd322bfb16d93cfed16ee9bc14940d7f` | Transferência ERC20 sem retenção; hook do pool cobra taxa em WETH no swap. `currentFeeBps` retornou **300 = 3%** para conta sem marca de lançamento. | Pool com hook e router específico não admitido pelo V4 atual. Transferências envolvendo PoolManager exigem autorizações transitórias do hook/router. |
| HASH `0xca75082b85bb7bec8325d513f615b16bda260020`, pool oficial com hook | ERC20 sem retenção. Hook informa **500 bps = 5%**, confirmado em compra e venda reais sobre a perna ETH. | Pool com hook não admitido. A indicação de 2,5% do site estava desatualizada para o estado medido. |
| Mesmo HASH, pool alternativo ETH/HASH sem hook | LP: **2%**; protocolo: **0,1%**, combinados pela fórmula V4 em **2,098%**, antes de impacto de preço. | A ausência de hook satisfaz esse critério estrutural; não constitui admissão econômica ou operacional completa. |

O token HASH não deve ser globalmente marcado como incompatível porque um de
seus pools tem hook. A identidade relevante é chain + token + PoolKey + rota.
Os dois pools HASH e as evidências da incidência estão na
[qualificação específica](transfer-tax-2026-09-21/hash-pools.md).

No QUOTRON, a fonte do token e a do hook correspondem ao runtime observado.
`launchFeesFinalized=true`; a biblioteca diferencia a taxa base de 3% de uma
faixa de lançamento de 90%, com marca por comprador. O getter para a conta
sintética não marcada retornou 3%, `markedUntil=0` e ausência de restrição.
Isso não promete a mesma condição para qualquer endereço ou estado futuro.
`ROYALTY_BPS=500` é royalty de NFT, **não** retenção de 5% em transferências
ERC20. O token também sincroniza NFTs ERC404 ao cruzar unidades inteiras.

A fonte HASH fornecida pelo Sourcify se declara reconstruída do bytecode.
Seu runtime corresponde exatamente ao código lido no nó; isso comprova a
correspondência operacional, não a autoria original dos identificadores e
comentários. O ERC20 usa débito/crédito integrais de Solady. Permissões de mint
e demais riscos do emissor não são aprovados por esta qualificação.

[Fontes completas, hashes e leituras fixadas](transfer-tax-2026-09-21/TOKEN_READS.json)
foram coletadas no bloco finalizado **69.017.481**, hash
`0xf49e7cea2707d87c922f4b9bae473da523710375c8e9a70e68b591d412077471`.
O PoolKey QUOTRON foi recomputado e confirmado contra o PositionManager:
`0x0b142aaf734f1b063355bfe854e282a13b26dcac86e2e564e74540f9b218d069`.
Seu `slot0` tinha LP fee zero apesar da cobrança de 3% pelo hook.
As cobranças de hook dos dois pools oficiais não devem ser tratadas como
fees convencionais disponíveis ao LP: sua distribuição segue o hook. O
Domino atual reinveste fees de LP comprovadas pelo core, não uma porcentagem
de todo custo de negociação mostrado por um site.

## Transferências reais e compensação interna

A intuição de que parte do reinvestimento acontece dentro do mesmo singleton
está correta. A compensação interna do PoolManager entre crédito de fees e
débito da nova liquidez não transfere ERC20. Contudo, há etapas entre endereços:

- Coleta no caminho geral: **PoolManager → vault**.
- Reinvestimento geral e entrada de swap: **vault → PoolManager**.
- Saída de swap e sobra do reinvestimento otimizado: **PoolManager → vault**.
- Cobrança Domino: **vault → feeRecipient**.

Criar um sucessor não cria uma segunda carteira de tokens para aquela posição.
Ainda assim, as transferências acima existem conforme a receita executada.
A análise por etapa está no [mapa histórico de trajetos](transfer-tax-2026-09-21/TRANSFER_PATHS.md).

O [replay de oito casos](transfer-tax-2026-09-21/TOKEN_TRANSFER_REPLAY.json)
executou o código real dos tokens no fork. HASH debitou e creditou integralmente
nos quatro trajetos testados: carteira→vault, vault→destinatário, vault→PM e
PM→vault. QUOTRON entregou integralmente em carteira→vault e vault→destinatário;
vault→PM reverteu `NotRouter`, e PM→vault reverteu
`UnauthorizedPoolSettlement`, sem a autorização transitória da rota canônica.

As contas e os saldos de teste são sintéticos, somente no fork. Nenhuma isenção,
regra de rota ou autorização foi alterada. Os valores QUOTRON ficaram abaixo
de uma unidade inteira para isolar o ERC20; fronteiras de sincronização NFT e
um ciclo completo de negociação desse hook não foram qualificados.

## Correção da contabilização NET

O teste com retenção **sintética** de 3% encontrou uma falha separada dos dois
tokens reais: NET inferia custo de liquidez como `fees realizadas − saldo
recebido`. Uma retenção na sobra recebida podia virar liquidez fictícia e
elevar a fee Domino se o destinatário da fee estivesse isento e os limites
do plano fossem amplos. O saldo contábil continuava lastreado; esse check
sozinho não detectava a classificação incorreta.

A implementação corrigida separa as etapas: modifica a liquidez, lê o crédito
nominal do PositionManager no PoolManager, calcula o custo real, saca a sobra
e exige recebimento exato. A nova chamada interna `executionTake()` só aceita
o engine fixado, durante execução autenticada NET, com moedas e destinatário
fixos. Uma diferença reverte toda a operação, inclusive a cobrança Domino.
O formato do plano e as tarifas aprovadas permanecem os mesmos.

Os oito testes oficiais de trajetos passaram após a correção, cobrindo coleta,
aporte, entrada/saída de swap, destinatário de fees, sobra NET e compensação
sem sobra. O caso NET usa também custo independente calculado por
`SqrtPriceMath`, sem inferi-lo pelo saldo recebido. Um teste adicional cobre a
recusa de `executionTake()` durante uma execução autenticada fora de NET.

Essa correção rejeita recebimento reduzido; não implementa suporte geral a
fee-on-transfer. Um token que debita extra do PoolManager e entrega o nominal
ao destinatário exige qualificação própria: a medição apenas do crédito do
vault não detecta esse mecanismo. As saídas do próprio vault verificam tanto
débito quanto crédito exatos.

## Validação do código e CI

Freeze de produção: `abe25808da712de13b7f90b1c2089b08dffc0a94`, 13 fontes,
2.670 linhas. [Manifesto atualizado](transfer-tax-2026-09-21/artifact-verification.json).
Apenas engine e implementação do vault mudaram o runtime. O vault ocupa
24.002 bytes (margem 574; mínimo exigido 313) e o engine 22.335 bytes
(margem 2.241; mínimo exigido 2.048).

- Solidity: **269 testes em 21 suítes**, executadas sequencialmente pelo comando
  de snapshot; baseline renovada com 250 entradas determinísticas. Os aumentos
  de gas incluem as verificações adicionais e o deploy dos contratos maiores
  dentro das fixtures. [Resultados e delta](transfer-tax-2026-09-21/CORE_VALIDATION.json).
- Backend com Anvil/PostgreSQL temporários: **17/17**, zero skips, cobrindo
  recibos (9), histórico (1) e runner (7).
- Preparação/verificação de release com Anvil: **6/6**; transporte RPC privado:
  **6/6**; ferramentas de contratos: **42/42**; higiene Solidity sem achados.
- Oito transações de deploy re-simuladas pelo RPC próprio em fork: todas passaram,
  com **19.504.419 gas Anvil** e perfis ainda indisponíveis. Não é estimativa
  completa de gas Nitro; a proposta pública foi depois incluída no pacote da
  [auditoria independente](V4_INDEPENDENT_AUDIT_SPEC_2026-09-21.md).
  [Resumo da regressão e simulação](transfer-tax-2026-09-21/NET_REGRESSION.json).

Os quatro CIs vermelhos tinham duas causas comuns: hash de origem desatualizado
no manifesto performance e bundle de carteira com 150.184 bytes gzip, acima do
limite de 150.000. O commit `d56f0dad6446928017fe67184f4589432a160d0e` atualiza
manifestos/pins e compartilha o validador duplicado, preservando callbacks
semânticos separados. O bundle caiu a **149.589 bytes**, sem elevar seu limite.
[Verificações locais e limitação do teardown Chrome/macOS](transfer-tax-2026-09-21/CI_REMEDIATION.json).
Uma rodada subsequente identificou 23 fixtures de backend que ainda calculavam
o líquido a 2% para cenários Domino a 4%. A correção `255fc38` usa a tarifa da
política e acrescenta validação dos dois modos. O
[CI integral desse commit](https://github.com/domino-money/domino/actions/runs/35645990350)
passou: 269 testes Solidity, 2.229 de backend e 12 de release, sem skips nessas
suítes; frontend com 1.401 passes e seis skips previstos. Os cinco jobs passaram.
Reexecutar um commit antigo não incorpora essas correções.

## Relação com o publisher e a banda

Ler preço/`slot0` pelo RPC não calcula automaticamente taxa do token, hook,
router, impacto e isenções por endereço. A banda compara preços; ela não é
um orçamento de taxas e não deve ser ampliada para compensar uma cobrança
de 3% ou 5%. Uma cotação/simulação da rota completa deve incluir esses custos
na saída líquida e na decisão de executar ou esperar.

Os hooks identificados continuam fora das rotas admitidas. A alternativa HASH
sem hook ainda precisa de liquidez, cotação, limites e rentabilidade adequados.
A faixa imutável de publicação foi selecionada pelo usuário após a medição:
**50 sqrt-bps**, aproximadamente −0,9975%/+1,0025% no preço do par. A comparação
ocorre na publicação; a execução tem limites próprios de impacto e de preço.
A publicação prevista continua sob demanda
quando houver uma execução elegível; não foi ativado serviço de publicação.

## Reprodução

Com dependências do repositório instaladas e acesso autorizado ao RPC próprio:

```sh
node reports/transfer-tax-2026-09-21/qualify_token_reads.mjs
node reports/transfer-tax-2026-09-21/replay_token_transfers.mjs
node scripts/test-contracts.mjs --match-path test/reference/OfficialFeeOnTransferRoutes.t.sol
node scripts/test-contracts.mjs --match-path test/DominoVaultV4Custody.t.sol
```

O replay fixa o bloco do arquivo de leituras, verifica hashes de runtime e
reconfere canonicidade. A repetição das leituras usa um novo bloco finalizado;
as taxas e o estado podem mudar. Os dados HASH têm seu próprio bloco e
limitações explícitas no relatório específico.
