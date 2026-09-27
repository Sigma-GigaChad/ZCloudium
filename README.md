# z-cloudium

**ZCode Web in a container, ready to run.** A hardened, versioned and published
image, behind a password plus a TOTP code, with no toolchain to install: no
pnpm, no Node, no compilation.

The name is a pun: ZCodium (the fork the runtime comes from) plus cloud. The
project exists because upstream `zai-org/ZCode` **publishes no server binary**
(desktop installers only), which would otherwise mean compiling the whole
monorepo for every version.

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
      ZCLOUDIUM_BROWSER_MCP: "on"
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

Interface: **http://127.0.0.1:3030**. The first connection runs the setup
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
image: ghcr.io/sigma-gigachad/z-cloudium:3.14.4
```

The available tags are `latest`, `<version>` (for example `3.14.4`) and
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

## Authentication

The published port is served by an authentication gateway, which comes with the
image. The runtime itself is bound to `127.0.0.1:3131` inside the container and
is reachable only through that gateway.

- **First connection**: the setup wizard asks for a username, a password (at
  least 12 characters), then the enrolment of a TOTP code (RFC 6238), displayed
  as a QR code and as an `otpauth://` URI for your authenticator application.
- **Later connections**: username and password, then the six digit code. A code
  cannot be replayed: the last accepted step is stored server side.
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
  setup wizard back. There is no password change route: resetting the account is
  how you rotate the credentials.
- **Failures**: eight failed attempts from the same key block that key for five
  minutes, and the limit applies to all three steps (the password, the six digit
  code, and the TOTP enrolment of the first connection), so a known password does
  not leave the code open to be walked through. The block is a real bound: the
  failure budget expires with it, so the first failure after a block ends starts
  a fresh count and eight new failures are needed before the key is blocked
  again. A failed attempt every five minutes therefore cannot keep a key blocked
  for good. The key is the connecting socket address: the `x-forwarded-for`
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
- **Accounts**: stored in `/data/auth/users.json` (scrypt hashes, TOTP secrets,
  mode 0600). The session signing key is `/data/auth/secret.key`. Removing
  `/data/auth` resets the whole thing and the wizard runs again, which reopens
  the first connection window: until the wizard is finished again, anyone can
  claim the instance.

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

The unsafe profile (`compose.unsafe.yml`) carried the same block, and the defect
it hid was worse there: `/workspace` is not mounted on that profile at all, so the
agent worked in the container's own filesystem, outside `/host`, and lost the work
with the container. That file now sets `ZCODE_SERVER_WORKSPACE` to the same
`/host/home/<user>`, and `./check-unsafe.sh` fails when the runtime does not report
it.

## Browser automation for the agent

ZCode ships a built-in Browser Use, and the runtime carries everything it needs:
the backend, the Playwright that drives it, and the official `browser-use`
plugin among the plugins the runtime enables by default. What web mode does not
offer is a way to turn it on: `zcode --web` parses a fixed option list and
rejects `--browser-use`, while the agent it spawns is the process that would
accept it.

Until that path has been proven in a container with no display, the capability
is provided through MCP, which is **additive**: nothing of the application is
modified.

The image ships:

| Component | Version | Why |
| --- | --- | --- |
| `chrome-devtools-mcp` | `1.10.1` | maintained browser MCP server (Google), driven over stdio |
| `chromium` | pinned in `chromium.version`, `154.0.8037.57-1~deb12u1` | the browser it drives, through `--executablePath /usr/bin/chromium` |

Both are installed **at build time**: no package manager is needed at runtime,
and two containers started from the same image run the same browser server.

On startup, the entrypoint merges this entry into the agent configuration,
`<home>/.zcode/cli/config.json`:

```json
{
  "mcp": {
    "servers": {
      "chrome-devtools": {
        "type": "stdio",
        "command": "/usr/local/bin/chrome-devtools-mcp",
        "args": [
          "--headless",
          "--isolated",
          "--executablePath",
          "/usr/bin/chromium",
          "--chromeArg=--no-sandbox",
          "--no-usage-statistics",
          "--no-performance-crux"
        ],
        "enabled": true,
        "timeoutMs": 60000
      }
    }
  }
}
```

What the merge guarantees, and what it refuses to do:

