# pipeline-doctor

> One command that tells you if your pipeline is safe before it costs you the repo.

`pipeline-doctor` audits a repository's CI pipeline in a single run:
GitHub Actions workflow security, hardcoded secrets, dependency
vulnerabilities (via the free OSV API), and pipeline hygiene — with a
plain-language report and a CI exit code. Since v0.2.0 it also verifies
what is actually running after the deploy: the image in the cluster
against git, ArgoCD sync and health, the rollout, the app's HTTP/TLS,
Postgres, and an end-to-end probe that creates, reads and deletes one
ephemeral record.

**Status: v0.2.0.** Six check families: the four v1 families (workflow
security, secrets, hygiene, dependency vulnerabilities via OSV) plus
`ci` (what the pipeline builds) and `deploy` (what is actually running
in the cluster). Tested (200/200) and dogfooded against real repos
(see [Dogfooding](#dogfooding)).

## Install

```bash
npx pipeline-doctor
```

No install needed — `npx` runs it in place. Requires Node.js 20+.

## Usage

```bash
# Audit the repo in the current directory
npx pipeline-doctor

# Audit another repo
npx pipeline-doctor /path/to/repo

# Only one check family
npx pipeline-doctor --only workflow

# Only the post-deploy checks (needs credentials, see below)
npx pipeline-doctor --only deploy

# Deploy checks without cluster access: DEP-01, DEP-04, DEP-09 and
# DEP-10 are reported as skipped, not failed
npx pipeline-doctor --only deploy --repo-only

# Machine-readable output (for CI artifacts)
npx pipeline-doctor --json > pipeline-doctor-report.json
npx pipeline-doctor --junit > pipeline-doctor-report.xml

# Write an example pipeline-doctor.yml (never overwrites an existing one)
npx pipeline-doctor init
```

## Example report

Real output from dogfooding — `npx pipeline-doctor` run on
`yclicourt/buildora-path2-backend` on 2026-11-13 (exit 1):

```
pipeline-doctor — buildora-path2-backend
workflows: 1 · files scanned: 23 · deps checked: 0 · 0.0s

  ✗ workflow/unpinned-action      .github/workflows/ci.yml:30
      actions/checkout@v4 pins a tag or branch (@v4), not a commit SHA — pin actions/checkout by SHA: replace @v4 with the full commit SHA of that ref
  ✗ workflow/unpinned-action      .github/workflows/ci.yml:32
      actions/setup-python@v5 pins a tag or branch (@v5), not a commit SHA — pin actions/setup-python by SHA: replace @v5 with the full commit SHA of that ref
  ⚠ workflow/persist-credentials  .github/workflows/ci.yml:30
      actions/checkout persists the GitHub token by default in this job, but no step pushes or publishes anything — add with: { persist-credentials: false } to the checkout step
  ⚠ hygiene/no-timeout            .github/workflows/ci.yml:9
      job "testing" has no timeout-minutes — a hung job runs for up to 6 hours — add timeout-minutes: 10 to job "testing"
  ⚠ hygiene/no-concurrency        .github/workflows/ci.yml:4
      no concurrency with cancel-in-progress on a PR workflow — stale runs keep burning minutes — add a top-level concurrency block with cancel-in-progress: true, e.g. concurrency: { group: ${{ github.workflow }}-${{ github.ref }}, cancel-in-progress: true }
  ⚠ deps/no-lockfile              .:1
      no lockfile found (package-lock.json, pnpm-lock.yaml or yarn.lock) — dependencies are not pinned, so no version can be checked against OSV — commit a lockfile (npm install / pnpm install / yarn install) so pinned versions exist to check

  2 errors · 4 warnings · ignored: 0
```

Secrets are never printed in full — findings show the file, the line
and the masked secret only (`ghp_...aaaa`).

Exit codes: `0` no error findings, `1` at least one error finding
(or warning with `failOn: warning`), `2` usage error, invalid config,
unreadable directory, or a backend that cannot be reached (network
error, 429, 5xx — the run fails loudly instead of reporting
"all clear").

## Deploy checks (v0.2.0)

The `deploy` family verifies the live cluster against git. It needs
credentials, and they come from **environment variables only** — never
from `pipeline-doctor.yml`, never printed in any report:

| Variable | Used by |
|---|---|
| `DATABASE_URL` | DEP-06, DEP-08, DEP-11 (one shared Postgres connection) |
| `PIPELINE_DOCTOR_HARBOR_URL`, `PIPELINE_DOCTOR_HARBOR_USER`, `PIPELINE_DOCTOR_HARBOR_TOKEN` | DEP-01 (digest), DEP-02 (size) |
| `PIPELINE_DOCTOR_ARGOCD_URL`, `PIPELINE_DOCTOR_ARGOCD_TOKEN` | DEP-03, DEP-07 |
| `PIPELINE_DOCTOR_K8S_API_URL`, `PIPELINE_DOCTOR_K8S_TOKEN` | DEP-01, DEP-04, DEP-09, DEP-10 |
| `PIPELINE_DOCTOR_APP_URL` | DEP-05, DEP-12 |
| `PIPELINE_DOCTOR_APP_USER`, `PIPELINE_DOCTOR_APP_PASSWORD` | DEP-12 login (only when a login step is configured) |
| `GITHUB_TOKEN` | CI-07 (last GitHub run green) |

A check whose backend is not configured is reported as **skipped**,
with the missing variable named — never as a pass and never as a
failure. A backend that answers 4xx is also skipped (the token cannot
see that resource). A network error, 429 or 5xx aborts the run with
exit 2.

`--repo-only` (or `deploy.repoOnly: true` in config) runs without
cluster access: DEP-01, DEP-04, DEP-09 and DEP-10 are reported as
skipped, and the repo-side checks (image sizes, migrations, DB disk,
probe) still run against their own backends.

The end-to-end probe (DEP-12) defaults to a plain CRUD API with no
login: `POST /tasks/`, `GET /tasks/{id}/`, `DELETE /tasks/{id}/`.
It creates one task, reads it back, and deletes it in a `finally` —
whatever happened before, the probe record does not stay behind.
Configure it in `pipeline-doctor.yml` (see [Configuration](#configuration));
the login step is optional and its credentials come from
`PIPELINE_DOCTOR_APP_USER` / `PIPELINE_DOCTOR_APP_PASSWORD`.

## Configuration

Optional `pipeline-doctor.yml` in the repo root:

```yaml
failOn: error            # error | warning
ignore:
  - rule: workflow/unpinned-action
    path: .github/workflows/release.yml
    reason: "internal action, pinned by its own tag"
checks:
  workflow: true
  secrets: true
  deps: true
  hygiene: true
  ci: true
  deploy: true
deploy:
  repoOnly: false
  budgets:                 # max image size in MB (DEP-02)
    frontendMb: 75
    backendMb: 250
    genericMb: 300
  probe:                   # end-to-end probe (DEP-12)
    # login:               # optional; uncomment for an API with auth
    #   path: /api/auth/login/
    #   usernameField: username
    #   passwordField: password
    #   tokenField: token
    #   tokenScheme: Bearer
    create:
      path: /tasks/
      body: { title: "pipeline-doctor probe", description: "Ephemeral probe task — safe to delete", done: false }
      idField: id
    read:
      path: /tasks/{id}/
    delete:
      path: /tasks/{id}/
```

Every `ignore` entry must carry a `reason` — a silence without
justification is a hole nobody reviews.

## Checks (v1 + v0.2.0)

| Family | What it catches |
|---|---|
| `workflow` | Unpinned actions, `pull_request_target` with checkout, template injection, excessive permissions, persisted credentials, untrusted input in `run:` |
| `secrets` | GitHub tokens, AWS keys, private keys, passwords in connection URLs, generic high-entropy tokens — masked in the report, never printed in full |
| `deps` | Vulnerable dependencies from the lockfile, via the free OSV API (no key). Critical/high severity fails the CI; medium/low warns. No lockfile → one warning, never an error. If OSV cannot be reached the run fails loudly (exit 2) instead of reporting "all clear" |
| `hygiene` | Missing timeouts, missing concurrency with `cancel-in-progress` on PR workflows, unprotected deploys, `setup-node` without cache |
| `ci` | What the pipeline builds: image tags pinned to a commit SHA, digests matching Harbor, no `latest` anywhere, a clean git tree, OWASP Docker (non-root `USER` in the last stage) and security headers, last GitHub run green |
| `deploy` | What is actually running in the cluster — the 12 checks below |

### Deploy checks

| Rule | What it verifies |
|---|---|
| `deploy/digest-in-k3s` (DEP-01) | The image running in the cluster is the one git pins (tag, or digest resolved via Harbor) |
| `deploy/image-size` (DEP-02) | Built images fit the size budgets (75 MB frontend / 250 MB backend / 300 MB generic) |
| `deploy/argocd-synced-healthy` (DEP-03) | ArgoCD Application is Synced and Healthy (Degraded errors, Progressing/Unknown warns) |
| `deploy/rollout-complete` (DEP-04) | Rollout finished: updated/available replicas and observed generation, no missed progress deadline |
| `deploy/http-tls` (DEP-05) | The app answers HTTP 200; TLS certificate valid (error under 7 days, warning under 30) |
| `deploy/db-select-1` (DEP-06) | Postgres answers `SELECT 1` — owns the connection failure for DEP-08 and DEP-11 |
| `deploy/no-drift` (DEP-07) | No drifted resources in ArgoCD |
| `deploy/pending-migrations` (DEP-08) | Every Django migration in git is applied (a missing `django_migrations` table means "never migrated") |
| `deploy/service-endpoints` (DEP-09) | Every Service has endpoints behind it |
| `deploy/pods-restarting` (DEP-10) | No CrashLoopBackOff, no container with 5+ restarts (1–4 warns), no recent BackOff/OOMKilled events |
| `deploy/db-disk` (DEP-11) | Database size vs the PVC that holds it (warning at 80%, error at 90%) |
| `deploy/end-to-end-probe` (DEP-12) | Create → read → delete one record through the real API; the record is deleted even if the read fails |

## Dogfooding

Audited 2026-11-13 against the author's own repos (shallow clones)
plus this repo itself:

| Repo | Exit | Errors | Warnings | Headline |
|---|---|---|---|---|
| `buildora-frontend` | 1\* | 3 | 3 | 3 unpinned actions; no secrets |
| `buildora-backend` | 1\* | 5 | 3 | 3 unpinned actions; 2 connection-string passwords (local dev defaults, see below) |
| `buildora-path2-backend` | 1 | 2 | 4 | 2 unpinned actions; no npm lockfile (Python repo) |
| `buildora-path3-backend-fastapi` | 1 | 2 | 4 | 2 unpinned actions; no npm lockfile (Python repo) |
| `ecommerce-backend` | 1\* | 2 | 0 | No CI workflows at all; 2 connection-string passwords (placeholders, see below) |
| `pipeline-doctor` (self) | 1 | 9 | 5 | Own test fixtures flagged (expected); 2 critical vulns in dev-only `tinypool@1.1.1` |

\* Full runs on the three Node repos exited 2 on the `deps` family:
the OSV API is reachable from this sandbox (a 2-dependency repo
checks fine, and this repo's own 105 deps checked in 1.6s), but
large lockfiles (438–925 packages) hit flaky proxy failures mid-run
and the tool fails loudly (exit 2) instead of reporting "all clear".
Per-family runs without `deps` completed and are the source of the
counts above. The deps family itself was verified live against the
real OSV API on small lockfiles during days 5–6.

Notes from the audit (verified by hand, file:line checked):

- Every `workflow/*` and `hygiene/*` finding checked was real:
  unpinned `actions/checkout@v4`, `pnpm/action-setup@v4`,
  `actions/setup-node@v4`, `setup-python@v5`; missing
  `timeout-minutes` and `concurrency` on PR workflows.
- **Likely false positives — placeholder passwords in connection
  strings.** `ecommerce-backend` `.env.example:7`
  (`postgresql://username:password@host:port`) and `README.md:46`
  (`postgresql://user:password@localhost:5432`) flag the literal
  word `password` as a credential. Same class in
  `buildora-backend` (`.env.example:6`, `.github/workflows/ci.yml:12`):
  the password is the local docker-compose dev default, not a
  production secret. The rule fires by design (a password in a URL
  is a password in a URL), but `.env.example` files and docs
  examples deserve a placeholder allowlist in v1.1.
- **Own test fixtures get flagged.** The self-run reports the fake
  secrets in `tests/secrets.test.ts` (e.g. the well-known AWS
  example key `AKIAIOSFODNN7EXAMPLE`, masked as `AKIA...MPLE`).
  Correct behavior — the tool cannot know they are fixtures — and
  the existing `ignore` config (with a required reason) is the way
  to silence them.

### v0.2.0 (2026-11-15)

Dogfooded against `tasks-app-platform-devops` (k3s + ArgoCD, the
reference case for the deploy family) and this repo itself:

- `--only deploy` on tasks-app with no credentials: all 12 deploy
  checks reported as skipped with the missing variable named, exit 0
  — nothing silently passes. With `--repo-only`, the four
  cluster-dependent checks (DEP-01, DEP-04, DEP-09, DEP-10) report
  "repo-only mode: no cluster access".
- Full run on tasks-app: 20 errors · 22 warnings (same as the Fase 1
  run — the deploy checks all skip without credentials, so they add
  no noise to a repo that has none configured).
- Self-run on this repo: 0 errors · 0 warnings, exit 0.
- Manifest discovery verified against the real repo: 3 Deployments
  (backend, frontend, minio), 9 ArgoCD Applications, the Postgres PVC
  at 2 Gi, one Django migration — including Helm `{{.Values.x}}`
  references resolved against `values.yaml`.
- **Real finding in the reference repo.** The frontend Service
  template references `.Values.frontend_tasks_app.*`, which does not
  exist in `values.yaml` — the Service name is unresolvable, so
  DEP-09 skips it instead of guessing. A latent chart bug the tool
  surfaced rather than silently working around.

Tests: 200/200 (163 from Fase 1, 37 new for the deploy family),
`tsc` clean.

## License

MIT — Copyright (c) 2026 Yoan Carlos Licourt Acosta.
