# CI runners: Clawber pilot

The Clawber pilot compares selected offline CI workloads in a disposable Linux VM with the same commands on a GitHub-hosted runner. It is a manual experiment, not a migration of the existing CI workflows.

The runner implementation is **Clawber, x64**. Unrelated research workloads remain outside this architecture. Production RPC/backend machines, wallet runtimes and their credentials are outside the runner environment. Actual management hostnames and SSH identities stay in private operator configuration.

## Current scope

- Existing [CI](../.github/workflows/ci.yml) and [Position journeys](../.github/workflows/funding-ui.yml) continue to run on GitHub-hosted Ubuntu. Their triggers, per-main-commit execution, assertions and deployment boundaries are retained.
- The separate [Clawber CI pilot](../.github/workflows/clawber-ci-pilot.yml) accepts only a manual `workflow_dispatch` on `main`.
- Each pilot uses the exact dispatched `github.sha` for a GitHub-hosted control and a Clawber guest. A comparison of different commits is invalid.
- The initial workload is `read-worker`. Browser, contract and Backend choices are separate qualification steps; their presence in the workflow does not establish that they passed on Clawber.
- There is no automatic pull-request execution on Clawber, deployment, queue fallback, production activation or use of a real wallet/RPC key.

GitHub branch protection and the repository's [execution policy](EXECUTION_POLICY.md) are unchanged. The pilot adds evidence and does not turn a failed hosted check green.

## Guest and storage boundary

| Property | Pilot boundary |
| --- | --- |
| Host | Clawber x64 only |
| Guest | Disposable Ubuntu 24.04 x64 VM, one CI job per guest |
| Resource budget | 4 vCPU, 16 GiB RAM, 80 GiB writable disk capacity |
| Host storage root | `/mnt/narrative-ssd/domino-ci-pilot` |
| Base image and tools | [Pinned image inputs](../scripts/ci/image-lock.json); repository Node/Python pins and installed PostgreSQL 16 tools |
| Runner routing | `self-hosted`, `Linux`, `X64`, `domino-ci-pilot`, plus the exact run/attempt label `domino-ci-<run_id>-<run_attempt>` |
| Guest user | No job `sudo`, no host Docker socket or host filesystem mounts |
| Lifecycle | Fresh guest for one job; destroy its writable disk and runtime state afterward |

The storage root is reserved for pilot-owned images and guests. Provisioning and rollback must leave other host disks, VMs, services and workloads alone. A resource limit is a ceiling, not permission to consume the host's remaining capacity; start with one guest at a time.

The [network](../scripts/ci/libvirt/network.xml) and [filters](../scripts/ci/libvirt/filter.xml) block private, host, Tailnet, link-local and metadata IPv4 destinations, all IPv6 and unsolicited inbound access. Guest egress permits DNS through the dedicated resolver and public IPv4 TCP port 443 with established replies. These controls belong outside contributed job code.

This is a network-range/port boundary, not a DNS or destination-domain allowlist. Public production HTTPS front doors remain reachable as they would be for an ordinary unauthenticated public client. Private RPC/backend networks and sockets, host mounts and credentials remain unavailable. Do not describe this policy as blocking every production URL.

## Authorization and credentials

Runner labels select a machine; they do not authorize a commit. The operator-side [launcher](../scripts/ci/start-clawber-pilot.py) requires the authenticated GitHub actor to match both the run's original and triggering actor, with repository `write`, `maintain` or `admin` permission. It verifies the repository, manual pilot workflow, `main` ref, reviewed full SHA, selected workload, successful hosted admission job and exactly one matching queued guest job before requesting a just-in-time (JIT) runner.

GitHub requests use the operator's existing access on the operator's Mac, outside Clawber. Registration includes the workflow's exact run/attempt label so a different queued job cannot consume this guest. The launcher sends only the short-lived, single-job JIT configuration over SSH stdin to the host controller; it attempts to remove the registration in `finally`, including failed starts. The host controller validates the ephemeral input and VM boundary, not GitHub run authorization.

Do not place a long-lived GitHub token on Clawber, in an image, in cloud-init files, in process arguments, in the repository or in logs. Confirm that no pilot runner registration remains after completion or failure; a cleanup attempt is not a confirmed cleanup receipt.

