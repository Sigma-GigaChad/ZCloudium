# Security

This document describes what is hardened, what is not, and why. It separates two
things that are easily confused: **the image** (what the agent carries) and
**the container** (the rights it is given at launch).

Nothing here can fix the behaviour of ZCode itself: that is third party code
which does not depend on this project. Everything below is about the Docker
wrapper and the gateway shipped with the image.

## Three profiles

| | `compose.yml` (restricted) | `compose.full-access.yml` (full access) | `compose.unsafe.yml` (unsafe) |
| --- | --- | --- | --- |
| User | `1000:1000` (unprivileged) | `root` | `root` |
| Filesystem view | `/workspace` plus the `/data` volume | the whole VM mounted on `/host` | the whole VM, plus its processes and Docker |
| Container rootfs | `read_only` plus tmpfs `/tmp` | writable (see below) | writable (see below) |
| Capabilities | none (`cap_drop: ALL`) | 7 administration capabilities | all of them (`privileged`) |
| Machine namespaces | no (`pid` isolated) | no | shared (`pid: "host"`) |
| Machine's Docker socket | no | commented out | mounted, active |
| Reach of a compromise | the workspace | the whole VM | the whole machine, host included |
| Authentication | on by default | on by default, and it matters most here | on by default, and it matters most here |

The restricted profile is enough for most uses. Full access is a deliberate
choice, with the consequences described further down. The unsafe profile
removes the container boundary itself: `privileged` plus `pid: "host"` means
the agent runs commands on the machine through `nsenter`, installs packages
with the machine's package manager, and controls the machine's containers
through the socket. On that profile there is nothing to elevate to: the agent
already is root of the machine, and the gateway decides only who reaches it.

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

## TLS: what the gateway's own certificate is worth

The gateway serves https by default, with a certificate it generates itself. Stated plainly, because the difference matters more than the padlock:

**It encrypts the connection and it does not authenticate the server.** Nobody
signed that certificate, so a browser warns once and the operator accepts it. An
attacker who can intercept the connection can present their own certificate and
the browser will warn in the same way: the warning becomes the only signal, and a
user trained to click through it has no signal at all. Against a passive observer
on the network it is a real improvement over plain http; against an active one it
is not a defence unless the certificate is pinned or signed by something the
browser already trusts.

**What it does buy, and why it is worth turning on anyway**: an https origin is a
secure context, which the platform withholds over plain http on anything but
localhost. That is what the clipboard, service workers, and the SHA-256 used to
hash an attachment before upload need (see README.md, and app-script.mjs for the
polyfill this makes unnecessary). Encryption of the traffic is the second benefit,
not the first.

**Where it must be turned off**: anywhere something in front already terminates
TLS. A reverse proxy, a WireGuard or Tailscale tunnel, a NAS with its own
certificate: `ZCLOUDIUM_TLS=off` there, because the proxy does the job better, with
a certificate the browser actually trusts. That is the one deployment where the
default is wrong, and it is one variable.

**The names are the trap.** A certificate generated inside the container cannot
name the address the browser uses, and a browser refuses a name the certificate
does not carry even after the warning is accepted. `ZCLOUDIUM_TLS_HOSTS` is how the
operator declares them, and the certificate is regenerated when the list changes.
An operator who turns TLS on without declaring the address they browse to gets a
connection refused, not a warning, which is why this paragraph exists.

## The gateway, honestly

What it does: it authenticates a browser session (password plus TOTP), it keeps
the runtime off every published interface, and it owns the session cookies.

**It also edits one answer: the application's own document.** A script block is
appended before `</body>` of the html the runtime sends, which supplies the
SHA-256 a browser withholds on a non-secure origin (without it, sending a file
fails with `fault.attachment.checksumUnavailable` on every plain `http://` address
except `localhost`). What that means in security terms, stated plainly: the
gateway is not a pure pass-through towards the application's document, the page
the operator loads carries code this project wrote, and that code runs with the
application's own privileges in that tab. It is our own code, it is served from
the same origin behind the same session, it is the only such edit the gateway
makes, and it is asserted by tests that also assert the negative case (with
`insecureHelpers: false`, the document reaches the browser byte for byte). It
grants no new power to anyone: whoever reaches that page already has the panel,
the browser and the whole session. What it does rule out is a claim that the
application's document is untouched, and that claim is not made anywhere any more.

**The one window where it protects nothing: before the wizard is finished.** With
no `/data/auth/users.json`, `POST /_auth/setup` needs no session at all, because
that is what creates the first account. Between the moment the container starts
and the moment somebody completes the wizard, the published port is genuinely
unauthenticated: **whoever connects first creates the account, and therefore owns
the instance**. On the full access profile, that first visitor creates an account
that has root on the host machine. This is not a theoretical window: a container
restarted with an empty or lost data volume, or a first deployment left running
before its wizard was completed, is in exactly that state. What the operator must
do about it:

