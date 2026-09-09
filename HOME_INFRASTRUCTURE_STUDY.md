# Self-hosted infrastructure planning for Domino

9 September 2026. Planning reference, generalized for public documentation. No host qualification or provisioning is established by this document. It supplements the public-alpha architecture in [TECH_STACK.md](TECH_STACK.md). Keep the operator's hardware inventory and access details in private deployment records.

## Infrastructure roles

| Resource class | Proposed role |
|---|---|
| Restricted archival storage | Public-event and price archives, simulation outputs, database backups and restore exercises. Keep an independent offsite backup. Storage topology, available capacity and high-IOPS performance need verification. |
| Linux compute with local SSD storage | Development/staging, event indexing and replay, local PostgreSQL, historical strategy simulations, CI and load tests. These backend workloads primarily need CPU, RAM, SSD and RPC access. |
| Optional AI compute | Local inference, research and development assistance when a specific workload justifies it. A future educational assistant may explain independently computed position data. Financial calculations, policy checks and signing remain deterministic and isolated. |
| Local networking | Archive transfer, backups and batch-data exchange between machines. Local link speed does not establish external upload bandwidth, public latency or internet/power redundancy. |

Distributed inference needs compatible software; aggregate memory across multiple machines is not automatically a shared RAM space for arbitrary programs. Check CPU architecture, container compatibility, local storage and interconnect requirements per workload.

## Recommended division

Self-hosted infrastructure can support development, public-data archives, batch computation, replay, research and optionally a qualified chain node. The public interface/API, operational database, scheduled execution and isolated signing service retain the proposed cloud deployment. Loss of the self-hosted link should delay research/backfills rather than interrupt user operations. Self-hosted public observations must pass the same canonicality, completeness, freshness and price-quality checks before operational use.

Keep active PostgreSQL storage on an appropriate local SSD; use archival storage for recovery unless its measured topology supports a reviewed database deployment. Machines at the same site share power/ISP failure risks. Do not introduce competing self-hosted/cloud signers or independent automatic broadcasters for the same operator nonce stream.

## Optional Robinhood node

The [Robinhood full-node documentation](https://docs.robinhood.com/chain/run-a-full-node/) provides the provider's CPU, memory, storage and endpoint requirements. Recheck the current guidance and measure actual chain size, client architecture support, initial sync quotas and sustained I/O before provisioning. Archive nodes need substantially more capacity; a pruned full-node snapshot does not qualify arbitrary historical state calls. A node also needs Ethereum execution and beacon endpoints. An inventory entry or an unqualified disk is not evidence of sufficient capacity.

A qualified independent node could support RPC cross-checks and historical reads and reduce some provider demand. It does not reduce transaction gas, replace the application indexer or remove the network's sequencer/L1 dependencies. Compare provider savings against power, storage and maintenance before committing.

## Adoption sequence

1. Use qualified compute and restricted archival storage for historical-capital/price indexing and metrics work, after access and deployment details are arranged privately.
2. Measure CPU, memory, database growth, I/O and RPC consumption with representative pools and complete daily windows.
3. Decide whether locally attached NVMe expansion and a node are justified by those measurements.
4. Add AI workloads only when a specific feature or internal workflow has a measurable benefit.

Before sizing a deployment, privately record CPU architecture, storage/cache layout, accelerator requirements if any, UPS/runtime, external upload capacity and internet redundancy. This reference does not propose a hardware purchase or claim that a particular private inventory meets the requirements.
