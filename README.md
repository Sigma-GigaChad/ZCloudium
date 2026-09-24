# zcode-docker

Image Docker de **ZCode Web**, bâtie sur le runtime précompilé publié par le fork
[ZCodium](https://github.com/ZCodium-project/ZCodium), avec un versioning qui
tient dans deux fichiers.

Objectif : un snapshot figé et reproductible du logiciel, sans installer pnpm,
Node, Electron ni aucune dépendance de build sur la machine qui l'héberge.
Aucune toolchain n'existe dans l'image finale.

## Pourquoi ce fork plutôt que l'amont

Amont (`zai-org/ZCode`) **ne publie aucun binaire serveur** : ses releases ne
contiennent que des installeurs desktop (dmg / exe). Utiliser l'amont imposerait
de compiler soi-même à chaque version — `pnpm install` sur tout le monorepo,
build de 15 à 30 min — ce qui est précisément ce qu'on veut éviter ici.

ZCodium publie, à chaque release, le tarball du runtime serveur (`zcodium-<version>.tar.gz`)
avec son `sha256.txt`. L'image ne fait donc que télécharger, vérifier et extraire :
**~13 secondes de build** au lieu d'une demi-heure.

Ce fork annonce par ailleurs retirer la télémétrie et les remontées de l'amont,
et synchroniser les commits amont un par un. **Ce point n'est pas vérifié par
moi** : c'est une affirmation de tiers, sur du code de tiers. Deux garde-fous
sont en place malgré tout :

- le `sha256` du tarball est **épinglé dans ce repo** (`zcode.sha256`) : une
  release modifiée après coup fait échouer le build au lieu de passer inaperçue
- l'image force `ZCODE_MODEL_TELEMETRY_ENABLED=0` (l'export OTLP de l'amont est
  de toute façon inactif sans `OTEL_EXPORTER_OTLP_ENDPOINT` configuré)

Si tu ne veux dépendre que de l'éditeur d'origine, `Dockerfile.from-source`
compile l'amont toi-même — au prix du build long, et il n'est pas encore validé
(voir plus bas).

## Le modèle de versioning

Deux fichiers, une seule vérité :

| Fichier | Contenu |
| --- | --- |
| `zcode.version` | le tag de release épinglé (ex. `v3.14.3`) |
| `zcode.sha256` | le sha256 du tarball de cette release |

- un tag d'image par release : `zcode-web:3.14.3` + `zcode-web:latest`
- le sha256 exact est inscrit dans un label (`org.opencontainers.image.revision`)
- bumper = `./check-upstream.sh --bump`

```bash
./check-upstream.sh              # à jour ? (exit 0) ou nouvelle release ? (exit 1)
./check-upstream.sh --bump       # met à jour zcode.version + zcode.sha256
./check-upstream.sh --build      # bump puis rebuild
REPO=zai-org/ZCode ./check-upstream.sh   # surveiller l'amont d'origine à la place
```

Pour un cron quotidien qui ne fait que prévenir :

```
0 6 * * * cd /srv/zcode-docker && ./check-upstream.sh || mail -s "ZCode: nouvelle release" moi@example.com
```

## Construire

```bash
./build.sh                # -> zcode-web:3.14.3 + zcode-web:latest
IMAGE=ghcr.io/moi/zcode ./build.sh --push
```

`docker build .` fonctionne aussi sans passer par le script : les valeurs par
défaut du Dockerfile correspondent à `zcode.version` / `zcode.sha256`.

Si tu préfères ne pas builder sur la VM, build ailleurs et pousse dans un
registry privé — la VM ne fait alors qu'un `docker pull`. Le Dockerfile ne
change pas.

## Lancer

```bash
cp compose.yml compose.local.yml   # et adapter l'IP de bind
docker compose -f compose.local.yml up -d
```

Interface sur `http://<ip-privée>:3030`. État serveur : `docker compose logs -f`.

## Durcissement

Le détail est dans [SECURITY.md](SECURITY.md) : ce qui est appliqué, ce qui est
délibérément écarté, et les risques résiduels. En résumé :

