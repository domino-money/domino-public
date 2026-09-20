# Capacidade do Domino e do RPC local — 20/09/2026

Estudo solicitado para **10, 100 e 1.000 usuários simultâneos**. Uma aba visível por usuário, salvo indicação contrária. Escopo: leituras públicas, carteira, aquisição de dados e infraestrutura; execução financeira não foi ativada nem submetida a carga.

## Conclusão

**O nó tem margem de processamento no perfil medido; o caminho atual do app e a aquisição de dados ainda precisam de mudanças para produção.** O Nitro completou cerca de **299 itens RPC/s adicionais**, em lotes de oito, além dos consumidores existentes. O gateway completou **30 leituras persistidas/s** e apresentou a primeira recusa na etapa de 45/s. Na carteira, mesmo uma página a cada quatro segundos encontrou uma resposta de **7,9 s** associada a fallback por HTTP 503, bloqueando a seguinte.

| Cenário base | Leitura do estudo |
|---|---|
| **10 usuários** | Demanda pequena diante das medições, mas a disputa atual no nginx e a cota por IP impedem declarar a experiência já qualificada. Corrigir admissão e reserva de capacidade antes do lançamento. |
| **100 usuários** | Os ~18,5 POST/s cabem no patamar isolado observado de leitura persistida; falta qualificar a mistura com carteiras, atividade, rede pública e diversidade de tokens. Prioridade em software e aquisição, sem evidência de necessidade imediata de mais CPU/RAM. |
| **1.000 usuários** | Os ~185 POST/s e a lane provider excedem o desenho atual. O processamento bruto do nó mostrou uma ordem de grandeza compatível com o perfil base de RPC, mas isso não qualifica o produto. Exige cache compartilhado, concorrência controlada, aquisição ampliada e disponibilidade fora da residência. |

Os cenários são projeções condicionais, não números de usuários certificados. A distinção decisiva é entre muitos usuários consultando os mesmos dados persistidos e muitos mercados diferentes exigindo atualização.

O limite de 25 requisições/s é uma proteção configurada no nginx, **não o teto do computador**. Existem três problemas distintos: disputa dos processos por essa cota; concorrência e trabalho repetido no caminho HTTP/PostgreSQL; capacidade de manter muitos mercados diferentes atualizados. Aumentar apenas o nginx não resolve os três.

**Inventário de tokens da carteira continua exclusivamente na Alchemy**, conforme a decisão vigente. Os saldos e as outras leituras Robinhood usam o RPC local, com fallback. Ethereum/Beacon continuam como upstreams do nó. O estudo não alterou essas escolhas nem as configurações de produção.

## Evidência e limites da medição

O hardware, os limites e os agregados públicos foram lidos no host `clawber` e na VM. Os testes preservaram os coletores e usaram apenas operações de leitura, com chegada programada, concorrência limitada e interrupção ao encontrar erros, perda de agendamento ou latência fora da meta. Leituras públicas podem renovar a demanda normal das seis pools conhecidas; nenhum catálogo sintético foi inserido na produção.

Foram separados:

1. **Nitro direto no host:** localhost, sem nginx/Cloudflare; mistura de 60% chamadas de estado, 20% headers, 10% código e 10% logs dos últimos 100 blocos. Rotação determinística de 64 pools reais do catálogo. Isso amplia o conjunto anterior de uma pool, mas não equivale a estado frio, carteira diversificada ou varredura histórica. Não houve limpeza de cache.
2. **Reader real:** HTTP de loopback na VM, com PostgreSQL de produção e os gates existentes; 80% overview das seis pools, 10% busca persistida e 10% histórico persistido de um dia.
3. **Gateway isolado com reader real:** código e limites do gateway, verificação RSA real contra uma chave efêmera de teste, 1.000 identidades de IP simuladas apenas dentro do processo de teste. Nenhuma porta foi publicada e a autenticação de produção não foi modificada. Inclui os dois HTTP internos por leitura e o PostgreSQL; exclui Uvicorn do gateway, Cloudflare, rede externa, login e navegador.
4. **Carteira real:** inventário da carteira pública de fixture, com 20 candidatos, pela API na VM. Inclui Alchemy de inventário, RPC local, gates e eventual fallback. Não representa todas as carteiras nem todos os tipos de ERC20.

