# Preparação do deploy V4 — Robinhood mainnet, 21/09/2026

**Estado: preparação concluída até os dados disponíveis; versão congelada não está pronta para envio.** A auditoria encontrou incompatibilidade real entre os blocos usados pelos contratos e os blocos da Robinhood. O relatório também reproduz um problema de recuperação no Setup. Nenhuma transação foi assinada ou enviada à mainnet.

## O que está conferido

- Rede: Robinhood Chain mainnet, chain ID **4663**; acesso de leitura ao RPC oficial confirmado.
- Fontes auditados: `ec2e9aaa4a6f2f87c93553166fb2795171cb2a94`; checkout do pacote: `7be7820efb2f261f49b688b1ad4e467b7f3725a2`.
- Sete artefatos recompilados: todos os tamanhos e hashes de runtime coincidem com o pacote original.
- 228 testes originais e 8 testes adicionais de auditoria passaram. Alguns testes adicionais reproduzem os problemas encontrados.
- Oito etapas de implantação e sua verificação passaram em uma rede local descartável; isso não é um deploy na mainnet.
- Arquivo de parâmetros preparado com campos pendentes explícitos: `public-deployment.template.json`. Ele é um modelo e será rejeitado pelo gerador enquanto contiver `null`.

## Carteiras e autonomia

| Papel | Poder | Separação |
| --- | --- | --- |
| Deployer | Implanta e vincula a implementação uma única vez; depois não administra cofres. | Pode coincidir com outro papel. Precisa ser compatível com o pacote CREATE por EOA. |
| Destinatário das taxas | Recebe taxas; não comanda cofres ou execução. Endereço imutável. | Diferente de operador, publicador e guardião. |
| Operador | Executa planos dentro das regras do cofre e pode pausar. | Diferente dos três papéis acima indicados; revogável pelo dono de cada cofre. |
| Publicador | Publica/revoga observações; sua indisponibilidade para a automação. | Diferente de operador, guardião e destinatário das taxas na preparação. |
| Guardião | Revoga observações e troca o publicador após aceitação. | Chave separada, fora da automação. Pode escolher um publicador que ele próprio controla. |

São suficientes quatro endereços se deployer e destinatário das taxas coincidirem. Cinco separam também implantação e tesouraria. As chaves de operador e publicador devem ter armazenamento e acesso separados; o guardião deve ficar fora desses serviços. O dono de cada cofre é um sexto papel, individual por usuário: controla retiradas, políticas, operador, pausa e retomada.

## Pendências concretas antes de gerar as transações reais

1. Corrigir a leitura/validação de blocos para a Robinhood Nitro, manter a autenticação por hash e produzir novo freeze com novos artefatos. Não basta o ensaio em Anvil.
2. Resolver a recuperação independente dos ativos no Setup para o escopo que admite tokens pausáveis/controlados por emissor.
3. Definir os cinco papéis acima com endereços públicos explícitos. Nenhuma chave privada é necessária para preparar as transações.
4. Definir a faixa de desvio do publicador (`priceGuardDeviationBps`, em preço raiz quadrada), tarifa de Setup (`setupFeeBps`, 0–65), versão e validade dos perfis. Nenhum valor de fixture foi adotado como decisão de produção.
5. Com os endereços e bytecodes finais, ler saldo e nonce pending/latest do deployer, conferir os códigos dos papéis, simular a sequência e escolher tetos de gas/custo e reserva. O preço de gas observado é apenas uma amostra; não é um orçamento aprovado.

## Ordem do pacote

| Nonce relativo | Etapa |
| ---: | --- |
| 0 | DominoVaultFactoryV4 |
| 1 | DominoVaultReadHelper |
| 2 | DominoRoutingHelperV4 |
| 3 | DominoPriceGuardV4 |
| 4 | DominoExecutionEngineV4 |
| 5 | DominoVaultV4, implementação dos clones |
| 6 | DominoSetup |
| 7 | `factory.finalizeImplementation(implementation)` |

Os endereços previstos dependem da carteira e do nonce inicial. Uma criação que falha consome nonce; não se deve deslocar a sequência preservando previsões antigas. O pacote de implantação não cria cofres de usuários, não dá aprovações de NFT e não ativa o operador.

## Ferramentas preparadas

`scripts/audit-v4-mainnet-preflight.mjs` faz apenas leituras e registra o domínio de blocos, dependências e papéis. Aceita RPC público ou um arquivo privado de endpoint. `scripts/prepare-financial-release.mjs` gera as oito transações sem assinatura quando todos os parâmetros e artefatos finais estiverem definidos. A ação `verify` confere recibos finalizados e contratos depois da implantação.

O preflight usa `--snapshot finalized` por padrão. Neste RPC público, o cabeçalho finalizado estava disponível, mas as leituras de seu estado falharam. A execução explícita com `--snapshot latest` conferiu os três códigos de dependências e os dois vínculos ao PoolManager, e confirmou a incompatibilidade de blocos. Os dois resultados estão preservados nos arquivos `mainnet-preflight.json` e `mainnet-preflight-latest.json`; a leitura atual não substitui a verificação finalizada posterior ao deploy. Os oito testes do novo verificador passaram.

O [relatório da auditoria](../V4_AUDIT_EXECUTION_2026-09-21.md) contém as evidências e os limites desta execução. O [procedimento original](../../docs/FINANCIAL_RELEASE.md) descreve preparação, assinatura pelo deployer, verificação e recuperação parcial.
