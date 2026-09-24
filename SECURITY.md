# Sécurité

Ce document décrit ce qui est durci, ce qui ne l'est pas, et pourquoi. Il
distingue deux choses que l'on confond facilement : **l'image** (ce que l'agent
embarque) et **le conteneur** (les droits qu'on lui donne au lancement).

Rien ici ne peut corriger le comportement de ZCode lui-même : c'est du code tiers
qui ne dépend pas de nous. Tout ce qui suit porte sur l'enveloppe Docker.

## Deux profils

| | `compose.yml` (restreint) | `compose.full-access.yml` (accès total) |
| --- | --- | --- |
| Utilisateur | `1000:1000` (non privilégié) | `root` |
| Vue du FS | `/workspace` + volume `/data` | toute la VM montée sur `/host` |
| Rootfs conteneur | `read_only` + tmpfs `/tmp` | inscriptible (voir plus bas) |
| Capacités | aucune (`cap_drop: ALL`) | 7 capacités d'administration |
| Portée d'une compromission | le workspace | toute la VM |

Le profil restreint suffit pour la plupart des usages. L'accès total est un choix
délibéré, avec les conséquences décrites plus bas.

## Ce qui est durci

### Dans l'image (`Dockerfile`)

- **Image de base épinglée par digest** : `node:24.14.0-bookworm-slim@sha256:d8e448a5…`.
  Un tag republié ne peut pas modifier silencieusement le contenu du build.
- **Runtime vérifié par sha256 épinglé dans le repo** (`zcode.sha256`). Une release
  amont modifiée après coup fait échouer le build au lieu de passer inaperçue.
- **Refus de construire si le runtime tiers contient un binaire setuid/setgid.**
  Le tarball est du code tiers : un setuid y serait un vecteur d'élévation, le
  build s'arrête si `find … -perm -4000 -o -perm -2000` remonte quelque chose.
- **Aucune toolchain de build** dans l'image finale : ni pnpm, ni compilateur, ni
  Electron. Moins de surface, moins de CVE à suivre.
- **Utilisateur non privilégié `node` par défaut.** Le profil accès total le
  remplace explicitement par root : c'est une décision de lancement, pas un défaut
  hérité de l'image.
- `APT` sans recommandations, listes supprimées, `pipefail` actif dans le shell de
  build.

### Dans le conteneur (les deux profils)

- **`no-new-privileges:true`** : interdit toute élévation par binaire setuid ou
  fichier-capability, y compris depuis le FS monté.
- **`cap_drop: [ALL]`** puis ajout explicite du minimum. Docker accorde par défaut
  des capacités inutiles ici ; sont désormais absentes : `NET_RAW` (forge de
  paquets), `SYS_ADMIN`, `SYS_MODULE`, `SYS_PTRACE`, `MKNOD`, `SETFCAP`,
  `AUDIT_WRITE`, `SYS_CHROOT`.
- **Limites de ressources** : `pids_limit` (anti fork-bomb), `mem_limit`, `cpus`.
  Un agent qui s'emballe ne doit pas faire tomber la VM.
- **Pas de `privileged`, pas de socket Docker par défaut.** Le socket est
  commenté : le monter équivaut à root sur l'hôte.
- **Port publié sur une seule interface privée.** Jamais `3030:3030`.
- **Télémétrie forcée à l'arrêt** (`ZCODE_MODEL_TELEMETRY_ENABLED=0`), alors que
  l'exporter OTLP amont est de toute façon inactif sans endpoint configuré.

### Ce qui est délibérément *non* appliqué

- **`read_only` sur le profil accès total.** Avec root sur `/host`, un attaquant
  persiste de toute façon dans `/etc` de la VM (unités systemd, cron,
  `authorized_keys`). Le `read_only` n'empêcherait rien et casserait l'usage
  légitime — `apt install` dans le conteneur, notamment. L'appliquer là serait du
  durcissement de façade. Le profil restreint l'applique, lui, sans coût.
- **Capacités réduites au point de rendre root inopérant.** Retirer `DAC_OVERRIDE`
  ou `CHOWN` ferait échouer un `apt install` ou un `chown` ordinaire : on
  dégraderait l'outil sans contenir quoi que ce soit, puisque le FS de la VM reste
  monté.

## Risques résiduels

À lire avant de lancer le profil accès total.

1. **Le port est la seule barrière.** `--no-token` + root : quiconque atteint le
   port 3030 obtient un accès root à la VM. Binder sur l'IP privée suppose que le
   réseau privé est réellement de confiance (VLAN dédié, WireGuard, Tailscale).
   Les capacités réduites n'y changent rien : root sur un FS monté suffit.
2. **La VM doit être jetable.** Traite cette VM comme une machine compromise par
   conception : pas de credentials d'infrastructure, pas d'accès au reste du parc,
   pas de clés SSH réutilisées ailleurs. Si elle tombe, rien d'autre ne tombe.
3. **Fichiers appartenant à root dans ton home.** Constaté en test : lancé en root,
   l'agent crée des fichiers root dans `$HOME/.zcode` (`v2/provider_config.json`,
   bases sqlite, certificats…). Ton utilisateur de VM ne pourra plus les modifier
   sans `sudo`. C'est le prix de l'uid 0, pas un bug.
