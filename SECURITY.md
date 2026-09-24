# Security

This document describes what is hardened, what is not, and why. It separates two
things that are easily confused: **the image** (what the agent carries) and
**the container** (the rights it is given at launch).

Nothing here can fix the behaviour of ZCode itself: that is third party code
which does not depend on this project. Everything below is about the Docker
wrapper and the gateway shipped with the image.

## Two profiles

| | `compose.yml` (restricted) | `compose.full-access.yml` (full access) |
| --- | --- | --- |
| User | `1000:1000` (unprivileged) | `root` |
| Filesystem view | `/workspace` plus the `/data` volume | the whole VM mounted on `/host` |
| Container rootfs | `read_only` plus tmpfs `/tmp` | writable (see below) |
| Capabilities | none (`cap_drop: ALL`) | 7 administration capabilities |
| Reach of a compromise | the workspace | the whole VM |
| Authentication | on by default | on by default, and it matters most here |

The restricted profile is enough for most uses. Full access is a deliberate
choice, with the consequences described further down.

## What is hardened

### In the image (`Dockerfile`)

- **Base image pinned by digest**: `node:24.14.0-bookworm-slim@sha256:d8e448a5...`.
  A republished tag cannot silently change the content of the build.
- **Runtime verified against the sha256 pinned in this repository**
  (`zcode.sha256`). An upstream release modified after the fact fails the build
  instead of going unnoticed.
- **Build refused if the third party runtime carries a setuid/setgid binary.**
  The tarball is third party code: a setuid there would be an elevation vector,
  so the build stops when `find ... -perm -4000 -o -perm -2000` reports
  something. The scan covers the runtime directory on purpose: Chromium's setuid
  helper is distribution packaged, and `no-new-privileges` neutralises it anyway.
- **No build toolchain** in the final image: no pnpm, no compiler, no Electron.
  Less surface, fewer CVEs to follow. The browser MCP server is installed at
  build time, so no package manager is needed at runtime either.
- **Unprivileged `node` user by default.** The full access profile replaces it
  with root explicitly: that is a launch decision, not a default inherited from
  the image.
- **Authentication gateway in front of the published port.** Not an
  application change: a separate process, which owns `/_auth/*`, requires a
  password plus a TOTP code, and proxies everything else. The runtime is bound
  to loopback inside the container, so the gateway is the only way in.
- **Telemetry forced off** (`ZCODE_MODEL_TELEMETRY_ENABLED=0`), and the browser
  MCP server is started with `--no-usage-statistics --no-performance-crux`,
  which disables the upstream defaults that would send data to Google.
- `APT` without recommendations, lists removed, `pipefail` active in the build
  shell.

### In the container (both profiles)

- **`no-new-privileges:true`**: forbids any elevation through a setuid binary or
  a file capability, including from the mounted filesystem.
- **`cap_drop: [ALL]`** then explicit addition of the minimum. Docker grants
  useless capabilities by default; the following are now absent: `NET_RAW`
  (packet forgery), `SYS_ADMIN`, `SYS_MODULE`, `SYS_PTRACE`, `MKNOD`, `SETFCAP`,
  `AUDIT_WRITE`, `SYS_CHROOT`.
- **Resource limits**: `pids_limit` (anti fork bomb), `mem_limit`, `cpus`. An
  agent that runs away must not take the VM down. Browser automation adds a
  handful of Chromium processes and its own memory: raise these two when a heavy
  page reaches them.
- **No `privileged`, no Docker socket by default.** The socket is commented out:
  mounting it is equivalent to root on the host.
- **Port published on a single private interface.** Never `3030:3030`.

### What is deliberately *not* applied

- **`read_only` on the full access profile.** With root on `/host`, an attacker
  persists in the VM's `/etc` anyway (systemd units, cron, `authorized_keys`).
  `read_only` would prevent nothing and would break legitimate use, `apt install`
  inside the container in particular. Applying it there would be cosmetic
  hardening. The restricted profile applies it, and it costs nothing there.
- **Capabilities reduced to the point of making root inoperative.** Removing
  `DAC_OVERRIDE` or `CHOWN` would break an ordinary `apt install` or `chown`:
  the tool would be degraded without containing anything, since the VM
  filesystem stays mounted.

## The gateway, honestly

What it does: it authenticates a browser session (password plus TOTP), it keeps
the runtime off every published interface, and it owns the session cookies.

What it does not do:

- it is not a sandbox: once you are authenticated, you get exactly what the
  runtime offers, including a shell through the agent;
- it is not a multi-user system: one instance, one account. There is no account
  management interface, no password reset, no audit log of what the agent does;
- it only speaks HTTP over a plain socket. **Put TLS in front of it** if the port
  is reachable from a network you do not fully trust (a reverse proxy, a
  WireGuard or Tailscale interface); otherwise the password and the TOTP code
  travel in clear text;
- its accounts live in `/data/auth/users.json` (scrypt hashes, TOTP secrets,
  mode 0600) and its signing key in `/data/auth/secret.key`. Anyone who can read
  the volume can run the instance, and can also add an account;
- the failure counter (8 failures, then five minutes blocked per source address)
  is in memory: restarting the container resets it.

Defaults worth knowing: 12 hour sessions, a TOTP code that cannot be replayed
(the last accepted step is stored), and a `next` parameter restricted to
same-origin paths, so it cannot be turned into an open redirect.

`ZCLOUDIUM_AUTH=off` removes the gateway entirely: the runtime is published
directly, with `--no-token`, so **anyone who reaches the port gets a shell on
the container**, as root in the full access profile. It exists so that the
behaviour of the previous image can be restored with one variable, without
rebuilding anything. On a trusted network, with a restrictive bind address, it
is a reasonable choice. Anywhere else, it is not.

