# Domino V2 — re-auditoria da remediação

**Veredito consolidado: REQUEST_CHANGES.**

**A correção contratual de DV2-01 foi aceita no escopo revisado.** Não foi identificado novo defeito bloqueador de contrato no delta. O veredito não significa que a falha média original permanece: resta a pendência **baixa/documental de proveniência histórica em DV2-04**, além do estado do gate de CI explicitado abaixo.

- Commit: `559c509ff71d71e49ac720bd6acd8a9783531ebb`.
- Árvore: `e5ed5db6404ae9d5464028690f788ea3a217ebbd`.
- Manifesto SHA-256: `2975c377c6f3690a702fddeecfe4ffb2c4ccab6e52c8739f4877ce458f66ed5c`.
- Source tree SHA-256: `7a78b034fc09c924140173748b5a620cebd539d9635690adbda1154c0b95edfe`.
- Pacote recebido SHA-256: `dc5d29a38bec0b13a33a1919977c5a80ad2beca453756a3a85cd25eae56cbdea`.
- Consulta final: **2026-10-04T15:47:44.725618-03:00** (`2026-10-04T18:47:44.725618+00:00`).
- CI do main, run `37223288312`: **completed / success**, no SHA acima.
- Tag `v2-audit-2026-10-04.2`: **não encontrada na consulta remota; não criada por esta auditoria**.

## 1. Escopo e natureza desta entrega

Esta é uma re-auditoria direcionada de DV2-01 a DV2-05 e dos limites documentais solicitados. Não é uma repetição integral da auditoria anterior. Foram revisados os deltas de contratos, ferramenta RPC, testes de isolamento, bootstrap, runner/batches/relatórios de mutação e documentação; foram executados os testes existentes do candidato corrigido.

A revisão manual foi dividida em três frentes independentes de execução de testes: contrato, tooling e proveniência. Seus pareceres estáticos estão anexos. Os condicionantes dinâmicos desses pareceres são resolvidos por este relatório consolidado e pelos logs do processo principal. Não houve alteração de fontes canônicos, transação pública, corte/movimentação de tag ou escrita no GitHub. Não foram geradas provas de exploração nem executadas campanhas removendo proteções nesta re-auditoria.

Não atribuímos ao candidato as 1.068 execuções Solidity nem os 352 resultados Slither da auditoria anterior. A evidência runtime nova é a enumerada na seção 3.

## 2. Resultado por achado

### DV2-01 — MÉDIA — FECHADO / CORRIGIDO

A nova enumeração em `contracts/src/v2/route/DominoSwapExecutor.sol:425-464` inclui os intermediários de cada caminho V3 estruturalmente válido. O conjunto é capturado antes das pernas e comparado após cada uma (`:133-153`); `_checkEffect` exige saldo inalterado para tokens que não sejam entrada/saída (`:411-422`). Capacidade, deduplicação e índices foram revisados dentro dos limites existentes de hops.

As regressões fornecidas passaram no candidato exato: rota V3, zap, vault e auto-exit. Suas asserções verificam `SwapEffectMismatch`, backing/passivos e rollback, não apenas qualquer revert. Referências: `contracts/test/v2/route/DominoSwapExecutorV3.t.sol:264-308`, `adversarial/HopTokenBacking.t.sol:200-210`, `adversarial/HostileOperator.t.sol:200-227` e `adversarial/AutoExitAttacks.t.sol:755-783`, sob `contracts/test/v2/`.

O fechamento se limita à falha original observável por saldo. Tokens com `balanceOf` mentiroso, double-entry e os sweeps best-effort aceitos não se tornam suportados por essa correção.

### DV2-02 — GATE DE RELEASE — FECHADO / CI DO CANDIDATO APROVADO

A correção de isolamento está presente em `scripts/v2/deploy-preflight.test.mjs:33-39,164-195`: a transação pendente é retirada antes de reabilitar automine, e o isolamento faz limpeza antes do revert. A nova regressão passou; o comando de tooling passou **54/54** localmente.

O diagnóstico de contaminação do nonce é fortemente corroborado pela ordem dos testes, código anterior e log da falha. Não afirmamos ter observado a txpool no instante do run remoto original nem reproduzido a corrida por remoção da correção.

O run completo de main passou no SHA exato, attempt 1, com 14 jobs concluídos em success. Assim, o gate original de DV2-02 está fechado. A tag ainda não estava publicada na consulta final; sua ausência não foi contada como um novo defeito de código.

