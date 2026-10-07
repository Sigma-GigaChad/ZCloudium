# Environment and configuration

Every knob of a ZCloudium deployment, with its default and its escape hatch.
The defaults are the opinionated setup described in the
[README](README.md#what-is-on-by-default); everything here is a deliberate
departure from it.

The variables are set in the `environment:` block of the compose file (or
`docker run -e`). Unrecognised values fall back to the default and say so in
the container logs — a typo never silently changes a security position.

## The variables at a glance

| Variable | Default | Controls |
| --- | --- | --- |
| `ZCLOUDIUM_AUTH` | `on` | whether the authentication gateway is in front of the port |
| `ZCLOUDIUM_TLS` | `on` | whether the gateway terminates TLS itself |
| `ZCLOUDIUM_TLS_HOSTS` | *(generated)* | extra names the self-signed certificate must carry |
| `ZCLOUDIUM_SESSION_TTL_HOURS` | `12` | session (and stolen-cookie) lifetime |
| `ZCLOUDIUM_TRUST_PROXY` | `off` | whether `x-forwarded-for` keys the failure block |
| `ZCLOUDIUM_VOLUME_CHECK` | `on` | whether the startup pre-check may refuse to start |
| `HOME` / `ZCODE_DATA_BASE_DIR` | `/data` | where the runtime's state (and skills, memories) lives |
| `ZCODE_SERVER_WORKSPACE` | `/workspace` | the directory the agent works in |
| `ZCODE_MODEL_TELEMETRY_ENABLED` | `0` | the runtime's telemetry, forced off in the image |

## TLS

**The gateway serves https by default**, with a certificate it generates on
first start into `<data>/tls/` and keeps afterwards (it is replaced when it
expires, when it stops naming a host, or when it cannot be read). The
certificate is **ECDSA P-256**: markedly cheaper handshakes than RSA for a
curve every browser agrees on. An existing certificate that still names its
hosts is kept whatever its algorithm.

What the self-signed certificate buys, and it is more than encryption: an
https origin is a **secure context**, which the platform requires for the
clipboard, for service workers, and for the SHA-256 a file is hashed with
before being attached.

The certificate is deliberately broad, because the alternative is an operator
staring at a name mismatch: it carries the loopback names, the machine's own
addresses and hostname, and the private hostname families anyone is likely to
reach it by (`*.local`, `*.lan`, `*.internal`, `*.home.arpa`, `*.home`).

Two things it cannot guess:

- **an address.** A wildcard covers names, never `192.168.51.224`. Declare what
  you browse to:

  ```yaml
  ZCLOUDIUM_TLS_HOSTS: "192.168.51.224,box.example"
  ```

  The certificate is regenerated when the list changes. A browser refuses a
  name the certificate does not carry, and that refusal can be clicked through,
  but declaring it is better.

- **turning it off.** A deployment with a reverse proxy, a WireGuard or
  Tailscale tunnel, or a NAS certificate already terminating TLS says:

  ```yaml
  ZCLOUDIUM_TLS: "off"
  ```

  Two layers doing it is one too many. The startup log states which position is
  in force. Note that with TLS off and no proxy in front, the origin is plain
  http and not a secure context: attaching a file then fails with
  `fault.attachment.checksumUnavailable` on any address except `localhost`,
  because the platform withholds `crypto.subtle` there. The answer is to let
  the gateway, or a proxy in front of it, terminate TLS.

Stated plainly, because the difference matters more than the padlock: the
self-signed certificate **encrypts the connection but does not authenticate
the server**. Against a passive observer it is a real improvement over plain
http; against an active one it is not a defence unless the certificate is
pinned or signed by something the browser trusts. The full reasoning is in
[SECURITY.md](SECURITY.md).

## Authentication

The published port is served by the authentication gateway, which comes with
the image; the runtime itself is bound to `127.0.0.1:3131` inside the container
and reachable only through it.

- **First connection**: the setup wizard asks for a username, a password (at
  least 12 characters), then the enrolment of a TOTP code (RFC 6238), shown as
  a QR code and an `otpauth://` URI. The enrolment page also shows **ten
  recovery codes**: each signs in once in place of the TOTP code. Save them
  when they are shown — they are never displayed again, and only hashes are
  stored (`/data/auth/users.json`, single use, marked as spent).
- **Later connections**: username, password, six digit code. A code cannot be
  replayed (the last accepted step is stored server side). A recovery code, in
  any spelling, is accepted in the same field and works exactly once.
- **Password change** (`/_auth/password`): asks for the current password and
  rotates the session signing key on success — **every** session ends, including
  a cookie stolen before the change. There is no "forgot password" route that
  works without credentials; the last resorts are a recovery code or deleting
  `/data/auth` (which reopens the first-connection window).
- **Accounts** (`/_auth/users`, owner only): the first wizard's account is the
  **owner**; only it creates accounts. Any account uses the interface with the
  same rights — there are no roles beyond account management.
- **GitHub credentials** (`/_auth/github`, owner only): the enrolment page for
  the token that Cloud Environments inherit — see the README's
  [remote work section](README.md#work-from-the-browser-ssh-hosts-and-cloud-environments).
- **Metrics** (`/_auth/metrics`): the Prometheus text format, behind the
  session — failed attempts, blocks, sessions issued, recovery codes used,
  proxied requests. Plain counters, no labels.
- **Sessions**: an HMAC signed cookie, 12 hours by default. Short on purpose:
  that is the window a stolen cookie stays usable. Change it with
  `ZCLOUDIUM_SESSION_TTL_HOURS` (positive number, fractional allowed; anything
  else falls back to 12 with a log line). Restarting the container does not end
  a session (the key lives on the volume); delete `/data/auth/secret.key` to
  invalidate all of them at once.
- **Failure block**: eight failed attempts from one key block that key for five
  minutes, on every gated step (password, code, enrolment, password change), so
  a known password does not leave the second factor walkable. The budget
  expires with the block and is persisted across restarts. The key is the
  connecting socket address unless `ZCLOUDIUM_TRUST_PROXY=on` — see below.
- **Health**: `GET /_auth/health` answers `ok` without a session (what the
  container healthcheck probes). With authentication off, that path falls
  through to the web app and the probe no longer tests anything meaningful;
  both compose files carry a commented override that probes
  `/api/server-info` instead.

### Turning authentication off

```yaml
ZCLOUDIUM_AUTH: "off"
```

The runtime is then published directly on port 3030 with **no authentication**:
anyone who reaches the port gets a shell on the container (as root on the full
access profile). It exists so the previous behaviour stays one variable away,
and it is acceptable only on a trusted network with the port on loopback or a
private interface.

### The failure block and the proxy question

The block is keyed on the connecting socket by default, which is the safe
direction: a client that could choose its key (by setting a header) would have
no limit at all. The cost: behind the Docker port mapping or any NAT that does
not rewrite `x-forwarded-for`, every client shares one key, so eight failures
from anyone lock everybody out for five minutes — a bounded, repeatable denial
of the sign-in page, visible in the logs.

`ZCLOUDIUM_TRUST_PROXY=on` hands the key back to the header. It is only
correct behind a proxy that **overwrites** the header with the address it saw;
a proxy that appends lets an attacker keep choosing the first element.

## Volumes and the startup pre-check

Two paths hold the instance; both must be mounts:

| Path | Holds | Shipped as |
| --- | --- | --- |
| `/data` (`HOME`, `ZCODE_DATA_BASE_DIR`) | accounts, session key, TLS certificate, GitHub credentials, settings, skills, agent configuration | named volume `z-cloudium-data` |
| `/workspace` (`ZCODE_SERVER_WORKSPACE`) | the agent's files: projects, git repositories | named volume `z-cloudium-workspace` |

Before anything else starts, the entrypoint reads the container's mount table
(`/proc/self/mountinfo` — no Docker socket involved) and **refuses to start**
when either path would not survive the container:

- a fresh **anonymous volume** (Docker created it because the `-v` was
  forgotten): the error names the volume to mount, e.g.
  `-v z-cloudium-data:/data`;
- the **bare container filesystem** or **tmpfs** under either path.

An anonymous volume that already carries content (a restarted `docker run`
container reusing its volume) starts with a loud warning — nothing is lost
while that unnamed volume lives, but the warning tells you how to migrate to a
named one. Paths under a bind mount pass (the full access profile puts both
directories under `/host`).

The escape hatch is `ZCLOUDIUM_VOLUME_CHECK=off`, for a deliberately
disposable container; the startup log then states that persistence is not
verified. Where the mount table cannot be read at all (non-Linux host), the
check says so and skips instead of guessing.

### Working on real files

Replace the workspace volume with a bind mount and prepare the ownership
(the container runs as uid 1000):

```yaml
volumes:
  - z-cloudium-data:/data
  - /srv/z-cloudium/workspace:/workspace   # chown 1000:1000 on the host
```

### Backing up and restoring /data

```bash
./backup-data.sh                                      # -> ./z-cloudium-data-<timestamp>.tar.gz
./backup-data.sh --list                               # the backups of the directory
./backup-data.sh --restore z-cloudium-data-...tar.gz  # replaces the volume (stop the container first)
```

The archive is **not encrypted** (scrypt hashes and TOTP secrets inside):
store it where you would store the volume itself. Another volume name: pass it
as the first argument or set `ZCLOUDIUM_DATA_VOLUME`.

## The full access profile

`compose.full-access.yml` mounts the machine's filesystem on `/host` and runs
the agent as root. Three environment details matter there:

- **Your `~/.zcode` again.** Skills, commands and memories resolve through
  `$HOME/.zcode`, so both variables point at the real home:

  ```yaml
  HOME: /host/home/<user>
  ZCODE_DATA_BASE_DIR: /host/home/<user>
  ```

  The agent then sees `~/.zcode/skills`, `~/.zcode/cli` (commands, memories,
  `config.json`) and `~/.zcode/v2` (configuration). Copy your workstation
  `~/.zcode` to that machine to start from your existing environment.

- **Git's protection is lifted for this process only** (as root, git refuses a
  repository owned by another uid):

  ```yaml
  GIT_CONFIG_COUNT: "1"
  GIT_CONFIG_KEY_0: safe.directory
  GIT_CONFIG_VALUE_0: "*"
  ```

- **Files owned by root in your home.** Run as root, the agent creates
  root-owned files in `$HOME/.zcode` (`v2/provider_config.json`, sqlite
  databases, certificates). Your VM user will need `sudo` to modify them.
  That is the consequence of uid 0, not a bug.

What the profile means and costs — snapshots, no infrastructure credentials,
an isolated VLAN — is in [SECURITY.md](SECURITY.md).

## Migrating from a version that carried a `command:` block

The entrypoint builds the runtime's arguments from the environment; a leftover
`command:` block is appended to the entrypoint and **ignored**, with one log
line saying so. In your `compose.local.yml`:

1. delete the whole `command:` block;
2. if it carried a workspace other than `/workspace`, set
   `ZCODE_SERVER_WORKSPACE` to that path;
3. a different port needs no migration: the entrypoint picks the addresses and
   the gateway keeps publishing 3030;
4. `--no-token` needs no migration either: `ZCLOUDIUM_AUTH` decides whether the
   gateway is in front.
