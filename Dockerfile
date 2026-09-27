# syntax=docker/dockerfile:1

# ZCode Web, built on the PRECOMPILED runtime published by the ZCodium fork.
#
# Why not a build from source: the runtime is published as is (a tarball plus
# its sha256), so there is no pnpm, no Electron and no Node toolchain in the
# image, and the build takes seconds instead of half an hour. Building from the
# sources upstream is still available in Dockerfile.from-source.
#
# The extracted runtime contains bin/ (the runner), server/ (HTTP plus
# WebSocket), web/ (the client) and agent/ (the agent), plus its own
# node_modules: it is self contained.
#
# What this image adds around the runtime, without patching one line of it:
#   - gateway/: an authentication gateway, and the entrypoint. It owns the
#     published port, asks for a password plus a TOTP code, and proxies to the
#     runtime, which is then confined to loopback.
#   - Chromium with the fonts it renders pages with, and the browser MCP server
#     the agent drives it through. Built in because a container has no display,
#     and pinned in chromium.version: the browser is the one component whose
#     version decides what the agent sees, so two builds of one commit have to
#     agree on it.
#   - the operator panel that watches that same browser, served by gateway/. It
#     does not speak the browser's protocol itself: it asks the gateway for a
#     resolution, and the gateway poses it on the runtime's own playwright-core,
#     whose presence the build asserts below so a runtime that stops shipping it
#     fails here rather than in a container (issue #9).
#
# Hardening (see SECURITY.md):
#   - base image pinned by digest, not by a mutable tag
#   - runtime tarball verified against the sha256 pinned in this repository
#   - the build refuses a third party runtime that carries a setuid/setgid binary
#   - unprivileged `node` user by default (the full access compose replaces it
#     with root explicitly: that is a choice, not a default)

# The base image is pinned by digest: a republished `node:24.14.0-bookworm-slim`
# cannot silently change the content of the build.
ARG NODE_VERSION=24.14.0
ARG NODE_SLIM_DIGEST=sha256:d8e448a56fc63242f70026718378bd4b00f8c82e78d20eefb199224a4d8e33d8

FROM node:${NODE_VERSION}-bookworm-slim@${NODE_SLIM_DIGEST}

# The pins are not defaults. They live in zcode.version, zcode.sha256 and
# chromium.version at the root of the repository, and every build path passes
# them: ./build.sh, build.yml, and both jobs of e2e.yml. A default here is what
# let a build ship the previous runtime under the new tag, the image announcing
# 3.14.3 in its own labels while zcode.version said 3.14.4. The guard below
# refuses that build instead of producing it.
ARG ZCODIUM_VERSION
ARG TARBALL_URL
ARG TARBALL_SHA256

# The browser, pinned the same way: the exact Debian package versions for apt,
# and the string `chromium --version` has to contain.
ARG CHROMIUM_PACKAGE
ARG CHROMIUM_COMMON_PACKAGE
ARG CHROMIUM_UPSTREAM

# The browser MCP server is pinned to an exact version, and recorded in
# README.md: an image must not depend on whatever the npm tag points at on the
# day it is rebuilt.
ARG BROWSER_MCP_PACKAGE=chrome-devtools-mcp
ARG BROWSER_MCP_VERSION=1.10.1

LABEL org.opencontainers.image.title="z-cloudium" \
      org.opencontainers.image.description="ZCode Web behind an authentication gateway (ZCodium runtime ${ZCODIUM_VERSION})" \
      org.opencontainers.image.version="${ZCODIUM_VERSION}" \
      org.opencontainers.image.revision="${TARBALL_SHA256}" \
      org.opencontainers.image.source="https://github.com/ZCodium-project/ZCodium" \
      org.opencontainers.image.licenses="Apache-2.0"

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# First thing the image builds: every pin arrived, or the build stops here, in
# bash, with a sentence a human can act on.
RUN for value in "$ZCODIUM_VERSION" "$TARBALL_URL" "$TARBALL_SHA256" "$CHROMIUM_PACKAGE" "$CHROMIUM_COMMON_PACKAGE" "$CHROMIUM_UPSTREAM"; do \
      if [ -z "$value" ]; then \
        echo "This build is missing a pinned build argument." >&2; \
        echo "They come from zcode.version, zcode.sha256 and chromium.version: pass every one with --build-arg." >&2; \
        exit 1; \
      fi; \
    done

