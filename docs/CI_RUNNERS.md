# Self-hosted CI runners

All six repository workflows route their jobs to **Clawber x64 by default**. A root-owned broker supplies one disposable Ubuntu VM per job, with at most two guests running at once. Unrelated research workloads remain outside this architecture. `Clawber` is the runner implementation namespace used by the committed workflows, scripts and units; actual management hostnames and SSH identities stay in private operator configuration.

The broker and GitHub App are provisioned and active. **The first automatic broker-admitted job and the complete all-jobs migration are still awaiting execution qualification.** Earlier manual pilot results are historical evidence at the bottom of this document, not proof that every current job/profile has passed.

## Workflow coverage

The [reviewed runner policy](../scripts/ci/runner-policy.json) covers 24 expanded display identities across six workflows, including matrix partitions and the manual workload choices. They do not all run in every workflow invocation.

| Workflow | Guest profiles and dependencies |
| --- | --- |
| [CI](../.github/workflows/ci.yml) | `systemd` for hygiene; `normal` for path selection, Frontend, Read Worker, five browser parts, Backend and three contract parts; `deploy` for preview/release |
| [Position journeys](../.github/workflows/funding-ui.yml) | `normal`; Node and lock-selected Chromium |
| [Automation OFF rehearsal](../.github/workflows/automation-off-rehearsal.yml) | `systemd`; Python, synthetic users and privileged unit/peer checks inside the guest |
| [Execution Cloudflare preflight](../.github/workflows/execution-cloudflare-preflight.yml) | `deploy`; Node and the existing Cloudflare step credential |
| [Read-path release](../.github/workflows/read-path-release.yml) | `deploy`; Node/npm/Wrangler and the existing Cloudflare step credential |
| [Clawber pilot/benchmark](../.github/workflows/clawber-ci-pilot.yml) | `normal` for admission and selected workload; Clawber-only by default; an explicit `compare_hosted=true` adds the hosted benchmark leg |

Existing triggers, assertions, contract/compiler freezes, per-main-commit execution, preview ordering/hold checks and release conditions are retained. The [execution policy](EXECUTION_POLICY.md) and GitHub branch protection are unchanged. There is **no automatic fallback to GitHub-hosted compute** if Clawber is unavailable.

## Capacity, storage and network

| Property | Current configuration |
| --- | --- |
| Slots | `1` and `2`, one disposable VM/job per slot |
| Each guest | Ubuntu 24.04 x64; 4 vCPU, 16 GiB RAM, 80 GiB writable disk capacity |
| Aggregate guest allocation | At most 8 vCPU and 32 GiB guest RAM; hypervisor overhead is separate |
| Storage | Existing SSD mount, `/mnt/narrative-ssd/domino-ci-pilot`; no new host volume |
| Trusted host source | Root-owned broker, controller and policy under `/opt/domino-ci` |
| Base image | `/mnt/narrative-ssd/domino-ci-pilot/base/ubuntu-24.04-ci.qcow2`, root-owned mode `0444` |
| Prepared base SHA-256 | `73835938384dafb7c497e6141f44fa4798574c57bf59adddb768d2bf33a992cf` |
| Dedicated network | `domino-ci-pilot`, `/29`; fixed guest host octets `.2` and `.3`, one per slot; network autostart enabled |
| Lifecycle | Single-job JIT runner; bounded lifetime; guest, writable disk, seed and job state removed afterward |

The dedicated network was expanded from `/30` to `/29` for the second slot while preserving UUID `c91f55f6-9d8a-4788-a1ae-332d39eaf9f7`. Only this CI network was migrated. Full guest addresses and network/filter definitions are in the [network source](../scripts/ci/libvirt/network.xml) and [filters](../scripts/ci/libvirt/filter.xml).

Guest egress permits DNS through the dedicated resolver and public IPv4 TCP port 443 with established replies. Private, host, Tailnet, link-local and metadata IPv4 destinations, all IPv6 and unsolicited inbound access are blocked. This is a range/port boundary, **not a DNS or destination-domain allowlist**: public production HTTPS front doors remain reachable as ordinary public clients. Private RPC/backend networks and sockets, host mounts and wallet/runtime credentials are unavailable to jobs.

Host prerequisites include KVM/libvirt, `virsh`, `qemu-img`, `cloud-localds`, libguestfs image tools, `systemd-run` and dedicated bridge DNS support. [Image preparation](../scripts/ci/prepare-image.sh) verifies locked downloads and builds OS dependencies before job execution. Controllers do not bootstrap host packages or alter unrelated services, VMs, containers, networks or disks.

## Profiles and job dependencies

