# Modelo de demanda por usuário — Domino, 20/09/2026

**Estimativa derivada do código, não benchmark.** A demanda principal de usuários ociosos está no backend HTTP/PostgreSQL: Home, Markets e PoolDetail consultam dados persistidos aproximadamente a cada cinco segundos. RPC cresce com abertura/paginação de carteiras, consultas por endereço, posições e diversidade das pools acompanhadas.

Código auditado: `03e1184094ae929985e57f6e0acfecdc094e64e3`. Os worktrees de implementação e de capacidade estão nesse mesmo commit. Esta análise não executou rede/RPC/load tests nem alterou implementação. O JSON irmão contém premissas, fórmulas, resultados sem arredondamento de apresentação e referências estruturadas.

## Comportamento real por tela

| Ação/tela | Demanda efetiva |
|---|---|
| Boot Home/Markets | Normalmente 1 GET capabilities V3 + 1 POST overview. Assets, login e manifestos de outros módulos são adicionais. |
| Home / Markets selecionados | Um overview para as seis pools; cerca de 11–12 POST/min enquanto visível. Ticker e tabela compartilham provider. |
| PoolDetail | Overview de uma pool a cada 5s; history cerca de 1/min; metrics/activity/positions uma vez por entrada se anunciadas. |
| TokenExplorer pronto | Overview de até 24 pools por página, cerca de 1/min. Paginação manual. |
| TokenExplorer em aquisição | Overview a cada 5s; 30s quando a aquisição foi recusada por capacidade. |
| Busca por nome | Um POST search por consulta estabilizada após debounce de 350ms; somente dados persistidos. |
| Consulta por endereço | Cache de metadata por aba até 5min; no miss, um POST token e RPC local. |
| Carteira | Primeira página ao montar com endereço; próximas páginas manuais, máximo 5. Sem polling após sucesso. |
| NFT positions | Somente ao pedir IDs ou abrir link com IDs; um POST para até 10 IDs e até 8 token reads adicionais, sujeitos ao cache. |
| Aba oculta | Polling público de overview/history pausa. Relógios de apresentação de 1s não fazem rede. |
| Carteira conectada | Conexão sozinha não cria RPC periódico pelo app. Sessão autenticada consulta me a cada 5min; renova após 20min se usada/visível. |
| Receipts de execução | Módulo separado: piso de 30s entre consultas, backoff até 300s se inalterado. Fora das tabelas públicas. |

As referências de linhas abaixo são do commit auditado:
- `app/src/lib/read/marketsProvider.ts:709` troca refresh configurado de 60s por 5s quando stored; jitter em :625 e visibilidade em :795. `app/src/App.tsx:161` mantém um provider e :184 limita ticker a Home.
- `app/src/components/read/screens/PoolWorkspace.tsx:174`: polling 5s; :206–208: rotas opcionais.
- `app/src/components/read/screens/StoredTokenExplorer.tsx:53`: 60s/5s/30s.
- `app/src/lib/read/historyRead.ts:38`: history 60s.
- `app/src/components/read/screens/TokenSearch.tsx:152`: debounce 350ms.
- `app/src/components/portfolio/PortfolioTokens.tsx:262`: montagem; `app/src/lib/read/screens/walletSession.ts:47`: cinco páginas.
- `app/src/lib/read/screens/positions.ts:231`: NFT e metadata.
- `app/src/session/controller.ts:99,:113`: refresh e sessão; `app/src/finance/execution.ts:14,:22`: receipts.
- `app/src/wallet/chain.ts:6–15`: não compila endpoint RPC no frontend.

## HTTP versus chamadas lógicas de RPC

Contagens de sucesso, sem retries/failover, com primário local v4 e ERC20 normais:

| Operação | POST app | RPC local lógico | HTTP para RPC local | Alchemy |
|---|---:|---:|---:|---:|
| Overview/search/history persistido | 1 | 0 imediato | 0 | 0 imediato |
| ERC20 token sem cache | 1 | 12 | 7 | 0 |
| Wallet com E ERC20 distintos válidos | 1 | 10 + 4E | 5 + 4 × ceil(E/8) | 2 |
| Wallet com 20 ERC20 | 1 | **90** | **17** | **2** |
| NFT com n IDs vivos, metadata em cache | 1 | 10 + 6n | 5 + 6n | 0 |
| NFT com 2 IDs vivos | 1 | 22 | 17 | 0 |

Inventário de carteira continua **exclusivamente Alchemy**, como autorizado: cada página faz eth_chainId + alchemy_getTokenBalances, maxCount 20. Depois os candidatos recebem saldos comprovados no RPC local. As dez chamadas base da carteira incluem verificação do failover, snapshot, saldo nativo e canonicalidade. Cada ERC20 acrescenta code/decimals/symbol/balanceOf, em lotes de oito. Páginas menores e contratos sem código custam menos; até dez tokens explícitos adicionais podem custar mais.