Uma requisição HTTP pode carregar vários itens JSON-RPC. Lotes economizam viagens de rede, mas não eliminam as operações. A latência por método dentro de um lote é a latência do envelope completo, e não uma medição interna da execução de cada item. [Especificação JSON-RPC](https://www.jsonrpc.org/specification#batch)

Nos benchmarks, percentis usam nearest rank e somente respostas bem-sucedidas; recusas, falhas e descartes são contados separadamente. Os percentis dos snapshots de infraestrutura e ticks dos coletores usam interpolação linear, incluindo `percentile_cont` no PostgreSQL. Amostras pequenas não qualificam percentis de cauda. Um teste curto aprovado demonstra o patamar observado, não disponibilidade contínua nem teto absoluto. O teste público anterior de 19/09 já havia concluído **uma hora a 20 HTTP/s, 72.000 requisições, zero erros, p95 23,45 ms**; seu conjunto era muito mais concentrado. Duas tentativas anteriores pararam por I/O/atraso de sincronização. Esses incidentes impedem inferir estabilidade de longa duração apenas pela CPU ociosa.

## Resultados dos testes

| Caminho | Maior etapa completa | Amostra nessa etapa | Latência bem-sucedida | Fronteira observada |
|---|---|---:|---|---|
| Nitro, chamadas individuais | 200 HTTP/itens/s por 45 s; entregues 199,82/s | 8.992 | p95 **0,452 ms**, p99 1,181 ms | Aos 300/s, parada preventiva após 17,13 s por três respostas lentas de logs em sequência; zero erros RPC |
| Nitro, lotes de oito | 37,5 HTTP/s = 300 itens/s por 45 s; entregues **298,84 itens/s** | 1.681 lotes / 13.448 itens | p95 **1,857 ms por lote**, p99 4,810 ms | Última etapa planejada de lotes; não foi encontrado teto físico |
| Reader + PostgreSQL | **45 POST/s por 30 s** | 1.350 | p95 **19,263 ms**, p99 20,878 ms | Aos 65/s, parada após 21,79 s por respostas lentas em sequência; zero erros HTTP nessa etapa |
| Gateway isolado + reader + PostgreSQL | **30 POST/s por 60 s** | 1.800 | p95 **28,348 ms**, p99 29,934 ms | Aos 45/s: 72 sucessos e uma recusa HTTP 429 em 1,71 s; gate stored não admitiu a requisição |
| Carteira pela API real | Não completou a primeira etapa de 0,25 página/s | Cinco sucessos e uma recusa | Mediana **1,664 s**, máximo **7,905 s** | A resposta longa ocupou a única vaga provider; a próxima recebeu HTTP 429. Não foram executadas as etapas de 0,5 e 1 página/s |

As duas curvas diretas executaram **56.956 itens RPC**, todos com resposta validada, sem erro do nó. No patamar scalar de 200/s houve oito descartes do gerador em 9.000 agendamentos; no lote de 300 itens/s, sete em 1.688. Essas perdas pequenas são incluídas na taxa efetivamente entregue, não contadas como sucessos.

A regra preventiva do harness também interrompe após três respostas consecutivas acima de 100 ms, mesmo quando o p95 global continua baixo. Na etapa scalar interrompida a 300/s, o p95 global foi 0,442 ms; os logs tiveram p99 de 67,268 ms e máximo de 234,378 ms. No reader a 65/s, o p95 global foi 28,453 ms e máximo 176,777 ms. **Essas interrupções não demonstram que 300 itens/s ou 65 POST/s sejam o teto do servidor.** Tampouco a recusa breve do gateway estabelece um teto universal de 45/s: ela demonstra a insuficiência da admissão naquele ensaio.

Durante as curvas do nó, CPU total do host chegou a **11,31%** e a memória disponível não caiu abaixo de **53,64 GiB**. A comparação não simultânea com o RPC de referência mostrou até cinco blocos de diferença, aproximadamente meio segundo; terminou sem atraso. Nenhum limite de saúde foi acionado. O nginx continuou tendo recusas de fundo já existentes, portanto “zero erros” acima refere-se exclusivamente às chamadas diretas do gerador.

A primeira tentativa do reader teve `BrokenPipeError` em uma conexão ociosa reutilizada, aos 45/s. O harness passou a descartar conexões ociosas por mais de quatro segundos, sem repetir requisições incertas. A nova etapa de 45/s completou 1.350 respostas com sucesso. Essa primeira interrupção foi tratada como problema de conexão do experimento, não como capacidade do reader. O gateway usou sua própria implementação HTTP e não depende dessa correção.

A curva de carteira oferece a evidência prática mais urgente. As primeiras quatro respostas levaram 1,602 / 1,678 / 1,664 / 1,577 s. A quinta demorou 7,905 s; enquanto ela ainda executava, a sexta foi recusada. Às **21:15:14 UTC**, o reader registrou `rpc_failover ... reason=http_503`. Na janela de 27 segundos correspondente, o nginx registrou **770 HTTP, oito 503 sem upstream**, mantendo p95 de upstream em 3 ms. Isso associa o atraso à contenção/fallback no caminho de acesso, não à necessidade de comprar um processador mais rápido. Cinco respostas não permitem qualificar p95/p99 de carteira; por isso são apresentados mediana e máximo.

Cada resposta de carteira bem-sucedida teve 20 candidatos de inventário Alchemy, 21 saldos com `read_at_block` incluindo o nativo, e estado `page_received`. As páginas permaneceram completas para essa fixture. Não foi necessária qualquer alteração de configuração do serviço.

Resultados estruturados: [scalar](capacity-2026-09-20/node-scalar.json), [batch8](capacity-2026-09-20/node-batch8.json), [reader](capacity-2026-09-20/stored.json), [primeira tentativa do reader](capacity-2026-09-20/stored-initial.json), [gateway](capacity-2026-09-20/gateway.json), [carteira](capacity-2026-09-20/wallet.json), [correlação de fallback](capacity-2026-09-20/wallet-correlation.json), [estado final e recusas nginx](capacity-2026-09-20/postconditions.json).

## Demanda prevista para o lançamento

Home/Markets e PoolDetail consultam overview persistido aproximadamente a cada cinco segundos. A tabela e o ticker compartilham a consulta na mesma aba. A carteira não faz polling após uma resposta bem-sucedida: carrega ao abrir e ao pedir mais páginas. Abas ocultas suspendem o polling público.

Perfil base: 80% das abas em Home/Markets/PoolDetail, 10% em TokenExplorer pronto, 10% em outras telas; por usuário/minuto, uma busca por nome, 0,1 página de carteira, 0,1 token sem cache, 0,02 consultas de dois NFTs e 0,2 gráficos ativos. Assim, 0,1 página/min equivale a **uma página por dez usuário-minutos**, não uma página a cada segundo.

| Usuários simultâneos | POST ao app/s | Leituras persistidas/s | RPC local lógico/s adicional | HTTP ao RPC local/s adicional | Alchemy inventário/s |
|---:|---:|---:|---:|---:|---:|
| 10 | 1,85 | 1,82 | 1,77 | 0,46 | 0,033 |
| 100 | 18,53 | 18,17 | 17,73 | 4,57 | 0,333 |
| 1.000 | 185,33 | 181,67 | 177,33 | 45,67 | 3,333 |

Essas são **taxas oferecidas estimadas**, antes de recusas e backoff, e não benchmark de usuários reais. Nas colunas de RPC, somar a aquisição de fundo — incluindo a demanda por novas pools — e as tentativas de retry/fallback, medidas separadamente. Nas colunas de HTTP do app, somar boot e outras rotas; os coletores não fazem essas chamadas pelo navegador. O backend não consulta a cadeia a cada overview; a aquisição é compartilhada entre usuários que veem a mesma entidade. A distribuição 80/10/10 do benchmark stored é uma mistura de rotas HTTP, diferente da distribuição de telas do perfil de usuários.

Uma página de carteira cheia corresponde a aproximadamente **90 itens RPC locais em 17 HTTP**, mais duas chamadas Alchemy. Uma leitura de ERC20 sem cache custa 12 itens locais em sete HTTP. A operação opcional `pool-activity` está ativa; `pool-metrics` e `pool-positions` não estão anunciadas. Se cada usuário abrir uma PoolDetail a cada dez minutos, adicionar, para 1.000 usuários, aproximadamente **1,67 POST/s + 16,67 itens RPC/s + 8,33 HTTP RPC/s**, com ledger pronto. Ledger incompleto pode custar mais.

O perfil alto supõe 0,5 página de carteira e 0,5 token sem cache por usuário/minuto. Para 1.000 usuários, demanda **235 POST/s e 886,67 itens RPC locais/s adicionais**, antes de coletores e `pool-activity`. É um cenário de atividade intensa, não previsão de adoção. As nove combinações baixo/base/alto e todas as fórmulas estão no [modelo de demanda](capacity-2026-09-20/demand-model.md), com [dados calculáveis](capacity-2026-09-20/demand-model.json).

Um lançamento sincronizado acrescenta aproximadamente N GET de capabilities e N POST de overview, além de assets e autenticação. A média sustentada não cobre esse pico. Da mesma forma, três abas Home atrás do mesmo IP já podem ultrapassar a cota atual de 30/min, mesmo com a máquina ociosa. Não se deve simular mil usuários públicos a partir de um único IP e interpretar essa recusa como teto global.

## Atualização de tokens e histórico: outro limite

Snapshot às 20:47:28 UTC: **2.104 entidades de pool persistidas — 2.103 com observação e uma pendente**, 1.342 tokens prontos e aproximadamente 146,8 mil pools distintas no catálogo de eventos e hints. Presença no catálogo não equivale a snapshot atual, liquidez ou histórico pronto.

| Conjunto | Idade observada dos dados |
|---|---|
| Seis pools com demanda recente | p50 5,13 s; p95/máximo 6,63 s |
| 2.097 outras pools com observação | p50 585,63 s; p95 1.039,83 s; máximo 1.090,63 s |
| Tokens persistidos | p50 650,63 s; p95 1.227,53 s |

Em cinco minutos, o coletor corrente publicou 620 atualizações de pool e 310 de token em 155 ticks: **2,07 pools/s**, incluindo repetições, com 466 pools distintas. O tick mediano levou 1,379 s, o médio 1,732 s e o p95 3,893 s, além de 0,2 s entre ticks. Estavam vencidas e sem lease 1.953 pools e 1.031 tokens. A configuração de atualização em 120 s para pools sem demanda não é uma garantia quando existe essa fila.

| Pools distintas que precisam estar frescas | Atualizações/s para uma rodada a cada 5 s | Comparação com 2,07/s observados |
|---:|---:|---:|
| 6 | 1,2 | Escala atualmente observada nas pools mais acessadas |
| 100 | 20 | Aproximadamente 9,7× |
| 1.000 | 200 | Aproximadamente 97× |

Uma rodada de 1.000 pools levaria cerca de **484 segundos** se a vazão observada permanecesse constante e todas as publicações de pool fossem destinadas a esse conjunto, sem repetições. Essa vazão já inclui o tempo gasto nos dois tokens por tick; não é uma medição isolada do custo por pool. Isso não prevê o tempo exato da fila: prioridades do agendador, falhas e atualização repetida das pools mais acessadas alteram o tempo de atendimento.

Havia 450 jobs de histórico (449 de um dia e um de uma semana), 443 com conclusão anterior e sete nunca concluídos. Conclusão anterior não significa cobertura atual completa. Havia 448 jobs vencidos no instante observado. A lane de histórico executou 47 ticks em cinco minutos, consumindo 8.573 itens RPC lógicos; é trabalho diferente de atualizar uma cotação corrente.

Portanto, **mil usuários vendo seis pools** e **mil usuários pedindo mil pools distintas** são cenários muito diferentes. Para qualquer token já adquirido, o objetivo deve ser resposta persistida rápida, com idade e cobertura explícitas. Para um token ainda não adquirido, a API pode responder rapidamente com estado de aquisição, mas não pode prometer histórico completo instantâneo. O lançamento deve medir separadamente tempo da primeira resposta, tempo até dados úteis, cobertura e atraso da atualização.

## Limites existentes que precisam mudar

Antes da carga direta do estudo, os contadores globais mostraram **90,37 itens RPC/s no Nitro e 24,48 HTTP/s no nginx**, na janela de cinco minutos até 20:49:01 UTC. São totais existentes, sem atribuição exata por consumidor; não são a contagem exclusiva dos coletores. A margem média nominal até 25 HTTP/s era somente **0,52 HTTP/s**, e já havia recusas por rajadas. Logo, a cota não oferece reserva demonstrada para usuários, mesmo com CPU disponível. Esse número não deve ser dividido diretamente pelos POST do app: cada fluxo gera quantidades diferentes de HTTP e itens RPC.

- **RPC público:** 25 HTTP/s por IP, burst 50; o caminho atual faz os coletores disputarem a mesma cota. Após o espaçamento anterior ainda houve 10 recusas nginx em 1.493 requisições/59 s, sem atingir o Nitro. Recusas podem provocar fallback Alchemy mesmo com o nó saudável. O nginx conta a chave e a requisição HTTP, não o custo do lote. [NGINX limit_req](https://nginx.org/en/docs/http/ngx_http_limit_req_module.html)
- **Provider lane:** uma operação por vez, intervalo mínimo de aproximadamente um segundo. Só a carteira com duração próxima de 1,6 s limita a vazão ideal a cerca de 0,6 página/s, antes das demais leituras. O perfil base de 1.000 usuários oferece 3,67 operações/s nessa lane, sem `pool-activity`.
- **Stored lane:** quatro slots no reader/gateway, mas somente dois workers compartilhados no gateway; Uvicorn reader/gateway limitados a 8/16 conexões concorrentes, um processo cada. Carteira lenta também ocupa worker.
- **PostgreSQL:** 40 conexões máximas. Overview abre duas conexões novas por requisição; token overview pode abrir três. Há advisory lock global na admissão da demanda. O UPDATE é amortizado em 15 segundos, mas as chamadas e o lock continuam a cada POST.
- **Cache:** respostas públicas atuais são POST/no-store, sem cache compartilhado no edge. O cache da aba não une o trabalho de usuários distintos.
- **Saldo explícito:** o fluxo Create usa a sessão de inventário para conferir um token específico, podendo executar descoberta completa e cerca de 94 itens RPC locais. Uma consulta restrita ao token deve dispensar esse inventário adicional, preservando Alchemy na tela de inventário.

## Plano de ampliação, por prioridade

| Etapa | Mudanças propostas | Critério de aceite |
|---|---|---|
| 1 — eliminar contenção artificial | Caminho autenticado privado VM→RPC pelo host/rede interna; orçamento agregado por itens, HTTP e concorrência; reservas separadas para usuários, atualização corrente e histórico; registrar motivo real do fallback | Ausência de fallback causado por cota com nó saudável; aquisição de fundo e usuários têm progresso e orçamento próprios |
| 2 — preparar leitura para 100 usuários | Cache/coalescing de dados públicos por chave validada, geração e frescor; amortizar heartbeat de demanda; pool PostgreSQL limitado; workers separados stored/provider; revisão da cota por identidade/IP; consulta de saldo explícito sem inventário desnecessário | Perfil de 100 usuários, distribuição de IPs/entidades realista, sem recusas normais; stored público p95≤500 ms e carteira p95≤3 s |
| 3 — preparar leitura para 1.000 usuários | Réplicas da API de leitura ou serviços separados, admissão distribuída; cache compartilhado para consultas repetidas; atualização/assinatura compartilhada dos snapshots; verificar CPU de serialização/validação e rede | Perfil base de 1.000, pico de entrada e margem de 30–50%; percentis, frescor e fallback dentro do orçamento durante coexistência |
| 4 — ampliar entidades frescas | Atualizar pool state em lotes presos ao mesmo bloco, compartilhar provas e metadata verificada dentro desse snapshot, deduplicar demanda entre usuários e workers; particionar claims por pool/lease; atualização incremental por eventos; histórico com checkpoints e orçamento garantido | Qualificação separada para 6/100/1.000 entidades distintas; medir idade p95/p99, tempo de aquisição e cobertura; não mascarar atraso com timestamp de resposta |
| 5 — disponibilidade e armazenamento | Instância de leitura e dados replicados fora da residência; teste de falha do host/ISP; corrigir telemetria WAN; revisar ligação PCIe do SSD; retenção e crescimento acompanhados | API continua atendendo durante falha residencial; rollback/failover testados, restauração comprovada e horizonte de disco medido |

As metas acima são critérios propostos para implantação futura, não certificações emitidas por este estudo. Aumentar concorrência exige primeiro orçamento compartilhado: multiplicar processos com um limitador local por processo também multiplica o consumo autorizado. Elevar o limite público sem separar aquisição e usuários preservaria a causa da disputa.

Cache/coalescing deve abranger somente dados públicos apropriados. Saldo de carteira, sessão, respostas dependentes de identidade e cursores opacos ficam fora do cache compartilhado. Hash do bloco, geração, idade e cobertura devem ser preservados, inclusive na recuperação e no fallback. Um TTL de poucos segundos não substitui o coletor: serve para unir centenas de pedidos equivalentes.

Para mil usuários no perfil base, aproximadamente 160 overviews/s são polling dos 80% em telas rápidas. Se todos compartilham a mesma chave das seis pools, um cache de 2 s com coalescing compartilhado reduziria **esse componente**, idealmente, a aproximadamente 0,5 leituras/s da origem. O tráfego navegador→app continua existindo. Nesse caso favorável, o total à origem cairia de 185,33 para 25,83 POST/s, ou 27,50 POST/s incluindo o exemplo de pool-activity; não significa que a API atual suporte essa mistura, pois a provider lane continuaria recebendo 5,33 operações/s.

Usuários, entidades quentes e chaves de cache são grandezas diferentes. **1.000 usuários não implicam 1.000 pools, nem 400 pools quentes implicam uma única chave.** Com Q chaves distintas consultadas continuamente e TTL de 2 s, o limite ideal de renovações seria Q/2 por segundo, limitado também pela taxa de pedidos; 400 chaves não permitem prometer a redução de 160/s para 0,5/s. Uma chave pode reunir seis pools, e filtros/paginação podem criar outras chaves. Caches ou partições independentes também podem repetir misses. Cache não elimina buscas distintas, carteiras nem o trabalho de adquirir/atualizar entidades; o ganho depende da distribuição real e não foi medido. Metadata de contratos ERC20/proxies não deve ser tratada como imutável: reutilização entre blocos exige regra explícita de validade e invalidação.

### Configuração candidata para qualificar, sem promessa de capacidade

Para a primeira meta de 100 usuários, começar separando os workers stored/provider e fazer os quatro slots stored efetivamente disponíveis no gateway, preservando inicialmente o gate provider; o perfil base oferece 0,367 operações/s provider, ou 0,533/s incluindo a frequência de pool-activity do exemplo. Medir duração, fila e variância antes de aumentar esse gate. Introduzir um pool PostgreSQL pequeno, com teto **agregado** entre processos/réplicas; 8–16 conexões para a camada pública é um intervalo inicial de ensaio, condicionado às conexões já usadas pelas demais lanes, dentro das 40 totais. A quantidade de conexões, sozinha, não resolve o advisory lock global.

Para 1.000/base com a mesma frequência de pool-activity, o orçamento incremental é aproximadamente **194 itens RPC locais/s e 54 envelopes HTTP RPC/s**, além dos coletores e retries. Com reserva de 30–50%, dimensionar o orçamento total sobre a carga observada de fundo mais esse incremento, sem comparar itens RPC diretamente ao limite HTTP do nginx. A camada provider precisaria aceitar aproximadamente **7,6–10,7 operações/s** para manter 30–50% da capacidade livre sobre 5,33/s; concorrência candidata de 4–8 operações deve ser testada contra tempo de serviço e headroom, não simplesmente ativada. Réplicas devem compartilhar esse orçamento, e o cache favorável acima não substitui essa mudança. A decisão sobre CPU/RAM adicional depende dessa qualificação por lane e do conjunto de entidades; este estudo não estabelece que determinada compra suporte mil usuários.

## Hardware, disco, rede e continuidade

O host tem Ryzen 7 9800X3D, **8 núcleos/16 threads e 91,7 GiB utilizáveis de RAM**. Nitro ocupava aproximadamente 29 GiB; havia 53,8 GiB disponíveis. A VM possui quatro vCPU e 7,76 GiB de RAM. No baseline de cinco minutos, CPU total do host foi 3,79%, iowait 0,21% e disco ocupado 2,70%. Docker 100% de CPU corresponde a um núcleo; não confundir uma amostra percentual do container com toda a máquina.

O SSD do Nitro tem aproximadamente 647,5 GiB usados e 1.166,6 GiB livres. Continua operando em **PCIe 3.0 x1**, embora o controlador suporte x4. Há incidentes anteriores de pressão de I/O; revisar o slot/adaptador/lane na próxima manutenção é mais fundamentado do que comprar CPU ou RAM agora. O estudo não reconfigurou o dispositivo nem executou benchmark destrutivo de disco.

O uso do filesystem cresceu **5,945 GiB nas últimas 24 h** e **44,873 GiB nas 65 h disponíveis**. Não existem sete dias completos de série. Esses ritmos equivalem a aproximadamente 5,9–16,6 GiB/dia; com cerca de 713 GiB de margem até um limiar operacional de 25% livres sobre a soma de espaço usado e disponível do `df`, excluindo os blocos reservados do filesystem, a sensibilidade é de **43–120 dias**, caso os ritmos persistam. Isso não é previsão de esgotamento: catch-up, compactação, retenção e crescimento real precisam ser separados com 7–14 dias de observação. Planejar expansão com antecedência; não assumir que os 1,14 TiB livres resolvem meses de produção automaticamente.

A NIC física negocia 10 Gb/s, mas a capacidade nominal/máxima da operadora não foi medida. As séries atuais do node-exporter mostram a interface do container, não o tráfego WAN do host. Foi feita uma transferência privada limitada, descrita abaixo; ela não certifica o caminho público nem isola todos os limites da rede. Compressão HTTP efetiva, TLS e limites do plano Cloudflare precisam ser verificados no caminho público.

Transferência adicional de **32 MiB de dados sintéticos**, com SSH sem compressão/multiplexação e emissão limitada a 8 MiB/s: completou em **4,507 s**, incluindo estabelecimento da conexão, equivalente a **59,56 Mbit/s** no caminho host→Mac. Os IPs de saída pública eram distintos; isso, isoladamente, não comprova a topologia nem exclui VPN. A amostra prova somente essa entrega limitada entre esses pontos naquele momento. Não é teste de saturação do ISP ou de desempenho Cloudflare. [Resultado da transferência](capacity-2026-09-20/network.json)

Como sensibilidade, mantendo os aproximadamente **27.000 bytes por resposta** da mistura persistida testada, o perfil base demandaria cerca de **0,39 / 3,92 / 39,24 Mbit/s** em respostas stored para 10 / 100 / 1.000 usuários, antes de compressão. A mistura real tem outras proporções e páginas de até 24 pools; carteira, atividade, sincronização do nó, headers e demais tráfegos são adicionais. Portanto a transferência de 59,56 Mbit/s não certifica margem suficiente para mil usuários. Cache no edge pode reduzir a saída da residência, mas depende do hit rate medido.

Réplicas do conector Cloudflare no mesmo host não protegem contra falha do host ou do ISP. Da mesma forma, fallback Alchemy configurado dentro da VM não mantém a API acessível quando a VM perde a Internet. Para produção, é necessário um caminho de leitura fora desse domínio de falha. [Disponibilidade do Tunnel](https://developers.cloudflare.com/tunnel/configuration/)

Estado histórico ausente é uma questão de cobertura/archive, separada da vazão. Logs e headers antigos já funcionam localmente; algumas leituras antigas de estado usam fallback. Não migrar para archive apenas para corrigir 503 de admissão, nem dimensionar disco Robinhood copiando números de Arbitrum One. [Archive Nitro](https://docs.arbitrum.io/run-arbitrum-node/more-types/run-archive-node)

## Qualificação que falta antes de produção

Depois das alterações, executar uma campanha autenticada de ponta a ponta com IPs/identidades representativos, cenários baixo/base/alto e diversidade de entidades. Manter coletores, atualização corrente, histórico e fallback ativos. Incluir pelo menos uma janela prolongada que atravesse compactação/ingestão; a recomendação é qualificar 24 horas no alvo de lançamento, além dos testes curtos de pico e recuperação.

Medir: pedidos oferecidos/aceitos/recusados; latência p50/p95/p99 por rota; itens RPC e HTTP por método/lane; fallback por motivo; head lag; idade dos snapshots; filas e cobertura histórica; CPU/RSS/I/O/PSI; pool/locks/conexões PostgreSQL; bytes WAN e cache hit. Reserva de 30–50% deve incidir sobre os gargalos observados, não sobre uma regra genérica de usuários por servidor.

Não foram medidos WebSocket de mil clientes, transações/execução financeira, custo monetário do plano Alchemy/Cloudflare, failover completo do ISP, estado frio de mil pools ou capacidade máxima destrutiva de hardware. Inventário Alchemy do perfil base corresponde a 2 / 20 / 200 chamadas por minuto para 10 / 100 / 1.000 usuários simultâneos; o custo depende da duração real da simultaneidade, métodos e plano, não apenas do pico de usuários.

## Artefatos reproduzíveis

- [Infraestrutura, PostgreSQL e aquisição](capacity-2026-09-20/infrastructure.md), [JSON](capacity-2026-09-20/infrastructure.json).
- [Modelo de demanda](capacity-2026-09-20/demand-model.md), [JSON](capacity-2026-09-20/demand-model.json).
- [Harness de loopback](../scripts/benchmark-capacity.py), [gateway isolado](../scripts/benchmark-capacity-gateway.py).
- [Implantação local-first e evidência anterior de contenção](LOCAL_RPC_FIRST_2026-09-20.md).

Verificação: 27 testes offline do harness passaram, incluindo resposta JSON-RPC, agendamento sem rajadas, interrupção, deadline absoluto, limite de corpo, guard de saúde e conexão ociosa. O gateway teve sete verificações herméticas com sockets bloqueados, além dos testes reais descritos; a assinatura inválida retornou 403 na fixture. O helper de transferência teve a sintaxe local/remota revisada e executou a amostra limitada com sucesso. Não foi necessário repetir os testes da aplicação, pois seu código e configuração não mudaram.

Reader, gateway, desenvolvimento e os três coletores estavam ativos após o trabalho. Reader retornou `ok`, sem vaga ocupada; Nitro estava sincronizado, túnel pronto e sem atraso na comparação final com a referência. Todos os processos de carga terminaram; nenhum monitor recorrente ou mudança de capacidade foi instalado. O estudo registra limites e uma proposta de ampliação, não um deploy dessa proposta.
