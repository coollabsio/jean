# AI Pipeline PR Lifecycle — Design

> **Révision 2026-07-21** — La liste devient **multi-surface et multi-colonnes** :
>
> - une commande unique `list_ai_pipeline_tasks` renvoie **deux buckets** :
>   `review` (`to review`/`in review`, PR correspondante requise, draft accepté) et `stuck`
>   (statut ClickUp `stuck`, **PR optionnelle** — sur les 16 tickets STUCK
>   observés le 2026-07-21, 6 n'avaient aucune PR et les 10 autres n'avaient
>   qu'une PR **draft**, d'où le join distinct par bucket) ;
> - `resume_ai_pipeline_task(project_id, task_id, pr_number?, target_status?)`
>   remplace `resume_ai_pipeline_pr` : **avec** PR → `checkout_pr` + assignation
>   PR + claim ClickUp (`in review`) ; **sans** PR → `create_worktree` sur une
>   branche `CU-<id>-<slug>` (la convention pipeline, donc le lien ClickUp
>   continue de se résoudre depuis la branche) + claim ClickUp (`in progress`) ;
> - le **projet est épinglé** dans le sidecar (`project_id`) via
>   `set_ai_pipeline_project`, donc les mêmes tickets s'affichent quel que soit
>   le point d'entrée (sidebar sous Mission Control, onglet « Pipeline IA » ⌘7
>   de New Session, palette, menu worktree) ;
> - la reprise **ne ferme plus** la surface hôte : la ligne passe « Repris ✓ »
>   et l'enchaînement de tickets est possible ;
> - `stuck` est ajouté à `PLANEXPO_STATUSES`, et `ClickUpTask` porte désormais
>   `tags` / `priority` / `date_updated` (utilisés pour le scan visuel).
>
> UI partagée : `AiPipelineTaskList` (modale + onglet), état par ligne rendu par
> **icône + mot** (jamais la couleur seule).

> **Révision 2026-06-23** — La Phase 1 a pivoté : **ClickUp est la source de
> vérité**, pas l'état GitHub. Le listing montre les **tickets ClickUp en
> `to review` OU `in review`** (les deux colonnes de review existent),
> **non-assignés OU assignés à moi**, joints à leur PR du repo courant via la
> convention `CU-<id>`. Les PR draft / CI rouge sont **affichées** (normales en
> review). Commande : `list_ai_pipeline_review_tasks` (ClickUp `statuses[]` +
> filtre `review_inclusion` + join dashboard `/prs`). Un ticket sans PR à branche
> `CU-` (ex. self-improve `fixes`/`fix-logs`) n'est pas listé (rien à lier).
> Vérifié sur données prod le 2026-06-23. Le reste du doc ci-dessous décrit le
> design initial (listing PR-driven), conservé pour l'historique.

> Feature **perso** (fork `fsioni/jean`). Ne remonte PAS chez coollabsio.
> Worktree `feature-lifecycle`. Fork **public** → aucune URL/donnée interne en dur.

## Problème

Mon workflow est **full-IA** : je ne crée jamais ticket/branche à la main. Une
pipeline IA externe (`ai-full-flow`) pousse des PR sur GitHub et les suit dans
un dashboard interne (`ai-agents.planexpo`). Je veux, depuis Jean :

1. **Reprendre** une PR de la pipeline : la lister, créer un worktree dessus,
   m'auto-assigner sur la tâche ClickUp **et** la PR GitHub.
2. **Terminer** : en une action, passer la tâche ClickUp en `TO DEPLOY` **et**
   merger la PR.

Frontière UI : une autre session bosse sur les rows de worktree
(`SessionListRow`/`ProjectTreeItem`/`ProjectCanvasView`). **Je n'y touche pas.**
Ma surface = une **modal dédiée** + des edits minimes dans `ChatWindow`.

---

## Analyse de l'API du dashboard (réelle, sondée le 2026-06-22)

`https://ai-agents.planexpo/` = FastAPI/uvicorn derrière Caddy, **cert interne
(self-signed)**, **pas d'auth** (réseau interne). Endpoints découverts :
`/prs`, `/tickets`, `/status`, `/queue`, `/digest`, `/metrics/*`, `/actions/*`,
`/attention*`, `/live/active`.

### `GET /prs` — l'endpoint qu'il me faut

