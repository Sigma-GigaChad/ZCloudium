# z-cloudium

**Your ZCode agent, in your browser, in a container that starts already
secured.** One image, two volumes, one port — and the first page you see is a
setup wizard, not a README.

```text
              published port 3030 (https by default)
operator ────────────────────────────────────────────┐
browser                                             ┌┴───────────────┐
 │ password + TOTP                                  │    gateway     │
 └─────────────────────────────────────────────────►│  /_auth/* own  │
                                                    │  pages, CSP,   │
                                                    │  sessions,     │
                                                    │  rate limit    │
                                                    └───────┬────────┘
                                        proxies everything else
                                                    ┌───────▼────────┐
                                                    │  ZCode runtime │
                                                    │  127.0.0.1:3131│
                                                    └───┬────────┬───┘
                                               ┌────────┘        └─────────┐
                                          /data volume        /workspace volume
                                  accounts, session key,   the agent's files:
                                  TLS cert, settings,      projects, git repos
                                  skills, agent config
```

- **A real login page in front of the agent.** Password, TOTP, recovery codes,
  account management, rate limiting, TLS with a certificate generated at first
  start. The runtime itself never touches a published interface: it lives on
  loopback inside the container.
- **An opinionated image: the safe path is the default path.** Volumes are
  required (the container refuses to start without them, instead of silently
  throwing your work away), telemetry is off, the port binds to localhost, and
  the container runs unprivileged with a read-only filesystem.
- **Remote work built in.** From the browser, the agent connects to SSH hosts
  and provisions **Cloud Environments** — disposable dev containers on a
  machine of yours, with a setup script and your GitHub credentials inherited.
  The container stays a sandbox; the heavy work happens where your code lives.

The runtime is the ZCodium fork's, pinned to a release, plus a small reviewed
patch series that enables the remote workspace features
([patches/README.md](patches/README.md)). The gateway is an additive layer:
it imports no application code and an upstream update cannot break it.

## Quick start

The image is public — no clone, no login. Save this as `compose.yaml` in an
empty directory:

```yaml
services:
  z-cloudium:
    image: ghcr.io/sigma-gigachad/z-cloudium:latest
    restart: unless-stopped
    stop_grace_period: 20s
    user: "1000:1000"
    ports:
      - "127.0.0.1:3030:3030"
    volumes:
      - z-cloudium-data:/data
      - z-cloudium-workspace:/workspace
    environment:
      HOME: /data
      ZCODE_DATA_BASE_DIR: /data
      ZCODE_SERVER_WORKSPACE: /workspace
      ZCODE_MODEL_TELEMETRY_ENABLED: "0"
    read_only: true
    tmpfs:
      - /tmp:size=512m,mode=1777
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
    pids_limit: 512
    mem_limit: 4g
    cpus: 2

volumes:
  z-cloudium-data:
  z-cloudium-workspace:
```

```bash
docker compose up -d
```

Open **https://127.0.0.1:3030** (the browser warns once about the self-signed
certificate — see [ENVIRONMENT.md](ENVIRONMENT.md#tls) to bring your own
certificate in front). The setup wizard runs once: username, password, then
enrol a TOTP code in your authenticator. After that, the port asks for the
password and the code before it serves anything.

> **Complete the wizard before anyone else reaches the port.** Until an account
> exists, whoever connects first creates it and owns the instance. Start the
> container, open it from the machine itself, finish the wizard, then publish
> the port. Details in [SECURITY.md](SECURITY.md).

To reach it from another machine of your private network, replace `127.0.0.1`
in the `ports` section with that machine's IP.

## What is on by default

The image is opinionated on purpose: the secure choice should never be the
one you have to discover. Everything in this table has an escape hatch in
[ENVIRONMENT.md](ENVIRONMENT.md) — and every one of them is a decision you can
read, not an accident.

| | Default | Why |
| --- | --- | --- |
| Authentication | password + TOTP, wizard on first start | the agent runs shell commands; the port must not be anonymous |
| TLS | on, ECDSA certificate generated at first start | encryption plus a secure context (clipboard, attachments) |
| Volumes | **required** — the container refuses to start otherwise | work written to a throwaway filesystem is work lost |
| Telemetry | forced off | none of ours to give, none of the runtime's either |
| Port binding | `127.0.0.1` in the shipped compose files | the gateway is the front door; it should not face a network by accident |
| Container | unprivileged, read-only rootfs, `cap_drop: ALL` | a compromise does not persist and has no privileges to use |