**Dans l'image** — base épinglée par digest, tarball runtime vérifié par le
sha256 épinglé dans ce repo, refus de construire si le runtime tiers contient un
binaire setuid/setgid, aucune toolchain de build, utilisateur non privilégié par
défaut.

**Dans les conteneurs** — `no-new-privileges`, `cap_drop: [ALL]` puis ajout
explicite du minimum, limites `pids`/`mem`/`cpus`, pas de socket Docker par
défaut, port lié à une seule interface privée, télémétrie forcée à l'arrêt.

Le profil restreint (`compose.yml`) ajoute le rootfs en lecture seule avec un
tmpfs `/tmp`. Le profil accès total ne l'applique pas, volontairement : avec root
sur `/host` cela n'empêcherait aucune persistance tout en cassant `apt install`.

## Accès total au FS de la VM (root)

`compose.full-access.yml` fait tourner l'agent en root avec tout le FS de la VM
monté sur `/host` : il peut lire et écrire n'importe où, y compris `/etc`, `/var`
et `/root`.

```bash
./check-full-access.sh                       # vérifie les mécanismes (image jetable)
cp compose.full-access.yml compose.local.yml # adapter l'IP et les chemins
docker compose -f compose.local.yml up -d
```

**Le point à comprendre : « sudo » n'est pas le mécanisme.** Installer sudo dans
l'image ne donnerait aucun droit de plus — sudo ne fait que re-rootiser *à
l'intérieur* du conteneur, alors que les droits réels du conteneur sont décidés
par ses options de lancement. Ce qui donne l'accès root à la VM, ce sont
exactement ces deux lignes :

```yaml
user: root          # uid 0 dans le conteneur = uid 0 sur le FS monté
volumes:
  - /:/host         # tout le FS de la VM
```

`--privileged` n'est **pas** nécessaire pour ça (il n'ajoute que l'accès aux
périphériques), et `docker.sock` est une option distincte qui équivaut elle aussi
à root sur l'hôte.

### Retrouver ton ~/.zcode existant

Les skills, commandes et mémoires ne se résolvent pas via le data dir mais via
`$HOME/.zcode` (`packages/services/src/skills/skillsService.ts` et
`.../memory/memoryService.ts`). D'où le réglage des deux variables vers ton vrai
home de VM :

```yaml
environment:
  HOME: /host/home/<user>
  ZCODE_DATA_BASE_DIR: /host/home/<user>
```

L'agent voit alors `~/.zcode/skills`, `~/.zcode/cli` (commandes, mémoires) et
`~/.zcode/v2` (configuration). Copie ton `~/.zcode` de poste vers la VM pour
partir de ta configuration existante.

### Protection git à lever

En root, git refuse d'opérer sur un dépôt appartenant à un autre uid
(`detected dubious ownership in repository`). Le compose lève la protection pour
ce process uniquement, sans toucher à la config git de la VM :

```yaml
GIT_CONFIG_COUNT: "1"
GIT_CONFIG_KEY_0: safe.directory
GIT_CONFIG_VALUE_0: "*"
```

`./check-full-access.sh` valide les cinq points : uid 0, lecture de
`/etc/shadow`, écriture hors du conteneur, visibilité de `$HOME/.zcode`, et le
comportement git avec et sans ce correctif.

### Risque

Sans token **et** en root, quiconque atteint le port 3030 a un accès root à cette
VM. Bind impératif sur l'IP privée, et prends un **snapshot Proxmox** avant la
première utilisation : un agent qui se trompe de chemin peut casser le système.
Le conteneur est en `restart: unless-stopped`, il revient donc après un reboot.

## Configurer le modèle

Aucun tunnel vers z.ai n'est nécessaire : client web, backend et agent tournent
dans le conteneur. Seuls les appels au LLM sortent.

Au premier accès, l'interface affiche directement l'écran d'accueil **API Key**
(provider `Z.ai`, champ de clé, bouton Continue). La clé saisie est écrite côté
serveur dans `provider_config.json` du volume `/data` : elle survit aux
recréations de conteneur. Le `baseUrl` étant configurable, un endpoint
compatible OpenAI/Anthropic local fonctionne aussi.

