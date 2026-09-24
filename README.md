# z-cloudium

**ZCode Web dans un conteneur, prêt à lancer.** Une image durcie, versionnée et
publiée, sans toolchain à installer : pas de pnpm, pas de Node, pas de compilation.

Le nom est un jeu de mots — ZCodium (le fork d'où vient le runtime) + cloud. Le
projet existe parce que l'amont `zai-org/ZCode` **ne publie aucun binaire serveur**
(seulement des installeurs desktop), ce qui obligerait sinon à compiler tout le
monorepo à chaque version.

## Démarrage rapide

```bash
# 1. L'image est privée : s'authentifier une fois auprès de GHCR.
#    Le token doit porter le scope read:packages (PAT classique).
printf '%s' "$GHCR_TOKEN" | docker login ghcr.io -u <ton-user> --password-stdin

# 2. Récupérer le compose et lancer.
git clone https://github.com/Sigma-GigaChad/z-cloudium.git
cd z-cloudium
docker compose up -d
```

Interface : **http://127.0.0.1:3030**

C'est tout. Le compose par défaut ne demande **aucune édition** : port sur
localhost, workspace dans un volume Docker, durcissement actif. Au premier accès,
l'interface demande une clé API Z.ai — elle est écrite dans le volume, donc elle
survit aux recréations du conteneur.

Pour y accéder depuis une autre machine du réseau privé, remplacer `127.0.0.1`
par l'IP dans la section `ports` de `compose.yml`.

### Sans compose

```bash
docker run -d --name z-cloudium \
  -p 127.0.0.1:3030:3030 \
  -v z-cloudium-data:/data \
  --read-only --tmpfs /tmp:size=512m \
  --security-opt no-new-privileges:true \
  --cap-drop ALL \
  ghcr.io/sigma-gigachad/z-cloudium:latest
```

### Épingler une version

`latest` suit la dernière release. Pour figer :

```yaml
image: ghcr.io/sigma-gigachad/z-cloudium:3.14.3
```

Les tags disponibles sont `latest`, `<version>` (ex. `3.14.3`) et `sha-<commit>`.

### Authentification du paquet

Le paquet GHCR est **privé** comme le repo, et l'étape `docker login` n'est pas
optionnelle : sans elle, `docker pull` répond `denied`.

Le token doit porter le scope **`read:packages`** — un token OAuth de la CLI `gh`
ne l'a pas (son scope `repo` ne suffit pas pour les paquets). Il faut donc un
**PAT classique** avec `read:packages` :

```
GitHub → Settings → Developer settings → Personal access tokens (classic)
→ Generate new token → cocher « read:packages »
```

Deux façons de supprimer cette étape pour rendre le lancement réellement clé en
main :

- **Rendre le paquet public** : la visibilité d'un paquet GHCR est indépendante de
  celle du repo. Un paquet publié depuis un repo privé peut être public.
  Chemin : `GitHub → ton organisation → onglet Packages → z-cloudium →
  Package settings → Change visibility → Public`.
- Ou faire builder chacun depuis les sources (`./build.sh`, quinze secondes) : plus
  aucun registry dans la boucle.

Pour ton propre usage sur une VM privée, le PAT `read:packages` est le choix le plus
conservateur : rien n'est exposé publiquement.

### Travailler sur de vrais fichiers

Par défaut le workspace est un volume Docker, pour que `docker compose up -d`
fonctionne sans préparation. Pour donner accès à un dossier de la machine,
commenter le volume `z-cloudium-workspace` dans `compose.yml` et le remplacer par
un montage de dossier — après un `chown 1000:1000` côté hôte, le conteneur
tournant en uid 1000 :

```yaml
- /srv/z-cloudium/workspace:/workspace
```

## Le modèle de versioning

Deux fichiers, une seule vérité :

| Fichier | Contenu |
| --- | --- |
| `zcode.version` | le tag de release amont épinglé (ex. `v3.14.3`) |
| `zcode.sha256` | le sha256 du tarball de cette release |

Un tag d'image par release, le sha256 inscrit dans un label
(`org.opencontainers.image.revision`), et une veille automatique :

```bash
./check-upstream.sh              # à jour ? (exit 0) ou nouvelle release ? (exit 1)
./check-upstream.sh --bump       # met à jour zcode.version + zcode.sha256
./check-upstream.sh --build      # bump puis rebuild local
REPO=zai-org/ZCode ./check-upstream.sh   # surveiller l'amont d'origine à la place
```

Le workflow `upstream-check` fait cette veille chaque semaine et **ouvre un
ticket** quand une release sort — il ne modifie rien tout seul, le bump reste une
décision explicite.

## Construire l'image soi-même

```bash
./build.sh                # -> ghcr.io/sigma-gigachad/z-cloudium:{3.14.3,latest}
./build.sh --push         # idem, puis push vers le registry
```

Le build prend une quinzaine de secondes : il télécharge le tarball amont (81 Mo),
vérifie son sha256 et l'extrait. Un build local satisfait directement les fichiers
compose, qui référencent la même image.

La CI (`.github/workflows/build.yml`) reconstruit et publie à chaque push sur
`main`, puis un job `smoke` **démarre l'image publiée** et vérifie que l'interface
répond — une image n'est pas livrée sans avoir été lancée.

## Durcissement

Le détail complet — ce qui est appliqué, ce qui est délibérément écarté et les
risques résiduels — est dans [SECURITY.md](SECURITY.md). En résumé :

**Dans l'image** : base épinglée par digest, tarball runtime vérifié par le sha256
épinglé dans ce repo, refus de construire si le runtime tiers contient un binaire
setuid/setgid, aucune toolchain de build, utilisateur non privilégié par défaut.

**Dans les conteneurs** : `no-new-privileges`, `cap_drop: [ALL]` puis ajout
explicite du minimum, limites `pids`/`mem`/`cpus`, pas de socket Docker par défaut,
port lié à une seule interface, télémétrie forcée à l'arrêt.

Le profil restreint (`compose.yml`) ajoute le rootfs en lecture seule avec un tmpfs
`/tmp`. Le profil accès total ne l'applique pas, volontairement : avec root sur
`/host` cela n'empêcherait aucune persistance tout en cassant `apt install`.

## Accès total au FS de la machine (root)

`compose.full-access.yml` fait tourner l'agent en root avec tout le FS de la
machine monté sur `/host` : il peut lire et écrire n'importe où, y compris `/etc`,
`/var` et `/root`.

```bash
./check-full-access.sh                        # vérifie les mécanismes (image jetable)
cp compose.full-access.yml compose.local.yml  # adapter le port et les chemins
docker compose -f compose.local.yml up -d
```

**Le point à comprendre : « sudo » n'est pas le mécanisme.** Installer sudo dans
l'image ne donnerait aucun droit de plus — sudo ne fait que re-rootiser *à
l'intérieur* du conteneur, alors que les droits réels sont décidés par les options
de lancement. Ce qui donne l'accès root à la machine, ce sont exactement ces deux
lignes :

```yaml
user: root          # uid 0 dans le conteneur = uid 0 sur le FS monté
volumes:
  - /:/host         # tout le FS de la machine
```

`--privileged` n'est **pas** nécessaire pour ça (il n'ajoute que l'accès aux
périphériques). `docker.sock` est une option distincte, également équivalente à
root sur l'hôte, laissée commentée.

