# Auditoria independente — Domino V2

**Snapshot:** `v2-audit-2026-10-04`  
**Data:** 4 de outubro de 2026  
**Veredito:** **REQUEST_CHANGES — não aprovar o freeze para release como está.**

## 1. Resumo executivo

A identidade do freeze e a reprodutibilidade do bytecode foram confirmadas. A revisão manual cobriu os **52 arquivos Solidity** e os **seis arquivos da ferramenta de implantação** definidos no pacote. Foram executados os testes existentes, análise estática e verificações de reprodução do pacote, sem alterar os fontes congelados ou enviar transações a redes públicas.

O principal achado é **DV2-01 / RFZ-01, severidade média**: há uma lacuna na preservação de obrigações denominadas em um token intermediário de uma rota V3 quando esse token debita do remetente mais que o valor transferido. O comportamento não está abrangido pelo aceite específico para sweeps best-effort. A severidade é condicional à classe de token; não foi demonstrado impacto cruzado sobre outro ERC-20 independente, nem identificada a presença de tal ativo em um deployment público.

Há também pendências de **garantia do release e qualidade das evidências**, distintas de vulnerabilidades on-chain: falha no CI do commit congelado, roteiro de reprodução incompleto e falta de replay das campanhas históricas de mutação nas condições exatas alegadas. A aprovação de duas frentes de revisão, limitada às suas premissas, **não anula o achado no executor compartilhado**.

Este é um relatório de auditoria técnica assistida por IA. Não é certificação de ausência de falhas, auditoria formal nem aprovação de um deployment real.

## 2. Identidade e escopo

Identificadores comparados literalmente com os anexos:

- Repositório: `domino-money/domino`.
- Tag anotada: `v2-audit-2026-10-04`.
- Objeto da tag: `ca9aede4ab55de02db39d8714f60abf620515cfb`.
- Commit: `5e63d2dba9123fdc585f7f272b83532b491fbc51`.
- Árvore: `db8bfb4e57a043a94f7fe55bf02725cb65836b1c`.
- Manifesto: `contracts/release-artifacts-v2.json`.
- SHA-256 do manifesto: `4f607c2f0ee6c58f156453147fac19029f90b1437613ec3ad228242938436ebb`.
- `sourceTreeSha256`: `296008a420406c857706033149e39d17fba544061507ee9ad0ed06a199f75ad9`.

A identidade corresponde aos anexos. O texto do pacote dentro da tag difere do anexo no preenchimento das referências de freeze/CI; a diferença foi preservada, não normalizada silenciosamente. A contagem local encontrou **8.040 linhas**, enquanto o pacote declara 8.039; é uma discrepância documental de uma linha, não divergência de árvore.

### Escopo revisado

- Registry, anchor, route, fees, positions e matemática vendorizada.
- Zap V3/V4, vaults/factory/executors/swap module e auto-exit.
- Tipos, interfaces e interfaces externas mínimas.
- `scripts/v2/deploy.mjs`, `deploy-schema.mjs`, `deploy-manifest.schema.json`, `release-manifest.mjs`, `scripts/solc-compile.cjs` e `scripts/prepare-financial-release.mjs`.

Fora do veredito: backend/planner/signer/indexer, app, workers Cloudflare, API contracts como produto, V1 como produto, drafts Elysium-v3, custody de chaves e estado atual de deployments públicos. Artefatos V1 foram gerados apenas como dependência técnica do gate de tamanho usado pelo runner.

## 3. Método e separação de evidências

- Clone separado, checkout detached do commit, verificação de tag/árvore/hash e inventário tracked.
- Instalação pelas lockfiles, recompilação independente e confronto byte a byte com o manifesto e os artefatos Foundry.
- Revisão manual por três frentes de contratos; revisão central da ferramenta de implantação e consolidação das interações.
- Execução sequencial de todos os arquivos de suíte V2 versionados, incluindo adversarial e invariant.
- Slither com os 52 fontes e configuração de compilador congelada; triagem por ID de cada resultado.
- Amostra explícita de mutações dos batches existentes, com baseline, rejeição do mutante e baseline restaurada.
- Reprodução das instruções do anexo em outro checkout limpo e leitura dos logs reais do CI.