```json
{
  "generated_at": "2026-06-22T14:35:01Z",
  "repos": {
    "planexpo": {
      "slug": "Spottt/planexpo",
      "policy": { "merge": false, "squash": true, "rebase": true },
      "rebase_only": false,
      "prs": [
        {
          "number": 3976,
          "title": "feat(86cac8hvh): Emailing 2ème passe …",
          "branch": "CU-86cac8hvh-emailing-2eme-passe",
          "url": "https://github.com/Spottt/planexpo/pull/3976",
          "ci": "SUCCESS",            // SUCCESS | FAILURE | PENDING
          "isDraft": true,
          "mergeable": "MERGEABLE",   // MERGEABLE | CONFLICTING | UNKNOWN
          "created_at": "2026-06-22T11:25:25Z",
          "labels": ["ai-full-flow"]
        }
      ]
    },
    "myb":    { "slug": "Spottt/myb",                "prs": [ … ] },
    "agenda": { "slug": "Spottt/mybrocante-agenda",  "prs": [] },
    "self":   { "slug": "Spottt/ai-full-flow",       "prs": [] }
  }
}
```

Faits exploités :

- **Les PR de la pipeline portent le label `ai-full-flow`** (autres labels vus :
  `ai-review`, `approve`, `comment`, `workflow-fail`).
- **`branch` suit la convention `CU-<taskId>-…`** → lie déjà chaque PR à sa
  tâche ClickUp via la fonction existante
  `parse_clickup_task_id_from_branch()` (`clickup_link.rs`).
- `slug` = `owner/repo` GitHub → permet de matcher la PR au **projet Jean** par
  son remote.
- `mergeable` / `ci` / `isDraft` → pré-checks avant reprise/merge.

> **Pas de réinvention d'endpoint** : on consomme `/prs` tel quel.
> `/tickets` (vue ticket-centrée avec `pr_number`, `pr_merged`, `preview_url`,
> `last_decision`) reste dispo pour plus tard ; **hors scope** ici.

### Conséquences techniques

- **Cert interne** → le client reqwest doit accepter le cert
  (`danger_accept_invalid_certs(true)`), acceptable car gated derrière une URL
  **configurée par l'utilisateur** pour de l'infra interne.
- **URL configurable, jamais en dur** (fork public) → sidecar dédié, default
  `None`. Même politique que la preview URL Jenkins (déjà configurable).

---

## Réutilisé vs Ajouté

### Réutilisé tel quel (zéro modif)

| Brique                                                                                 | Emplacement                               |
| -------------------------------------------------------------------------------------- | ----------------------------------------- |
| `assign_clickup_task_to_me(task_id, project_id)`                                       | `projects/clickup_tasks.rs`               |
| `update_clickup_task_status(task_id, status, project_id)`                              | `projects/clickup_tasks.rs`               |
| `resolve_clickup_task_for_worktree(worktree_id)` + `parse_clickup_task_id_from_branch` | `projects/clickup_link.rs`                |
| `get_clickup_task` / `get_clickup_me` (vérif assignation)                              | `projects/clickup_tasks.rs`               |
| `checkout_pr(project_id, pr_number)` → crée worktree depuis PR                         | `projects/commands.rs`                    |
| `merge_github_pr(worktree_path)` (`gh pr merge --merge`)                               | `projects/commands.rs`                    |
| `get_github_pr(project_path, pr_number)` (détail PR, dont `author`/`assignees`)        | `projects/github_issues.rs`               |
| `resolve_gh_binary` + `silent_command` (invocation `gh`)                               | `gh_cli/config.rs`, `platform/process.rs` |
| Pattern sidecar `load_sidecar`/`save_sidecar`                                          | `projects/clickup_config.rs`              |
| Patterns UI : Dialog shadcn, `useQuery`/`useMutation`, `toast.*`, `openUrl`            | `services/*`, `components/*`              |

### Ajouté

**Backend (Rust)** — nouveau module `src-tauri/src/ai_pipeline/` :

- `config.rs` — sidecar `<app_data>/ai_pipeline/config.json` :

  ```rust
  struct AiPipelineConfig {
    dashboard_url: Option<String>,   // ex "https://ai-agents.planexpo"
    pipeline_label: Option<String>,  // default "ai-full-flow"
  }
  ```

  - commandes `get_ai_pipeline_config` / `set_ai_pipeline_config`.