- every other key and every other MCP server in the file is preserved;
- it is idempotent: running it twice changes nothing the second time;
- an entry that is already present and identical leaves the file **untouched**;
- before the first modification, the previous file is kept next to it, as
  `config.json.zcloudium-backup`;
- a malformed file is **refused, not repaired**: a syntax error, an `mcp` field
  that is not an object, or an `mcp.servers` that is not an object, and the
  container starts without the browser server, logging why. Your provider keys
  are never rewritten from a guess;
- the file is written atomically (temporary file plus rename) and keeps its
  permissions, or gets `0600` if it is created.

Set `ZCLOUDIUM_BROWSER_MCP=off` to leave the configuration alone entirely.

In the restricted profile the home is `/data`, so the file lives in the volume.
In the full access profile the home is the **real home of the machine**: this is
where the backup matters, since the file typically holds your provider keys and
your own MCP servers. Tested on that profile: the entry is added, `context7`
and the provider section are intact, and the backup holds the previous file byte
for byte.

## The browser panel (live view and viewport control)

The agent drives a headless browser inside the container. The panel puts that same
page on screen, next to the conversation, with the controls the picture needs: it
is what makes the web build usable for the workflows that need a human in the
loop, and it is the one thing a screen stream could not give (a viewport control
without giving up the view, see below).

The panel is on by default, which is the position the tool was asked for: the
entrypoint starts one Chromium in the container, attaches the agent's MCP server
to it, and serves the panel from the gateway. Both sides then drive **one single
page**: your clicks and its actions land in the same browser, and neither blocks
the other. `ZCLOUDIUM_BROWSER_PANEL=off` restores the shape the image shipped
before: no browser is started, the MCP entry keeps its launch arguments, and
`/_browser/...` is ordinary application traffic.

Open `http://<host>:3030/_browser/` after signing in. It is behind the same
session as everything else, and the WebSocket it opens is refused without one.

| Part | What it is |
| --- | --- |
| live view | `Page.startScreencast` frames painted into a canvas, scaled to fit the window |
| address bar | the address the page is at right now, and the way to change it: type, press Enter, and the gateway navigates the page. Only http and https, deliberately (see below) |
| navigation | back, forward and refresh, next to the address bar, with the labels the desktop pane uses |
| viewport | a preset selector (`1280x720`, `1366x768`, `1600x900`, `1920x1080`) that applies in one gesture, plus a width and a height field for anything else, `320x320` up to `3840x2160`, and a fit-to-window option. The panel asks the gateway for it, and the gateway poses it with `Emulation.setDeviceMetricsOverride` on the page. `1366x768` is what the fields start at, and what the panel adopts only when the page has no size of its own yet |
| interaction | mouse move, press, release, wheel and drag, and the keyboard, through the CDP input events. Click the picture once to give it the keyboard |
| indicator | the page is shared with the agent, and the strip shows the size the page reports and the age of the last frame |
| actions | Open DevTools through the gateway, open the current page in your own browser, and detach: the panel in a window of its own, 1366x900, which is how the third column is assembled when the web app cannot host the pane itself |

### Why the address bar is not the desktop pane

The desktop build has a browser pane in its side column, with the same address
bar, the same free-size viewport and an element picker. That pane is an Electron
guest: the bundle carries its labels (`browser.title`, `browser.responsive.*`,
`browser.elementPicker.*`) and the IPC namespace its host uses
(`zcode:browser-view-*`), and the web entry of that same bundle mounts the
application with `supportsEmbeddedBrowser: false`. The runtime says it in one
sentence, `browser.desktopOnly`, which its Settings page renders as "Browser pane
is available on desktop only".

So in the web build the pane is not offered, and it cannot be turned on from
outside without patching the client, which this project does not do. What the
third column is here: this page, in a window beside the application, opened with
the detach button. The controls are the desktop pane's, so the gesture is the same
even though the container is not.

Two deliberate differences from the desktop pane, both about not blurring what the
panel is:

- **the address bar takes http and https only.** The desktop also takes `file:`,
  `data:` and `about:`. Inside the panel, a `data:` page or a file from the
  container looks like any other site, and whoever holds a session already reaches
  both through the agent, where it leaves a trace;
- **the element picker is DevTools'.** `Ctrl+Shift+C` in the DevTools this panel
  opens is the real picker, with the real highlight (`Overlay.setInspectMode`),
  and it yields a selector to paste into the conversation. The desktop pane's own
  picker exists because it has an IPC channel into the conversation; this page has
  none, so a picker here would copy what DevTools already does properly.