- **`normal`:** no guest `sudo`; Node/runtime tooling, Chromium libraries/fonts, Python runtime libraries and PostgreSQL 16 binaries are installed in the image. Workflows install locked dependencies. Browser jobs install the Chromium selected by `playwright-core` and export `DOMINO_BROWSER_PATH`, rather than relying on a global Chrome installation.
- **`systemd`:** the same disposable guest with guest-only passwordless sudo and systemd as PID 1. CI hygiene needs real unit loading/reloading; Automation OFF creates synthetic users/groups and temporary fixture paths. These privileges do not grant host access, and these jobs receive no deployment secrets.
- **`deploy`:** a broker admission class mapped to the **normal VM profile**, without sudo. Existing GitHub Cloudflare secrets are supplied transiently to their existing job steps. Deployment code runs only under its retained main/dispatch/source/hold conditions; it receives neither the App PEM nor the broker installation token.

Backend uses the repository Python pin, PostgreSQL tools at `/usr/lib/postgresql/16/bin`, and the pinned Anvil/Forge/Solidity toolchain. The [database helper](../backend/dev_postgres.py) creates task-local Unix-socket clusters, not a shared database service. Redis is not required. Contract suites retain one dependency closure per invocation because a whole-tree solc-js compile has a known memory constraint.

## Broker authorization and labels

The [broker](../scripts/ci/clawber_broker.py) polls GitHub outbound over HTTPS, checks queued jobs, and admits work only from its root-owned policy. It never executes a controller or policy supplied by a job checkout.

Admission verifies the private, non-forkable Domino repository and numeric identity; active workflow identity/path; immutable run SHA and current attempt; exact queued job identity/display name; and both original/triggering actors' `write`, `maintain` or `admin` permissions. Allowed events are main pushes, same-repository pull requests targeting main, and authorized manual dispatches subject to each workflow's branch constraints. Fork jobs are refused. `deploy` is never admitted for a PR and requires main.

Each admitted job has exactly seven routing labels:

```text
self-hosted
Linux
X64
domino-ci
domino-ci-<run_id>-<run_attempt>
domino-ci-<normal|systemd|deploy>
<exact domino-job-... label from runner-policy.json>
```

The per-job/matrix label prevents a different job in the same run/profile from consuming that runner. Labels select work; they are not authorization. Policy v1 has `repository`, `repository_id`, `base_labels`, `run_label_template` and a `jobs` array whose entries contain `workflow`, `job_name`, `job_label`, `profile`, `lifetime_seconds`. Exact expanded names are allowlisted; no wildcard grants admission. Lifetimes include setup and retain startup headroom, with a 90-minute maximum. Actions job timeouts remain independent.

## GitHub App, group and credentials

Use a GitHub App whose installation selects only `domino-money/domino`. Required permissions are organization **Self-hosted runners: write**, repository **Actions: read** and **Metadata: read**; no repository Administration permission or PAT is required for the organization runner scope. Keep the provisioned App and installation IDs in the private broker configuration.

Use the dedicated organization runner group `domino-clawber`: visibility `selected`, public repositories disallowed, and the selected repository set verified as exactly the intended Domino repository. The broker checks this group restriction before registration. Record its numeric ID in the private broker configuration.

The App PEM is `/etc/domino-ci/github-app.pem`, root-owned mode `0600`. The [service](../scripts/ci/domino-clawber-broker.service) supplies it through `LoadCredential`; its value is never committed, printed or copied into a guest. Short-lived installation tokens expire in approximately one hour and remain only in broker memory. Only single-use JIT configuration crosses controller stdin. Guest GitHub job tokens and authorized deploy-step secrets are separate from broker credentials.

Existing workflow `contents: read` permissions are preserved. The pilot explicitly disables persisted checkout credentials; do not assume every standard workflow checkout does so. Every job still receives a fresh guest and its checkout/runtime credential state is destroyed with that guest.

## Configuration and service operation

Install reviewed source/policy under root-owned, non-writable-by-jobs `/opt/domino-ci`. Configuration is `/etc/domino-ci/broker.json`, root-owned mode `0600`; broker state is `/var/lib/domino-clawber-broker`, mode `0700`. The following schema example uses illustrative App, installation and runner-group IDs. Replace all three with the provisioned IDs before installation:

```json
{
  "app_id": 123456,
  "installation_id": 12345678,
  "runner_scope": "organization",
  "runner_owner": "domino-money",
  "runner_group_id": 1,
  "controller": "/opt/domino-ci/clawber_pilot.py",
  "base_sha256": "73835938384dafb7c497e6141f44fa4798574c57bf59adddb768d2bf33a992cf",
  "state_directory": "/var/lib/domino-clawber-broker"
}
```

