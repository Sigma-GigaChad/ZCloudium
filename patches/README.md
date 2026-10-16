# The z-cloudium patch series

A series of patch files, applied in name order by `Dockerfile.from-source`
onto the pinned ZCodium revision before the build. Everything the product
adds to the runtime lives here, and nothing else is allowed to drift from
upstream: an upstream bump means refreshing these files, not hunting deltas.

The build also runs `scripts/validate-remote-bridge.mts`: an in-memory,
two-hop round trip (browser channel client → local channel server →
`toService` proxy → remote channel client → remote channel server) proving
that a call and an event subscription survive `exposeOnChannelServer`. That is
the failure class a typecheck cannot see — the bridge once broke exactly there
and every other check stayed green.

## What it contains

| Area | Files | Purpose |
| --- | --- | --- |
| Host machine card | packages/server/src/hostMachine.ts (new), packages/server/src/http.ts, packages/shared/src/remoteTarget.ts, packages/shared/src/validation.ts, packages/shared/src/platform.ts, wizard files | the « Machine courante » card: SSH connect to the Docker host, bridge-gateway auto-detect, ed25519 keypair in the volume (OpenSSH private format hand-serialized), public key shown once, ZCLOUDIUM_HOST_MACHINE off-switch |
| Durable remote sessions | `packages/server/src/remoteSessionRegistry.ts` (new), `packages/server/src/http.ts`, `packages/web/src/main.tsx`, `packages/ui/src/Root.tsx`, `packages/ui/src/root/types.ts`, `packages/ui/src/root/useRemoteWorkspaceHistory.ts` | remote sessions live server-side, keyed by target identity and workspace scope: a browser refresh/close detaches its socket without disposing anything, a re-attach to a live session is instant (dedupe + in-flight coalescing), and the connection dies only via `onDidRemoteClose`, explicit dispose, or server restart. Includes the runtime-preferences bridge (the remote runtime asks its host for session preferences on cold resume — desktop answered, the web server now does too) and the web-only `autoReconnectRemoteWorkspaces` boot flag |
| Remote services bridge | `packages/server/src/remoteBridge.ts` (new), `packages/server/src/http.ts` | `/ws/remote/:id` exposes the full remote channel set (registers the same `ProxyChannel.toService` service proxies `RemoteServiceAccess` builds, so `exposeOnChannelServer` wraps them exactly like local services) instead of four services, and disposes the remote connection when the browser socket closes; `POST /api/dispose-remote/:id` releases an attached connection; ticket ids use `randomUUID` |
| Web remote connect (SSH) | `packages/web/src/main.tsx`, `packages/server/src/http.ts` | `platform.connectRemote` calls `POST /api/connect-remote`, attaches the session over `/ws/remote/<ticket>`, registers it renderer-side with the resolved target; `allowRemoteWorkspace` on for web. The route passes the deploy options desktop gets at compile time — the remote-assets CDN base (env `ZCODE_REMOTE_ASSET_CDN_BASE_URL` override, else the pinned ZCodium release assets) and a data-volume cache dir |
| Wizard: SSH only | `packages/ui/src/hooks/useRemoteConnectionForm.ts`, `packages/ui/src/SSHDialog.tsx`, `packages/ui/src/Root.tsx` | Docker and WSL connect to the machine running the client — desktop only (`isDesktop` gate); the web wizard offers SSH alone |
| Attachment staging | `packages/server/src/attachmentStage.ts` (new), `packages/web/src/main.tsx`, `packages/ui/src/lib/chatAttachments.ts`, `packages/ui/src/v4/composer/useComposerAttachments.ts` | `POST /api/stage-attachment` writes uploads into the agent's own space (dir 0700, file 0600, the desktop temp-text layout) and returns a real path; `createTempTextAttachment` works in web; binary files (zip, docx, …) are staged instead of failing at send. The 20 MiB protocol cap stands |
| MCP settings | `packages/web/src/main.tsx` | `loadMcpFromUserDirectory`/`saveMcpToUserDirectory` delegate to the server-side `mcp-sync` channel (already exposed to web clients): the settings page lists and persists into the agent's `~/.zcode/cli/config.json`. Legacy migration stays a no-op |
| WS liveness (0002) | `packages/server/src/wsLiveness.ts` (new), `packages/web/src/wsWatchdog.ts` (new), `packages/server/src/http.ts`, `packages/client/src/remoteServiceAccess.ts`, `packages/web/src/main.tsx` | idle tabs die silently (sleep/resume, NAT eviction) and nothing noticed: a sent message spun forever on a half-open socket. The server now pings every 30s (terminate on missed pongs, the canonical `ws` pattern) and exposes a `ws-liveness` RPC channel; the web bootstrap runs a watchdog probing it every 25s (10s timeout) and answers a dead probe or a real close with a "connection lost — reloading" overlay + auto-reload (durable sessions make the reload cheap). Deliberate tradeoff: the overlay text is not i18n'd — three large locale files for one emergency line costs more rebase surface than it is worth |
| Encoded web assets (0003) | `packages/server/src/staticAssets.ts` (new), `packages/server/src/http.ts`, `packages/rpc/src/logging-middleware.ts`, `packages/rpc/src/index.ts` | the static branch reads once and compresses per process (brotli, gzip fallback; cache keyed by path+mtime), serves `Content-Encoding` with `Vary`, keeps hashed assets `immutable`, and answers `304` for `index.html` revalidation; RPC call logging is quiet unless `ZCODE_RPC_LOG=1` |
| Web boot and notifications (0004) | `packages/web/src/bootSocket.ts` (new), `packages/web/src/taskNotifications.ts` (new), `packages/web/src/main.tsx`, `packages/web/src/wsWatchdog.ts`, `packages/ui/src/index.ts` | the socket opens in parallel with `/api/server-info` and the boot surface holds until the first workspace tab paints; notification permission is requested once on the first user gesture, a click focuses the window and routes to the task, unread counts feed the app badge; the watchdog probes immediately, on visibility, and when the network returns |
| Remote attachment staging (0005) | `packages/server/src/remoteAttachmentTransfer.ts` (new), `packages/server/src/remoteSessionRegistry.ts`, `packages/server/src/remoteBridge.ts`, `packages/server/src/http.ts` | the server streams server-staged bytes to the target over the session's own SSH backend (desktop layout, 0700/0600) and answers `staged:true` with a real remote path, so the web composer can attach files to a remote workspace; a dead session fails explicitly and the 20 MiB cap stands |

## Upstream policy

- new files wherever possible; the edited upstream files carry small, marked
  hunks (comments starting `zcloudium:` or explaining the change);
- behaviour without this series stays exactly upstream's behaviour: the
  `dockerContainer` and `cloudEnvironment` fields are optional, and the web
  remote connect path is only exercised from the web entry;
- upstreaming is the intent: each area maps to an isolated commit in the source
  tree, so it can be proposed to ZCodium-project/ZCodium separately.

## Regenerating

```sh
git clone --branch v1.0.2 https://github.com/ZCodium-project/ZCodium.git /tmp/zc-src
cd /tmp/zc-src
git checkout -b zcloudium-web-remote
# apply the current patches in order, rebase onto the new release, then:
git format-patch v1.0.3..HEAD --stdout > /tmp/series.patch
# then split it back into patches/<NNNN>-*.patch files by area
```