### TLS, terminated here or in front

`ZCLOUDIUM_TLS=on` makes the gateway serve https itself, with a certificate it
generates on first start into `<data>/tls/` and keeps afterwards (it is replaced
when it expires, when it stops naming a host, or when it cannot be read).

What that buys, and it is more than encryption: an https origin is a **secure
context**, which is what the platform requires for the clipboard, for service
workers, and for the SHA-256 a file is hashed with before being attached. On such
an origin the script described below does nothing at all, because the browser
already provides what it was there to replace.

What it is not: trust. Nobody signed that certificate, so the browser warns on the
first visit and the operator accepts it once. And a certificate generated inside
the container cannot guess the address the browser uses, so **declare it**:
`ZCLOUDIUM_TLS_HOSTS="192.168.51.224,nas.local"` adds those names, and the
certificate is regenerated when they change. A browser refuses a name a certificate
does not carry, even after the warning, which is the one trap here.

Leave it off when something in front already terminates TLS: a reverse proxy, a
WireGuard or Tailscale tunnel, a NAS with its own certificate. Turning it on there
would break that setup, which is why the default is off and the startup log says
which position is in force. Where there is nothing in front, a self-signed https is
worth more than plain http, and it is the only thing that makes the rest of the
platform available.

### The one script the gateway adds to the application

Attaching a file fails with `fault.attachment.checksumUnavailable` on any origin
that is not a secure context, which means every plain `http://` address except
`localhost`. The client hashes the attachment before uploading it
(`crypto.subtle.digest("SHA-256", ...)`) and refuses to go on when `crypto.subtle`
is absent, and browsers only provide it over https or on localhost. Nothing in the
runtime is wrong: it is the platform's rule meeting the deployment this README
recommends, a container reached over a LAN or a VPN address.

So the gateway supplies the missing piece: it appends one script block to the
application's document as it proxies it. The script does nothing when
`crypto.subtle` exists, which covers every https origin and `localhost`, and
otherwise defines `digest` for SHA-256, the only method the bundle uses. Its hash
is checked against Node's own implementation in `tests/app-script.test.mjs`, on the
empty message, the padding boundary, several blocks and non-ASCII bytes: a wrong
hash would be worse than the fault it replaces.

This is the only place the gateway edits the application's own code, and it is
additive: the document the runtime sends is what the browser receives, plus a
block before `</body>`. The document is asked for uncompressed so the edit is
possible, and only when the request is for a document: an asset, an API answer or
a request that does not accept html crosses untouched. `insecureHelpers: false`
on `createGateway` turns it off, and then the document is the runtime's byte for
byte (both cases are asserted in `tests/gateway.test.mjs`).

TLS in front of the port remains the better answer, and the reason is bigger than
this fault: a secure origin is also what makes the clipboard, service workers and
the rest of the platform available. This block is what keeps a plain http
deployment usable in the meantime.

### Who owns the resolution, and why it matters

Chromium changed this in 154: an emulation override now belongs to the session
that posed it, and is cleared when that session detaches. Until 153 it outlived
it. A panel that posed its own override therefore lost your resolution every time
you closed the tab, which is the one case the panel exists for: acting with the
viewer closed, then reopening and finding the state intact. Measured on the
pinned browser, both halves of the rule: a session that only attaches and detaches
leaves another session's override alone, and a session that poses replaces it for
the whole page, so its own detach leaves the page at the window size.

So the gateway owns the override, not the panel: it opens one connection to the
debug port on the first request and keeps it, poses the viewport on a session it
never detaches, and re-sends the call even when the numbers did not change,
because a second press of Apply has to work. The panel posts small JSON documents
to `/_browser/viewport`, behind the session and the same origin rule as the rest
of the browser routes, and it never poses anything itself. Opening the panel asks
for an `attach`: a page nobody resized is left exactly as it was, and a page whose
resolution you chose is put back if something else cleared it in the meantime.
Moving the target selector to another page sends a `release`, which stops forcing
a size on the page you left without touching it.

That connection is what the runtime's own `playwright-core` is for: the image
asserts its presence at build time, from the runtime it already pins, rather than
installing a second copy of it.