## Work from the browser: SSH hosts and Cloud Environments

The wizard's **Remote connection** dialog offers two things beyond the local
workspace:

- **SSH (Remote host)** — the agent connects to any machine you can SSH to and
  works there. From the browser, like from the desktop app.
- **Cloud Environment** — a disposable dev container, provisioned on that SSH
  host at the moment you create it: base image of your choice (default
  `ubuntu:26.04`), an optional setup script that installs whatever the project
  needs, and your GitHub credentials inherited from the container — the
  environment can clone and push the moment it exists. No sshd inside, no
  published port, no Docker credentials on the machine running ZCloudium:
  everything travels through your SSH session. The environment persists
  (dependencies survive between sessions) until you remove it.

GitHub credentials are enrolled **once, in this container**: the owner's menu
has a *GitHub credentials* page, the token is validated against
`api.github.com` and stored on the `/data` volume. Fine-grained tokens work
and limit the blast radius.

## Deployment profiles

Two ways to run it, one philosophy: **the container is a sandbox, and heavy
work happens on a machine reached over SSH — never by widening the container.**

- **Restricted** (`compose.yml`, the default): unprivileged user, read-only
  root filesystem, no capabilities, both directories in named volumes. This is
  the profile to stay on.
- **Full access** (`compose.full-access.yml`): the agent runs as root with the
  machine's filesystem on `/host`. For when the agent must genuinely act on
  the machine that hosts it. What it means, what it costs, and why `sudo` is
  not the mechanism: [SECURITY.md](SECURITY.md).

## Persistence, checked at startup

`/data` (accounts, settings, skills) and `/workspace` (the agent's files) are
the instance. The entrypoint reads the container's mount table before starting
and **refuses to start** if either lives on a throwaway filesystem — including
the anonymous volume Docker silently creates when you forget the `-v`. The
error message states exactly which volume to mount; `ZCLOUDIUM_VOLUME_CHECK=off`
exists for a deliberately disposable container.

Backups are one command: `./backup-data.sh` snapshots `/data`
(`--restore` puts one back; the archive is unencrypted, treat it like the
volume itself).

## Versions and builds

- `latest` on ghcr.io follows the pinned release in `zcode.version`, compiled
  from source with the patch series; CI publishes it on every merge to `main`,
  and the smoke job starts the published image before letting it ship.
- Freeze a version with `image: ghcr.io/sigma-gigachad/z-cloudium:3.14.7`
  (tags: `latest`, `<version>`, `sha-<commit>`).
- `./check-upstream.sh` watches for new releases and opens an issue; `--bump`
  applies one. Bumping includes refreshing the patch series — recipe in
  [patches/README.md](patches/README.md).
- Build it yourself with `./build.sh` (product, from source) — nothing but
  Docker is needed; `--precompiled` exists for checks and refuses `--push`.

## Documentation

| | |
| --- | --- |
| [ENVIRONMENT.md](ENVIRONMENT.md) | every variable: TLS, auth off, session lifetime, proxy trust, volume layout, backups, the volume pre-check |
| [SECURITY.md](SECURITY.md) | what is hardened, what is not, and why — the honest threat model |
| [patches/README.md](patches/README.md) | the runtime patch series and the upstream-bump recipe |
| [e2e/](e2e/) | the 20 Playwright specs that run against the real image |

## What has been verified

Everything above is enforced or tested, not just written: 112 unit tests
(`node --test --test-force-exit`) cover the gateway and the entrypoint
including the volume pre-check; 20 Playwright specs run against the real image
on every push to `main` (wizard, sessions, WebSocket, redirects, throttle);
the CI smoke job starts the published image, checks the gateway, the runtime
version against the tag, the patch-series markers, and that an unmounted
container is refused. The full reasoning about what this cannot fix lives in
[SECURITY.md](SECURITY.md).

## Acknowledgements

The runtime comes from the [ZCodium](https://github.com/ZCodium-project/ZCodium)
fork of `zai-org/ZCode`, which publishes the server distribution the desktop
upstream does not. Its telemetry-removal claims are third party claims about
third party code; the safeguards this project adds (pinned sources, forced
telemetry off, no outbound trust) are verified here.
