# z-cloudium

**ZCode Web in a container, ready to run.** A hardened, versioned and published
image, behind a password plus a TOTP code, with no toolchain to install: no
pnpm, no Node, no compilation.

The name is a pun: ZCodium (the fork the runtime comes from) plus cloud. The
project exists because upstream `zai-org/ZCode` **publishes no server binary**
(desktop installers only), which would otherwise mean compiling the whole
monorepo for every version.

```text
                published port 3030 (https by default)
  operator ─────────────────────────────────────────────┐
  browser                                             ┌─┴──────────────┐
   │ password + TOTP                                  │     gateway    │
   └────────────────────────────────────────────────► │  /_auth/* own  │
                                                      │  pages, CSP    │
                                                      │  sessions,     │
                                                      │  rate limit    │
                                                      └───────┬────────┘
                                           proxies everything else
                                                      ┌───────▼────────┐
                                                      │  ZCode runtime │
                                                      │  on 127.0.0.1  │
                                                      │  :3131 only    │
                                                      └───┬────────┬───┘
                                                 ┌────────┘        └─────────┐
                                            /data volume       /workspace volume
                                    accounts, session key,   the agent's files:
                                    TLS cert, settings,      projects, git repos
                                    skills, agent config
```

The gateway is an additive layer: it imports no application code, never edits a
runtime answer, and an upstream update cannot break it.

## Quick start

No clone, no login: the image is public. Save this as `compose.yaml` in an
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
      ZCLOUDIUM_AUTH: "on"
      ZCLOUDIUM_SESSION_TTL_HOURS: "12"
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