The panel needs the browser MCP server, which is on by default: with
`ZCLOUDIUM_BROWSER_MCP=off` no browser is started and the logs say so, because a
browser nobody drives would be a stray process.

### Why a panel exists when Chromium serves its own DevTools

Chromium serves its DevTools frontend over HTTP as soon as remote debugging is on,
and through the gateway it gives live view, live DOM, element picking, the console
and the network waterfall at no cost. It cannot give the live view **and** the
viewport control at once: `/_browser/devtools/inspector.html` renders the page and
has no device toolbar, and the same frontend with `can_dock=true` has the toolbar
and renders no page into your tab. Measured, twice. The panel owns the view and
the controls together, and the DevTools button covers the depth. The element
picker therefore stays with DevTools (its highlight is the real one,
`Overlay.setInspectMode`), and `Ctrl+Shift+C` there still yields a selector you can
paste into the conversation.

The button builds its URL itself and does not use the `devtoolsFrontendUrl` field
of the discovery documents: Chromium writes a
`chrome-devtools-frontend.appspot.com` URL there, which an offline deployment
cannot reach. The path that works is
`/_browser/devtools/inspector.html?ws=<host>/_browser/devtools/page/<id>`, and it
is what the button opens.

### The picture is a frame stream, not video

Frames arrive when the page produces one, and they are painted as they arrive.
Measured on the container browser: 8 to 20 ms after a visible change, and never
for a change nobody can see (a text node updated while it was scrolled out of the
viewport produced no frame at all in 2.5 s). There is no encoder, no ffmpeg and no
video protocol, and the rate follows the page rather than a clock: a page that
animates streams, a still page sends nothing. So: supervision, not video. The
footer says how many frames arrived and how old the last one is, which is what
tells you the picture is fresh rather than frozen. Drag and drop through the
browser's own HTML5 API (dropping a file onto a page) is the one gesture the panel
does not do.

The picture is capped independently of the layout size, at `1920x1080`, and the
panel asks for that cap on attach, before it knows the page's own size. Chromium
scales a larger page down to fit those bounds, keeps the page's aspect ratio, and
never scales a smaller one up. Measured on Chromium `153.0.8010.52`, the browser
the image carried when this panel was written (`chromium.version` pins
`154.0.8037.57` today): a `1920x1080` page streams `1920x1080`, a `3840x2160` page
streams `1920x1080`, and a `640x480` page streams `640x480`. A cap asked for later
is not possible: Chromium answers a second `Page.startScreencast` while one is
running with `Screencast is already active`.

### Where the browser profile lives

The profile, with the agent's cookies and logins, is written to
`<ZCODE_DATA_BASE_DIR>/browser-profile`, which means:

- restricted profile (`compose.yml`): `/data/browser-profile`, on the data volume,
  and nothing is written to the read-only root filesystem;
- full access and unsafe profiles: `HOME` **and** `ZCODE_DATA_BASE_DIR` are your
  real home, so the profile lands in **your own `~/browser-profile`** (inside the
  container, `/host/home/<user>/browser-profile`).

That directory belongs to the panel and is written only while the panel is on,
which is the default. With `ZCLOUDIUM_BROWSER_PANEL=off` the agent's MCP server
launches its own browser with `--isolated` (the entry at the top of this section):
a throwaway profile under the container's temporary directory, so nothing is
written to `<ZCODE_DATA_BASE_DIR>/browser-profile` and no login outlives that
browser process. With the panel on, the one container browser keeps its cookies
and logins in that directory across restarts of the container, and the panel shows
that same browser, so what it displays is the state accumulated there since the
container was first started.

A container that was killed rather than stopped leaves Chromium's `SingletonLock`
in that directory, pointing at the old machine name, and Chromium then refuses to
start. The entrypoint releases only that lock (three files, and only when it names
another machine) before launching, and says so in the logs.

### Behind a TLS terminating proxy

Set `ZCLOUDIUM_TRUST_PROXY=on` there. The proxy speaks TLS to your browser and
plain HTTP to the container, so the browser sends an `https` Origin while the
gateway serializes `http`, and the panel's own origin check would refuse its own
frontend. The flag already means "a proxy I control is in front", and it accepts
exactly the `https` variant of the request's own authority, nothing else. See
SECURITY.md for the rule in full.

### The panel and the agent see the same page