O PR #323 passou no mesmo tree, confirmado por API, mas esse resultado não substitui o run de main no commit candidato. O run anterior `37206891445` permanece corretamente registrado: attempt 1 `failure`; attempt 2 `success`, posterior. A reexecução antiga não apaga o resultado da auditoria anterior.

### DV2-03 — BAIXA — FECHADO / CORRIGIDO

`sh scripts/v2/audit-bootstrap.sh` foi executado em clone novo, sem `node_modules`, `app/node_modules`, `contracts/out` ou `contracts/cache`. Instalou as dependências, gerou os pré-requisitos V1/V2/integração e concluiu:

> contracts/release-artifacts-v2.json matches: 52 sources, 12 contracts, and the Foundry artifacts are the same contracts.

A mensagem final foi `V2 audit build ready`. Em seguida, o exemplo anteriormente inviável, `AutoExitInvariants.t.sol`, executou **10 testes e todos passaram**, sem falha em `setUp`. Fonte: `scripts/v2/audit-bootstrap.sh:18-38`. Evidências: `checks/cold-precondition.json`, `checks/01-cold-bootstrap.log` e `checks/suite-00-AutoExitInvariants.t.log`.

### DV2-04 — BAIXA — PARCIALMENTE CORRIGIDO; RESÍDUO HISTÓRICO ABERTO

**O que está corrigido/confirmado:**

- Os batches 29/18/5 agora estão versionados; o batch atual de auditoria contém as cinco entradas D-1/D-2 e cinco entradas DV2-01.
- As oito substituições stale de vault foram reescritas, e as duas guardas novas foram incluídas.
- Os quatro relatórios atuais conferem quanto a SHA do batch, fontes e suites, conjuntos completos de labels, seleção, rebuild e contagens: **29 + 18 + 10 + 10 = 67 linhas declaradas como CAUGHT**.
- Os testes do runner passaram dentro do grupo de 49 testes de ferramentas auxiliares. A revisão estática não encontrou fail-open que contabilize erro de compilação, sinal, saída incompleta ou edição não aplicada como detecção.

**O que não está comprovado:**

Os runs históricos exatos continuam sem vinculação contemporânea a um source hash. O próprio `reports/v2-audit-2026-10-04/remediation/mutation-history.json:3,9,238,447` declara scripts fora do repositório e working trees não hashados no momento da execução. A recomendação anterior pedia inputs/resultados históricos exatos vinculados à fonte (`reports/v2-audit-2026-10-04/AUDITORIA_DOMINO_V2.md:116-124`). Transcrição posterior mais reruns novos não autentica retroativamente aqueles runs.

Os JSONs atuais são consistentes, mas seus resultados `CAUGHT` são **execuções declaradas pelo autor**, não 67 mutações reexecutadas por esta re-auditoria. Seus hashes não devem ser apresentados como prova independente de execução; os 49 testes do runner também não equivalem a uma campanha Solidity.

**Pendência mínima para fechamento documental:** ou fornecer os registros contemporâneos que de fato existirem, sem reconstruí-los artificialmente; ou corrigir expressamente a alegação de remediação integral, classificar as campanhas antigas como históricas não verificáveis e registrar sua substituição por evidência nova vinculada ao candidato. Não exigimos recuperar hashes que nunca foram produzidos. Essa alternativa é documental/de assurance e não requer, por si só, alteração dos contratos. Até essa disposição explícita, não registramos DV2-04 como integralmente fechado.

**Não é uma nova vulnerabilidade financeira.** A correção de aplicabilidade atual permanece aceita; não a invalidamos por falta da prova histórica.

### DV2-05 — INFORMATIVA — FECHADO / CORRIGIDO

O limite de resposta é aplicado durante a leitura do stream, com teto padrão de 8 MiB (`scripts/v2/deploy.mjs:432-445`). A validação exige envelope JSON-RPC 2.0, ID correlacionado e exclusividade entre `result`/`error`; ID nulo só é aceito para erro (`:447-482`). O grupo de testes de implantação passou, incluindo os casos de envelope/tamanho já versionados.

O teste da borda usa um teto reduzido no mesmo leitor e verifica separadamente o valor default; não declaramos teste de uma resposta real de 8 MiB + 1. Os limites de retries, timeout e orçamento lógico permaneceram inalterados. Envelope válido não comprova a veracidade dos dados de um RPC.

## 3. Execução independente do candidato