# git/curl: the agent runs real shell commands in its workspace and uses them
# constantly. less/procps: convenience (pagers, ps). openssl: the gateway
# terminates TLS with a certificate it generates, and a certificate is not
# something to hand-roll in Node.
# chromium: the browser the MCP server drives, pinned in chromium.version and
# installed at that exact version, companion package included so apt cannot pair
# a pinned chromium with another chromium-common. `chromium --version` is
# compared to the manifest right after: a distribution point release silently
# changing the browser is what broke the operator viewport between two builds of
# one commit.
# openssl: the gateway terminates TLS with a certificate it generates itself, and
# a certificate is not something to hand-roll in Node. It is the only reason this
# package is here: the runtime brings its own TLS libraries.
# fonts-*: with --no-install-recommends no font is installed at all, and
# Chromium would then render every page with empty boxes. CJK fonts are
# deliberately left out (tens of megabytes): install fonts-noto-cjk in a derived
# image if you need them.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates \
      "chromium=${CHROMIUM_PACKAGE}" \
      "chromium-common=${CHROMIUM_COMMON_PACKAGE}" \
      curl \
      fonts-dejavu-core \
      fonts-liberation \
      fonts-noto-color-emoji \
      git \
      less \
      openssl \
      procps \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /data /workspace \
 && chown node:node /data /workspace \
 && installed="$(chromium --version)" \
 && echo "$installed" \
 && case "$installed" in \
      *"Chromium ${CHROMIUM_UPSTREAM}"*) ;; \
      *) echo "The installed browser is not the pinned one: ${installed}" >&2; exit 1 ;; \
    esac

# Browser automation for the agent, installed at build time: no package manager
# is needed at runtime, and two containers started from the same image run the
# same browser server. Chromium is loaded from the distribution package above
# through --executablePath, so this step downloads no browser of its own.
RUN npm install --global "${BROWSER_MCP_PACKAGE}@${BROWSER_MCP_VERSION}" \
 && rm -rf /root/.npm \
 && test -x /usr/local/bin/chrome-devtools-mcp \
 && chrome-devtools-mcp --version

# Download, integrity check, extraction, then content check.
#
# The setuid scan covers the third party runtime only, which is the code this
# project cannot audit. Chromium ships a setuid helper of its own; it is
# distribution packaged, it is outside this path, and `no-new-privileges` in
# both compose profiles prevents it from ever gaining anything.
RUN set -euo pipefail; \
    curl -fsSL "$TARBALL_URL" -o /tmp/zcodium.tar.gz; \
    echo "${TARBALL_SHA256}  /tmp/zcodium.tar.gz" | sha256sum -c -; \
    mkdir -p /opt/zcodium; \
    tar -xzf /tmp/zcodium.tar.gz -C /opt/zcodium --strip-components=1; \
    rm -f /tmp/zcodium.tar.gz; \
    test -f /opt/zcodium/bin/zcode.mjs; \
    test -f /opt/zcodium/server/entry-http.js; \
    if [ ! -d /opt/zcodium/agent/node_modules/playwright-core ]; then \
      echo "The runtime no longer ships playwright-core, which the browser panel uses to own the viewport (issue #9)." >&2; \
      echo "Either install it explicitly in this image, or point gateway/lib/page-owner.mjs at where it went." >&2; \
      exit 1; \
    fi; \
    setuid="$(find /opt/zcodium -xdev \( -perm -4000 -o -perm -2000 \) -print)"; \
    if [ -n "$setuid" ]; then \
      echo "Third party runtime: unexpected setuid/setgid binaries, refusing to build." >&2; \
      echo "$setuid" >&2; \
      exit 1; \
    fi

# The gateway and the entrypoint. Kept out of /opt/zcodium so that the third
# party runtime directory stays exactly as it was extracted.
COPY gateway /opt/cloudium/gateway

# The `node` user (uid 1000) comes from the base image: no user creation, no uid
# conflict, and no privilege by default.
ENV ZCODE_DATA_BASE_DIR=/data \
    ZCODE_SERVER_WORKSPACE=/workspace \
    ZCODE_MODEL_TELEMETRY_ENABLED=0 \
    HOME=/data

RUN ln -sfn /opt/zcodium/bin/zcode.mjs /usr/local/bin/zcode

VOLUME ["/data"]

WORKDIR /workspace

## Unprivileged user by default. The container hardening (cap_drop,
## no-new-privileges, read-only rootfs) lives in the compose files.
USER node
EXPOSE 3030

# /_auth/health is served by the gateway and answers without a session, which is
# exactly what a probe needs. With ZCLOUDIUM_TLS=on the port speaks TLS only, so
# the probe does too, and it cannot verify a certificate nobody signed: the
# variable is read from the environment rather than guessed, and the http branch
# is unchanged, so an existing container keeps probing what it always probed. With ZCLOUDIUM_AUTH=off there is no gateway and this
# path falls through to the web app, which answers 200 with the interface shell
# (measured), so the container still reports healthy while the probe no longer
# tests anything: override the healthcheck to probe /api/server-info, both compose
# files show how.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "const on=['on','true','1','yes'].includes(String(process.env.ZCLOUDIUM_TLS||'').trim().toLowerCase()); if(!on){fetch('http://127.0.0.1:3030/_auth/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1));} else {require('node:https').get({host:'127.0.0.1',port:3030,path:'/_auth/health',rejectUnauthorized:false},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1));}"

# The entrypoint starts the runtime on loopback, merges the browser MCP server
# into the agent configuration, and puts the gateway on the published port. It is
# the only place that knows the addresses, so the compose files carry no command
# line any more. ZCLOUDIUM_AUTH=off restores the previous behaviour (the runtime
# published directly, without authentication) from the environment alone.
ENTRYPOINT ["node", "/opt/cloudium/gateway/start.mjs"]