The viewport control changes the layout the page reports, not only the picture:
asked for `640x480`, a page with a `(max-width: 700px)` rule flipped its media
query, and the agent's own screenshots followed the new size. Closing the panel
disturbs nothing, and reopening it finds the same document, the same typed text
and the same emulated viewport: the browser is the agent's, and the panel is a
viewer plus a control surface on it. The suite covers this end to end, against a
container started with the panel on.

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

## The machine itself, no container boundary (unsafe)

`compose.unsafe.yml` goes one step further than full access: the container is
`privileged`, shares the machine's process namespace (`pid: "host"`), and holds
the machine's Docker socket. Concretely, the agent can:

- read and write every path of the machine, as full access;
- run commands as the machine itself, inside its namespaces:
  `nsenter -t 1 -m -u -i -n -p -- <command>`;
- install packages with the machine's own package manager, apt, pacman or
  whatever it runs, from inside the conversation:
  `nsenter -t 1 -m -u -i -n -p -- apt-get install -y <pkg>`;
- see and signal the machine's processes, and control the machine's containers
  through the mounted Docker socket.

There is nothing to elevate to: the agent already is root on the machine, so
sudo and privilege requests are no-ops. Tell it once in a conversation that
these paths exist (or add them to your `AGENTS.md` in the operator home), and it
will use them directly.

```bash
./check-unsafe.sh                        # verifies all of it (throwaway container)
cp compose.unsafe.yml compose.local.yml  # adapt the port and the home paths
docker compose -f compose.local.yml up -d
```

The authentication gateway stays in front of the port on this profile too. It
decides **who** reaches the agent; it does not limit **what** the authenticated
agent can do, which is the machine, period.

Two things to know:

- **Snapshot the machine before the first run, and before every unsupervised
  run.** On this profile a wrong command is a wrong command on your machine, and
  `apt` or `pacman` installs are real installs.
- **On a multi distribution WSL setup**, `pid: "host"` and the `/:/host` mount
  resolve against the environment of the Docker daemon, which may be a different
  distribution from the one your shell runs in (found while testing: the daemon
  side ran Arch based CachyOS with pacman while `/host` carried Debian with
  apt; both were usable, each through its own path). On the intended target, a
  single distribution VM, the two are the same machine and this caveat does not
  exist.

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

Three files, one single truth, and no value repeated in the build:

| File | Content |
| --- | --- |
| `zcode.version` | the pinned upstream release tag (for example `v3.14.4`) |
| `zcode.sha256` | the sha256 of that release tarball |
| `chromium.version` | the pinned browser: both Debian package versions, and the upstream string |

Every build path reads these three files and passes them as build arguments:
`./build.sh`, `build.yml`, and both jobs of `e2e.yml`. The Dockerfile carries no
default for any of them and refuses to build when one is missing, so a path that
forgets a pin fails at the first step instead of shipping an image that
contradicts its own tag. That is not hypothetical: with the runtime tag in the
Dockerfile as a default, a CI build of the 3.14.4 tree produced an image
labelled 3.14.3, carrying the 3.14.3 runtime, that the workflow would have
pushed as `3.14.4`. The smoke job now compares, rather than prints, the runtime
and the browser inside the published image.

The browser is pinned for the same reason, and it is the component that matters
most: Debian's security channel moved chromium from 153 to 154 between two
builds of the same commit, and that is what broke the operator viewport.
Raising the pin is a deliberate edit plus a rebuild, never a side effect of when
the image was built, and the build turns red on its own the day the pinned
version leaves the distribution channel.

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
an explicit decision. The browser is not part of that watch, because its pin is
not tied to a release: `chromium.version` says what to do.

## Building the image yourself

```bash
./build.sh                # -> ghcr.io/sigma-gigachad/z-cloudium:{<zcode.version>,latest}
./build.sh --push         # same, then push to the registry
```

A build without any cache (`docker build --no-cache`, measured at 39 seconds on
the development machine) installs Chromium and its fonts (342 MB), installs the
pinned browser MCP server, downloads the 81 MB upstream tarball, verifies its
sha256 and extracts it. A rebuild with a warm cache takes a few seconds. A local
build satisfies the compose files directly, since they reference the same image
name.

