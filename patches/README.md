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
| Remote services bridge | `packages/server/src/remoteBridge.ts` (new), `packages/server/src/http.ts` | `/ws/remote/:id` exposes the full remote channel set (registers the same `ProxyChannel.toService` service proxies `RemoteServiceAccess` builds, so `exposeOnChannelServer` wraps them exactly like local services) instead of four services, and disposes the remote connection when the browser socket closes; `POST /api/dispose-remote/:id` releases an attached connection; ticket ids use `randomUUID` |
| Web remote connect | `packages/web/src/main.tsx` | `platform.connectRemote` calls `POST /api/connect-remote`, attaches the session over `/ws/remote/<ticket>`, registers it renderer-side with the resolved target (a history reconnect reuses the same container); a failed connect after provisioning removes the environment; `allowRemoteWorkspace` and `supportsCloudEnvironments` on for web |
| Cloud environments | `packages/server/src/cloudEnvironments.ts` (new) | `POST /api/cloud-environments` provisions a disposable dev container on an SSH host (default `ubuntu:26.04`), runs the setup script, propagates the gateway's stored GitHub credentials (the container's own `$HOME/.config/gh/hosts.yml`; a hosts.yml on the SSH host is the fallback); `DELETE` removes it |
| Container transport | `packages/server/src/remote/sshDockerBackend.ts` (new), `packages/server/src/remote/create-backend.ts`, `packages/shared/src/remoteTarget.ts`, `packages/shared/src/validation.ts` | the runtime runs inside a container on the SSH host (`docker exec` over the operator's SSH session), selected with the optional `dockerContainer` field (validated as a name or id, never a flag) |
| Platform contract | `packages/shared/src/platform.ts` | optional `supportsCloudEnvironments`: the wizard hides the Cloud Environment card on platforms that do not declare it (desktop would silently ignore provisioning) |
| Wizard | `packages/ui/src/hooks/useRemoteConnectionForm.ts`, `packages/ui/src/lib/remoteConnectionWizard.ts`, `packages/ui/src/RemoteConnectionDialogContent.tsx`, `packages/ui/src/SSHDialog.tsx`, `packages/ui/src/i18n/locales/en-US.ts`, `packages/ui/src/i18n/locales/zh-CN.ts`, `packages/shared/src/test-ids.ts` | the Docker card becomes **Cloud Environment** on capable platforms: same SSH host and credential fields, plus a base image and an optional setup script |

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
git format-patch v3.14.8..HEAD --stdout > patches/0001-zcloudium-web-remote-and-cloud-environments.patch
```