O achado DV2-01 foi corroborado pela inspeção do código, da evidência local já registrada e da igualdade dos 52 fontes do sandbox com o snapshot canônico. Não se apresenta isso como execução independente duplicada pelo coordenador. A entrega é defensiva: não inclui payloads operacionais, roteiro de exploração ou código de ataque.

Sandboxes de revisão reutilizaram dependências pinned do checkout por symlink, onde declarado; isso não é uma afirmação de hermeticidade integral. A reprodução fria do roteiro instalou suas próprias dependências pelas lockfiles. Binários externos vendorizados foram verificados/exercitados como fixtures, não auditados opcode por opcode.

## 4. Resultados executados

- **Build/manifesto:** os 12 contratos reproduzidos e os artefatos Foundry equivalentes; verificação inicial e final passaram.
- **Suítes Solidity originais:** 1.068 testes passaram, zero falhas, zero skips, em 76 contratos de teste e 67 arquivos de suíte. Inventário sem faltantes nem duplicados.
- **Adversarial/invariant:** 19 arquivos, 23 contratos de teste, 168 testes passaram. Esses 168 estão incluídos nos 1.068, não são adicionais.
- **Demais V2:** 48 arquivos, 900 testes passaram, também incluídos nos 1.068.
- **Ferramenta de implantação V2:** 53/53 passaram. Além disso, três replays separados do comando original do CI passaram, 53 por execução; replays não foram somados como testes únicos.
- **Helpers partilhados/runner:** 54 testes declarados, 53 passaram, 0 falhas e 1 skip. O skip é o teste opcional EVM de V1 condicionado a `DOMINO_TEST_EVM=1`; não foi executado nem contado como PASS.
- **ABI, fixtures/math vendorizada, higiene e gas baselines V2 e V2-audit:** passaram; os dois baselines registraram `Gas baseline: no regressions.`
- **Slither:** execução bem-sucedida, 102 detectores habilitados, 352 resultados. Triagem individual validada por ID: 147 falsos positivos, 205 aceitos/informacionais, zero alertas do scanner promovidos a vulnerabilidade e zero não triados. Isso não invalida DV2-01, identificado pela revisão manual.
- **Mutações selecionadas:** 12/12 detectadas; 11 suítes distintas de baseline restaurada passaram. Não equivale às campanhas históricas completas.
- **Pipeline de checks local:** 79 comandos concluíram com exit0. O roteiro frio foi uma execução separada e falhou conforme DV2-03; ele não foi ocultado pelo total do pipeline.

### Ambiente registrado

macOS 26.2 ARM64; Node `v25.5.0`; npm `11.8.0`; Forge `1.7.1` commit `4072e48705af9d93e3c0f6e29e93b5e9a40caed8`; solc-js `0.8.26+commit.8a97fa7a`; Slither `0.11.6`. Compilação: via-IR, 200 runs, Cancun, metadata bytecode hash `none`. Lockfiles e inventários resolvidos de dependências constam das evidências. O host local não é o ambiente Linux do CI; não se pressupõe equivalência de temporização.

## 5. Achados e pendências

### DV2-01 — MÉDIA — Preservação incompleta do backing em token intermediário V3

**Tipo:** segurança/contabilidade. **Estado:** aberto. **Origem:** RFZ-01 da revisão route/fees/zap.

**Referências:** `contracts/src/v2/route/DominoSwapExecutor.sol:166-184`, `:326-388`, `:425-435`; `contracts/src/v2/route/DominoAssistedSwap.sol:34-40`.

**Diagnóstico defensivo:** o conjunto de verificações de débito e backing não cobre uniformemente todos os tokens movimentados pelo caminho V3. Em particular, a proteção dos extremos da leg não equivale à proteção de uma obrigação preexistente em uma moeda intermediária. Um comportamento de débito adicional dessa moeda pode deixar uma obrigação sem cobertura apesar de a ação completar.