The CI (`.github/workflows/build.yml`) rebuilds and publishes on every push to
`main`, then a `smoke` job **starts the published image**, checks that the
gateway answers, that the interface sits behind it, and that Chromium and the
browser MCP server are in place. An image is not shipped without having been
started.

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

**Chromium weakens its own sandbox, and that is stated plainly**: inside the
container the browser is started with `--no-sandbox`, because capabilities are
dropped and `no-new-privileges` is set, which makes the setuid helper and the
namespace sandbox unusable (`No usable sandbox!` is what Chromium answers
without it). What contains it is the container itself (uid 1000, read-only root
filesystem, no capability, no-new-privileges) plus the rule that matters: the
browser must not be pointed at untrusted pages. See SECURITY.md.

## What has been verified

Tested by actually running things, not only written. The measurements below date
from the run that made them: where one names a version, that is the version it
was measured on, while `zcode.version` and `chromium.version` are what a build
carries today.

- **test suite**: 203 tests, 203 pass, 0 fail, in a throwaway container
  (`node:24.14.0-bookworm-slim`, `node --test`, which prints the count and
  exits on its own)
- **image build**: 1.38 GB, and the image agrees with its own tag: the runtime
  answers `3.14.4`, `chromium --version` answers `Chromium 154.0.8037.57`, the
  two Debian packages are installed at exactly the versions `chromium.version`
  pins, and the OCI labels carry `v3.14.4` and the pinned sha256.
  `chrome-devtools-mcp --version` answers `1.10.1`
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
- **unsafe workspace, and the check that keeps it**: `./check-unsafe.sh` starts
  the throwaway container with the image's own entrypoint (no `--entrypoint bash`,
  no `command:` block, the home and the workspace in the environment) and reads
  the workspace back from the running runtime, at
  `http://127.0.0.1:3131/api/server-info`: it answers
  `workspaces[0].path == /host/tmp/zcloudium-unsafe-home`, the mounted home. The
  same container started with the pre-fix settings (the `command:` block with
  `--workspace=/host/home/delta`, no `ZCODE_SERVER_WORKSPACE`) answered
  `/workspace`, logged `ignoring the extra command line arguments (...)`, and that
  path is not a mount inside the container (`mount` shows none): the agent's work
  landed in the container's own filesystem. Removing the variable from the script
  makes probe 1 fail with `reports '/workspace' instead of
  /host/tmp/zcloudium-unsafe-home` and the script exits `1`
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
- **browser MCP server**: handshake over stdio as uid 1000 under the same
  hardening, 30 tools listed, `navigate_page` on a `data:` URL succeeded,
  `evaluate_script` returned the page title and the user agent
  (`HeadlessChrome/153.0.0.0`), `take_screenshot` returned a PNG (93612 base64
  characters, about 70 KB): the browser really renders
- **agent configuration merge**: created on first start, then
  `already configured` on restart with the file untouched; on the full access
  profile the entry is added to the mounted operator home, `context7` and the
  provider section are intact, and the backup holds the original file byte for
  byte
- **`ZCLOUDIUM_AUTH=off`**: the runtime answers on the published port with no
  authentication, `GET /api/server-info` returns `200`
- **`ZCLOUDIUM_BROWSER_MCP=off`**: the configuration file is byte for byte
  identical after the start, no backup created
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
- **browser panel, in a real browser, against a real container**
  (panel on, which is the default, hardening on, read-only root filesystem): the
  panel is served at `/_browser/` behind the session; it painted a first frame
  about 900 ms after opening and adopted the size the page was already at; the
  viewport fields applied `640x480` and the page itself reported
  `640x480 dpr=1` with `(max-width: 700px)` flipped, while the frame bitmap became
  `640x480`; a click on the picture focused the page's own input, typing through
  the panel landed `Hi there 42` in it with every key reported to the page's
  keydown listener, a click on a button fired its click handler once, and a wheel
  moved the page from `scrollY 0` to `300`; a still page produced no new frames
  (two canvas digests 1.5 s apart were identical); the DevTools button opened
  Chromium's own frontend through the gateway, which showed the fixture's real DOM
  in its Elements panel
- **browser panel continuity**: with the viewer closed, a real key press and a
  real DOM change were made through CDP, and reopening the panel found the same
  `performance.timeOrigin` (no reload), the same typed text, the same emulated
  viewport, the fields adopted from the page, and a picture that showed the change
  made while nobody was watching. Opening the panel disturbed nothing, and a
  navigation made by the agent while the panel was open appeared in it (the
  address line and the picture followed)
