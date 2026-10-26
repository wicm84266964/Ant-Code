# Source update core — architecture and integration contract

The updater serves standalone official source installations only. It does not update
packaged executables or embedded copies, publish packages, change product versions,
or replace release validation. The installation root is the running product source,
not the user's project. Unsupported layouts or unsafe state fail closed.

## Architecture and preparation

- The manager captures immutable boot identity, checks installation eligibility,
  discovers one network route and issues an expiring, server-owned update plan.
  Snapshot reads are local only; check/start run in the background.
- The target is the current branch's official public HTTPS upstream tip. Apply is
  fast-forward only. Reject missing upstream, detached HEAD, dirty/untracked or
  hidden-index state, divergent/ahead branches, active Git operations, worktrees,
  submodules, symlinks, path case aliases and unsafe executable Git/rewrite/TLS
  configuration. Reject alternate object stores and executable alternate-ref
  commands before object/ref operations or fetch. Never invent an upstream.
- Proxy discovery reads application settings, environment, Git/npm configuration
  and Windows static system proxies; it does not scan ports or assume defaults.
  Support HTTP/HTTPS proxies only; SOCKS and PAC/WPAD are explicit unsupported
  errors. Manual proxy/direct consent is one-shot. A failed proxy never silently
  falls back to direct, a mirror or disabled TLS.
- Git and npm use the same selected route. Remove conflicting route/config/env
  bypasses, including NO_PROXY and bare PROXY. Discovery only reads original npmrc
  files, including explicitly supplied user/global paths; it never rewrites them.
  Installation uses private empty user/global npmrc files, the public HTTPS npm
  registry, `replace-registry-host=never`, `noproxy=,`, and explicit `proxy=false` /
  `https-proxy=false` for direct mode. Reject candidate npmrc files (case-insensitively),
  Git/file dependency helpers, and locks without integrity-pinned HTTPS resolutions.
- A private worker closure prepares the candidate before shutdown using
  `npm ci --ignore-scripts --no-audit --no-fund` with a 10-minute install bound.
  Validate Node engine, resources and entry syntax, then run the candidate's real
  `CLI --version` to load static/transitive imports. Require exit 0, exact candidate
  version, no stderr and no HOME writes within 30 seconds / 4 KiB. Use a private
  HOME/config/temp and OS-execution-only environment allowlist, without credentials,
  Node injection, package-root/SEA overrides or update tokens. The product version
  branch returns before config migration/runtime/network startup. This is an entry
  contract check, **not an OS sandbox for arbitrary malicious candidate code**.
- Preparation failure leaves the old HTTP service, HEAD and dependencies unchanged,
  without a mutation permit or restart. Only after preparation and a safe maintenance
  gate may the worker apply the FF and exchange dependencies. FF uses
  `--no-overwrite-ignore` to protect ignored files created during a race.

## Trusted server and CLI wiring

All roots and startup options below come from trusted code, never HTTP input.

```ts
const sourceRoot = await sourceRootFromModule();
const boot = await captureBootSnapshot(sourceRoot, env);
const manager = await SourceUpdateManager.create({
  sourceRoot, projectCwd, host, actualPort, env, config, boot,
  strictRestartSupported: true,
  getActivity,     // Include all active, queued and uncertain work.
  prepareShutdown // async ({jobId, releaseWorker}) => void
});
await manager.snapshot(); // Local reads only.
manager.check({ proxyUrl, allowDirect }); // Synchronous acceptance; background job.
manager.start({ planId });               // {accepted:true, jobId}; background job.
await manager.dispose();                // Unregister this Dashboard's lease.
// Diagnostics/tests only; never await in HTTP check/start handlers:
await manager.settled();
// New process, only after successful strict bind to the original address:
await acknowledgeSourceUpdate({ sourceRoot, boot, host, actualPort, strictPort: true, env });
```

- Derive `sourceRoot` from `sourceRootFromModule()` or the actual server module,
  never project cwd, `LAB_AGENT_PACKAGE_ROOT`, requests or browser-supplied paths.
  Capture boot identity once before checks: `productVersion`, `bootCommit`,
  `instanceId`. Preserve Dashboard protocol `status.version = "dashboard.v2"`.
  Create the manager after listening, with the real project cwd and actual port.
- `GET /api/source-update` awaits `snapshot()` without fetching. POST check/start
  validate plain JSON, authentication, CSRF, Host and Origin and return HTTP 202
  immediately. Check accepts only `{proxyUrl?, allowDirect?}`; start accepts only
  `{planId}`, never commands, roots, URLs or plan contents. Never spread requests
  into trusted options. Unknown fields throw `INVALID_CHECK_INPUT` /
  `INVALID_START_INPUT`; synchronous failures expose only safe `UpdateError.code`,
  not arbitrary exception text. Background check rejection becomes blocked + code.
- `snapshot()` returns `{boot, phase, message?, route?, plan?, jobId?, limitations,
  strictRestartSupported}`. Plan fields are `{id, head, target, branch, remote,
  mergeRef, createdAt, expiresAt}`. Do not expose installation/upstream URLs, proxy
  credentials, nonce, raw stderr or journal. `route.endpoint` omits credentials;
  `message` is a safe code. Caller mutation cannot change manager state. One-shot
  credentials stay in memory and inherited worker stdin, not argv or journals.
- Check is single-flight and invalidates previous plans. Start consumes one matching,
  non-expired ready plan; retry requires a new check. Initial journal recovery is
  allowed only while untouched idle; thereafter snapshots follow the exact current
  job. State epochs discard stale asynchronous reads, so historical completion
  cannot overwrite a new blocked check or a failed pre-journal launch.