- complete the wizard immediately after the first start, before exposing the port
  to anything, and treat an unfinished wizard as "the service is open";
- keep the port on loopback, or on a private interface, until the wizard is done;
- check that `/data/auth/users.json` exists on a running deployment: it is the
  only sign that an account was created. If it is missing while the port is
  reachable, the instance is claimable by anyone who reaches it;
- remember that deleting `/data/auth` reopens the window, and that a container
  created without the `/data` volume reopens it on every start.

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
- the failure counter is in memory: restarting the container resets it.

Defaults worth knowing: sessions last 12 hours (set `ZCLOUDIUM_SESSION_TTL_HOURS`
to change it, a positive number of hours, anything else is refused and replaced
by 12 with a log line), a TOTP code that cannot be replayed (the last accepted
step is stored), and a `next` parameter restricted to a same origin path.

### The failure block, and what it is keyed on

Eight failed attempts from one key block that key for five minutes. The block is
checked on all three steps that can be attacked, so it applies to the password,
to the six digit code and to the TOTP enrolment of the first connection. Without
that, a known password would leave the second factor open to be walked through,
six digits at a time.

The five minutes are a bound on the block, and the failure budget expires with
it: the first failure after a block ends starts a fresh count of one, so eight
new failures are needed before the key is blocked again. A key whose count
survived its block would stay at the threshold, and one failure every five
minutes would then keep every client, the operator included, out of the sign in
page for good. What the bound guarantees is that a block always ends and that
the window that follows can be used to sign in, not that nobody can trigger
another one: an attacker who keeps failing can keep re-blocking, as the bullet
below on the global block explains.

**The key is the connecting socket address by default, not a header.** That is
the safe direction and it has a cost:

- a client that could choose its key would have no rate limit at all, since
  changing a header is enough to start again from zero. The gateway therefore
  ignores `x-forwarded-for` unless it is told otherwise, and the file that
  documents `ZCLOUDIUM_TRUST_PROXY=on` is the only place it is read from;
- behind the Docker port mapping, and behind any NAT or reverse proxy that does
  not rewrite the header, every client shares the socket address of the last hop.
  The block is then global: eight failed attempts from anyone lock every user out
  for five minutes. That is a denial of service a stranger can trigger, and it is
  the price of not trusting a header. It is bounded, and the bound is the whole
  of it: five minutes, after which the budget behind the key starts again, so a
  key is never blocked for more than five minutes at a time. It is visible in the
  logs (`[auth] too many failures from <address>`, then one line per refused
  attempt on the code and enrolment steps), and it can be avoided by binding the
  port to loopback and reaching it through a proxy that sets the header, with
  `ZCLOUDIUM_TRUST_PROXY=on`;
- turning `ZCLOUDIUM_TRUST_PROXY=on` means the header decides who is blocked. It
  is only correct when the proxy in front **overwrites** the header with the
  address it saw: if it appends to a client supplied value, an attacker keeps
  choosing the first element of the list, which is the key again.

The `next` parameter is refused unless it is a same origin path: it is rejected
when it carries a backslash (raw or percent encoded), an encoded slash or any
whitespace, and then resolved against a fixed origin, so `/\evil.com` or
`/<tab>/evil.com` cannot become a protocol relative URL. The redirect the gateway
sends is the resolved path, never the value it was given. Dot segment
normalisation gets its own test, because resolving can turn a single leading
slash into two while the origin stays the fixed one: `/..//evil.com` resolves to
`//evil.com`, which a browser reads as another host. A resolved path that starts
with `//` is therefore refused as well.

The session lifetime is what a stolen cookie is worth. Twelve hours is a
deliberate compromise between usability and exposure; on the full access profile
that cookie is worth root on the machine, so raising the value raises the window
during which a cookie taken from a browser, a proxy or a log stays usable.
Restarting the container does not end a session, since the signing key lives in
the volume: delete `/data/auth/secret.key` to invalidate all of them at once
(the next start creates a new key), or `/data/auth` to reset the account as well
and bring the setup wizard back (and reopen the window described above).

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

## The browser panel

The browser panel serves `/_browser/` behind the session: a live view of the
browser the agent drives, a viewport control, and the keyboard and the mouse. It
is on by default, and `ZCLOUDIUM_BROWSER_PANEL=off` turns it off. Stated plainly,
without softening it:

**It hands the agent's browser, with its logged in sessions, to whoever holds a
session.** Not a picture of it: the page itself, its cookies, its open
authenticated tabs, and the ability to type into them. If that browser is signed
into something important, then so is anyone who can sign in to this container. On
the full access and unsafe profiles the session cookie is already worth root, so
the browser adds no new class of power there; on the restricted profile it is the
first capability that reaches outwards with the agent's own credentials rather
than through a shell the agent would have to be asked to run.

**On by default because it is the tool, and one variable turns it off.** The
browser the agent drives, and the panel that watches it, are the point of the web
build rather than an option, so a deployment that exposes this port to anyone but
its operator should say `ZCLOUDIUM_BROWSER_PANEL=off` (both compose files carry
the line, commented) and keep the session as the only thing standing between a
stranger and the agent's browser. With it off no browser is started for the panel,
`/_browser/...` is ordinary application traffic, and nothing observable changes:
the same image carries the same Chromium and the same gateway either way. The
switch decides whether the entrypoint starts a browser, whether the agent's MCP
entry attaches to it instead of launching its own, and whether the gateway knows
the route exists. Enabling it does not add a port: the debug endpoint is bound to
loopback inside the container, and the gateway is the only way in.

### The Origin rule, exactly

The panel is a browser route, so two checks stand in front of it: the session (302
to the sign in page for HTTP, 401 before any upgrade for the WebSocket) and the
Origin.

1. **A request with no `Origin` header is allowed.** Only a browser context sends
   one, and the clients that must keep working send none: the MCP server, the
   automation harness, curl. Refusing them would break the agent, so their absence
   is not treated as a browser that failed to identify itself.