### Retrouver ton ~/.zcode existant

Les skills, commandes et mémoires ne se résolvent pas via le data dir mais via
`$HOME/.zcode` (`packages/services/src/skills/skillsService.ts` et
`.../memory/memoryService.ts`). D'où le réglage des deux variables vers ton vrai
home :

```yaml
environment:
  HOME: /host/home/<user>
  ZCODE_DATA_BASE_DIR: /host/home/<user>
```

L'agent voit alors `~/.zcode/skills`, `~/.zcode/cli` (commandes, mémoires) et
`~/.zcode/v2` (configuration). Copie ton `~/.zcode` de poste vers cette machine
pour partir de ton environnement existant.

### Protection git à lever

En root, git refuse d'opérer sur un dépôt appartenant à un autre uid
(`detected dubious ownership in repository`). Le compose lève la protection pour
ce process uniquement, sans toucher à la config git de la machine :

```yaml
GIT_CONFIG_COUNT: "1"
GIT_CONFIG_KEY_0: safe.directory
GIT_CONFIG_VALUE_0: "*"
```

### Effet de bord à connaître

Lancé en root, l'agent crée des fichiers **appartenant à root** dans le
`$HOME/.zcode` de la machine (`v2/provider_config.json`, bases sqlite,
certificats). L'utilisateur devra passer par `sudo` pour les modifier ou les
supprimer. C'est la conséquence de l'uid 0, pas un bug.

### Risque

Root sur toute la machine **plus** `--no-token` : quiconque atteint le port 3030
devient root sur le système. Le bind sur une IP privée est alors la seule barrière.
Prends un snapshot de la machine avant la première utilisation — un agent qui se
trompe de chemin peut casser le système — et traite cette machine comme
compromise par conception : pas de credentials d'infrastructure, pas d'accès au
reste du parc.

## Configurer le modèle

Aucun tunnel vers z.ai n'est nécessaire : client web, backend et agent tournent
dans le conteneur. Seuls les appels au LLM sortent.