Omit `private_key` so systemd's credential directory supplies it. Omit `base_image` to use the controller's pinned SSD default; the broker requires every ancestor of an explicitly configured image path to be root-owned, while this shared SSD mount is administrator-owned. The service runs the host broker with `/opt/domino-ci/runner-policy.json`; code, configuration, parents and state must satisfy its root-ownership/no-symlink/permission checks.

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now domino-clawber-broker.service
sudo systemctl status --no-pager domino-clawber-broker.service
sudo journalctl -u domino-clawber-broker.service -n 80 --no-pager
```

The broker records durable slot/job/runner identities before registration, retries failed starts with backoff, and revalidates a job immediately before creating JIT credentials. Startup recovery checks both slots and cleans exact recorded runner registrations. A guest lifecycle success is not a test pass: GitHub remains authoritative for the job result.

**Stopping or restarting the service interrupts active CI guests.** Prefer draining first: pause new submissions and wait for the current queue/active slots to empty, observing GitHub and broker release events. There is no dedicated drain command; `systemctl stop` is not a graceful drain operation.

```sh
sudo systemctl stop domino-clawber-broker.service
```

For recovery, stop the broker first and let active controller cleanup finish. The controller can recover each exclusively locked slot using root-owned ownership metadata:

```sh
sudo python3 /opt/domino-ci/clawber_pilot.py --slot 1 --cleanup-slot
sudo python3 /opt/domino-ci/clawber_pilot.py --slot 2 --cleanup-slot
```

Cleanup validates exact domain, slot and job-directory identities before removing anything. If a domain cannot be confirmed absent, or recovery metadata is missing/invalid, it fails closed and preserves files for inspection. Never replace this with prefix-wide `virsh destroy`, firewall resets, or broad disk deletion. Verify guest domains, job directories and corresponding GitHub registrations are gone, then restart the broker. Interrupted jobs require an explicit same-SHA rerun; restarting the broker does not turn them into successful checks.

## Manual benchmark and break-glass operation

The manual pilot uses the shared [workload script](../scripts/ci/run-pilot-workload.sh). Default dispatch uses Clawber only:

```sh
gh workflow run clawber-ci-pilot.yml \
  --repo domino-money/domino --ref main -f workload=read-worker
```

Request a hosted benchmark control explicitly with `-f compare_hosted=true`. Both legs use the same dispatched SHA and runtime patch versions resolved by admission. Record cold/warm cache state, provisioning/queue/job times, resource pressure, failures and teardown separately. No queued guest job is automatically transferred to a hosted pool.

The older [manual launcher](../scripts/ci/start-clawber-pilot.py) is break-glass tooling only, with the broker stopped. It requires an already successful pilot preflight at the exact run/SHA before registration; it cannot bootstrap a queued self-hosted preflight. It accepts historical and current pilot routing labels and keeps the operator's GitHub access on the operator's computer. Use only after inspecting the run, never concurrently with automatic slot admission:

```sh
python3 scripts/ci/start-clawber-pilot.py \
  --run-id "$DOMINO_PILOT_RUN_ID" --sha "$DOMINO_PILOT_SOURCE_SHA" \
  --workload read-worker \
  --ssh-config "$DOMINO_CI_SSH_CONFIG" --ssh-host "$DOMINO_CI_SSH_HOST" \
  --base-sha256 "$DOMINO_CI_BASE_SHA256"
