# Jenkins — Fraîcheur de la preview vs PR (design)

_2026-06-19 — branche `preview-freshness` (fork perso/équipe, ne remonte pas chez coollabsio)._

Étend le module Jenkins existant (`src-tauri/src/jenkins/`). **Ne réécrit rien.** Le module
gère déjà statut/stages/queue/re-run/notifs + `preview: Option<JenkinsBuild>` et `preview_url`.
Objectifs décidés avec Farès :

1. **Fraîcheur** : « ma preview est-elle à jour avec ma PR ? »
2. **Accès** : surfacer l'URL preview via un **badge Preview dédié** (barre du worktree).

## Découverte décisive (réorientation du design)

L'idée initiale — lire le commit du **build `deploy-preview`** et le comparer au HEAD PR — ne
tient pas face au vrai Jenkins (vérifié en direct via l'API REST) :

- Le job `deploy-preview` est **vide** (`color: notbuilt`, `lastBuild: null`). La preview est en
  réalité déployée par le **stage « Deploy preview » du pipeline `build-and-test`**.
- Les builds `build-and-test` **n'exposent aucun SHA** : pas de `hudson.plugins.git.util.BuildData`
  exploitable, pas de `changeSets`, pas de param `GIT_COMMIT` / `ghprbActualCommit`. Aucun moyen
  d'obtenir le commit déployé côté Jenkins.

**Nouvelle source de vérité : la preview elle-même.** Chaque environnement preview sert un
endpoint `GET https://<PR>.<preview-host>/version` (`text/plain`, sortie `git log -1`), dont la
**première ligne est `commit <sha40>`** = le commit réellement déployé. (Confirmé sur un env
stable type `https://<prod-host>/version`.) L'hôte preview est configuré par projet via le
template `jenkins_preview_url_template` (placeholder `{pr}`) — aucun domaine interne en dur.

## 1. Probe `/version` + comparaison HEAD PR

Module `src-tauri/src/jenkins/freshness.rs` :

```rust
pub struct PreviewFreshness {        // camelCase
    pub status: String,              // UP_TO_DATE | STALE | DOWN | UNKNOWN
    pub preview_sha: Option<String>, // commit servi par la preview (/version)
    pub pr_head_sha: Option<String>, // headRefOid de la PR
    pub behind_by: Option<u32>,      // nb de commits de retard (best-effort)
}
```

- **Pur & testé** : `parse_version_sha(body)` (1ʳᵉ ligne `commit <sha>`) et
  `classify(reachable, preview_sha, pr_head_sha, behind_by)` :
  - injoignable → **DOWN** ;
  - SHA preview == HEAD (prefix-insensitive) → **UP_TO_DATE** (`behind_by = 0`) ;
  - SHA preview != HEAD mais aucun commit de la PR ne manque à la preview
    (`behind_by = 0`, notamment pour `refs/pull/<n>/merge`) → **UP_TO_DATE** ;
  - SHA preview != HEAD avec des commits manquants ou un compare indisponible → **STALE**
    (périmée ; `behind_by` si dispo) ;
  - un SHA manquant → **UNKNOWN**.
- **I/O** : `probe_preview(pr_id)` via `reqwest` (timeout 4 s, `Range: bytes=0-127`, certs
  internes tolérés) ; HEAD PR via `gh pr view <n> --json headRefOid` ; retard via
  `gh api repos/{owner}/{repo}/compare/<base>...<head>` (si les SHA diffèrent). Les appels `gh`
  (bloquants) tournent en `spawn_blocking` ; réutilise `resolve_gh_binary(&app)`.

## 2. Intégration (pas de nouvelle commande Tauri)

`JenkinsWorktreeStatus` gagne `preview_freshness: Option<PreviewFreshness>`, calculé **après**
`assemble_status` dès qu'il y a une PR (`status.pr_id`) :

- `get_jenkins_status` (à la demande) — charge `data` une fois (config + worktree.path).
- `poller.rs` (60 s, background) — émet via `jenkins:status-update`.

Aucune commande ajoutée → rien à enregistrer dans `lib.rs` / `dispatch.rs`. La plomberie
SHA-côté-Jenkins de la 1ʳᵉ itération (champ `commit_sha`, extension du `tree`, extraction)
a été **retirée** (morte).

## 3. UI — Badge Preview dédié

`src/components/jenkins/PreviewBadge.tsx`, monté dans la barre du worktree
(`SessionChatModal.tsx`, à côté de `JenkinsStatusBadge`, **pas** `ChatWindow.tsx`). Réutilise
`useJenkinsStatus` (même `queryKey` → une seule requête).

- Caché si pas de `previewUrl`.
- Pastille : vert **à jour** · ambre **périmée** (+ « en retard de N commits ») · rouge
  **hors ligne** (DOWN) · gris (inconnu). Clic → `openUrl(previewUrl)`. Tooltip : libellé +
  SHA preview vs PR.

Types TS : interface `PreviewFreshness`, `previewFreshness` sur `JenkinsWorktreeStatus`.

## 4. Tests

- `freshness.rs` : `parse_version_sha` (dump réel, rejets) + tous les états de `classify`
  (up / stale / down / unknown, tolérance SHA court et merge contenant le HEAD de PR).
- `bun run check:all`.

## Hors scope v1

- Pas d'état « déploiement en cours » dédié (pendant un redeploy la preview reste STALE puis
  bascule UP_TO_DATE) ; pas de bouton « redéployer ».
- `behind_by` best-effort : si le compare échoue, on affiche quand même **STALE**.

---

## Mise à jour 2026-07-23 — CI unifiée : `/version` a changé de forme

Vérifié en direct sur les previews des PR ouvertes + l'API Jenkins (`unified-deploy-preview`).
Depuis que les déploiements passent par `docker compose` (pipeline unifié), une preview répond
`/version` de **trois** façons, et le parsing d'origine n'en gérait qu'une :

| Réponse observée                     | Signification                      | Avant                                     | Maintenant          |
| ------------------------------------ | ---------------------------------- | ----------------------------------------- | ------------------- |
| `200` + SHA nu 40 hex (`text/plain`) | déploiement unifié récent          | UNKNOWN (gris)                            | comparé normalement |
| `200` + dump `commit <sha>`          | ancien déploiement encore en place | comparé                                   | inchangé            |
| `404` (« Cannot GET /version »)      | app **up**, fichier non publié     | DOWN (rouge, bouton « Ouvrir » désactivé) | fallback Jenkins    |
| `502` / timeout                      | env réellement éteint              | DOWN                                      | inchangé            |

Trois conséquences dans `jenkins/freshness.rs` :

1. `parse_version_sha` accepte le SHA nu (exigé complet — 40 hex — pour ne pas confondre avec
   une chaîne de version) **et** l'ancien `commit <sha>`.
2. Le probe distingue « injoignable » (erreur transport / 5xx → `DOWN`) de « joignable sans
   version » (4xx → `Probe::Up(None)`). Un 404 ne doit plus griser une preview qui marche.
3. Fallback : sans SHA servi, on prend le paramètre `REVISION` du dernier
   `unified-deploy-preview` **réussi** de la PR (`commands::deployed_revision`). C'est ce que
   Jenkins a _déployé_, pas ce qui est _servi_ — `PreviewFreshness.sha_source`
   (`preview` | `jenkins`) porte la nuance jusqu'au badge, qui affiche alors « Déployé <sha> »
   et « (d'après Jenkins) ».