**Precondições relevantes:** rota V3 multi-hop; token intermediário com débito adicional do remetente; obrigação/saldo preexistente na mesma moeda. A presença dessas condições em uma implantação pública não foi avaliada.

**Impacto e limite:** quebra condicional de I2 e da leitura ampla de I5. A evidência registrada mostra obrigação nominal de `1000000000000000` e backing remanescente de `500000000000000` na mesma moeda. Não foi demonstrado débito de outro ERC-20 independente. O executor é compartilhado; a correção e a avaliação de impacto devem contemplar zap, vault e auto-exit, sem presumir que o mesmo cenário foi reproduzido de ponta a ponta em cada host.

**Relação com F-01/F-03/F-04:** os consertos documentados continuam presentes e suas regressões passam. Isso não fecha a classe inteira de débitos não convencionais em todos os pontos de pagamento. Não é double-entry e não é um sweep best-effort; portanto, o aceite registrado para esses casos não encerra automaticamente este achado.

**Correção recomendada:** aplicar a política de débito exato de modo consistente aos pagamentos de swap e preservar o backing de todas as moedas relevantes da operação. Adicionar testes de preservação de passivos nos hosts afetados, mantendo as regressões já existentes de output-tax/buy-tax. Se a decisão de produto for excluir essa classe de token, tornar a exclusão precisa e efetivamente verificável, com novo aceite explícito; o texto atual não basta.

**Critério de fechamento:** novo snapshot em que toda operação suportada preserva seus passivos ou reverte atomicamente, acompanhado de verificação independente do build e dos testes de regressão correspondentes. Nenhuma correção foi aplicada nesta auditoria.

### DV2-02 — BLOQUEIO DE RELEASE — CI do commit congelado não está verde

**Tipo:** evidência/integração, não vulnerabilidade financeira demonstrada.

PR319, run `37201444263`, passou na árvore idêntica. Porém o job Backend `111449829937` do run `37206891445`, sobre o próprio commit congelado, falhou na verificação offline da ferramenta CREATE3 V2: **53 testes, 50 passaram, 3 falharam**.

O primeiro erro observado foi `nonce too low` em `deploy-preflight.test.mjs`; testes subsequentes receberam `deployer_nonce_mismatch` onde esperavam outros bloqueios. Não foi atribuída causa definitiva a uma corrida apenas pela sequência dos erros.

O comando exato dos cinco arquivos de teste foi repetido localmente três vezes, sem alterar fontes: **53/53 em cada execução**. Um diagnóstico local limitado de restauração de snapshot também não reproduziu a falha. Isso delimita a observação: falha real remota, não reproduzida no ambiente local; não é conserto nem substituição do gate remoto.

**Ação recomendada:** resolver e explicar a falha, preservar o log e obter os gates requeridos no snapshot que efetivamente será liberado. Não marcar o run como success com base no PR anterior ou em um replay local.

**Estado consultado ao fechar:** run `37206891445`, tentativa `1`, `status=completed`, `conclusion=failure`, `head_sha=5e63d2dba9123fdc585f7f272b83532b491fbc51`; atualizado no GitHub em `2026-10-04T14:25:36Z`.

### DV2-03 — BAIXA — Roteiro do pacote não basta para iniciar o exemplo em checkout limpo

**Tipo:** reprodutibilidade/documentação. **Estado:** confirmado.

Executando instalação, build e comparação do manifesto conforme o anexo em um segundo checkout limpo, o build e o manifesto passaram. O comando de exemplo `AutoExitInvariants.t.sol` falhou em `setUp()` com `vm.getCode: no matching artifact found`: **zero testes de comportamento chegaram a executar**.

A matriz principal funcionou após gerar o artefato de integração usado pelo CI (`test/v2/integration/IntegrationArtifacts.sol`) e os artefatos auxiliares necessários pelo gate de tamanho do wrapper. O gate V1 é uma dependência adicional do runner, não uma falha do contrato V2.

**Ação recomendada:** publicar um bootstrap completo, testado em checkout limpo, com os builds auxiliares e a ordem correta. Os comandos reais dessa auditoria e os logs da tentativa fria acompanham o pacote de evidências.