- **the viewport survives the panel closing**, on the pinned Chromium
  (`154.0.8037.57`). The rule was measured first, on a live container: a session
  that attaches and detaches without posing anything leaves another session's
  override alone (`1024x768` before and after), while a session that poses its own
  override replaces it for the whole page and its detach leaves the page at the
  window size (`780x493`). That second half is the bug: the panel used to pose its
  own override, so closing it threw the operator's resolution away. With the
  gateway posing it on a session it never detaches, the end to end continuity spec
  passes on that same browser: the page still reports `800x600` after the panel is
  closed and reopened, which it did not before
- **browser panel, offline and unauthenticated**: without a session, `/_browser/`,
  `/_browser/json/list` and `/_browser/devtools/inspector.html` answer `302` to the
  sign in page and the WebSocket upgrade answers `401` before any upgrade; a
  document that names another host cannot point the panel's socket anywhere but
  its own gateway (unit tested on the URL builder)
- **TLS terminating proxy**: with `ZCLOUDIUM_TRUST_PROXY=on`, an `https` Origin
  of the request's own authority (case and the scheme's default port normalised)
  is accepted on the browser route and on its upgrade, and a different authority,
  name or port is still refused with 403; with the flag off the `https` Origin is
  refused, which is the behaviour before this change
- **end to end, both positions of the panel switch**, against the image: the suite
  passes on a container started with no environment variable at all, which is the
  default position (26 passed, including the five panel specs: the session
  requirement including the upgrade, the viewport control measured from the page,
  the detach and reattach continuity, the address bar with the history buttons, and
  the DevTools button), and on one started with `ZCLOUDIUM_BROWSER_PANEL=off`
  (21 passed, the 5 panel specs skipped with a reason). Those two runs were made by
  hand on this machine, with the same container flags the compose files use. The
  e2e workflow runs the same suite twice on every push, in two parallel jobs, one
  per position of the switch, each asking for its position explicitly, and both
  jobs were observed green on the runner with this release
  (`playwright` and `playwright-panel`, 7m6s and 7m7s).

## Implementation details

- **glibc base is mandatory** (`node:24.14.0-bookworm`), not Alpine: the runtime
  package embeds precompiled `node-pty` binaries
  (`@lydell/node-pty-linux-x64`) and no musl variant is published.
- **Node 24.14.0** is the version the project pins (`mise.toml`) and that the
  runtime needs, not only the build.
- **File search**: ripgrep, bfs and ugrep are embedded in the runtime package,
  there is no need to install them in the image.
- **Fonts**: `fonts-dejavu-core`, `fonts-liberation` and
  `fonts-noto-color-emoji` are installed, because `--no-install-recommends`
  installs no font at all and Chromium would then render pages with empty boxes.
  CJK fonts are left out on purpose (tens of megabytes): add `fonts-noto-cjk` in
  a derived image if you need them.
- **Volumes**: `/data` (authentication, session key, API key, settings, skills,
  agent configuration) and `/workspace` are the only two paths to persist. On a
  bind mount, remember `chown 1000:1000` on the host.
- **`server-info` announces `3.14.0`** while the release tag is `v3.14.3`: the
  image tag is what counts.
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
compiles upstream yourself, at the price of a long build, and it is not
validated yet (see below).

## Dockerfile.from-source (not validated)

Compiles upstream `zai-org/ZCode` instead of using the precompiled runtime.

**That path does not work as is yet.** Finding of 2026-09-24: `pnpm build:zcode`
fails on `Missing @zcode/shared dist files`, because `packages/shared` has no
build script and is never compiled by `build:zcode`, while the SEA asset
collector (`sea-runtime-package-resolution.mjs`) requires
`packages/shared/dist/index.js`. The official sequence of the project
(`scripts/bootstrap.mjs` then `pnpm run build:bootstrap`) was added to that
Dockerfile and should produce that `dist`, but it has not been tested.

## Limits of web mode

Web mode does not allow connecting to a remote project from the interface
(`connectRemote` answers *not supported in Web mode yet*): the workspace is the
server directory mounted on `/workspace`. Distinctly, browser automation is now
available through the baked MCP server described above, and its browser can be
watched and driven by hand from the browser panel.