- **Bootstrap frio:** passou.
- **Solidity:** 172 testes aprovados, zero falhas e zero skips, em 19 instâncias de suite provenientes de 16 arquivos.
- **Ferramenta de implantação:** 54 aprovados, zero falhas/skips/cancelados.
- **Runners e ferramentas auxiliares:** 49 aprovados, zero falhas/skips/cancelados.
- **ABI, fixtures vendorizadas e higiene:** passaram.
- **Manifesto recompilado e Foundry artifacts:** comparação byte a byte passou no bootstrap e na verificação final.
- **Fontes:** 3.369 arquivos rastreados comparados antes/depois, zero divergências, `git status` limpo.

O inventário exato de comandos, tempos, saídas e arquivos está em `checks/results.json`, `checks/expected-suites.json`, `checks/summary.json` e logs associados. Runtime: macOS arm64, Node v25.5.0, npm 11.8.0, Forge 1.7.1 e solc 0.8.26; versões/lockfiles em `environment.json`.

Esta execução não é um novo replay integral de todos os testes V2 ou de todas as mutações. Não foram repetidos Slither, execução simbólica, provas formais ou testes de fork público. Os valores históricos de capacidade/gas não receberam uma nova certificação de produção.

## 4. Integridade e escopo do delta

O ZIP recebido tem 91.767 bytes; seus 12 payloads listados em SHA256SUMS conferem, sem arquivos não listados além do próprio SHA256SUMS. Os anexos individuais coincidem com o ZIP. O patch de 33 arquivos coincide exatamente com o diff Git usando `--abbrev=8`; sua aplicação reversa em modo check também passou. A diferença inicial de headers `index` era só a abreviação padrão de sete versus oito caracteres, não divergência de conteúdo.

A tag anterior foi preservada: objeto `ca9aede4ab55de02db39d8714f60abf620515cfb`, commit `5e63d2dba9123fdc585f7f272b83532b491fbc51`. Os quatro arquivos entregues na auditoria anterior estão byte a byte intactos no repositório.

Confirmado por comparação e rebuild:

- Uma fonte Solidity alterada: `DominoSwapExecutor.sol`.
- Um release input alterado: `scripts/v2/deploy.mjs`.
- ABI, compilador e conjunto de componentes inalterados.
- AutoExit, VaultSwapModule, ZapV3 e ZapV4 crescem 212 bytes cada em creation e runtime.
- Os outros oito contratos mantêm os mesmos bytes.
- Maior runtime: ZapV3, 23.766 bytes, margem de 810 bytes ao limite usado no pacote.
- 52 fontes, 8.062 linhas, todas com newline final.

## 5. Limites documentais e observações não bloqueadoras

As clarificações solicitadas estão adequadas: B inclui créditos `unclaimed`; rearm V3 não é descrito como dust com teto absoluto pequeno; `exitAll` não tem certificado universal de capacidade e o runbook por posição está explícito; a contagem de linhas foi corrigida.

Observações de assurance não tratadas como novos bloqueadores:

- O teste de caminho longo não isola o último intermediário com endereço distinto; a fonte o enumera corretamente.
- Não há regressão DV2-01 direta de perna V3 hospedada por ZapV4, embora o mesmo executor/herança incorpore a correção e seus invariantes gerais tenham passado.
- O objeto JSON-RPC `error` poderia ter validação de schema mais estrita, mas formatos incompletos falham fechados como erro de método.
- Orçamento de RPC é lógico/de admissão; retries internos e chamadas já iniciadas não são um teto rígido de HTTP/wall-clock.

A ausência de implantação pública de V2 e o aceite do owner para limites estão registrados pelo pacote, não foram autenticados por inventário on-chain ou testemunho externo nesta revisão.

## 6. Próxima decisão

1. Manter DV2-01, DV2-03 e DV2-05 fechados para este SHA; não repetir esses consertos sem alteração do artefato.
2. Dar disposição explícita ao resíduo histórico de DV2-04 — prova contemporânea real ou substituição/aceite documental claro, sem alegar comprovação retroativa.
3. O CI do main está aprovado no SHA exato. Eventual tag anotada e freeze pós-tag ainda deverão preservar essa identidade; não há autorização implícita de implantação.
4. Tratar tag e autorização de implantação como decisões separadas. Esta auditoria não publicou nem autorizou transações.

Os pareceres estáticos anexos preservam seus desconhecidos na hora em que foram redigidos; este relatório é a reconciliação final. As evidências novas estão no ZIP de entrega, com manifesto interno e recibo externo sem hash circular.