Fontes: `backend/inventory.py:49`, `backend/read_service.py:627,:704`, `backend/discovery.py:570`, `backend/rpc_failover.py:54`, `backend/nft_ownership.py:35,:66`.

Oportunidade futura: `app/src/components/create/WalletBalance.tsx:126` usa a sessão de inventário para conferir um token específico. `walletSession.ts:84` envia autoDiscover true; uma página cheia mais esse endereço pode custar 2 Alchemy + 94 RPC locais. A troca automática para tokens selecionados após lista vazia também reinicia discovery. Esta análise não mudou esse comportamento.

## Premissas dos perfis

Uma aba visível por usuário modelado. Composição comum: 80% Home/Markets/PoolDetail, 10% TokenExplorer pronto e 10% outras telas. Polling rápido arredondado para 12/min de forma conservadora; o período real inclui tempo de resposta e, no provider Home/Markets, jitter.

| Eventos por usuário/minuto | Baixo | Base | Alto |
|---|---:|---:|---:|
| Charts ativos por usuário | 0,1 | 0,2 | 0,3 |
| Buscas por nome | 0,1 | 1 | 3 |
| Páginas de carteira | 0,02 | 0,1 | 0,5 |
| Token reads sem cache | 0,02 | 0,1 | 0,5 |
| Consultas de 2 NFTs vivos | 0,005 | 0,02 | 0,1 |

O base corresponde a **uma página de carteira a cada dez usuário-minutos**, não uma consulta por segundo. W inclui abertura, paginação, remount e discovery extra. Cada página modelada possui 20 ERC20; metadata de NFT sem cache já está em A.

Variáveis: M = fração em polling rápido; T = fração em TokenExplorer pronto; C = charts ativos por usuário; S = buscas/min; W = páginas wallet/min; A = token reads sem cache/min; P = consultas de dois NFTs/min.

```text
Stored POST/min = 12M + T + C + S
Provider POST/min = W + A + P
App POST/min = Stored + Provider

Local RPC lógico/min = 90W + 12A + 22P
Local RPC HTTP/min = 17W + 7A + 17P
Alchemy inventory RPC/min = 2W

Demanda/s para N usuários = N × demanda/min / 60
RPC total = incremental + B_collectors + retries/failover
```

| Por usuário/minuto | Baixo | Base | Alto |
|---|---:|---:|---:|
| App POST | 9,945 | 11,12 | 14,10 |
| Somente stored | 9,90 | 10,90 | 13,00 |
| Provider lane | 0,045 | 0,22 | 1,10 |
| RPC local lógico incremental | 2,15 | 10,64 | 53,20 |
| RPC local HTTP incremental | 0,565 | 2,74 | 13,70 |
| Alchemy inventory | 0,04 | 0,20 | 1,00 |

## 10, 100 e 1000 usuários simultâneos

**Demanda oferecida, não throughput aceito nem capacidade medida.** 429/backoff podem reduzir envios às custas da experiência; não transformam sobrecarga em capacidade.

| Usuários | Perfil | App POST/s | Stored POST/s | RPC local lógico/s incremental | RPC local HTTP/s | Alchemy RPC/s |
|---:|---|---:|---:|---:|---:|---:|
| 10 | Baixo | 1,66 | 1,65 | 0,36 | 0,09 | 0,007 |
| 10 | Base | 1,85 | 1,82 | 1,77 | 0,46 | 0,033 |
| 10 | Alto | 2,35 | 2,17 | 8,87 | 2,28 | 0,167 |
| 100 | Baixo | 16,58 | 16,50 | 3,58 | 0,94 | 0,067 |
| 100 | Base | 18,53 | 18,17 | 17,73 | 4,57 | 0,333 |
| 100 | Alto | 23,50 | 21,67 | 88,67 | 22,83 | 1,667 |
| 1000 | Baixo | 165,75 | 165,00 | 35,83 | 9,42 | 0,667 |
| 1000 | Base | 185,33 | 181,67 | 177,33 | 45,67 | 3,333 |
| 1000 | Alto | 235,00 | 216,67 | 886,67 | 228,33 | 16,667 |

## Termos adicionais, mantidos separados