The job receives a read-only GitHub token; checkout uses `persist-credentials: false`. No repository deployment secret, RPC credential, signing key, wallet configuration or production database belongs in the guest. JIT configuration remains secret even though it is short-lived.

## Workloads and comparison evidence

Both pools run [the same workload script](../scripts/ci/run-pilot-workload.sh):

```sh
bash scripts/ci/run-pilot-workload.sh read-worker prepare
bash scripts/ci/run-pilot-workload.sh read-worker run
```

The script is a workload runner, not a VM provisioner or GitHub authorization controller. Its phases are `prepare` and `run`.

| Choice | Work performed |
| --- | --- |
| `read-worker` | Current Read Worker checks; no dependency installation |
| `contracts-v1` | Non-V2 contract suites, one dependency closure at a time; size checks and deterministic gas baseline |
| `contracts-v2-audit` | V2 adversarial/invariant suites and required artifacts; size checks and gas baseline |
| `browser-finance-create` | Unit/app builds and financial creation browser tests |
| `backend` | Fixture compilation, schema/export checks, disposable PostgreSQL/EVM tests and unsigned release checks |

The hosted admission job resolves the repository's Node pin and, for Backend, Python pin to exact patch versions; both comparison pools use those versions. Browser runs install the Chromium version selected by the locked `playwright-core` package in both pools. Browser OS libraries and fonts are image prerequisites; the job does not install packages with `sudo`. Backend runs require PostgreSQL 16 at `/usr/lib/postgresql/16/bin`; [the test database helper](../backend/dev_postgres.py) creates a per-task cluster through a private Unix socket, with no database TCP listener. Redis is not a requirement of these workloads.

Each comparison records source SHA, pool, workload, OS/architecture, runtime versions, phase durations and exit status. The pilot keeps timing JSONL and failed browser pictures as Actions artifacts for seven days. It preserves a failing command's status; successful reporting is not successful validation.

Report cold and warm cache runs separately. Include guest provisioning time, queue time, job wall time, resource pressure and teardown evidence alongside the measured workload phases. Additional runner processes share a physical host's capacity; adding them does not create CPU or RAM.

## Cache behavior

The existing CI's explicit Forge and V2 deployment compilation keys now include OS and architecture alongside compiler/lockfile/source inputs. Architecture-ambiguous legacy fallbacks are removed. The first run under the new key can compile cold.

Backend Forge restore and save are separate. After successful fixture builds, fixture qualifications and the V1 release check, CI records source hashes and saves the completed compilation before later Python/PostgreSQL tests. A later test failure no longer discards that compilation. The cache proves reusable build inputs, never that Backend tests or the later V2 release checks passed.

[Source pruning](../scripts/forge-cache.mjs) still removes changed/deleted sources, their importers and stale artifacts. [Cache policy tests](../scripts/forge-cache.test.mjs) verify architecture-qualified keys/fallbacks and the qualification/save ordering. Contract suites and gas collection continue to execute separately; this pilot does not consolidate or remove either validation pass.

Pilot caches are additionally separated by pool and workload and have no fallback prefixes. Hosted control results and guest results must not reuse one another's artifacts. Dependency downloads and caches contain no credentials or wallet state.

## Qualification and rollout

1. Prepare and verify the pinned base image, isolation rules and resource limits; prove that cleanup removes only pilot-owned guest state.
2. Run `read-worker` in the disposable guest and then the paired Actions workflow. Verify both results at the same full SHA, network restrictions and complete teardown.
3. Qualify browser and contract choices separately, including cold/warm behavior and failure artifacts. Preserve all assertions, fixed compiler inputs, release manifests and per-suite Forge closures; a whole-tree compile has an existing solc-js memory constraint.
4. Qualify Backend with the installed PostgreSQL tools and disposable EVM/Unix-socket cleanup. Fix or reproduce known test failures independently of runner performance.
5. Consider trusted pull-request workloads only in a later change with explicit authorization policy, isolation evidence, capacity limits and hosted recovery. Broad migration is outside this pilot.

Native installer/systemd checks that require privileged disposable users remain hosted. The current guest profile does not make those jobs compatible with a no-`sudo` runner. Deployment and credentialed operational workflows remain separate.