### DV2-04 — BAIXA — Evidência histórica de mutações não foi integralmente reproduzida

**Tipo:** garantia/cobertura, não defeito de contrato demonstrado.

O pacote alega campanhas de 29/29, 18/18 e 5/5. Não foram localizados no inventário versionado inputs/resultados identificados inequivocamente como essas campanhas específicas. Os batches históricos disponíveis são outros conjuntos; no batch de vault, **oito substituições textuais não se aplicam ao freeze atual**.

Nesta auditoria, uma amostra declarada de **12 mutações aplicáveis** foi detectada, com baselines originais e restauradas passando. Ela é evidência real da eficácia de guardas selecionadas, **não replay de todas as campanhas alegadas** nem cobertura exaustiva da implementação.

**Ação recomendada:** anexar os inputs e resultados exatos das campanhas históricas, vinculados ao source hash, e atualizar ou retirar entradas stale. Mutação não aplicada, timeout e erro de compilação não podem contar como detecção.

### DV2-05 — INFORMATIVA — Endurecimento do transporte RPC

**Referências:** `scripts/v2/deploy.mjs:434-462`; comparação com o helper de leitura limitada em `scripts/prepare-financial-release.mjs`.

A leitura JSON de RPC não limita explicitamente o tamanho do corpo e não valida completamente a correlação do envelope da resposta com o pedido. Testes de transporte locais verificaram essas permissividades. A camada read-only recusou um método de escrita antes de qualquer chamada de rede.

Isso é recomendação de robustez e integridade de evidência, não prova de crash nem de bypass financeiro. Um RPC malicioso já controla as informações on-chain que fornece; validar o envelope não torna essa fonte confiável. Recomenda-se limite de bytes, validação de versão/ID e erros tipados, preservando os limites de tempo e de número de chamadas.

## 6. Modelo de confiança e riscos aceitos

As seguintes decisões permanecem explícitas; não foram contadas novamente como vulnerabilidades novas:

- **Operador global:** pode pausar vaults; owner retoma e dispõe das saídas autorizadas. Nonces, budgets, floors e tetos on-chain foram revisados. A confiança é limitada, não eliminada.
- **Publisher/epoch:** chave comprometida deve sair de ambos os papéis e nunca ser readmitida. Observações futuras exigem essa disciplina; elevar epoch sozinho não revoga material futuro para sempre.
- **Governance/guardian:** handover imediato, oferta sem expiração e ausência de veto exigem monitoramento. Separação de papéis e custódia independente da Safe são premissas operacionais, não consequências de compilar o contrato.
- **Âncora na borda:** a proteção é relativa à âncora admitida, não a um preço externo incontroverso; banda, fee de pool e slippage se acumulam conforme o desenho aceito.
- **Auto-exit:** moeda da fee depende do rank no momento da execução; o mandato não fixa esse rank. D-1 e D-2 estão presentes e suas suítes passaram.
- **Sweeps best-effort:** a exposição de um token com comportamento incompatível pode alcançar obrigações na mesma moeda. Não confundir progresso de saída com garantia universal de ERC-20 hostil.
- **Double-entry:** tokens cujos endereços compartilham um saldo econômico estão fora do modelo. A redação “somente fees” é estreita demais para auto-exit: créditos `unclaimed` nessa moeda também dependem de independência contábil por endereço. Essa ampliação conceitual foi identificada estaticamente; não é apresentada como exploração demonstrada de moeda suportada.
- **Rearm V3:** snapshots inicial/final não provam que todas as operações intermediárias foram adições monotônicas. A exceção já está aceita em F3. Seu bound não é um teto absoluto pequeno; a palavra “dust” não deve sugerir garantia quantitativa inexistente.
- **Gas de exitAll:** cresce com membros e comportamento dos tokens. O caminho alternativo de retirada por posição continua sendo parte necessária do runbook; não há certificado de capacidade para qualquer chain/configuração real.

## 7. Invariantes e consertos internos

