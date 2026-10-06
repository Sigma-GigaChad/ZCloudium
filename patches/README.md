# The z-cloudium patch series

One patch file, applied by `Dockerfile.from-source` onto the pinned ZCodium
revision before the build. Everything the product adds to the runtime lives
here, and nothing else is allowed to drift from upstream: an upstream bump
means refreshing this file, not hunting deltas.

## What it contains

| Area | Files | Purpose |
| --- | --- | --- |
| Remote services bridge | `packages/server/src/remoteBridge.ts` (new), `packages/server/src/http.ts` | `/ws/remote/:id` exposes the full remote channel set (mirrors `RemoteServiceAccess`) instead of four services, and disposes the remote connection when the browser socket closes; `POST /api/dispose-remote/:id` releases an attached connection |
| Web remote connect | `packages/web/src/main.tsx` | `platform.connectRemote` calls `POST /api/connect-remote`, attaches the session over `/ws/remote/<ticket>`, registers it renderer-side; `allowRemoteWorkspace` enabled for web |
| Cloud environments | `packages/server/src/cloudEnvironments.ts` (new) | `POST /api/cloud-environments` provisions a disposable dev container on an SSH host (default `ubuntu:26.04`), runs the setup script, copies the host's gh credentials in; `DELETE` removes it |
| Container transport | `packages/server/src/remote/sshDockerBackend.ts` (new), `packages/server/src/remote/create-backend.ts`, `packages/shared/src/remoteTarget.ts`, `packages/shared/src/validation.ts` | the runtime runs inside a container on the SSH host (`docker exec` over the operator's SSH session), selected with the optional `dockerContainer` field |
| Wizard | `packages/ui/src/hooks/useRemoteConnectionForm.ts`, `packages/ui/src/lib/remoteConnectionWizard.ts`, `packages/ui/src/RemoteConnectionDialogContent.tsx`, `packages/ui/src/SSHDialog.tsx`, `packages/ui/src/i18n/locales/en-US.ts`, `packages/ui/src/i18n/locales/zh-CN.ts`, `packages/shared/src/test-ids.ts` | the Docker card becomes **Cloud Environment**: same SSH host and credential fields, plus a base image and an optional setup script |

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