```

Actual SSH profiles/identities stay outside this repository. The legacy launcher registration path is distinct from the App broker; confirm runner and guest cleanup before re-enabling the service. A repeated job needs its new attempt label. For a hosted comparison rerun, select the actual hosted job `databaseId` from `gh run view --json jobs`; do not substitute a newer main commit.

## Cache and validation behavior

Forge and V2 compilation keys include OS/architecture and compiler/lockfile/source inputs; legacy architecture-ambiguous fallbacks are removed. Backend saves completed, qualified fixture compilation before later Python/PostgreSQL tests. [Source pruning](../scripts/forge-cache.mjs) removes invalidated sources/importers/artifacts; a cache is not proof that tests or later V2 release checks passed.

Contract tests and gas snapshots remain separate validation passes. Pilot caches are separated by pool/workload and have no fallback prefixes. No cache contains App credentials, wallet state or production databases.

Workflow/policy guards check all expanded identities, profiles, labels and browser installation. Offline controller/broker/launcher tests use synthetic APIs and host commands. **63 Python and 12 Node focused checks passed during provisioning; these do not qualify the first automatic CI job or every workload/profile.** Full all-jobs execution, cancellation/restart recovery under actual load, and two-slot concurrent workload results remain to be recorded.

## Current provisioning receipt

The GitHub App was created/installed and its actual permissions authenticated. The dedicated runner group was created and its selected-repository restriction verified. The `/29` dedicated network migration and autostart are configured; the base image digest above is unchanged. The broker service is enabled and running. No queued self-hosted job had yet been admitted at this receipt: first automatic-job and complete migration qualification remain pending.

## Historical manual pilot evidence

The following receipts precede the automatic all-jobs architecture. They establish only the stated guest/manual workloads, images, commits and observations.

The Backend fixture record/save steps completed successfully in main runs [41457279408](https://github.com/domino-money/domino/actions/runs/41457279408), [41457965063](https://github.com/domino-money/domino/actions/runs/41457965063) and [41458676942](https://github.com/domino-money/domino/actions/runs/41458676942), before the same four Python failures reproduced from baseline `b374421a`. This confirms early-save execution; it does not establish three distinct cache uploads or a passing Backend suite. These historical results precede the separate clock-bound fixture updates in [PR 435](https://github.com/domino-money/domino/pull/435).

### Host qualification receipt: 2 November 2026

The corrected prepared image booted successfully. Its SHA-256 is `9e87be9fcf557dd919f7abb2ac7b7ddf114438977a7cd94a1ad18791dbdaa118`.

The guest probe exited **0**: public GitHub HTTPS succeeded; sampled host-bridge SSH/RPC, metadata and Tailnet connections timed out; IPv6 was unreachable; the runner user was denied `sudo`. The observed tools were Node `24.22.2` and PostgreSQL `16.15`.

The probe helper lost its QEMU guest-agent shutdown reply as the guest stopped and returned nonzero. The host lifecycle controller separately reported `guest_stopped` with exit **0**; independent host inspection confirmed **zero pilot domains and zero pilot job directories** afterward. The earlier image that failed to boot was also removed before this corrected-image qualification.

This receipt covers guest boot, the sampled network/privilege boundaries and confirmed teardown. No GitHub runner had been registered, no paired Actions comparison had run and no CI workload performance had been measured in the guest at this point.


The first paired Actions comparison subsequently passed on both pools at main `2d9d76db`: [Read Worker run 41457285874](https://github.com/domino-money/domino/actions/runs/41457285874). The workload phase took 5.251 s hosted and 1.721 s on Clawber; whole-job times were 17 s and 47 s respectively, including the guest's cold action/checkout/tool setup. This smoke validates plumbing and is too small to predict heavy-suite performance. Runner deregistration and guest teardown were confirmed. Host qualification also found and corrected two integration details: shared-base DAC relabeling is disabled only for the immutable backing file, and JIT input accepts GitHub's actual `Ephemeral: "True"` settings representation while refusing false values.


The first browser attempt stopped before workload execution because the initial guest image lacked `libcairo2`. The trusted image builder now includes that library. The corrected image (`73835938384dafb7c497e6141f44fa4798574c57bf59adddb768d2bf33a992cf`) passed an unprivileged Chromium 141.0.7390.37 DOM-rendering smoke and the full [browser comparison, run 41458581494](https://github.com/domino-money/domino/actions/runs/41458581494). Both pools passed **84/84 tests**, with zero failures, skips or cancellations, at source `a46d9f2554c05543b2706423cec28794063f543e`, Node 24.22.2 and the same locked Chromium. The hosted control passed in attempt 1; only the Clawber job was repeated in attempt 2 after correcting the image.

| Measured duration | GitHub-hosted | Clawber |
| --- | ---: | ---: |
| Install web dependencies | 20.617 s | 8.653 s |
| Install app dependencies | 9.773 s | 2.670 s |
| Build unit output | 27.110 s | 10.400 s |
| Build app | 41.212 s | 14.363 s |
| Browser workload phase | 1,282.238 s | 1,005.137 s |
| Whole Actions job | 23 min 25 s | 17 min 56 s |

The whole Clawber job took 5 min 29 s less (23.4%) in this single comparison. Provisioning is separate: the operator process started at 14:33:10 UTC and the guest job at 14:34:27, approximately 77 s later; operator start through job completion was approximately 19 min 13 s. These cold runs do not establish warm-cache behavior or performance for other workloads. Thirty-second sampling over 17 minutes observed peak QEMU resident memory of about 5.6 GiB within the 16 GiB guest limit; this does not qualify concurrent jobs.

After completion, the operator exited 0. Independent inspection confirmed zero pilot runner registrations, zero pilot domains and zero pilot job directories; the base remained root-owned with mode 0444. RPC impact is unqualified because the owner was changing that service in another session and instructed this experiment to disregard those interruptions. At that pilot stage, Contract and Backend workloads, automatic admission and broad migration had not been qualified. The current all-jobs configuration is described above.