- **I1/I2:** testes originais passaram sob seu modelo; DV2-01 impede uma afirmação universal de preservação de passivos para a classe de token identificada.
- **I3:** sem cobrança acima das regras confirmada no escopo revisado. A perda de backing de DV2-01 não é mudança da alíquota.
- **I4:** floors e âncora foram verificados, com os limites de confiança e de banda aceitos.
- **I5:** verificações dos extremos, allowances e efeitos existentes passam; a cobertura contábil ampla de moedas intermediárias exige correção de DV2-01.
- **I6:** owner-only, recipients e saídas foram revisados; nenhuma retirada não autorizada no modelo suportado foi confirmada.
- **I8/I9:** consentimento, domínio, nonces, validade, cruzamento, TWAP e banda presentes, com as premissas operacionais descritas.
- **I10:** custódia/checkpoints/subscription revisados; observar a exceção aceita de operatorRearm.
- **I12/I13:** nonce e regras da registry revisados e exercitados; handover e resposta a chave vazada continuam operacionais.
- **I15:** locks e autenticação de callbacks revisados; nenhum bypass foi confirmado.
- **I16:** conservação de créditos/fees no modelo suportado; não se estende a double-entry nem remove a necessidade de avaliar o executor compartilhado em DV2-01.

F-02 permaneceu efetivo para o runtime/configuração congelados. F-03 corrige shortfall de output, e F-04 protege os pagamentos exatos nos sites documentados; DV2-01 mostra que isso não equivale a cobertura completa de todo pagamento intermediário. D-1 limita TWAP a uma hora. D-2 desabilita o módulo em exitAll, sem revogar os mandatos que poderão voltar a valer após habilitação explícita.

## 8. O que não foi provado

- Ausência absoluta de bugs, prova formal ou execução simbólica.
- Reexecução integral das campanhas históricas específicas de mutação.
- Estado atual de chain, configuração real de Safe/governance, listagem de tokens ou qualidade econômica de liquidez/oráculos.
- Segurança integral dos runtimes Uniswap/Permit2/CreateX externos ou de cada opcode vendorizado.
- Segurança do backend, UI, signer, planner e operação de chaves.
- Presença de token afetado por DV2-01 em uma implantação pública.
- Causa definitiva da falha de CI não reproduzida localmente.

A auditoria cobre o escopo de fontes definido, mas essas limitações impedem chamar o resultado de certificação completa do sistema em produção.

## 9. Encaminhamento recomendado

1. Corrigir DV2-01 ou apresentar mudança explícita e verificável do contrato de suporte, com aceite de risco específico. Manter os demais achados e consertos no mesmo conjunto de critérios.
2. Corrigir o bootstrap do pacote e publicar a proveniência das campanhas históricas de mutação.
3. Resolver o CI do snapshot de release, sem substituir silenciosamente o resultado do commit congelado.
4. Esclarecer os limites aceitos de double-entry, rearm V3 e custos de saída.
5. Produzir novo commit/manifesto/tag e verificar o delta, a reprodução e os gates contra essa identidade nova. Não movimentar a tag auditada nem editar retroativamente o freeze recebido.

Nenhum desses passos foi implementado, publicado ou autorizado por esta auditoria.

## 10. Evidências e integridade final

Na verificação final de `2026-10-04T14:45:53.271068+00:00`, os **3353 arquivos tracked** continuavam com os mesmos hashes do inventário inicial. Nenhum arquivo tracked foi adicionado, removido ou alterado; `git status --porcelain` vazio. HEAD e árvore permaneceram os do freeze. A inspeção final não encontrou processo remanescente desta tarefa. Nenhuma correção de produto, push, tag, deploy ou transação pública foi efetuada.

A entrega acompanha JSON de findings, inventário de cobertura e arquivo de evidências com hashes por membro. O arquivo inclui resultados de regressões originais, identidades, logs de CI/reprodução e triagem estática. Não inclui árvores node_modules/venv, raciocínio interno dos revisores ou material operacional de exploração. O hash externo do arquivo é fornecido separadamente para evitar auto-referência.