À noter : avec `--no-token`, le serveur n'enregistre pas
`IProviderProvisioningTargetService` (canal qui permet à un client desktop
distant de pousser ses credentials). Le passage par les réglages de l'interface
n'est pas affecté ; c'est simplement le seul chemin disponible.

## Avertissement de sécurité

L'image tourne **sans authentification** (`--no-token`). Quiconque atteint le
port peut faire exécuter des commandes shell par l'agent, en tant qu'utilisateur
`node`, dans `/workspace`.

C'est un choix acceptable sur un réseau privé (LAN, VLAN, WireGuard/Tailscale).
Sinon :

- publie le port uniquement sur l'IP privée (`ports: "10.x.x.x:3030:3030"`, comme
  dans `compose.yml`), jamais `3030:3030`
- ou retire `--no-token` : le serveur génère un token et l'affiche dans les logs,
  à utiliser via `?token=...`

## Ce qui a été vérifié

Testé le 2026-09-24, build et exécution réels :

- build de l'image : ~13 s, sha256 du tarball vérifié pendant le build
- taille de l'image : 680 Mo
- conteneur : `healthy`, `GET /` répond 200, `/api/server-info` renvoie
  `{"version":"3.14.0","authRequired":false,"workspaces":[{"path":"/workspace"}]}`
- UI : la page se monte et affiche l'onboarding « API Key » (provider Z.ai)
- **profil restreint durci** : HTTP 200, `User=1000:1000`, `ReadonlyRootfs=true`,
  `CapDrop=[ALL]`, `no-new-privileges`, écriture dans le volume `/data` OK
- **profil accès total durci** : HTTP 200, `User=root`, `CapAdd` limité aux 7
  capacités d'administration, lecture de `/etc/shadow` OK, écriture sur le FS monté
  OK, skills visibles via `$HOME/.zcode`

Effet de bord constaté pendant ces tests et documenté dans SECURITY.md : lancé en
root, l'agent crée des fichiers **appartenant à root** dans `$HOME/.zcode`
(`v2/provider_config.json`, bases sqlite, certificats). L'utilisateur de la VM
devra utiliser `sudo` pour les modifier ou les supprimer.

Détail à connaître : `server-info` annonce `3.14.0` alors que le tag de release
est `v3.14.3`. Le versioning qui fait foi est celui de l'image.

## Détails d'implémentation

- **Base glibc obligatoire** (`node:24.14.0-bookworm`) et non Alpine : le paquet
  runtime embarque les binaires précompilés `node-pty`
  (`@lydell/node-pty-linux-x64`) et aucune variante musl n'est fournie.
- **Node 24.14.0** est la version épinglée par le projet (`mise.toml`) et
  nécessaire au runtime, pas seulement au build.
- **Recherche de fichiers** : ripgrep, bfs et ugrep sont embarqués dans le paquet
  runtime, inutile de les installer dans l'image.
- **Volumes** : `/data` (état, clé API, sessions) et `/workspace` (projet) sont
  les deux seuls points à persister. Sur un bind mount, pense à
  `chown 1000:1000` le dossier hôte : l'utilisateur du conteneur est `node` (uid 1000).

## Dockerfile.from-source (non validé)

Compile l'amont `zai-org/ZCode` à la place du runtime précompilé.

**Ce chemin ne fonctionne pas encore tel quel.** Constat du 2026-09-24 :
`pnpm build:zcode` échoue sur `Missing @zcode/shared dist files`, car
`packages/shared` n'a pas de script de build et n'est jamais compilé par
`build:zcode`, alors que le collecteur d'assets SEA (`sea-runtime-package-resolution.mjs`)
exige `packages/shared/dist/index.js`. La séquence officielle du projet
(`scripts/bootstrap.mjs`: `pnpm run build:bootstrap`) a été ajoutée dans ce
Dockerfile et devrait produire ce `dist`, mais elle n'a pas été testée.

## Limites du mode Web

Le mode Web ne permet pas de se connecter à un projet distant depuis l'interface
(`connectRemote` répond *not supported in Web mode yet*) : le workspace est le
dossier serveur monté sur `/workspace`.
