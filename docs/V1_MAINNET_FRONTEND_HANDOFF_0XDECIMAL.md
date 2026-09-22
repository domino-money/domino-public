# Domino V1 em mainnet — integração do frontend para 0xdecimal

Atualizado em **22 de setembro de 2026 (UTC)**. Destinatário: **0xdecimal / OxDecimal**.

Os sete contratos abaixo **já estão implantados na Robinhood Chain mainnet**. As oito transações de deploy/configuração foram confirmadas e verificadas em bloco finalizado pelo RPC próprio. O frontend pode usar esses contratos reais, com os perfis públicos anexos e os SDKs existentes no repositório. Não é necessário fazer outro deploy de contratos para conectar os fluxos de setup e controle de sequences.

O serviço que decide e executa o compound automaticamente ainda precisa ser integrado e ativado. A publicação destes endereços não significa que esse serviço esteja operando. Este handoff não alterou pins, flags ou serviços de produção.

## 1. Identidade do release e evidência

| Campo | Valor |
| --- | --- |
| Rede | Robinhood Chain mainnet |
| Chain ID | `4663` / `0x1237` |
| Nomes públicos | **Domino V1** |
| Versão técnica da implementação | **4** — preservar `implementationVersion() == 4` |
| Versão dos envelopes HTTP | `1.0.0-rc.1` — não renomear para acompanhar o marketing |
| Fonte implantada | [`33844248f59a713d83d710b0af70476f7b00dd15`](https://github.com/domino-money/domino/tree/33844248f59a713d83d710b0af70476f7b00dd15) |
| Tag congelada | [`v1-release-2026-09-21`](https://github.com/domino-money/domino/tree/v1-release-2026-09-21) |
| CI do candidato | [35670680472 — aprovado](https://github.com/domino-money/domino/actions/runs/35670680472) |
| Bloco finalizado usado na verificação | `69250734` |
| Hash desse bloco | `0x3435dfb3b0ece307341956c5c3f2b12a056a937b81797c24809c6f1e318e0b30` |
| SHA256 do manifesto de artefatos | `d74a6816df586ccc6ee660954df31e673111a7c2b95234330aa3e195cc1c4c57` |

As fontes dos sete contratos estão publicadas no Sourcify com os nomes V1 corretos. O resultado é `match` de criação e runtime, compatível com o build que usa `metadata.bytecodeHash: none`. A disponibilização dessas fontes no Blockscout permanece pendente: o encaminhamento automático recebeu HTTP 403, e a API PRO autenticada retornou Cloudflare 1010 (`browser_signature_banned`). Não usar o estado visual do explorer para inferir ausência de deploy. Os links Sourcify e as evidências estão no pacote do release; nenhuma credencial acompanha o pacote.

O pacote operacional do [release](https://github.com/domino-money/domino/releases/tag/v1-release-2026-09-21) reúne receipts, verificação finalizada, ABIs, fontes de verificação e checksums. Preservar a tag e o manifesto: mudanças do frontend não alteram o contrato já implantado.

## 2. Endereços reais

| Componente | Endereço | Papel no frontend |
| --- | --- | --- |
| [DominoVaultFactoryV1](https://robinhoodchain.blockscout.com/address/0x16bf6eaba7b31118627b277e97249720dfe1c7ff) | `0x16bf6eaba7b31118627b277e97249720dfe1c7ff` | Prever/criar vault por owner; âncora de identidade das sequences. |
| [DominoVaultReadHelperV1](https://robinhoodchain.blockscout.com/address/0x0f8e4a7894c83a5d6061246a1ba83261eddb608c) | `0x0f8e4a7894c83a5d6061246a1ba83261eddb608c` | Leituras agregadas das sequences. |
| [DominoRoutingHelperV1](https://robinhoodchain.blockscout.com/address/0xa00ca81cb91d5612913f87c142447cbce19a4ae5) | `0xa00ca81cb91d5612913f87c142447cbce19a4ae5` | Componente de roteamento vinculado à implementação. |
| [DominoPriceGuardV1](https://robinhoodchain.blockscout.com/address/0x0ac66e192a0651bc655e0734f43a9a9de73378f1) | `0x0ac66e192a0651bc655e0734f43a9a9de73378f1` | Âncora de preço das execuções; publisher/guardian operam fora do frontend. |
| [DominoExecutionEngineV1](https://robinhoodchain.blockscout.com/address/0x9bef35ea86aedc9489486c4db3d2816ba2ad7ce9) | `0x9bef35ea86aedc9489486c4db3d2816ba2ad7ce9` | Execução interna vinculada ao vault. |
| [DominoVaultV1 — implementação](https://robinhoodchain.blockscout.com/address/0x349965f26e62c2dec9746cd366d8f1364d679907) | `0x349965f26e62c2dec9746cd366d8f1364d679907` | Template dos clones; **não é o vault individual do usuário**. |
| [DominoSetupV1](https://robinhoodchain.blockscout.com/address/0x676f449fcfcd0f5ce4c7a1db2d98c7d6565dd37a) | `0x676f449fcfcd0f5ce4c7a1db2d98c7d6565dd37a` | Funding, swap assistido, mint, cancelamento e recuperação do owner. |

A factory já foi vinculada à implementação por `finalizeImplementation`, na [oitava transação](https://robinhoodchain.blockscout.com/tx/0x109aef9656f4bd08eae33c5da548261315bf53b6d07c25af49fc6052691cd641). Não repetir essa etapa.

Dependências Uniswap v4:

| Contrato | Endereço |
| --- | --- |
| PoolManager | `0x8366a39cc670b4001a1121b8f6a443a643e40951` |
| PositionManager | `0x58daec3116aae6d93017baaea7749052e8a04fa7` |
| StateView | `0xf3334192d15450cdd385c8b70e03f9a6bd9e673b` |

Papéis de serviço — endereços públicos, sem qualquer chave no frontend:

| Papel | Endereço |
| --- | --- |
| Deployer | `0x706627e3e75b0603c4b6f9a1ebbfc635da712747` |
| Destinatário de fees | `0x1488c84dafc03f7f4c4fb986f83ba99fd530c6f4` |
| Operator | `0x2320ea29fcf7b827e1a4039ed46244be4d4b29da` |
| Publisher | `0x4d6f91d3101569bb8c710bc332f621600e429e7b` |
| Guardian | `0x5e57fded90c4635648eb7b3ba29705ff0769d103` |

O operator é uma identidade global do serviço, com autorização e limites por vault. O owner usa sua própria carteira para criar, autorizar, pausar e recuperar. Não solicitar ao usuário acesso às carteiras de serviço.

## 3. Arquivos prontos para consumir

Os perfis abaixo são cópias dos envelopes produzidos pela verificação on-chain finalizada:

- [Setup: `setup-release.json`](deployments/v1-robinhood-mainnet-2026-09-21/setup-release.json).
- [Sequences: `sequence-release.json`](deployments/v1-robinhood-mainnet-2026-09-21/sequence-release.json).
- [Registro do deployment](deployments/v1-robinhood-mainnet-2026-09-21/deployment.json).

Os dois envelopes possuem `contractVersion`, `chainId`, `available` e `deployment`. O valor `available: true` no arquivo indica que o perfil foi gerado para admissão; **não comprova que o Worker esteja publicado ou que o serviço automático esteja ativo**.

Os perfis atuais expiram em **21/10/2026 às 19:01:30 UTC**, `expiresAt: 1792609290`. Antes de expirar, gerar nova admissão baseada em estado canônico e configuração vigente; não apenas editar a data em um JSON antigo. A expiração não remove o contrato da rede nem os direitos de recuperação do owner.

Os hashes nos perfis são do runtime efetivamente implantado, com immutables aplicados. Não substituir por hashes do bytecode de compilação. Em `sequence.deployment.codeHashes`, `vault` corresponde ao clone EIP-1167 derivado da implementação.

ABIs completos estão em `abi/Domino*.json` no pacote do release. Para o app, reutilizar os ABIs locais e as funções tipadas de [`setup.ts`](../app/src/finance/setup.ts) e [`sequence.ts`](../app/src/finance/sequence.ts). As fontes públicas V1 herdam as implementações técnicas existentes; não renomear seletores, tipos ou domínios Uniswap v4.

## 4. Mudanças concretas para conectar o app

### 4.1 Fixar as duas identidades no build

Em [`app/src/finance/pin.ts`](../app/src/finance/pin.ts), os dois pins ainda estão `null` no commit implantado. Substituir por:

```ts
export const SEQUENCE_FACTORY: Pin = '0x16bf6eaba7b31118627b277e97249720dfe1c7ff'
export const SETUP_CONTRACT: Pin = '0x676f449fcfcd0f5ce4c7a1db2d98c7d6565dd37a'
```

Atualizar também os comentários que dizem que os contratos não foram publicados. Manter `POSITION_MANAGER` no endereço já fixado. Não desativar `pinned()`/`unpinned()` nem usar um build de fixtures para contornar a ausência de pins. Os digests dos contratos HTTP em `app/src/lib/read/pin.ts` são outra identidade e não mudam por causa desses endereços.

### 4.2 Configurar os perfis no Worker existente

Worker: **`domino-setup-bridge`**. Entrada: [`bridge/src/setup-release.mjs`](../bridge/src/setup-release.mjs). Configuração: [`bridge/wrangler.setup.toml`](../bridge/wrangler.setup.toml). O service binding de produção `SETUP_BRIDGE` já existe em [`app/wrangler.toml`](../app/wrangler.toml).

Preencher as variáveis abaixo com **somente o objeto `deployment`**, serializado em JSON; não passar o envelope inteiro:

```sh
# Na raiz do repositório; a saída contém apenas configuração pública.
jq -c '.deployment' docs/deployments/v1-robinhood-mainnet-2026-09-21/setup-release.json
jq -c '.deployment' docs/deployments/v1-robinhood-mainnet-2026-09-21/sequence-release.json
```

| Variável do Worker | Valor |
| --- | --- |
| `SETUP_DEPLOYMENT_JSON` | Saída do primeiro comando. |
| `SEQUENCE_DEPLOYMENT_JSON` | Saída do segundo comando. |
| `SETUP_WALLET_ENABLED` | `"true"` disponibiliza os fluxos owner de Setup após integração. |
| `SEQUENCE_WALLET_ENABLED` | `"true"` disponibiliza os fluxos owner de sequences, incluindo ativação conforme a UI atual. |

As flags estão `"false"` na configuração versionada. Publicar perfis e ligar essas capacidades são mudanças de implantação do app/Worker; não dependem de nova transação de deploy dos contratos. Manter endereços/hashes lowercase, chaves exatas do schema e limites de 8192 bytes. Não incluir RPC privado, credenciais, signer, calldata ou campos extras.

**Disponibilidade operacional:** `executionAvailable: false` do relatório completo não é enviado no envelope de sequence e não é consultado pelo botão `Resume`. Ligar `SEQUENCE_WALLET_ENABLED` não fornece um bloqueio automático do ciclo. Se a entrega inicial oferecer apenas leitura e criação pausada, implementar essa disponibilidade explicitamente na UI antes de apresentar ativação. Preservar os caminhos de pausa, revogação e recuperação. Não anunciar “automação ativa” apenas porque o owner pode autorizar o operator.

### 4.3 Consumir os endpoints pelo app

| Endpoint | Parser |
| --- | --- |
| `GET /api/setup/v1/release` | `deploymentFrom` |
| `GET /api/setup/v1/sequence-release` | `sequenceDeploymentFrom` |

Usar [`readRelease()`](../app/src/finance/release.ts), como as telas atuais. Ele verifica o header `X-Domino-Setup-Contract: 1.0.0-rc.1`, tamanho, status e schema. O Worker responde com `no-store`. Flag desligada retorna HTTP 200, `available: false` e `deployment: null`; configuração inválida retorna 503.

O caminho público correto é um fetch same-origin de **`https://domino.money`**, sem query string. Abrir o endpoint diretamente na barra de endereço, usar `workers.dev` ou preview não equivale a esse fluxo: existem verificações de origem e metadata do fetch. O gate beta do Pages continua independente. A leitura do perfil público não precisa autenticar uma carteira.

### 4.4 Reutilizar as telas e o SDK

| Área | Código existente |
| --- | --- |
| Carteira EIP-1193 e identidade/nonce | [`finance/wallet.ts`](../app/src/finance/wallet.ts) |
| Setup, rota `#/setup` | [`AdvancedSetup.tsx`](../app/src/screens/AdvancedSetup.tsx), [`setup.ts`](../app/src/finance/setup.ts) |
| Sequences, rota `#/sequence` | [`Sequence.tsx`](../app/src/screens/Sequence.tsx), [`sequence.ts`](../app/src/finance/sequence.ts) |
| Performance | [`Performance.tsx`](../app/src/screens/Performance.tsx), [`performance.ts`](../app/src/finance/performance.ts) |

Conectar com `setupWallet()`, validar o perfil e criar `createSetupClient(...)` ou `createSequenceClient(...)`. Manter o callback que relê a admissão antes de novas ações; as telas atuais mostram a composição correta. Cada ação segue preparação/simulação → revisão explícita → `send(prepared, true)` → acompanhamento do recibo → releitura do estado.

Os valores raw são inteiros em strings/`bigint`; não usar `Number` para saldo, quantidade ou wei. Buscar decimals comprovados; moeda é identificada por rede + endereço, não por símbolo. O SDK usa o RPC da carteira para conferir contratos e simular as chamadas do owner. O RPC próprio permanece na infraestrutura privada de leitura/execução; não expor sua URL ou credenciais no bundle.

## 5. Fluxos do owner

### Setup: criar posição com os contratos reais

1. `fund(poolKey, amount0, amount1, gasBudget)` pode retornar primeiro `approve(setup, 0)` quando necessário, depois aprovação ERC20 exata e só então `open`. Confirmar cada recibo e preparar novamente; uma chamada de `fund` não garante que o funding já ocorreu.
2. Para moeda nativa, usar a convenção `zeroAddress` e `msg.value` exato. Respeitar ordenação das moedas, tick spacing, range e `hooks == zeroAddress`.
3. `swap(...)` permite um swap assistido por operação, cobra 65 bps sobre input bruto e exige limites/quote/simulação atuais.
4. `mint(...)` recebe range, liquidez, caps e limites de preço. `initialSqrtPriceX96 = 0` usa pool existente; valor não zero inicializa e fornece a primeira liquidez atomicamente. NFT e sobras seguem para o owner.
5. `cancel` retorna os saldos atuais, sem desfazer um swap anterior. `recover` permite recuperação por moeda; a primeira recuperação impede definitivamente novo swap/mint nessa operação. Não cobrar tarifa Domino de saída.

Mostrar separadamente tarifa Domino, fee da pool, impacto de preço e custo de rede. Slippage de Setup (10–500 bps, padrão 50) é diferente da banda imutável de 50 bps do PriceGuard.

### Sequences: aprovar o NFT e criar um vault

1. `inspectRoot(tokenId)` confere owner, pool/range e identidade, prevê o clone e compara com `factory.predictVault`.
2. `create(options, gas)` pode preparar primeiro a aprovação **individual do NFT para o clone previsto**. Não aprovar a implementação, a factory, o operator ou usar `setApprovalForAll` como atalho.
3. Após confirmação da aprovação, chamar `create` novamente para preparar `factory.createVault(params, ownerNonce)`. Esse nonce é próprio da factory por owner, distinto do nonce de transação da carteira.
4. A sequence nasce **pausada**, com consentimento explícito sobre fees ainda não coletadas. O root NFT permanece na carteira; o vault administra fees e posições filhas.
5. Usar `inspect`, `sequences`, `members` e `reserves` para leitura. `resume`, política/limites e restauração de operator são ações separadas. A API de recuperação inclui pausa, revogação de operator/root, retirada de NFT filho/fees e recuperação de moedas/posições.

O modo `compound` usa 200 bps e `maxPositions = 1`; `domino` usa 400 bps. Alterar política/limites incrementa a versão; `setPolicy` preserva o estado de pausa. A lista recente é limitada a oito sequences, e a leitura de membros a trinta sucessores por percurso; não apresentar a primeira página como histórico completo.

### Performance

Leituras dos NFTs não autorizam gasto. “Start tracking” envia `{vault, tokenIds}` para `/api/performance/v2/enroll` com sessão/CSRF e inicia cobertura histórica futura. Não inventar dados anteriores ao enrollment nem confundir tracking com início de compound. O bridge/collector de Performance precisa de configuração própria.

## 6. Regras financeiras que a UI deve preservar

| Regra | Valor aprovado |
| --- | --- |
| Auto-compound simples | **2%** / 200 bps |
| Domino compound | **4%** / 400 bps, por modo em todas as receitas |
| Base da tarifa da automação | Fees originais efetivamente consumidas, uma vez; nunca principal |
| Swaps internos da automação | Incluídos na tarifa 2%/4%; sem segunda tarifa Domino de swap |
| Swap assistido no Setup | **0,65%** / 65 bps; `tariffVersion = 1` |
| PriceGuard | **50 bps de sqrt(price)**, imutável; aproximadamente −0,9975%/+1,0025% no preço |
| Gas das ações do owner | Pago pela carteira do owner |
| Gas de operator/publisher | ETH abastecido manualmente pela empresa; sem venda/top-up automático |

Não há whitelist contratual de usuários, tokens ou pools. Isso não equivale a compatibilidade universal: hooks e transferências precisam cumprir os checks do contrato. Tokens com taxa de transferência podem ser incompatíveis em etapas de valor exato. A banda do PriceGuard não absorve imposto de token, slippage ou diferença de saldo; não alargá-la para ocultar tais efeitos.

## 7. Confirmação de carteira e tratamento de falhas

Preservar simulação, review atual, chain ID, vínculo de owner, teto de custo e journal de nonce entre abas/reloads. Timeout de RPC/carteira não prova falha da transação. Após hash retornado ou resultado ambíguo, reconciliar por hash/nonce/receipt e estado on-chain; **não reenviar automaticamente** e não limpar `localStorage` para contornar uma claim pendente.

Existe uma diferença concreta a tratar antes de promover a UX de sequences: [`sequence.ts`, método `receipt`](../app/src/finance/sequence.ts) ainda compara separadamente `gas`, `maxFeePerGas` e `maxPriorityFeePerGas` contra a revisão. A Rabby ajustou esses campos durante o deploy e o painel inicialmente bloqueou transações já bem-sucedidas. O verificador operacional do deploy foi corrigido para preservar a identidade exata e aceitar variações dentro do orçamento aprovado; **essa correção não foi automaticamente aplicada ao SDK do frontend**.

Qualificar esse caminho com a carteira suportada. Caso adote a mesma política de orçamento, manter exatos chain/type/from/to/nonce/value/calldata e validar custos máximos aprovados e recibos, sem desabilitar validações de identidade. Uma divergência de conferência deve aparecer separada de revert on-chain, com link do hash e sem botão de reenvio que duplique a ação. O SDK de Setup possui outro reconciliador; não presumir que os dois têm o mesmo comportamento.

Separar estados enviado, incluído, aguardando finalização, finalizado, revertido e órfão. O nó pode levar vários minutos para avançar `finalized`; não converter atraso em falha nem substituir silenciosamente esse tag por `latest`. Após reload, a leitura do estado continua disponível, embora o recibo de sequence dependa da revisão da sessão atual.

Erros úteis para diagnóstico: `deployment_not_pinned`, `deployment_identity_unpinned`, `deployment_code_changed`, `setup_admission_unavailable`, `sequence_admission_unavailable`, `sequence_release_expired`, `pending_wallet_transaction`, `wallet_identity_changed`, `gas_budget_exceeded` e `native_gas_reserve_insufficient`. A UI deve traduzi-los em mensagens claras em inglês. Perfil salvo e verificado pode sustentar recuperação com release indisponível/expirado; não autoriza novas aprovações ou ativações.

## 8. O que falta para o ciclo automático

O backend deve observar oportunidades, obter evidência qualificada, executar o planner econômico, publicar preço sob demanda, persistir o intent, acionar o signer/operator restrito e reconciliar os efeitos. As chamadas on-chain já existem: publisher → `PriceGuard.publish(observation)`; operator → `vault.execute(plan)`.

Isso não é um timer no navegador. Não colocar chaves operator/publisher no frontend nem pedir assinatura periódica ao owner para substituir o serviço. A especificação detalhada está em [`V4_AUTOMATION_CYCLE_POST_DEPLOY.md`](V4_AUTOMATION_CYCLE_POST_DEPLOY.md).

`EXECUTION_BRIDGE_ENABLED` e `PERFORMANCE_BRIDGE_ENABLED` são capacidades independentes. A existência de endereços reais não provisiona listeners privados, collectors, credenciais Access, evidência econômica ou signers. Exibir o estado operacional real e o motivo de indisponibilidade.

## 9. Entrega esperada da integração

1. Comitar os dois pins e usar os perfis publicados, mantendo as versões e hashes corretos.
2. Publicar/configurar o Worker e conferir os dois fetches same-origin pelo app, incluindo indisponibilidade e expiração.
3. Conectar Setup e Sequences aos SDKs existentes e corrigir a experiência de confirmação/recuperação da carteira descrita acima.
4. Mostrar criação pausada e disponibilidade operacional de forma explícita; preservar controles de saída/recuperação.
5. Validar os caminhos alterados com testes focados de frontend/bridge e a carteira suportada. Não refazer auditoria nem rebuild dos contratos congelados para essa tarefa. Testes de escrita devem usar ambiente descartável; conectar a carteira não é consentimento para uma operação financeira real.
6. Para publicar o app, seguir os comandos existentes `npm --prefix app run release:build`, `release:verify` e `deploy`, com sua configuração de produção. Não publicar dist de fixtures/wallet-test.
7. Registrar commit do frontend, configuração/capacidades efetivamente ativas e limitações restantes. Não chamar o compound de operacional enquanto o ciclo externo não estiver funcionando.

Referências adicionais: [fluxos owner e recuperação](OWNER_SETUP_AND_RECOVERY.md), [release financeiro](FINANCIAL_RELEASE.md), [política de preços](../PRICING_POLICY.md) e [política de reinvestimento](../REINVESTMENT_POLICY.md).
