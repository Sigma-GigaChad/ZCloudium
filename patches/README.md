# The z-cloudium patch series

One patch file, applied by `Dockerfile.from-source` onto the pinned ZCodium
revision before the build. Everything the product adds to the runtime lives
here, and nothing else is allowed to drift from upstream: an upstream bump
means refreshing this file, not hunting deltas.

The build also runs `scripts/validate-remote-bridge.mts`: an in-memory,
two-hop round trip (browser channel client → local channel server →
`toService` proxy → remote channel client → remote channel server) proving
that a call and an event subscription survive `exposeOnChannelServer`. That is
the failure class a typecheck cannot see — the bridge once broke exactly there
and every other check stayed green.

## What it contains

| Area | Files | Purpose |
| --- | --- | --- |
| Durable remote sessions | `packages/server/src/remoteSessionRegistry.ts` (new), `packages/server/src/http.ts`, `packages/web/src/main.tsx`, `packages/ui/src/Root.tsx`, `packages/ui/src/root/types.ts`, `packages/ui/src/root/useRemoteWorkspaceHistory.ts` | remote sessions live server-side, keyed by target identity and workspace scope: a browser refresh/close detaches its socket without disposing anything, a re-attach to a live session is instant (dedupe + in-flight coalescing), and the connection dies only via `onDidRemoteClose`, explicit dispose, or server restart. Includes the runtime-preferences bridge (the remote runtime asks its host for session preferences on cold resume — desktop answered, the web server now does too) and the web-only `autoReconnectRemoteWorkspaces` boot flag |
| Remote services bridge | `packages/server/src/remoteBridge.ts` (new), `packages/server/src/http.ts` | `/ws/remote/:id` exposes the full remote channel set (registers the same `ProxyChannel.toService` service proxies `RemoteServiceAccess` builds, so `exposeOnChannelServer` wraps them exactly like local services) instead of four services, and disposes the remote connection when the browser socket closes; `POST /api/dispose-remote/:id` releases an attached connection; ticket ids use `randomUUID` |
| Web remote connect (SSH) | `packages/web/src/main.tsx`, `packages/server/src/http.ts` | `platform.connectRemote` calls `POST /api/connect-remote`, attaches the session over `/ws/remote/<ticket>`, registers it renderer-side with the resolved target; `allowRemoteWorkspace` on for web. The route passes the deploy options desktop gets at compile time — the remote-assets CDN base (env `ZCODE_REMOTE_ASSET_CDN_BASE_URL` override, else the pinned ZCodium release assets) and a data-volume cache dir |
| Wizard: SSH only | `packages/ui/src/hooks/useRemoteConnectionForm.ts`, `packages/ui/src/SSHDialog.tsx`, `packages/ui/src/Root.tsx` | Docker and WSL connect to the machine running the client — desktop only (`isDesktop` gate); the web wizard offers SSH alone |
| Attachment staging | `packages/server/src/attachmentStage.ts` (new), `packages/web/src/main.tsx`, `packages/ui/src/lib/chatAttachments.ts`, `packages/ui/src/v4/composer/useComposerAttachments.ts` | `POST /api/stage-attachment` writes uploads into the agent's own space (dir 0700, file 0600, the desktop temp-text layout) and returns a real path; `createTempTextAttachment` works in web; binary files (zip, docx, …) are staged instead of failing at send. The 20 MiB protocol cap stands |
| MCP settings | `packages/web/src/main.tsx` | `loadMcpFromUserDirectory`/`saveMcpToUserDirectory` delegate to the server-side `mcp-sync` channel (already exposed to web clients): the settings page lists and persists into the agent's `~/.zcode/cli/config.json`. Legacy migration stays a no-op |

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
git clone --branch v3.14.7 https://github.com/ZCodium-project/ZCodium.git /tmp/zc-src
cd /tmp/zc-src
git checkout -b zcloudium-web-remote
# apply the current patches, rebase onto the new release, then:
git format-patch v3.14.8..HEAD --stdout > patches/0001-zcloudium-web-essentials.patch
```