## Browser automation: the sandbox is weakened, and here is the price

Inside the container, Chromium is started with `--no-sandbox`. That is not a
preference, it is the consequence of the hardening applied above, verified in
the built image:

```
$ chromium --headless --screenshot=... about:blank
[...] No usable sandbox! If this is a Debian system, please install the
chromium-sandbox package to solve this problem. [...]
```

- capabilities are dropped (`cap_drop: ALL`), so the setuid helper cannot gain
  anything;
- `no-new-privileges` disables the setuid transition and the namespace sandbox
  route, even if a helper is present;
- with the sandbox on, Chromium simply refuses to start, so without
  `--no-sandbox` there is no browser at all.

**What that costs**: a malicious page can escape the renderer and run code as
the container user, without passing through Chromium's own sandbox.

**Why it is nonetheless contained**: that code lands as uid 1000, with no
capability, no-new-privileges, a read-only root filesystem in the restricted
profile, and a writable area limited to `/data`, `/workspace` and `/tmp`. In
other words, exactly the rights the agent already has through its own shell
tool: the browser does not grant new reach. What changes is that a page becomes
as dangerous as a command, so the rule to keep is simple: **do not point the
browser at untrusted pages**, and keep network egress under control (the real
exfiltration control is the network: VLAN, firewall rules), because the browser
and the agent can both reach everything the machine reaches.

In the full access profile the calculus is different and worse: code that escapes
the renderer runs as root, with the machine's filesystem mounted on `/host`. The
escape itself is harder to reach through a browser than a shell command, but the
profile already grants that level of power to the agent, so the browser does not
change the class of risk: it adds a path that a web page, not a prompt, can
exercise. Keep that machine disposable.

## Residual risks

Read this before launching the full access profile.

1. **A full access container is a root session with a web interface.** The
   gateway is the barrier on the port; the private interface is the second layer.
   Binding on the private IP assumes that the private network is genuinely
   trusted (dedicated VLAN, WireGuard, Tailscale). Dropped capabilities change
   nothing there: root on a mounted filesystem is enough.
2. **The VM must be disposable.** Treat it as a machine compromised by design:
   no infrastructure credentials, no access to the rest of the fleet, no SSH keys
   reused elsewhere. If it falls, nothing else does.
3. **Files owned by root in your home.** Verified in testing: run as root, the
   agent creates root owned files in `$HOME/.zcode`
   (`v2/provider_config.json`, sqlite databases, certificates), and the entrypoint
   merges the browser MCP entry into `$HOME/.zcode/cli/config.json` (keeping a
   `config.json.zcloudium-backup` copy of the previous file). Your VM user will
   no longer be able to modify them without `sudo`. That is the price of uid 0,
   not a bug.
4. **Network egress is not filtered.** The agent can reach everything the VM
   reaches. The control that really counts against exfiltration is at the network
   level (VLAN, outbound firewall rules), not inside the container.
5. **The runtime comes from a third party** (the ZCodium fork). Integrity is
   verified by a pinned hash, the presence of setuid binaries is checked, but the
   code has not been audited. If that is not acceptable, `Dockerfile.from-source`
   compiles the original upstream, a path that is not validated to this day.
6. **The API key lives in the volume** (`/data` or `$HOME/.zcode`), in clear
   text, and the container can read it. That is inherent to a tool that must use
   it.
7. **Web mode has no multi-user management**: no accounts beyond the single
   gateway account, no audit log of the agent's actions, no per-user isolation.
8. **The browser sandbox is off** (see the previous section). Point the browser
   at pages you trust, or do not enable it.
9. **The baked browser MCP server is third party code** (`chrome-devtools-mcp`,
   pinned version), driven by the agent over stdio. It shares the container with
   the agent, and therefore has the same rights. Its published defaults that send
   usage statistics and performance data to Google are disabled at launch.

## Recommendations

- **Snapshot the VM before the first use** and before letting the agent work
  unsupervised.
- Start with the restricted profile; move to full access only for a real need.
- Dedicated VM, on an isolated VLAN, without credentials to the rest of the
  infrastructure.
- Keep `ZCLOUDIUM_AUTH=on`. If you must turn it off, publish the port on
  loopback only, and remember that the container healthcheck then probes the web
  app instead of the gateway.
- Mount `docker.sock` only if the agent must drive containers, and knowing that
  it is equivalent to root on the host.
- Put TLS in front of the port if the network is not fully trusted: the gateway
  has no TLS of its own.

## Reproducible checks

```bash
./check-full-access.sh    # uid 0, /etc/shadow, filesystem write, $HOME/.zcode, git
./check-upstream.sh       # pinned version against the latest release
```

The hardening of both profiles has been verified by running them:

| Check | Restricted | Full access |
| --- | --- | --- |
| HTTP response of the interface | 302 to the login page | 302 to the login page |
| `GET /_auth/health` | 200 `ok` | 200 `ok` |
| `Config.User` | `1000:1000` | `root` |
| `ReadonlyRootfs` | `true` | `false` (deliberate) |
| `CapDrop` | `[ALL]` | `[ALL]` |
| `CapAdd` | none | 7 administration capabilities |
| `SecurityOpt` | `no-new-privileges:true` | `no-new-privileges:true` |
| `PidsLimit` | 512 | 1024 |
| Reading `/etc/shadow` | not reachable | OK |
| Writing on the mounted filesystem | not reachable | OK |
| Writing in the `/data` volume | OK (session key, accounts) | OK |
| Skills visible through `$HOME/.zcode` | volume | OK |