- `getActivity()` conservatively includes active, queued, awaiting-approval,
  quarantined, uncertain, terminal/background and scheduled work. After candidate
  preparation, `prepareShutdown` atomically bars writes and schedule triggers, then
  rechecks activity. It must refuse busy/uncertain work without cancellation, shut
  down safely and **await `releaseWorker()` immediately before closing HTTP/exiting**.
  Normal return without release is refusal; keep the old service alive. The release
  callback rechecks leases, activity, repository identity, dirty/index state and
  ignored-file collisions. Never release first and then decide whether shutdown is
  safe. Mutation requires both the nonce permit and old PID death; the worker
  rechecks tree/index and leases again after old-process exit, before mutation.
  Dispose the manager on normal shutdown; never force-exit uncertain work to permit an update.
- Capture supported relative `LAB_AGENT_CONFIG` (trimmed), `LAB_AGENT_HOME`,
  `USERPROFILE`, `HOME`, `APPDATA`, `XDG_CONFIG_HOME` against the old cwd before any
  worker/restart cwd change. These cover config-v2 and workspace-trust paths.
  `ANT_CODE_HOME` is not consumed. Never journal environment or credentials.
- Restart uses absolute Node and `<sourceRoot>/src/cli/index.ts dashboard --host
  <same-host> --port <actual-port> --project <absolute-project> --no-open --strict-port`.
  CLI/server honor `--strict-port` and `ANT_SOURCE_UPDATE_STRICT_PORT=1`; bind failure
  exits without incrementing the port. Children clear Node injection, route and
  Git/npm env on restart; update nonce/root/job are passed explicitly.
- ACK is local/private, not an unauthenticated HTTP API. Run it after the new listener
  binds, before announcing success. Normal starts return false; invalid update boot
  throws and must fail closed. Verify strict host/port, nonce, target SHA, clean
  tree/index, distinct instance, old PID death, worker liveness and expected child
  PID. The worker revalidates ACK and child liveness. Exited restart records
  `RESTART_EXITED` immediately rather than waiting a full ACK timeout. Neither an
  HTTP GET nor a changed version string counts as ACK.

## Private storage, recovery and process limits

- State belongs to the standalone clone's `.git/ant-source-update`, never the user
  project. POSIX requires owner-only 0700; Windows removes inheritance, grants the
  current SID and verifies ACL using a fixed PowerShell script. JSON is file-flushed
  and atomically renamed; directory fsync is POSIX-only. Publish journal state in
  memory only after durable write succeeds.
- Locks are exclusive and never stolen automatically due to timeout or PID reuse.
  Participating Dashboards register instance/PID leases in the shared state directory.
  Other CLI/TUI processes are **not covered**: show this limitation and require users
  to close them before updating. All-CLI leases would need to reuse this boundary.
- Jobs retain the built-in-only worker closure, candidate and prior `node_modules`.
  Every mutation records intent and completion. After old-process exit, any error
  becomes `manualRecovery` and retains the lock, last durable intent and dependency
  location evidence, including failures after either dependency rename. Never
  automatically reset, clean, stash, roll back HEAD, relink npm or retry an ambiguous
  step. With all runtimes stopped, inspect `journal.json`, actual HEAD and dependency
  locations before manually selecting/restoring dependencies. Never delete a lock
  merely to retry. Successful updates also retain backups/candidates; a dedicated
  cleanup operation is not implemented.
- Process timeout/output caps initiate bounded termination rather than waiting for
  inherited-pipe close. POSIX uses private groups with TERM, escalation after 500 ms
  and a final 1-second deadline. Windows allows a live, still-owned child's fixed
  `System32/taskkill.exe /PID <child.pid> /T /F` the full existing 2.5-second cleanup
  budget to enumerate/terminate descendants, without an earlier helper cutoff.
  Helper failure falls back to the still-owned root; the unchanged final deadline
  bounds the helper, root and local pipes. Never kill by image
  name, scanned/journal PID or an already-exited root. Helpers are bounded. Exited
  children get a 500-ms output-drain window; once Windows root ownership is lost,
  close owned pipes and report `PROCESS_LIMIT` rather than risk PID reuse. Escaped
  descendants cannot be guaranteed removed; inspection/manual recovery may be needed.

## Support and validation limits

Real product CLI/server strict-port restart and local ACK were exercised on Windows
in disposable local Git clones, including relative config paths from a different cwd,
unchanged config bytes/revisions and journal recovery. Candidate import checks,
repository/route isolation, maintenance/schedule races, lease negatives and failure
retention have focused automated coverage. These checks are not a comprehensive
third-party security audit or a real public-upstream UI-driven update.

The product enables strict restart wiring, but each installation must still pass all
repository, layout, lease and activity checks. A server without an injected updater
remains unavailable with strict restart capability false. Missing upstream is always
a refusal, not an instruction to add a fake remote.

One earlier product restart recorded `RESTART_EXITED` without sufficient diagnostics
to locate the cause; later runs did not reproduce it. The intermittent risk is not
claimed resolved. POSIX process groups, permissions, rename/fsync and full restart
remain unvalidated at runtime. Real public-network upgrades, target pixel-level
visual acceptance, true TTY and global-install smoke also remain unvalidated. See
[the user-facing update guide](../../docs/deployment/source-self-update.md) for usage
and recovery; release candidates require their own release/process gates.