- `client.rs` — `reqwest` (accept invalid certs), `GET {dashboard_url}/prs`.
- `commands.rs` :
  - `list_ai_pipeline_prs(project_id) -> Vec<AiPipelinePr>` : appelle `/prs`,
    aplatit `repos`, **filtre au repo du projet** (match `slug` ↔ remote du
    projet) et au label pipeline ; renvoie `{number,title,branch,url,ci,isDraft,
mergeable,labels,clickupTaskId,repoSlug}`.
  - `assign_pr_to_me(worktree_path) -> ()` : **NOUVEAU** —
    `gh pr edit --add-assignee @me` via `silent_command`, après avoir vérifié
    via `gh pr view --json assignees,author` que la PR n'est **pas déjà
    assignée à quelqu'un d'autre que moi** (sinon erreur explicite).
  - `resume_ai_pipeline_pr(project_id, pr_number) -> ResumeResult` :
    orchestre **(a)** `checkout_pr` → worktree, **(b)** résout `clickupTaskId`
    depuis la branche, vérifie l'assignation ClickUp (aucun autre assignee) puis
    `assign_clickup_task_to_me`, **(c)** `assign_pr_to_me`. Tolérant : si une
    sous-étape échoue (ex. tâche déjà prise), renvoie un statut partiel par
    sous-étape (worktree créé quand même).
  - `finish_ai_pipeline_pr(worktree_path, project_id, task_id) -> FinishResult` :
    **une action** = `update_clickup_task_status(..,"to deploy",..)`
    **puis** `merge_github_pr(worktree_path)`. Statut par sous-étape.
- Enregistrement : **`lib.rs` `generate_handler![]` ET `dispatch.rs`** pour
  chaque commande (config + 4 commandes), avec `emit_cache_invalidation` sur les
  mutations.

**Frontend (TS/React)** :

- `src/types/ai-pipeline.ts` — types miroir camelCase.
- `src/services/ai-pipeline.ts` — `useAiPipelineConfig`, `useAiPipelinePrs(projectId)`,
  `useResumeAiPipelinePr()`, `useFinishAiPipelinePr()` (mutations + invalidation
  worktrees/clickup/jenkins).
- `src/components/ai-pipeline/AiPipelinePrModal.tsx` — **modal dédiée** (Dialog
  shadcn) : liste les PR (badges ci/draft/mergeable + tâche CU), bouton
  **« Reprendre »** par PR (toast loading→success, ouvre le worktree à la fin).
- `src/components/ai-pipeline/AiPipelineSettings.tsx` — champ URL + label dans
  Settings → Integrations (réutilise le pattern `ClickUpSettings`).
- Hook d'ouverture : un flag dans `ui-store` (`aiPipelineModalOpen`) +
  **un bouton minimal** (point d'entrée dans le toolbar projet / là où sont déjà
  les actions PR — **sans toucher** les rows de worktree).
- Action **« Terminer (TO DEPLOY + merge) »** : exposée dans la modal et/ou un
  bouton minimal dans `ChatWindow` à côté des actions PR existantes.

---

## Phase 1 — Reprendre une PR (#4)

1. Config sidecar `ai_pipeline` + Settings (URL dashboard, label).
2. `client.rs` + `list_ai_pipeline_prs` (filtre repo+label, mappe `clickupTaskId`).
3. `assign_pr_to_me` (`gh pr edit --add-assignee @me` + garde anti-écrasement).
4. `resume_ai_pipeline_pr` (checkout_pr + self-assign ClickUp + self-assign PR).
5. Modal `AiPipelinePrModal` + service + bouton d'ouverture minimal.
6. Enregistrement lib.rs + dispatch.rs. Tests Rust (mapping `/prs`, filtre repo,
   parse `clickupTaskId`, garde assignation). Tests TS service/modal.

## Phase 2 — Terminer (#6)

1. `finish_ai_pipeline_pr` (status `to deploy` + `merge_github_pr`), statut par
   sous-étape.
2. Service `useFinishAiPipelinePr` + bouton « Terminer » (modal + ChatWindow
   minimal) + toast.
3. Enregistrement lib.rs + dispatch.rs. Tests.

---

## Décisions / points ouverts

- **Matching repo↔projet** : on filtre `/prs` au repo dont le `slug` == remote
  GitHub du projet courant. La modal s'ouvre dans le contexte d'un projet.
- **Cert interne** : `danger_accept_invalid_certs(true)` sur le client AI
  pipeline (infra interne, URL user-configurée). Acceptable et isolé.
- **Statut ClickUp exact** : la valeur API est `"to deploy"` (cf. table
  `PLANEXPO_STATUSES`).
- **Sécurité fork public** : URL/label en sidecar, **rien en dur**. Doc sans
  hostname réel committé (placeholder dans Settings).
- **Garde assignation** : reprise refusée (ou avertie) si PR/tâche déjà assignée
  à un autre que moi — vérif avant écriture sur les deux côtés.