Interface: **https://127.0.0.1:3030** (a self-signed certificate the gateway
generates: the browser warns once, see [TLS](#tls-terminated-here-or-in-front)).
The first connection runs the setup
wizard: choose a username, a password, then enrol the TOTP code in your
authenticator application. After that, the port asks for the password and the
code before it serves anything.

> **Finish the wizard before the port is reachable by anyone else.** As long as no
> account exists, the setup wizard answers without any credential: whoever
> connects first creates the account, and that account owns the instance. On the
> full access profile, that account has root on the machine. So start the
> container, open the interface from the machine itself, complete the wizard, and
> only then publish the port to a private network. An instance left with its
> wizard unfinished, a container whose `/data` volume was recreated, or a
> deployment where `/data/auth` was deleted, is open to whoever reaches it. See
> [SECURITY.md](SECURITY.md).

That is all. The default compose file needs **no editing**: port on localhost,
workspace in a Docker volume, hardening active, authentication on. The account,
the session key and the API key are written into the volume, so they survive
container recreations.

To reach it from another machine of the private network, replace `127.0.0.1`
with that machine's IP in the `ports` section of the compose file above.

### Without compose

```bash
docker run -d --name z-cloudium \
  -p 127.0.0.1:3030:3030 \
  -v z-cloudium-data:/data \
  --read-only --tmpfs /tmp:size=512m \
  --security-opt no-new-privileges:true \
  --cap-drop ALL \
  ghcr.io/sigma-gigachad/z-cloudium:latest
```

The `--read-only` flag works because the gateway writes only into the `/data`
volume: that is verified before every release, not assumed.

### Pin a version

`latest` follows the latest release. To freeze it:

```yaml
image: ghcr.io/sigma-gigachad/z-cloudium:3.14.7
```

The available tags are `latest`, `<version>` (for example `3.14.7`) and
`sha-<commit>`.

### The image is public

The GHCR package is public (the repository stays private), so `docker pull`
works without any authentication. That was verified with an anonymous pull, and
it is what makes the copy-paste quick start work as is.

### Working on real files

By default the workspace is a Docker volume, so that `docker compose up -d`
works with no preparation. To give the agent access to a directory of the
machine, comment the `z-cloudium-workspace` volume out of `compose.yml` and
replace it with a bind mount, after a `chown 1000:1000` on the host (the
container runs as uid 1000):

```yaml
- /srv/z-cloudium/workspace:/workspace
```

### Backing up and restoring /data

`/data` holds the accounts, the session signing key, the TLS certificate, the
settings, the skills and the agent configuration: it is the instance.
`backup-data.sh` snapshots it through a throwaway container and restores it
back:

```bash
./backup-data.sh                                      # -> ./z-cloudium-data-<timestamp>.tar.gz
./backup-data.sh --list                               # the backups of the directory
./backup-data.sh --restore z-cloudium-data-...tar.gz  # replaces the volume (stop the container first)
```

The archive is **not encrypted** (it contains scrypt hashes and TOTP secrets):
store it where you would store the volume itself. On another name than
`z-cloudium-data`, pass the volume as the first argument or set
`ZCLOUDIUM_DATA_VOLUME`.

## Authentication

The published port is served by an authentication gateway, which comes with the
image. The runtime itself is bound to `127.0.0.1:3131` inside the container and
is reachable only through that gateway.

- **First connection**: the setup wizard asks for a username, a password (at
  least 12 characters), then the enrolment of a TOTP code (RFC 6238), displayed
  as a QR code and as an `otpauth://` URI for your authenticator application.
  The enrolment page also shows **ten recovery codes**: each one signs in once
  in place of the TOTP code. Save them when they are shown, because they are
  never displayed again, and only their hashes are stored (in
  `/data/auth/users.json`, single use, each one marked as it is spent).
- **Later connections**: username and password, then the six digit code. A code
  cannot be replayed: the last accepted step is stored server side. A recovery
  code (in any spelling: dashes, spaces, lower case) is accepted in the same
  field and works exactly once.
- **Password change**: `/_auth/password`, behind the session, asks for the
  current password. On success the session signing key is rotated, so **every**
  session ends at that moment, including the one that made the change and any
  cookie stolen before it: the answer to a leaked cookie is to change the
  password. There is still no "forgot password" route that works without the
  current credentials; the last resorts are a recovery code (if the
  authenticator, not the password, was lost) or deleting `/data/auth`.
- **Accounts**: the account created by the first wizard is the **owner**, and
  only it can create further accounts (`/_auth/users`, behind its session). The
  owner enrols the new account and relays its authenticator secret and recovery
  codes; the new user then signs in and is expected to change the password. Any
  account can use the interface with the same rights; there are no per-account
  roles or restrictions beyond account management being owner-only. Stored in
  `/data/auth/users.json` (scrypt hashes, TOTP secrets, hashed recovery sheets,
  owner flag, mode 0600). The session signing key is `/data/auth/secret.key`.
  Removing `/data/auth` resets the whole thing and the wizard runs again, which
  reopens the first connection window: until the wizard is finished again,
  anyone can claim the instance.
- **Metrics**: `/_auth/metrics`, behind the session, answers the Prometheus
  text format: failed attempts, blocks applied, sessions issued, recovery codes
  used, requests proxied to the runtime and cumulative proxying time. It is for
  an operator reading it (or scraping it) rather than a dashboard: plain
  counters, no labels, no histograms.
- **Sessions**: an HMAC signed cookie, **12 hours by default**. The lifetime is
  the window during which a stolen cookie stays usable, so it is short on
  purpose, and on the full access profile that cookie is worth root on the
  machine. Change it with `ZCLOUDIUM_SESSION_TTL_HOURS` (a positive number of
  hours, fractional allowed); any value that is not a positive number is refused
  and replaced by 12, with a line in the logs saying so. Closing the browser does
  not end the session, and neither does restarting the container: delete
  `/data/auth/secret.key` to invalidate every session at once (the next start
  creates a new signing key, so every existing cookie stops verifying), or
  `/data/auth` to reset the account and the sessions together, which brings the
  setup wizard back. Changing a password rotates the key automatically.
- **Failures**: eight failed attempts from the same key block that key for five
  minutes, and the limit applies to every gated step (the password, the six digit
  code, the TOTP enrolment of the first connection, and the current password of
  the change form), so a known password does not leave the code open to be
  walked through. The block is a real bound: the failure budget expires with it,
  so the first failure after a block ends starts a fresh count and eight new
  failures are needed before the key is blocked again. A failed attempt every
  five minutes therefore cannot keep a key blocked for good. The budget is
  persisted in `/data/auth/failures.json`, so restarting the container does not
  reset it. The key is the connecting socket address: the `x-forwarded-for`
  header is ignored unless you set `ZCLOUDIUM_TRUST_PROXY=on`, which is only
  correct behind a proxy that overwrites that header. Behind the Docker port
  mapping every client shares one socket address, so the block is global: eight
  failures from anyone lock everybody out for five minutes. That is a denial of
  service, bounded to one block of five minutes at a time and visible in the
  logs, and it is the price of not letting a client choose its own key. Details
  in [SECURITY.md](SECURITY.md).
- **Health**: `GET /_auth/health` answers `ok` without a session, which is what
  the container healthcheck uses. With `ZCLOUDIUM_AUTH=off` there is no gateway
  and that path falls through to the web app, which answers 200 with the
  interface shell: the container still reports healthy, but the probe no longer
  tests the gateway (both compose files carry a commented override that probes
  `/api/server-info` instead).

### Turning authentication off

`ZCLOUDIUM_AUTH=off` restores the previous behaviour of the image: the runtime
is published directly on port 3030, with `--no-token`, and **no
authentication**. It is useful for a first look and for the full access profile
on a trusted network, and it is a one variable decision:

```yaml
environment:
  ZCLOUDIUM_AUTH: "off"
```

Anyone who reaches the port then gets a shell on the container, as root in the
full access profile. Keep it on a private network, or turn it back on.

### Upgrading from a version that carried a `command:` block

Before the gateway, both compose files ended with a `command:` list holding the
runtime arguments (`--web --host=0.0.0.0 --port=3030 --workspace=... --no-open
--no-token`), and the README invited you to copy that file to
`compose.local.yml` and adapt it. The entrypoint now builds those arguments
itself, so a `command:` block kept from that version is **appended to
`start.mjs` and ignored**: the container starts, uses the environment instead,
and logs one line saying so:

```
[start] ignoring the extra command line arguments (--web --host=0.0.0.0 ...): the workspace, the addresses and the data directory come from the environment.
```

What to do, in your `compose.local.yml`:

1. delete the whole `command:` block;
2. if it carried a workspace other than `/workspace`, set
   `ZCODE_SERVER_WORKSPACE` to that path instead;
3. if it carried a different loopback port, nothing needs migrating: the
   entrypoint picks the addresses, the gateway keeps publishing 3030;
4. if it carried `--no-token`, nothing to do either: the entrypoint passes it to
   the runtime on loopback, and `ZCLOUDIUM_AUTH` decides whether the gateway is
   in front.

In the full access profile there is one more consequence: the workspace is no
longer a command line argument but `ZCODE_SERVER_WORKSPACE`, which that file now
sets to `/host/home/<user>`. Without it the image default `/workspace` wins, and
the agent works in a throwaway path inside the container instead of your home on
the machine.

## TLS, terminated here or in front

**The gateway serves https by default**, with a certificate it generates on first
start into `<data>/tls/` and keeps afterwards (it is replaced when it expires, when
it stops naming a host, or when it cannot be read). The certificate is **ECDSA
P-256**: the handshakes are markedly cheaper in CPU than RSA's for a curve every
browser agrees on. A certificate that is already on a volume and still names its
hosts is kept whatever its algorithm, so an RSA certificate from an older
deployment is not force-replaced. Nobody has to ask for an
encrypted connection, and nobody has to think about it.

What that buys, and it is more than encryption: an https origin is a **secure
context**, which is what the platform requires for the clipboard, for service
workers, and for the SHA-256 a file is hashed with before being attached.

The certificate is deliberately broad, because the alternative is an operator
staring at a name mismatch: it carries the loopback names, the machine's own
addresses and hostname, and the private hostname families anyone is likely to
reach it by (`*.local`, `*.lan`, `*.internal`, `*.home.arpa`, `*.home`). A hostname
in one of those families is therefore covered without declaring anything.

Two things it cannot guess, and both are what the optional variables are for:

- **an address.** A wildcard covers names, never `192.168.51.224`. Declare what you
  browse to: `ZCLOUDIUM_TLS_HOSTS="192.168.51.224,box.example"`. The certificate is
  regenerated when the list changes. A browser refuses a name the certificate does
  not carry, and that refusal can be clicked through, but declaring it is better;
- **turning it off.** A deployment with a reverse proxy, a WireGuard or Tailscale
  tunnel, or a NAS certificate already terminating TLS says `ZCLOUDIUM_TLS=off`:
  two layers doing it is one too many. The startup log says which position is in
  force, so nobody has to guess. Note that with TLS off and no proxy in front, the
  origin is plain http and not a secure context: attaching a file then fails with
  `fault.attachment.checksumUnavailable` on any address except `localhost`, because
  the platform withholds `crypto.subtle` there. That is the platform's rule, not a
  fault of the runtime; the answer is to let the gateway, or a proxy in front of
  it, terminate TLS.

## The host filesystem, with full access (root)

`compose.full-access.yml` runs the agent as root with the whole filesystem of
the machine mounted on `/host`: it can read and write anywhere, including
`/etc`, `/var` and `/root`.

```bash
./check-full-access.sh                        # checks the mechanisms (throwaway image)
cp compose.full-access.yml compose.local.yml  # adapt the port and the paths
docker compose -f compose.local.yml up -d
```

**What that means concretely**, since it is a use case this project supports on
purpose:

- the agent edits any file of the machine, including the kernel configuration,
  the package database, systemd units and `/root`;
- `apt install`, `git` on any repository of the machine, `docker` commands
  through the (optional) socket, all work as root;
- it can therefore break the system with a wrong path, and nothing inside the
  container prevents that. The container stops being a boundary: the boundary
  becomes the machine;
- it sees your real `~/.zcode` (skills, commands, memories, configuration), so
  the setup is your personal environment, and files created there belong to
  root: your user will need `sudo` to change or delete them.

**What it costs**, in the same terms: snapshots before every unsupervised run,
no infrastructure credentials on that machine, no access to the rest of the
fleet, and an isolated VLAN. Treat it as compromised by design.

**The point to understand: "sudo" is not the mechanism.** Installing sudo in the
image would grant no additional right: sudo only re-roots *inside* the
container, while the real rights are decided by the launch options. What gives
root on the machine is exactly these two lines:

```yaml
user: root          # uid 0 in the container equals uid 0 on the mounted filesystem
volumes:
  - /:/host         # the whole filesystem of the machine
```

`--privileged` is **not** required for that (it only adds access to devices).
`docker.sock` is a separate option, equally equivalent to root on the host, and
left commented out.

The authentication gateway is on by default in this profile, which is where it
matters most: with a root agent, an open port would mean owning the machine.

## Deployment doctrine: a sandbox here, development elsewhere

A previous profile, `compose.unsafe.yml`, removed the container boundary on
purpose: `privileged`, the machine's process namespace (`pid: "host"`) and the
Docker socket mounted, so the agent could `nsenter` into the machine, install
packages with its package manager and drive its containers. It is **removed**:
everything it offered beyond full access was the definition of a machine
compromised by design, and `check-unsafe.sh` went with it. What it was used for
is now spelled out as a doctrine instead of a launch flag.

**The container is a sandbox, and that is all it is.** It serves the web
application behind the gateway, and the work it produces lives in Docker
volumes, not in the container: `/data` for the state that must survive (the
gateway accounts, the runtime configuration), and the workspace directory for
the work itself. Replacing the container never costs a line of work; the image
is disposable by construction, and no profile needs to punch through it.

**Everything heavier happens on a dedicated machine, reached over SSH.**
System packages, machine level services, repositories with their own
toolchains, long running development jobs: those run on a dedicated
development machine, and the agent works on it through ZCode's Remote SSH
feature instead of through a wider container — from the desktop app, and from
the web interface in this image, where the wizard also offers **Cloud
Environment**: a disposable container on that machine, provisioned with a
setup script, in which the agent installs whatever the project needs
(see "Web mode: remote workspaces and cloud environments"). The machine owns
its own credentials and its own hardening; the container only needs to reach
it, which is one outbound SSH connection and no new published port. The full
access profile stays for the case where the agent must genuinely act on the
very machine that hosts it, with the consequences documented above.

### Finding your existing ~/.zcode again

Skills, commands and memories do not resolve through the data directory but
through `$HOME/.zcode` (`packages/services/src/skills/skillsService.ts` and
`.../memory/memoryService.ts`). Hence both variables point at your real home:

```yaml
environment:
  HOME: /host/home/<user>
  ZCODE_DATA_BASE_DIR: /host/home/<user>
```

The agent then sees `~/.zcode/skills`, `~/.zcode/cli` (commands, memories,
`config.json`) and `~/.zcode/v2` (configuration). Copy your workstation
`~/.zcode` to that machine to start from your existing environment.

### Git protection to lift

As root, git refuses to work on a repository owned by another uid (`detected
dubious ownership in repository`). The compose file lifts the protection for
this process only, without touching the machine's git configuration:

```yaml
GIT_CONFIG_COUNT: "1"
GIT_CONFIG_KEY_0: safe.directory
GIT_CONFIG_VALUE_0: "*"
```

### Known side effect

Run as root, the agent creates files **owned by root** in the machine's
`$HOME/.zcode` (`v2/provider_config.json`, sqlite databases, certificates) and
in `$HOME/.zcode/cli/config.json`, which the entrypoint also touches. Your VM
user will need `sudo` to modify or delete them. That is the consequence of uid
0, not a bug.

## Authentication of a compromise: what the gateway does and does not do

It decides who may talk to the runtime, nothing more. It does not sandbox the
agent, does not filter the network, and does not add a multi-user model: one
instance, one account. See [SECURITY.md](SECURITY.md) for the full reasoning.

## The versioning model

Two files, one single truth, and no value repeated in the build:

| File | Content |
| --- | --- |
| `zcode.version` | the pinned upstream release tag (for example `v3.14.7`) |
| `zcode.sha256` | the sha256 of that release tarball |

Every build path reads these two files and passes them as build arguments:
`./build.sh`, `build.yml`, and the e2e job of `e2e.yml`. The Dockerfile carries no
default for any of them and refuses to build when one is missing, so a path that
forgets a pin fails at the first step instead of shipping an image that
contradicts its own tag. That is not hypothetical: with the runtime tag in the
Dockerfile as a default, a CI build of the 3.14.4 tree produced an image
labelled 3.14.3, carrying the 3.14.3 runtime, that the workflow would have
pushed as `3.14.4`. The smoke job now compares, rather than prints, the runtime
inside the published image.

One image tag per release, the sha256 written into a label
(`org.opencontainers.image.revision`), and an automatic watch:

```bash
./check-upstream.sh              # up to date? (exit 0) or new release? (exit 1)
./check-upstream.sh --bump       # updates zcode.version + zcode.sha256
./check-upstream.sh --build      # bump, then rebuild locally
REPO=zai-org/ZCode ./check-upstream.sh   # watch the original upstream instead
```

The `upstream-check` workflow does that watch every week and **opens an issue**
when a release comes out. It never modifies anything by itself: the bump stays
an explicit decision.

## Building the image yourself

```bash
./build.sh                # -> ghcr.io/sigma-gigachad/z-cloudium:{<zcode.version>,latest}
./build.sh --push         # same, then push to the registry
```

A build without any cache (`docker build --no-cache`, measured at 39 seconds on
the development machine before the browser was part of the image, and faster
now) downloads the 81 MB upstream tarball, verifies its
sha256 and extracts it. A rebuild with a warm cache takes a few seconds. A local
build satisfies the compose files directly, since they reference the same image
name.

The CI (`.github/workflows/build.yml`) rebuilds and publishes on every push to
`main`, then a `smoke` job **starts the published image**, checks that the
gateway answers and that the interface sits behind it. An image is not shipped
without having been started.

## Hardening

The complete detail (what is applied, what is deliberately left out, and the
residual risks) is in [SECURITY.md](SECURITY.md). In summary:

**In the image**: base pinned by digest, runtime verified against the sha256
pinned in this repository, build refused if the third party runtime carries a
setuid/setgid binary, no build toolchain, unprivileged user by default, gateway
in front of the published port.

**In the containers**: `no-new-privileges`, `cap_drop: [ALL]` then explicit
addition of the minimum, `pids`/`mem`/`cpus` limits, no Docker socket by
default, port bound to a single interface, telemetry forced off.

The restricted profile (`compose.yml`) adds the read-only root filesystem with a
tmpfs `/tmp`. The full access profile does not apply it, deliberately: with root
on `/host` it would prevent no persistence while breaking `apt install`.

## What has been verified

Tested by actually running things, not only written. The measurements below date
from the run that made them: where one names a version, that is the version it
was measured on, while `zcode.version` is what a build carries today.

- **test suite**: 101 tests, 101 pass, 0 fail (`node --test --test-force-exit`,
  which prints the count and exits on its own). The new features carry their own
  tests: the recovery sheet arithmetic, the single-use rule end to end, the
  password change and the key rotation it forces, the failure budget surviving a
  restart, the metrics counters, the owner flow, and the 502 page
- **image build**: 0.89 GB, and the image agrees with its own tag: the runtime
  answers the version `zcode.version` pins, and the OCI labels carry the tag
  and the pinned sha256
- **the pins are enforced, not documented**: `docker build .` with no build
  argument fails at the first step with `This build is missing a pinned build
  argument.` and exit 1, so no build path can ship an image that contradicts
  its own tag
- **container start** (restricted profile, all hardening on): the entrypoint
  logs `gateway listening on 0.0.0.0:3030 (authentication on), runtime confined
  to 127.0.0.1:3131`, container `healthy`
- **health endpoint**: `GET /_auth/health` returns `200 ok` without a session
- **redirect**: `GET /` returns `302` to `/_auth/login?next=%2F`, and
  `/api/server-info` is not proxied without a session
- **full login**: setup wizard, TOTP enrolment, session cookie, then
  `GET /api/server-info` returns `200` with
  `{"version":"3.14.0","workspaces":[{"path":"/workspace"}]}` and `GET /`
  returns the application shell
- **session lifetime**: the session cookie issued by the wizard carries
  `Max-Age=43200` (12 hours) by default, `Max-Age=3600` with
  `ZCLOUDIUM_SESSION_TTL_HOURS=1`, and an unusable value
  (`ZCLOUDIUM_SESSION_TTL_HOURS=forever`) falls back to 43200 with a line in the
  logs saying so. The default is pinned by a test, so the code and this
  documentation cannot drift apart
- **full access workspace**: with the full access profile the runtime reports
  `workspaces[].path` as the mounted operator home (measured on a throwaway home
  in the test), not the image default `/workspace`: the workspace comes from
  `ZCODE_SERVER_WORKSPACE`
- **leftover `command:` block**: a container started with the old argument list
  appended logs `ignoring the extra command line arguments (...)` and still runs
  with the loopback arguments built from the environment
- **failure block**: from inside a container, eight wrong passwords each carrying
  a different `x-forwarded-for` are all answered `401` and attributed to the
  socket address in the logs, and the correct password that follows is answered
  `429` (before this was keyed on the socket, that same sequence ended on `303`,
  so the header was enough to start over). Eight wrong codes at the second factor
  followed by a genuinely valid code are answered `429` with no session, where
  the second factor used to accept the valid code after eight failures
- **failure block, and the end of it**: the same container, measured before and
  after the fix: eight wrong passwords are answered `401` and the ninth `429` in
  both. Once the five minutes are over, the gateway before the fix answered the
  next wrong password `401` and the one after it `429`, so one attempt every five
  minutes kept the sign in page refused indefinitely. It now answers `401` to
  eight fresh wrong passwords and only the ninth is `429`, which is the budget
  starting again
- **open redirect**: a sign in whose `next` is `/\evil.com`, `/%5Cevil.com`,
  `//evil.com` or `/\/evil.com` ends on `/`, the root of this origin, instead of
  redirecting to the host the value names. The value the sign in page renders in
  its hidden field is the sanitised one, and that is where a path that dot
  segment normalisation turns into a protocol relative one was visible:
  `next=/..//evil.com`, `/.//evil.com`, `/%2e%2e//evil.com` and `/a/..//evil.com`
  render as `/` (the gateway before the fix rendered `value="//evil.com"` for
  each of them), while a legitimate `/settings?tab=model` still renders in full
- **`ZCLOUDIUM_AUTH=off`**: the runtime answers on the published port with no
  authentication, `GET /api/server-info` returns `200`
- **restricted profile via compose**: `ReadonlyRootfs=true`, `CapDrop=[ALL]`,
  `no-new-privileges`, `User=1000:1000`, tmpfs `/tmp`, and the gateway answers
  while writing only into the `/data` volume
- **CI, real runs on GitHub runners** (merge `bd468a3`, tag `v3.14.3`):
  `build-image` green in 3m01 (`build` plus `smoke`, which pulls the **published**
  image, starts it with the full hardening and checks the gateway and the
  interface), and `e2e` green in 6m25 (the 20 Playwright tests against the image
  the workflow builds). Three tags pushed: `latest`, `3.14.3` and `sha-bd468a3`.
- **public package**: `docker logout ghcr.io` then `docker pull
  ghcr.io/sigma-gigachad/z-cloudium:latest` succeeds without any credential
- **copy-paste quick start**: the `compose.yaml` from this README, saved in an
  empty directory on a machine that never cloned anything, starts a `healthy`
  container whose logs show the gateway on the published port and the runtime
  confined to loopback, and `GET /` answers `302` to the sign in page
- **end to end, against the image**: the 20 Playwright specs pass in one run of
  `e2e/scripts/run-e2e.sh` (3.8 minutes) against a container started with the
  full hardening from the image built by this tree: the wizard, the theme, the
  session requirement including the WebSocket upgrade, the `next` sanitisation
  in a real browser, the sign out and code replay rules, and the second factor
  throttle. The e2e workflow runs the same suite on every push.

## Implementation details

- **glibc base is mandatory** (`node:24.14.0-bookworm`), not Alpine: the runtime
  package embeds precompiled `node-pty` binaries
  (`@lydell/node-pty-linux-x64`) and no musl variant is published.
- **Node 24.14.0** is the version the project pins (`mise.toml`) and that the
  runtime needs, not only the build.
- **File search**: ripgrep, bfs and ugrep are embedded in the runtime package,
  there is no need to install them in the image.
- **Volumes**: `/data` (authentication, session key, API key, settings, skills,
  agent configuration) and `/workspace` are the only two paths to persist. On a
  bind mount, remember `chown 1000:1000` on the host.
- **`server-info` announces `3.14.0`** while the release tag is `v3.14.3`: the
  image tag is what counts.
- **x64 only, for now**: the runtime tarball embeds prebuilt `node-pty` binaries
  for `linux-x64` and no `arm64` or `musl` variant, so an arm64 host (Raspberry
  Pi, NAS, ARM Mac) has nothing to run. Serving arm64 means compiling node-pty
  for it, which means the from-source path.
- **Gateway files** live in `/opt/cloudium/gateway`, outside `/opt/zcodium`, so
  the third party runtime directory stays exactly as it was extracted. The
  gateway imports no application code: it is an additive layer, and an upstream
  update cannot break it.

## Why this fork rather than upstream

Upstream (`zai-org/ZCode`) publishes desktop installers only (dmg / exe): using
it would mean compiling the monorepo at every version, that is 15 to 30 minutes
of build on a capable machine. ZCodium publishes the server runtime tarball with
its `sha256.txt` at every release, hence a build measured in minutes here.

This fork claims to remove upstream telemetry and reporting, and to synchronise
upstream commits one by one. **That is not verified**: it is a third party
claim about third party code. Two safeguards limit the risk: the sha256 is
pinned in this repository (a modified release fails the build), and the image
forces `ZCODE_MODEL_TELEMETRY_ENABLED=0` (the upstream OTLP exporter is inactive
anyway without `OTEL_EXPORTER_OTLP_ENDPOINT`).

If you want to depend only on the original vendor, `Dockerfile.from-source`
compiles the sources yourself. Read its header first: the build is validated,
but the image it produces is not the product (see below), and the original
vendor's tag series lags the fork the precompiled runtime comes from.

## The from-source build carries the remote workspace features

The precompiled image runs the published tarball exactly as the fork ships it.
The features that need runtime changes — opening Remote SSH sessions from the
web client, and creating Cloud Environments — live in a small, reviewed patch
series that `Dockerfile.from-source` applies to the pinned ZCodium revision
before compiling it (`./build.sh --from-source`). The image it produces carries
the same gateway, entrypoint and hardening as the precompiled one; only the
runtime differs, and the build proves the series reached the artefacts (it
greps one server route and one web string after extraction).

What the series adds, and where it is documented: `patches/README.md` lists
every file and the upstream policy — new files for new capabilities, small
marked hunks in the few edited ones, upstream behaviour without it. The pinned
revision is labelled with its exact commit (`org.opencontainers.image.revision`),
and `build.sh` refuses a from-source build whose `patches/` is empty: an image
compiled without the series would silently miss every feature this path exists
for.

Costs, measured: about 5 minutes of cold build against about 8 seconds for the
precompiled path; the tarball it builds does not reproduce the official one bit
for bit (tarballs carry mtimes), which is why the image version is the source
revision, not a hash of the output. Upstream `zai-org/ZCode` stops at `v3.14.3`:
building current versions means building this fork's git anyway.

## Web mode: remote workspaces and cloud environments

The stock web client refuses remote connections (*not supported in Web mode
yet*), because the server exposes only four services over the remote
WebSocket. In this image the web client connects Remote SSH targets like the
desktop one, and the wizard's method list offers **Cloud Environment** instead
of Docker: the wizard collects the SSH host and credentials plus an optional
base image (default `ubuntu:26.04`) and an optional setup script, the server
provisions a disposable container on that host, copies the host's GitHub CLI
credentials into it (authenticate `gh` and `git` once on the machine, every
environment inherits them), and the runtime connects into the container through
the operator's SSH session — no sshd in the container, no published port, no
Docker credentials on the machine running this image.

Environments persist on the host (the setup script runs once, dependencies
survive between sessions) and are removed with `docker rm -f <name>` on that
machine, or by an operator who wants the space back.
