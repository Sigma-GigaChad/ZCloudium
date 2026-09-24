# syntax=docker/dockerfile:1

# ZCode Web — image bâtie sur le runtime PRÉCOMPILÉ publié par le fork ZCodium.
#
# Pourquoi pas un build depuis les sources : le runtime est publié tel quel
# (tarball + sha256), donc pas de pnpm, pas d'Electron, pas de toolchain Node
# dans l'image, et un build de quelques secondes au lieu d'une demi-heure.
# Le build depuis les sources amont reste disponible dans Dockerfile.from-source.
#
# Le runtime extrait contient bin/ (runner), server/ (HTTP + WebSocket), web/
# (client) et agent/ (l'agent), plus ses node_modules : il est autonome.
#
# Durcissement (voir SECURITY.md) :
#   - image de base épinglée par digest, pas par tag mutable
#   - tarball runtime vérifié par sha256 épinglé dans le repo (zcode.sha256)
#   - refus de construire si le runtime tiers contient un binaire setuid/setgid
#   - utilisateur non privilégié `node` par défaut (le compose « accès total »
#     le remplace explicitement par root : c'est un choix, pas un défaut)

# L'image de base est épinglée par digest : un `node:24.14.0-bookworm-slim`
# republié ne peut pas changer silencieusement le contenu du build.
ARG NODE_VERSION=24.14.0
ARG NODE_SLIM_DIGEST=sha256:d8e448a56fc63242f70026718378bd4b00f8c82e78d20eefb199224a4d8e33d8

FROM node:${NODE_VERSION}-bookworm-slim@${NODE_SLIM_DIGEST}

ARG ZCODIUM_VERSION=v3.14.3
ARG TARBALL_URL=https://github.com/ZCodium-project/ZCodium/releases/download/v3.14.3/zcodium-3.14.3.tar.gz
ARG TARBALL_SHA256=7af6e216ed65bd44bcf4d410d92c651757b19d65afef5a66e314c3927f0dac53

LABEL org.opencontainers.image.title="z-cloudium" \
      org.opencontainers.image.description="ZCode Web (runtime ZCodium ${ZCODIUM_VERSION})" \
      org.opencontainers.image.version="${ZCODIUM_VERSION}" \
      org.opencontainers.image.revision="${TARBALL_SHA256}" \
      org.opencontainers.image.source="https://github.com/ZCodium-project/ZCodium" \
      org.opencontainers.image.licenses="Apache-2.0"

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# git/curl : l'agent exécute de vraies commandes shell dans son workspace et s'en
# sert en permanence. less/procps : confort (pagers, ps).
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates curl less procps \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /data /workspace \
 && chown node:node /data /workspace

# Téléchargement, vérification d'intégrité, extraction, puis contrôle du contenu.
RUN set -euo pipefail; \
    curl -fsSL "$TARBALL_URL" -o /tmp/zcodium.tar.gz; \
    echo "${TARBALL_SHA256}  /tmp/zcodium.tar.gz" | sha256sum -c -; \
    mkdir -p /opt/zcodium; \
    tar -xzf /tmp/zcodium.tar.gz -C /opt/zcodium --strip-components=1; \
    rm -f /tmp/zcodium.tar.gz; \
    test -f /opt/zcodium/bin/zcode.mjs; \
    test -f /opt/zcodium/server/entry-http.js; \
    setuid="$(find /opt/zcodium -xdev \( -perm -4000 -o -perm -2000 \) -print)"; \
    if [ -n "$setuid" ]; then \
      echo "Runtime tiers : binaires setuid/setgid inattendus, build refusé." >&2; \
      echo "$setuid" >&2; \
      exit 1; \
    fi

# L'utilisateur `node` (uid 1000) est fourni par l'image de base : pas de
# création d'utilisateur, pas de conflit d'uid, et aucun privilège par défaut.
ENV ZCODE_DATA_BASE_DIR=/data \
    ZCODE_SERVER_WORKSPACE=/workspace \
    ZCODE_MODEL_TELEMETRY_ENABLED=0 \
    HOME=/data

RUN ln -sfn /opt/zcodium/bin/zcode.mjs /usr/local/bin/zcode

VOLUME ["/data"]

WORKDIR /workspace

## Par défaut : utilisateur non privilégié. Le durcissement du conteneur
## (cap_drop, no-new-privileges, rootfs en lecture seule) vit dans les compose.
USER node
EXPOSE 3030

# 401 compte comme « serveur vivant » : /api/* est protégé quand un token est posé.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3030/api/server-info').then(r=>process.exit(r.ok||r.status===401?0:1)).catch(()=>process.exit(1))"

# ATTENTION : --no-token désactive toute authentification. Quiconque atteint le
# port peut exécuter des commandes shell dans ce conteneur. Ne publier le port
# que sur une interface privée (voir compose.yml et SECURITY.md).
ENTRYPOINT ["node", "/opt/zcodium/bin/zcode.mjs"]
CMD ["--web", "--host", "0.0.0.0", "--port", "3030", "--workspace", "/workspace", "--no-open", "--no-token"]