Before comparing performance, record assertion failures, timeouts and service errors at the same SHA in both pools. Baseline main `b374421a` had [Backend and browser failures](https://github.com/domino-money/domino/actions/runs/41207082011) and a [Position journeys assertion failure](https://github.com/domino-money/domino/actions/runs/41207082085); a faster machine is not evidence that those defects were fixed. A smoke pass establishes only the workload and boundaries actually observed.

## Operation and recovery

The host requires an existing SSD mount, KVM/libvirt, `virsh`, `qemu-img`, `cloud-localds`, the libguestfs image tools, `systemd-run` and the dedicated bridge's DNS support. Host prerequisites and network/filter admission are explicit operator setup; the controller does not automatically install packages, define a network or restart host services.

Inspect existing filter/network names first. For **initial creation of new pilot names only**, define the child filter before its parent, then define and start the dedicated network:

```sh
sudo virsh --connect qemu:///system nwfilter-list
sudo virsh --connect qemu:///system net-list --all
sudo virsh --connect qemu:///system nwfilter-define scripts/ci/libvirt/filter-ipv4.xml
sudo virsh --connect qemu:///system nwfilter-define scripts/ci/libvirt/filter.xml
sudo virsh --connect qemu:///system net-define scripts/ci/libvirt/network.xml
sudo virsh --connect qemu:///system net-start domino-ci-pilot
```

If a named resource exists, inspect its `nwfilter-dumpxml` or `net-dumpxml` first and preserve its existing UUID. Do not blindly redefine an active resource using an initial-creation template. These commands do not enable network autostart and must never target another network or filter.

On 2 November 2026, host preparation added `dnsmasq-base` for the dedicated libvirt bridge and started only the `domino-ci-pilot` network, without enabling its autostart or restarting existing services/containers. This is a host-preparation receipt, not a guest or Actions test result. After a host restart, an operator must review and start the dedicated pilot network before admitting a guest.

Host preparation runs from a reviewed checkout, outside the job. [prepare-image.sh](../scripts/ci/prepare-image.sh) verifies the pinned Ubuntu, Node and runner downloads, prepares the OS/browser/PostgreSQL prerequisites, and records the prepared image digest. It refuses a missing SSD mount or an existing final base image; it does not overwrite a running image or register a runner.

```sh
sudo bash scripts/ci/prepare-image.sh
```

The prepared base is `/mnt/narrative-ssd/domino-ci-pilot/base/ubuntu-24.04-ci.qcow2`; its `.sha256` receipt is the input to the controller. This prepared-image digest is different from the original Ubuntu download digest in `image-lock.json`. The dedicated network and filters must already be installed and active under their pilot names.

Once the workflow is integrated on `main`, the operator can request the initial paired comparison:

```sh
gh workflow run clawber-ci-pilot.yml \
  --repo domino-money/domino --ref main -f workload=read-worker
gh run list --repo domino-money/domino \
  --workflow clawber-ci-pilot.yml --limit 5
gh run view "$DOMINO_PILOT_RUN_ID" --repo domino-money/domino \
  --json headSha,event,workflowName,status,conclusion,jobs
```

Set `DOMINO_PILOT_RUN_ID` to the intended run. On the operator's Mac, launch only the reviewed full SHA with the prepared-image digest and private SSH profile supplied outside the repository:

```sh
python3 scripts/ci/start-clawber-pilot.py \
  --run-id "$DOMINO_PILOT_RUN_ID" --sha "$DOMINO_PILOT_SOURCE_SHA" \
  --workload read-worker \
  --ssh-config "$DOMINO_CI_SSH_CONFIG" --ssh-host "$DOMINO_CI_SSH_HOST" \
  --base-sha256 "$DOMINO_CI_BASE_SHA256"
```

Set `DOMINO_PILOT_SOURCE_SHA` to the reviewed 40-character run SHA and `DOMINO_CI_BASE_SHA256` from the prepared-image receipt. The SSH profile must already pin the host key; actual SSH identities/configuration stay outside this document. The launcher refuses a different actor, ref, SHA, workflow, workload or queued label before creating a runner.

The reviewed [host controller](../scripts/ci/clawber_pilot.py) must be installed at `/mnt/narrative-ssd/domino-ci-pilot/source/clawber_pilot.py`. The launcher invokes it through fixed noninteractive `sudo`, passing the encoded JIT configuration only on stdin. Its default base image, network, filter and runner directory match this runbook; inspect `--help` before using an override directly. The privileged host controller manages virtualization; contributed job commands still run as the unprivileged guest user. Do not register a persistent runner or place a long-lived GitHub credential on the host to bypass the lifecycle.

Run one pilot comparison at a time. The host controller serializes guests and refuses a stale pilot domain for operator inspection. The launcher defaults to 15 minutes for Read Worker, 90 for contracts, 35 for the browser workload and 50 for Backend; `--timeout-seconds` can override these up to the controller's 90-minute ceiling. These lifetimes include startup and setup. Actions separately retains a five-minute Read Worker limit, 75-minute contract limit, 25-minute browser limit and 40-minute Backend limit.

If the Clawber job cannot start, the existing hosted CI still runs. GitHub does not transfer the queued guest job to a hosted pool. Inspect the already recorded hosted result or manually rerun the hosted job for the same SHA; do not silently compare against a newer `main` commit. Select the hosted job's `databaseId`, not an arbitrary number copied from a URL:

```sh
gh run view "$DOMINO_PILOT_RUN_ID" --repo domino-money/domino \
  --json jobs --jq '.jobs[] | select(.name | contains("github-hosted")) | {name,databaseId}'
gh run rerun "$DOMINO_PILOT_RUN_ID" --repo domino-money/domino \
  --job "$DOMINO_PILOT_HOSTED_JOB_ID"
```

Set `DOMINO_PILOT_HOSTED_JOB_ID` to that hosted job's ID. A hosted-only rerun is recovery evidence, not a completed paired comparison. A guest rerun needs a fresh JIT configuration with the new attempt label, and a comparison must retain matching source/runtime identities.

Rollback stops further manual pilot admission, unregisters any remaining pilot runner, destroys the pilot guest and its writable state, and leaves the existing hosted workflows active. The controller performs guest shutdown and host-side teardown; if it cannot confirm the domain is absent, it retains the job directory and returns an error for inspection. Its exit status describes the VM lifecycle; the Actions job remains the authority for test outcome.

Cleanup must be scoped to the pilot's recorded resource identifiers and storage root; never use a broad VM, bridge, firewall or disk deletion command. Retain a sanitized receipt showing what was removed and any cleanup that still needs attention. There is no general-purpose cleanup subcommand that deletes arbitrary host resources.

## Evidence status

Hosted CI's hygiene job automatically runs the new controller/launcher unit tests, pilot workflow guards and shell syntax checks without GitHub credentials or host access:

```sh
python3 -B -m unittest discover -s scripts/ci -p 'test_*.py' -v
node --test scripts/ci/pilot-workflow.test.mjs
bash -n scripts/ci/prepare-image.sh scripts/ci/run-pilot-workload.sh
```

Source changes and local script/policy checks are distinct from a guest run and from an Actions comparison. Record the actual source SHA, run URLs, pool outcomes and cleanup receipt when each step completes. Until then, additional workload choices remain unqualified; this document does not claim a complete CI migration or an infrastructure performance result.

### Host qualification receipt: 2 November 2026

The corrected prepared image booted successfully. Its SHA-256 is `9e87be9fcf557dd919f7abb2ac7b7ddf114438977a7cd94a1ad18791dbdaa118`.

The guest probe exited **0**: public GitHub HTTPS succeeded; sampled host-bridge SSH/RPC, metadata and Tailnet connections timed out; IPv6 was unreachable; the runner user was denied `sudo`. The observed tools were Node `24.22.2` and PostgreSQL `16.15`.

The probe helper lost its QEMU guest-agent shutdown reply as the guest stopped and returned nonzero. The host lifecycle controller separately reported `guest_stopped` with exit **0**; independent host inspection confirmed **zero pilot domains and zero pilot job directories** afterward. The earlier image that failed to boot was also removed before this corrected-image qualification.

This receipt covers guest boot, the sampled network/privilege boundaries and confirmed teardown. No GitHub runner had been registered, no paired Actions comparison had run and no CI workload performance had been measured in the guest at this point.
