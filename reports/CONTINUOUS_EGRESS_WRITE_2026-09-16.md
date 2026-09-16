# Continuous egress for the indexer role — 16 September 2026

## What changed and why

The continuous policy denies everything to the indexer identity
(`chain write` ended in `denied_write`), which was correct while the indexers had
no service of their own. The demand queue changed that: `domino-queue-worker`
and `domino-catalogue-follower` run as `domino-write` and must resolve the
provider name and open HTTPS to it.

Until today that egress existed only as two runtime `nft insert` rules I applied
by hand for validation. The policy file is applied with an explicit flush and
re-add (`add table` / `delete table` / `add table` at the top of
`/etc/domino/continuous-reads/policy.nft`), so those rules disappear on the next
apply — including a reboot. This record formalises them in the file itself.

## The fragment

Rendered by `scripts/staging/continuous_egress_write.py` from sanitized input
(loopback resolver, public provider addresses only):

```
add set inet domino_continuous_reads write_ipv4 { type ipv4_addr; elements = { 40.160.64.137, 40.160.64.146, 40.160.64.160 }; }
add rule inet domino_continuous_reads write oifname "lo" ip daddr 127.0.0.53 udp dport 53 counter accept comment "queue worker resolver"
add rule inet domino_continuous_reads write oifname "lo" ip daddr 127.0.0.53 tcp dport 53 counter accept comment "queue worker resolver"
add rule inet domino_continuous_reads write oifname != "lo" ip daddr @write_ipv4 tcp dport 443 counter accept comment "indexer provider egress"
```

The set is declared immediately before the `write` chain and the accepts are
added before the existing `denied_write` drop, which is what the chain needs to
keep its default-deny shape.

## How it was applied, and verified

1. `policy.nft` copied to `policy.nft.bak-20260916` (root-only, same directory).
2. The four lines inserted into the file.
3. `systemctl restart domino-continuous-egress.service` — the flush/re-add pair
   rebuilt the table from the file, and the rule packet counters restarted at
   zero, which is the evidence that the live chain now comes from the file and
   not from my earlier runtime inserts.
4. Observed afterwards: the chain lists the three rules then the drop; the
   provider rule had already counted 484 packets / 60,413 bytes accepted; the
   worker resolved `robinhood-mainnet.g.alchemy.com` and read head 64,475,991.
5. Nothing else moved: `domino-read`, `domino-gateway` and
   `domino-continuous-egress` stayed active, the table still has its nine deny
   counters, the `read` chain is byte-identical, and the local read API answered
   `200` on `/v1/capabilities` after the re-apply.

## Rollback

`cp /etc/domino/continuous-reads/policy.nft.bak-20260916
/etc/domino/continuous-reads/policy.nft` then `systemctl restart
domino-continuous-egress.service`. The indexer identity loses provider egress
again and the queue worker stops reaching the chain; the ledger keeps whatever
it already committed.

## What the owner of this baseline still has to do

- `scripts/staging/dev_infrastructure.py` records the production baseline as
  `manifestSha256: d11a98ff…`. That digest no longer describes the shipped
  policy file. The dev installer deliberately refuses to touch this table, so
  re-pinning belongs to whoever owns the continuous baseline.
- The provider addresses are pinned by measurement (Alchemy behind Cloudflare).
  If they rotate, the set must be re-rendered and the service re-applied; the
  renderer refuses anything that is not a public IPv4 address, and it never
  resolves names itself.
- A store-and-forward queue means the worker can survive a short provider
  outage; it does not survive a rotated address without the re-render above.