2. **A request that carries one must name the origin of the gateway it arrived
   at**: the scheme comes from the socket, the authority from the `Host` header,
   and both are compared as strings once the authority has been normalised (the
   host lower cased, the scheme's default port dropped, see the next point).
   Another name, another port, another scheme (unless point 3 applies), a path, or
   the literal `null` of an opaque origin are refused with 403. The reason this
   check exists at all: every other service on the operator's loopback is
   same-site, so its pages arrive with the session cookie attached (`SameSite=Lax`
   counts loopback to loopback as same-site), and without a check one of those
   pages could open a control channel into the browser that holds the agent's
   sessions.
3. **Behind a TLS terminating proxy, `ZCLOUDIUM_TRUST_PROXY=on` also accepts the
   `https` variant of the request's own authority.** The proxy speaks TLS to the
   browser and plain HTTP to the container, so the browser sends `https` while the
   gateway serializes `http`, and without the flag the panel would refuse its own
   frontend in the deployment the README recommends. The flag already means "a
   proxy I control is in front", and it widens nothing else: the authority still
   has to be the request's own authority, so a different name or a different port
   is refused with the flag on exactly as with it off. Only the spelling is
   forgiven, and only the two that a browser and a proxy disagree about, because
   `normalizeAuthority` lower cases the host and drops the port that is the
   default for the scheme (`:80` on http, `:443` on https): a proxy configured with
   `$host:$server_port` on an https server appends `:443`, which the browser never
   spells out. With the flag off, the behaviour is exactly the one before the flag
   existed.

**Why the check lives in the gateway and not inside Chromium.** Chromium has its
own defence, and it stays fully closed behind the gateway: it refuses any Origin
it did not generate, which is why the gateway strips the header on the last hop,
where the request comes from the gateway rather than from a page.
`--remote-allow-origins` would be the wrong layer: it names trusted origins
*inside* the browser, so every page served from those origins, including a
compromised one, would reach the debug port directly. The gateway check only lets
through what arrived as its own frontend.

**An established panel connection outlives the session that opened it.** The
gateway checks the session when the WebSocket upgrade is made, not afterwards, so a
panel that is already open keeps working after the cookie expires, until the tab is
closed or the container restarts. What its holder keeps is everything a valid
session has, and it is more than the visible page: the socket carries the browser
level CDP session, so the cookies and the logged in pages of the browser the agent
drives are reachable through it. This is the same property as the application's own
WebSocket, which is authorised once and then left alone, and it is tracked as
follow-up issue #8 rather than fixed here: closing an established connection when
its session ends belongs to the gateway and would change the behaviour of the
application's own socket too.

**What the panel does not change.** It does not patch the application, does not
add a dependency, and does not widen the container's reach: it uses the same
Chromium, the same uid and the same volumes as the rest of the agent's work. The
one thing it adds to the filesystem is the browser profile (see the README for
where that lands per profile), and the one thing it removes on startup is
Chromium's own `SingletonLock` when it names another machine.

## Residual risks

Read this before launching the full access profile.

1. **The window before the wizard is finished is unauthenticated, and it is the
   biggest of these risks.** A container whose `/data/auth/users.json` does not
   exist yet answers the setup wizard without any credential: the first visitor
   creates the account and owns the instance. On this profile, that account has
   root on the machine. An empty, lost or freshly recreated data volume puts a
   running container back into that state, and so does deleting `/data/auth`.
   Complete the wizard immediately after the first start, keep the port off every
   untrusted network until it is done, and verify that `users.json` exists on a
   deployment that is exposed. See "The one window where it protects nothing" in
   the gateway section above.
2. **A full access container is a root session with a web interface.** The
   gateway is the barrier on the port; the private interface is the second layer.
   Binding on the private IP assumes that the private network is genuinely
   trusted (dedicated VLAN, WireGuard, Tailscale). Dropped capabilities change
   nothing there: root on a mounted filesystem is enough.
3. **The failure block is keyed on the connecting socket, so behind NAT it is
   global.** Eight failed attempts from anyone block every client for five
   minutes: a stranger can deny the sign in page, not the data. Each block ends
   after those five minutes and the budget starts again, so the denial is
   repeatable but never permanent: an attacker who keeps failing can keep
   re-blocking, and the window between two blocks is when the operator can sign
   in. The alternative, trusting `x-forwarded-for`, hands the choice of the key
   back to the client and removes the limit. The section above spells out both
   directions.
4. **The VM must be disposable.** Treat it as a machine compromised by design:
   no infrastructure credentials, no access to the rest of the fleet, no SSH keys
   reused elsewhere. If it falls, nothing else does.
5. **Files owned by root in your home.** Verified in testing: run as root, the
   agent creates root owned files in `$HOME/.zcode`
   (`v2/provider_config.json`, sqlite databases, certificates), and the entrypoint
   merges the browser MCP entry into `$HOME/.zcode/cli/config.json` (keeping a
   `config.json.zcloudium-backup` copy of the previous file). Your VM user will
   no longer be able to modify them without `sudo`. That is the price of uid 0,
   not a bug.
6. **Network egress is not filtered.** The agent can reach everything the VM
   reaches. The control that really counts against exfiltration is at the network
   level (VLAN, outbound firewall rules), not inside the container.
7. **The runtime comes from a third party** (the ZCodium fork). Integrity is
   verified by a pinned hash, the presence of setuid binaries is checked, but the
   code has not been audited. If that is not acceptable, `Dockerfile.from-source`
   compiles the original upstream, a path that is not validated to this day.
8. **The API key lives in the volume** (`/data` or `$HOME/.zcode`), in clear
   text, and the container can read it. That is inherent to a tool that must use
   it.
9. **Web mode has no multi-user management**: no accounts beyond the single
   gateway account, no audit log of the agent's actions, no per-user isolation.
8. **The browser sandbox is off** (see the previous section). Point the browser
   at pages you trust, or do not enable it.
9. **The baked browser MCP server is third party code** (`chrome-devtools-mcp`,
   pinned version), driven by the agent over stdio. It shares the container with
   the agent, and therefore has the same rights. Its published defaults that send
   usage statistics and performance data to Google are disabled at launch.
10. **With the browser panel on, a session is the agent's browser.** The panel is
   off by default; turned on, it gives `/_browser/` to anyone who signs in, and
   through it the live page, the cookies and the logged in sessions of the browser
   the agent drives. The Origin rule above keeps other services on the same
   loopback from reaching it, but it does not change what a session is worth: see
   the panel section for the exact boundary and for the one file it removes on
   startup (Chromium's `SingletonLock`, only when it names another machine).

## Recommendations

- **Finish the wizard before anything can reach the port.** On a first start,
  open it from the machine itself (or over a tunnel), create the account, and
  only then expose the port to the private network. An instance with the wizard
  still open is an instance anyone can claim.
- **Snapshot the VM before the first use** and before letting the agent work
  unsupervised.
- Start with the restricted profile; move to full access only for a real need.
- Dedicated VM, on an isolated VLAN, without credentials to the rest of the
  infrastructure.
- Keep `ZCLOUDIUM_AUTH=on`. If you must turn it off, publish the port on
  loopback only, and remember that the container healthcheck then probes the web
  app instead of the gateway.
- Leave `ZCLOUDIUM_TRUST_PROXY` off unless a reverse proxy you control overwrites
  `x-forwarded-for`, and remember that with it off every client behind the same
  last hop shares one block.
- Keep `ZCLOUDIUM_BROWSER_PANEL` on only where the session is as protected as the
  browser it exposes, and turn it off where it is not: it makes a stolen cookie
  worth the agent's logged in sessions, and behind a TLS terminating proxy it
  needs `ZCLOUDIUM_TRUST_PROXY=on` to accept the panel's own frontend.
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
