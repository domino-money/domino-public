# Self-hosted CI runners

All six repository workflows route their jobs to **Clawber x64 by default**. A root-owned broker supplies one disposable Ubuntu VM per job, with up to eight guests admitted within a shared CPU/memory budget. Unrelated research workloads remain outside this architecture. `Clawber` is the runner implementation namespace used by the committed workflows, scripts and units; actual management hostnames and SSH identities stay in private operator configuration.

The broker and GitHub App are active. The original two-slot rollout and subsequent expansion receipts below distinguish observed job results from remaining execution qualification; earlier manual pilot results are historical evidence, not proof that every current job/profile has passed.

## Follow a run on GitHub

Open [Actions](https://github.com/domino-money/domino/actions), select the commit/run and then a job to see its current step, logs and duration. Runner names start with `domino-broker-` and contain the run, attempt and job IDs. The selected runner is created for that job and disappears after cleanup; a permanently online idle runner is not expected.

`Queued` means a job is waiting for admission, resources or guest startup. The eight-slot limit applies across all workflows and commits. CPU, memory or heavy-job limits can be reached with fewer than eight guests: seven browser guests consume the complete current budget. Every main push keeps its own run, and there is no automatic hosted overflow. Compare queue/startup time separately from execution time when assessing turnaround.

The scheduler orders by the workflow run's creation time, so newly released browser partitions retain their parent run's priority. Within a run, path selection goes first to release dependent checks. Fitting jobs may use otherwise idle capacity; after a 180-second grace, a reservation prevents an older heavy job waiting for CPU/memory from being starved by continuous smaller jobs. Existing jobs are never preempted to make room.

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
| Slots | `1` through `8`, one disposable VM/job per slot |
| Each guest | Ubuntu 24.04 x64; size selected by the trusted job policy; 80 GiB sparse writable disk capacity |
| Aggregate guest allocation | At most 14 vCPU and 56 GiB guest RAM, with at most two heavy jobs; hypervisor overhead is separate |
| Storage | Existing SSD mount, `/mnt/narrative-ssd/domino-ci-pilot`; no new host volume |
| Trusted host source | Root-owned broker, controller and policy under `/opt/domino-ci` |
| Base image | `/mnt/narrative-ssd/domino-ci-pilot/base/ubuntu-24.04-ci.qcow2`, root-owned mode `0444` |
| Prepared base SHA-256 | `73835938384dafb7c497e6141f44fa4798574c57bf59adddb768d2bf33a992cf` |
| Dedicated network | `domino-ci-pilot`, `/28`; fixed guest host octets `.2` through `.9`, one per slot; network autostart enabled |
| Lifecycle | Single-job JIT runner; bounded lifetime; guest, writable disk, seed and job state removed afterward |

The dedicated network was expanded from `/30` to `/29` for the second slot, then to `/28` for eight slots, preserving UUID `c91f55f6-9d8a-4788-a1ae-332d39eaf9f7`. Each migration drained CI guests first and changed only this network. Full guest addresses and network/filter definitions are in the [network source](../scripts/ci/libvirt/network.xml) and [filters](../scripts/ci/libvirt/filter.xml).

The [shared resource definitions](../scripts/ci/clawber_resources.py) and root-owned policy assign these sizes independently of guest privileges:

| Resource class | vCPU | RAM | Jobs |
| --- | ---: | ---: | --- |
| `light` | 1 | 3 GiB | Hygiene, path selection, Read Worker, Automation OFF, execution inspection and small pilot checks |
| `standard` | 2 | 6 GiB | Frontend, gated preview and read-path release |
| `browser` | 2 | 8 GiB | Browser partitions, Position journeys and browser pilot |
| `heavy` | 3 | 12 GiB | Backend, contracts and their pilot workloads |

The broker reserves a job's full configured size before runner registration and releases it only after verified cleanup. CPU quota is enforced in each VM's libvirt definition; aggregate admission caps the sum of guest quotas and memory allocations. RAM currently unused by one admitted guest does not create an extra reservation for another. The manual launcher's compatibility class, `legacy` (4 vCPU/16 GiB), is not available to new automatic policy entries; historical active state is accounted conservatively during recovery.

Guest egress permits DNS through the dedicated resolver and public IPv4 TCP port 443 with established replies. Private, host, Tailnet, link-local and metadata IPv4 destinations, all IPv6 and unsolicited inbound access are blocked. This is a range/port boundary, **not a DNS or destination-domain allowlist**: public production HTTPS front doors remain reachable as ordinary public clients. Private RPC/backend networks and sockets, host mounts and wallet/runtime credentials are unavailable to jobs.

Host prerequisites include KVM/libvirt, `virsh`, `qemu-img`, `cloud-localds`, libguestfs image tools, `systemd-run` and dedicated bridge DNS support. [Image preparation](../scripts/ci/prepare-image.sh) verifies locked downloads and builds OS dependencies before job execution. Controllers do not bootstrap host packages or alter unrelated services, VMs, containers, networks or disks.

## Profiles and job dependencies

- **`normal`:** no guest `sudo`; Node/runtime tooling, Chromium libraries/fonts, Python runtime libraries and PostgreSQL 16 binaries are installed in the image. Workflows install locked dependencies. Browser jobs install the Chromium selected by `playwright-core` and export `DOMINO_BROWSER_PATH`, rather than relying on a global Chrome installation.
- **`systemd`:** the same disposable guest with guest-only passwordless sudo and systemd as PID 1. CI hygiene needs real unit loading/reloading; Automation OFF creates synthetic users/groups and temporary fixture paths. These privileges do not grant host access, and these jobs receive no deployment secrets. The runner child uses the standard `022` file-creation mask expected by existing CI fixtures; the host controller, guest launcher service and JIT files retain their private permissions.
- **`deploy`:** a broker admission class mapped to the **normal VM profile**, without sudo. Existing GitHub Cloudflare secrets are supplied transiently to their existing job steps. Deployment code runs only under its retained main/dispatch/source/hold conditions; it receives neither the App PEM nor the broker installation token.

Backend uses the repository Python pin, PostgreSQL tools at `/usr/lib/postgresql/16/bin`, and the pinned Anvil/Forge/Solidity toolchain. The [database helper](../backend/dev_postgres.py) creates task-local Unix-socket clusters, not a shared database service. Redis is not required. Contract suites retain one dependency closure per invocation because a whole-tree solc-js compile has a known memory constraint.

## Broker authorization and labels

The [broker](../scripts/ci/clawber_broker.py) polls GitHub outbound over HTTPS, checks queued jobs, and admits work only from its root-owned policy. It never executes a controller or policy supplied by a job checkout.

Admission verifies the private, non-forkable Domino repository and numeric identity; active workflow identity/path; immutable run SHA and current attempt; exact queued job identity/display name; and both original/triggering actors' `write`, `maintain` or `admin` permissions. Allowed events are main pushes, same-repository pull requests targeting main, and authorized manual dispatches subject to each workflow's branch constraints. Fork jobs are refused. `deploy` is never admitted for a PR and requires main. Resource classes come from the trusted host policy, never from a job's checkout, label or arbitrary size request.

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

The per-job/matrix label prevents a different job in the same run/profile from consuming that runner. Labels select work; they are not authorization. Policy v1 has `repository`, `repository_id`, `base_labels`, `run_label_template` and a `jobs` array whose entries contain `workflow`, `job_name`, `job_label`, `profile`, `resource_profile`, `lifetime_seconds`. Exact expanded names are allowlisted; no wildcard grants admission. Lifetimes include setup and retain startup headroom, with a 90-minute maximum. Actions job timeouts remain independent.

## GitHub App, group and credentials

Use a GitHub App whose installation selects only `domino-money/domino`. Required permissions are organization **Self-hosted runners: write**, repository **Actions: read** and **Metadata: read**; no repository Administration permission or PAT is required for the organization runner scope. Keep the provisioned App and installation IDs in the private broker configuration.

Use the dedicated organization runner group `domino-clawber`: visibility `selected`, public repositories disallowed, and the selected repository set verified as exactly the intended Domino repository. The broker checks this group restriction before registration. Record its numeric ID in the private broker configuration.

The App PEM is `/etc/domino-ci/github-app.pem`, root-owned mode `0600`. The [service](../scripts/ci/domino-clawber-broker.service) supplies it through `LoadCredential`; its value is never committed, printed or copied into a guest. Short-lived installation tokens expire in approximately one hour and remain only in broker memory. Only single-use JIT configuration crosses controller stdin. Guest GitHub job tokens and authorized deploy-step secrets are separate from broker credentials.

Existing workflow `contents: read` permissions are preserved. The pilot explicitly disables persisted checkout credentials; do not assume every standard workflow checkout does so. Every job still receives a fresh guest and its checkout/runtime credential state is destroyed with that guest.

## Configuration and service operation

Install reviewed broker, controller, `clawber_resources.py` and policy under root-owned, non-writable-by-jobs `/opt/domino-ci`. The controller's legacy manual source directory also needs the resource module beside it. Configuration is `/etc/domino-ci/broker.json`, root-owned mode `0600`; broker state is `/var/lib/domino-clawber-broker`, mode `0700`. The following schema example uses illustrative App, installation and runner-group IDs. Replace all three with the provisioned IDs before installation:

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

The broker records durable slot/job/runner identities and resource reservations before registration, retries failed starts with backoff, and revalidates a job immediately before creating JIT credentials. Startup recovery checks all eight slots and cleans exact recorded runner registrations. The default poll interval is 45 seconds; full queues do not require repeated admission attempts when no resource class fits. Discovery inspects at most the 24 oldest eligible runs and 64 candidate jobs per cycle. A 54-request HTTP budget per cycle bounds API consumption, including token refresh; incomplete cleanup retains its reservation for the next cycle. A guest lifecycle success is not a test pass: GitHub remains authoritative for the job result.

**Stopping or restarting the service interrupts active CI guests.** Drain first by creating the root-owned marker below. While it exists, the broker keeps monitoring and cleaning active jobs but admits no new guests. Wait until the state file's `active` map is empty and no owned CI guest remains; the GitHub queue itself need not be empty.

```sh
sudo install -o root -g root -m 0600 /dev/null /var/lib/domino-clawber-broker/drain
sudo journalctl -u domino-clawber-broker.service -n 80 --no-pager
```

After verified drain, stop the service for upgrades. Keep the marker through startup/recovery and remove it when the updated service is healthy to resume admissions:

```sh
sudo systemctl stop domino-clawber-broker.service
# Install and validate reviewed files, then:
sudo systemctl start domino-clawber-broker.service
sudo rm -- /var/lib/domino-clawber-broker/drain
```

For recovery, stop the broker first and let active controller cleanup finish. The controller can recover each exclusively locked slot (`1` through `8`) using root-owned ownership metadata:

```sh
sudo python3 /opt/domino-ci/clawber_pilot.py --slot 1 --cleanup-slot
sudo python3 /opt/domino-ci/clawber_pilot.py --slot 8 --cleanup-slot
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

Workflow/policy guards check all expanded identities, profiles, labels and browser installation. Offline controller/broker/launcher tests use synthetic APIs and host commands. The initial two-slot rollout passed 65 Python controller/broker/launcher cases and 12 Node workflow/cache cases. After a live fixture incompatibility, the unchanged 22-test auth-release installer suite also passed with the standard runner `022` file-creation mask. These checks complement the actual job receipts; they do not establish every workload or cancellation/restart recovery under load. The expansion receipt records its additional checks separately.

## Resource budget adjustment — 2 November 2026

The aggregate budget was increased from 12 vCPU/48 GiB to 14 vCPU/56 GiB after a 30-minute observation on 2 November 2026. The 181 samples showed no new host OOM kills or swap activity and low sustained memory/I/O pressure. All observed jobs used the browser resource class. Host-wide utilization, available capacity and unrelated workload measurements remain in the private capacity record; this observation qualifies only the stated workload and budget.

Seven browser guests now fit within the budget; an eighth does not. The eight-slot ceiling, two-heavy-job ceiling, per-job sizes, dedicated network and base image are unchanged. Keeping the heavy-job ceiling avoids extending a browser-only observation to unmeasured compilation workloads. Reassess host headroom, VM overhead and competing workloads privately before increasing the budget.

The 36 broker and 34 controller tests passed with the revised budget, including seventh-browser admission, eighth-browser rejection, independent CPU/memory/heavy limits, registration-time budget checks and bounded heavy-job backfill. Historical receipts below retain their original allocation values.

The host activated this budget at 19:28:35 UTC after all six previously active jobs completed successfully: five browser partitions in [run 41473660567](https://github.com/domino-money/domino/actions/runs/41473660567) and Frontend in [run 41474059077](https://github.com/domino-money/domino/actions/runs/41474059077). No job was cancelled for the update. The resource module was installed in both trusted source locations with SHA-256 `3b9aac1fb4d1efc5fae5f6c7028c542d12cea6aca7197eb9aa92fc496ceb7047`; the broker passed startup recovery before the drain marker was removed. The prior module and activation receipt are retained under `/opt/domino-ci/updates/budget-1456-20261102`.

## Eight-slot expansion receipt — 2 November 2026

The expanded broker was installed and admissions resumed at 17:25 UTC. Before migration, jobs `125373261037` (Contracts v2-audit) and `125373321634` (Repository hygiene) both completed successfully; no active job was cancelled. The dedicated network was migrated to `/28` with its UUID preserved, then the new service passed startup recovery with the drain marker present. The base image is unchanged. Root-owned source/policy/service backups are under `/opt/domino-ci/backups/20261102-172505`.

Focused validation passed: 34 controller tests, 36 broker tests, 14 manual-launcher compatibility tests and four Node workflow/policy tests. These cover all eight slot identities/locks, exact resource reservations, aggregate limits, oldest-run scheduling, heavy-job backfill, safe drain/recovery and bounded API use. The installed broker/controller/resource module/policy digests were compared with the reviewed source.

At 17:28 UTC, six browser VMs were running simultaneously: each actual libvirt domain had 2 vCPU, 8 GiB RAM and global CPU quota `200000` per `100000` microseconds. Their combined reservation reached exactly 12 vCPU/48 GiB, leaving slots 7–8 unallocated as intended. GitHub confirmed four jobs executing in [the oldest main run](https://github.com/domino-money/domino/actions/runs/41470516719); two guests for [the next admitted run](https://github.com/domino-money/domino/actions/runs/41473321707) were still starting. This verifies concurrent admission and the shared resource ceiling, not completion of the queued workload or eight simultaneous heavy jobs.

The initial admission burst reached the local HTTP request cap once. The unfinished registration retained its reservation until the next cycle verified cleanup, then returned to the queue with backoff; existing guests continued running. This `api_cycle_budget` event is the broker's own polling limit, not a GitHub rate-limit response.

## Original two-slot provisioning receipt

The GitHub App was created/installed and its actual permissions authenticated. The dedicated runner group was created and its selected-repository restriction verified. The `/29` dedicated network migration and autostart are configured; the base image digest above is unchanged. The broker service is enabled and running. The first automatic [CI run 41470516719](https://github.com/domino-money/domino/actions/runs/41470516719) and [Position journeys run 41470516835](https://github.com/domino-money/domino/actions/runs/41470516835) use source `4d775f9fa6d8d28f7acb02fd971d16e26fee6131`. Frontend passed in 198 seconds, while Position journeys occupied the other slot. The Frontend guest was cleaned up and its slot reused automatically. Both ordinary guests denied sudo; sampled peer-guest HTTPS, host-bridge SSH and metadata connections timed out; neither contained the App key or Docker socket.

At 15:51 UTC on 2 November 2026, that first run had passed Frontend (198 seconds), Read Worker (22), path selection (11), Contracts V1 (134), V2 (221) and V2-audit (248). These are whole-job durations, excluding queue/provisioning. Sampling observed two guests together reaching 12.33 GiB aggregate QEMU resident memory; this is an observed footprint, not their 32 GiB allocation limit or a guarantee for other workload pairs. Read-only admission checks also accepted the actual queued same-repository PR jobs and Automation OFF manual dispatch under their intended profiles.

Initial starts exposed a slot-directory mode masked to `0700`; the controller now explicitly sets validated slot ancestors to `0751` while keeping job directories `0710` and secret files `0600`. Hygiene then exposed the runner child inheriting `077`, which broke installer fixtures that expect standard directory traversal. Backend, launched before that correction, completed 3,626 tests with four failures: its negative permission fixtures also became private under `077`. The exact four failures reproduced locally under `077` and all four passed under `022`; the unchanged 22-test installer suite also passed under `022`. Only the runner child mask was changed; assertions and installer security checks were retained. The installed controller includes both corrections, without restarting active guests.

Position journeys passed 238 of 240 tests. Both failures reproduced locally with the same locked Chromium 141.0.7390.37: one geometry baseline sampled an unfinished ancestor entrance animation; the bulk-close scroll timeline alternated its own container padding every frame, moving the next-group button by 6.25 pixels indefinitely. The follow-up waits for relevant finite motion/fonts before the geometry baseline, preserving first-paint checks and exact equality; the scroll timeline now changes paint only, retaining fallback padding. A new eight-frame stability assertion failed before the CSS correction and passed afterward; all nine bulk-close tests and three focused geometry repetitions passed on macOS ARM64 with Node 24.22.1. The local browser checks do not establish Linux guest success.

At this receipt, the first main run's five browser partitions and the synthetic Automation OFF dispatch were still queued/running. Complete CI with these corrections, full systemd-profile qualification and an actual gated deployment were still pending. Subsequent runs appear in [Actions](https://github.com/domino-money/domino/actions); the first attempt's failures are retained as rollout evidence. Manual credentialed production releases were not dispatched merely to test runner routing.

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