- Boot sincronizado: aproximadamente 2N requisições app iniciais, N capabilities + N overview. Assets e autenticação adicionais.
- Cada data POST aceito normalmente produz dois HTTP gateway→reader: health GET e operação POST (`backend/read_gateway.py:115,:144`).
- Se as três rotas opcionais PoolDetail estiverem anunciadas, D entradas/min e K posições NFT oficiais vivas por pool acrescentam 3D POST e aproximadamente (41+3K)D chamadas RPC/min, com ledger já indexado/reconciliado. metrics custa 10; activity 10; positions 21+3K. Live-window/unindexed pode abrir leitura de logs mais cara. Fontes: `backend/read_service.py:169,:395,:461`.
- Flags reais foram confirmadas separadamente pelo agente de infraestrutura em [infrastructure.md](infrastructure.md), através dos campos permitidos do ambiente do gateway: V1 token, pool-market, pools, catalogue, nft-positions, wallet-assets, pool-activity; V2 pool-market; V3 overview, history, search. O health do reader não publica enabledReads. Entre os três opcionais de PoolDetail, **somente pool-activity está ativo**: a carga adicional de produção é **D POST + 10D RPC lógicos + 5D envelopes HTTP locais por usuário/minuto**, quando indexado. Exemplo separado das tabelas: D = 0,1 entrada/min e 1000 usuários acrescenta 1,67 POST/s, 16,67 RPC lógicos/s e 8,33 envelopes HTTP/s. O caso hipotético de três opcionais acima não foi somado aos cenários.
- B_collectors depende de pools/tokens únicos ativos e cobertura histórica. Mil usuários vendo seis pools compartilham aquisição; mil pools diferentes não têm o mesmo custo ou garantia de frescor.
- Alchemy pode receber fallback histórico por estado podado mesmo com node online. 2W isola inventário, não esse termo.
- Sessão/receipts/transactions são workloads separados. Não inferir que todo usuário conectado faz transação ou chama wallet a cada segundo.

## Limites encontrados no código

1. **Provider lane global:** concorrência um e intervalo padrão 1s (tolerância 50ms). No perfil base, 10/100/1000 oferecem 0,037/0,367/3,667 operações/s nessa lane; 1000/base excede o desenho atual mesmo antes de medir node. Duração impõe limite adicional: soma de taxa × tempo médio de ocupação < 1. `backend/read_api.py:142`.

2. **Stored slots quatro, gateway com dois workers compartilhados:** `backend/read_gateway.py:80,:332`; reader `backend/read_api.py:320`. Para 185,33 POST/s, duas threads exigiriam ocupação média ≤10,8ms antes de reserva/variância. Uma carteira lenta ocupa uma thread. Uvicorn gateway 16, reader 8, ambos um processo (:378 e :564).

3. **Quota por IP, não usuário:** 30/min, burst cinco, IPv6 agregado /64; capacidade do mapa 10000. Três abas Home atrás do mesmo IP podem excedê-la. Um gerador público com um único IP mede primeiramente essa restrição, não capacidade global. Não falsificar headers públicos para contorná-la. `backend/bridge_state.py:41,:48,:52`.

4. **Não há cache compartilhado de resposta pública:** Worker/gateway usam POST e no-store. Frontend guarda metadata por 5min/256 tokens e overview por 2s/32 chaves, por aba; scheduler une somente requests idênticos em voo, fila 12, budget 30/min e espaçamento 1,1s. `publicMetadataCache.ts:10,:53`, `scheduler.ts:52,:77,:176`. Capabilities bem-sucedidas ficam no source por namespace, sem polling.

5. **Conexões PostgreSQL por método:** overview de pool IDs abre duas; token overview até três; `PgPublicData.connection` chama psycopg.connect sem pool (`backend/public_observations.py:49`). Demandas usam advisory lock global 46630240; UPDATE amortizado 15s, mas chamadas/locks por POST continuam (`backend/migrations/026_public_demand.sql:22,:43`). Infraestrutura confirmou **max_connections = 40**, compartilhadas com outros consumidores; isso não significa quarenta conexões disponíveis exclusivamente ao read API.

6. **Aquisição limitada:** até 1000 novas demandas explícitas pendentes. Collector tem até quatro pools/dois tokens e 256 chamadas por tick; próxima pool ativa em 5s, inativa em 120s. `backend/manage_public_data.py:30,:135`. Isso evita custo linear por viewer, mas não garante frescor de entidades ilimitadas.

7. **Cursores em memória:** gateway mantém até 2048 handles com duração até 300s e geração; restart invalida. Escala horizontal exige coordenação/roteamento, não duplicar processo sem avaliar contratos (`backend/bridge_state.py:95`).

8. **Fronteira de cookies:** read family recebe zero cookies de navegador no proxy Pages; Worker autentica a própria chamada ao gateway. Isso permite estudar cache público por chave validada sem misturar sessão/carteira, mas não torna o cache atual existente. `app/functions/_lib/bridge.ts:80,:158`.

## Prioridades para a próxima decisão

- Medir tempo de serviço e throughput aceito das lanes stored/provider separadamente, contabilizando collectors e quota por IP.
- Coalescer/cachear respostas públicas por request canônico, geração e idade verdadeira da observação; manter sessão/saldo/cursores fora do cache compartilhado.
- Amortizar heartbeat de demanda e avaliar pool de conexões PostgreSQL.
- Alinhar ou separar workers gateway para stored/provider preservando admissão limitada e budgets.
- Evitar discovery Alchemy quando a ação pede apenas saldo explícito, preservando o inventário intencional.
- Testar pools populares compartilhadas e tokens frios diversos como cargas distintas, com perfis de usuário e cardinalidade documentados.

Estes itens são conclusões de leitura, não mudanças implementadas. Os benchmarks do estudo devem ser anexados separadamente e não reclassificar estas estimativas como medições.