4. **Sortie réseau non filtrée.** L'agent peut atteindre tout ce que la VM atteint.
   Le contrôle qui compte vraiment contre l'exfiltration est au niveau du réseau
   (VLAN, règles firewall en sortie), pas dans le conteneur.
5. **Le runtime vient d'un tiers** (fork ZCodium). L'intégrité est vérifiée par
   hash épinglé, la présence de setuid est contrôlée, mais le code n'a pas été
   audité. Si cela n'est pas acceptable, `Dockerfile.from-source` compile l'amont
   d'origine — chemin non validé à ce jour.
6. **La clé API vit dans le volume** (`/data` ou `$HOME/.zcode`), en clair, et le
   conteneur peut la lire. C'est inhérent à un outil qui doit s'en servir.
7. **Le mode Web n'a pas de gestion multi-utilisateurs** : pas de comptes, pas de
   journal d'audit des actions de l'agent.

## Recommandations

- **Snapshot Proxmox avant la première utilisation** et avant de laisser l'agent
  travailler sans surveillance.
- Commencer par le profil restreint ; ne passer à l'accès total qu'en cas de besoin
  réel.
- VM dédiée, sur un VLAN isolé, sans credentials vers le reste de l'infra.
- Ne monter `docker.sock` que si l'agent doit piloter des conteneurs — et en
  sachant que c'est équivalent à root sur l'hôte.
- Si le réseau privé n'est pas totalement de confiance, retirer `--no-token` : le
  serveur génère un token et l'affiche dans `docker compose logs`.

## Vérifications reproductibles

```bash
./check-full-access.sh    # uid 0, /etc/shadow, écriture FS, $HOME/.zcode, git
./check-upstream.sh       # version épinglée vs dernière release
```

Le durcissement des deux profils a été vérifié par exécution :

| Contrôle | Restreint | Accès total |
| --- | --- | --- |
| Réponse HTTP de l'UI | 200 | 200 |
| `Config.User` | `1000:1000` | `root` |
| `ReadonlyRootfs` | `true` | `false` (délibéré) |
| `CapDrop` | `[ALL]` | `[ALL]` |
| `CapAdd` | — | 7 capacités d'administration |
| `SecurityOpt` | `no-new-privileges:true` | `no-new-privileges:true` |
| `PidsLimit` | 512 | 1024 |
| Lecture `/etc/shadow` | — | OK |
| Écriture sur le FS monté | — | OK |
| Écriture dans le volume `/data` | OK | OK |
| Skills visibles via `$HOME/.zcode` | — | OK |