Au premier accès, l'interface affiche directement l'écran d'accueil **API Key**
(provider `Z.ai`, champ de clé, bouton Continue). La clé est écrite côté serveur
dans `provider_config.json` du volume `/data` : elle survit aux recréations de
conteneur. Le `baseUrl` étant configurable, un endpoint compatible
OpenAI/Anthropic local fonctionne aussi.

À noter : avec `--no-token`, le serveur n'enregistre pas
`IProviderProvisioningTargetService` (canal qui permet à un client desktop distant
de pousser ses credentials). Le passage par les réglages de l'interface n'est pas
affecté ; c'est simplement le seul chemin disponible.

## Avertissement de sécurité

L'image tourne **sans authentification** (`--no-token`). Quiconque atteint le port
peut faire exécuter des commandes shell par l'agent, en tant qu'utilisateur `node`
dans le profil restreint, en tant que **root** dans le profil accès total.

Le défaut est donc `127.0.0.1` : joignable depuis la machine hôte uniquement.
Pour l'ouvrir au réseau, deux options :

- publier le port sur l'IP privée (`ports: "10.x.x.x:3030:3030"`), jamais
  `3030:3030`
- ou retirer `--no-token` : le serveur génère un token et l'affiche dans
  `docker compose logs`, à utiliser via `?token=...`

## Ce qui a été vérifié

Testé par exécution réelle, pas seulement écrit :

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
- `check-full-access.sh` valide les 5 mécanismes du profil accès total
- **CI** : jobs `build` et `smoke` verts au premier passage (commit `d6a7e61`).
  Trois tags poussés — `latest`, `3.14.3`, `sha-d6a7e61` — sous le digest
  `sha256:83ae9903…`. Le job `smoke` a tiré l'image **publiée**, l'a démarrée avec
  le durcissement complet et a vérifié que l'interface répond.

## Détails d'implémentation

- **Base glibc obligatoire** (`node:24.14.0-bookworm`) et non Alpine : le paquet
  runtime embarque les binaires précompilés `node-pty`
  (`@lydell/node-pty-linux-x64`) et aucune variante musl n'est fournie.
- **Node 24.14.0** est la version épinglée par le projet (`mise.toml`) et
  nécessaire au runtime, pas seulement au build.
- **Recherche de fichiers** : ripgrep, bfs et ugrep sont embarqués dans le paquet
  runtime, inutile de les installer dans l'image.
- **Volumes** : `/data` (état, clé API, sessions, skills) et `/workspace` sont les
  deux seuls points à persister. Sur un montage de dossier, pense à
  `chown 1000:1000` côté hôte.
- `server-info` annonce `3.14.0` alors que le tag de release est `v3.14.3` : c'est
  le tag d'image qui fait foi.

## Pourquoi ce fork plutôt que l'amont

Amont (`zai-org/ZCode`) ne publie que des installeurs desktop (dmg / exe) : utiliser
l'amont imposerait de compiler le monorepo à chaque version, soit 15 à 30 minutes
de build sur une machine équipée. ZCodium publie, à chaque release, le tarball du
runtime serveur avec son `sha256.txt` — d'où un build de quinze secondes ici.

Ce fork annonce retirer la télémétrie et les remontées de l'amont, et synchroniser
les commits amont un par un. **Ce point n'est pas vérifié** : c'est une affirmation
de tiers, sur du code de tiers. Deux garde-fous limitent le risque : le sha256 est
épinglé dans ce repo (une release modifiée fait échouer le build), et l'image force
`ZCODE_MODEL_TELEMETRY_ENABLED=0` (l'export OTLP amont est de toute façon inactif
sans `OTEL_EXPORTER_OTLP_ENDPOINT` configuré).

Si tu ne veux dépendre que de l'éditeur d'origine, `Dockerfile.from-source` compile
l'amont toi-même — au prix du build long, et il n'est pas encore validé (voir plus
bas).

## Dockerfile.from-source (non validé)

Compile l'amont `zai-org/ZCode` à la place du runtime précompilé.

**Ce chemin ne fonctionne pas encore tel quel.** Constat du 2026-09-24 :
`pnpm build:zcode` échoue sur `Missing @zcode/shared dist files`, car
`packages/shared` n'a pas de script de build et n'est jamais compilé par
`build:zcode`, alors que le collecteur d'assets SEA
(`sea-runtime-package-resolution.mjs`) exige `packages/shared/dist/index.js`. La
séquence officielle du projet (`scripts/bootstrap.mjs` → `pnpm run build:bootstrap`)
a été ajoutée dans ce Dockerfile et devrait produire ce `dist`, mais elle n'a pas
été testée.

## Limites du mode Web

Le mode Web ne permet pas de se connecter à un projet distant depuis l'interface
(`connectRemote` répond *not supported in Web mode yet*) : le workspace est le
dossier serveur monté sur `/workspace`.
