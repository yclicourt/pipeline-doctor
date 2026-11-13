# pipeline-doctor

> One command that tells you if your pipeline is safe before it costs you the repo.

`pipeline-doctor` audits a repository's CI pipeline in a single run:
GitHub Actions workflow security, hardcoded secrets, dependency
vulnerabilities (via the free OSV API), and pipeline hygiene — with a
plain-language report and a CI exit code.

**Status: v1 complete.** All four check families (workflow security,
secrets, hygiene, dependency vulnerabilities via OSV) are implemented,
tested (90/90), and dogfooded against real repos on 2026-11-13 (see
[Dogfooding](#dogfooding)). Post-deploy verification (`deploy/*`) is
phase 2.

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
or unreadable directory.

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
```

Every `ignore` entry must carry a `reason` — a silence without
justification is a hole nobody reviews.

## Checks (v1)

| Family | What it catches |
|---|---|
| `workflow` | Unpinned actions, `pull_request_target` with checkout, template injection, excessive permissions, persisted credentials, untrusted input in `run:` |
| `secrets` | GitHub tokens, AWS keys, private keys, passwords in connection URLs, generic high-entropy tokens — masked in the report, never printed in full |
| `deps` | Vulnerable dependencies from the lockfile, via the free OSV API (no key). Critical/high severity fails the CI; medium/low warns. No lockfile → one warning, never an error. If OSV cannot be reached the run fails loudly (exit 2) instead of reporting "all clear" |
| `hygiene` | Missing timeouts, missing concurrency with `cancel-in-progress` on PR workflows, unprotected deploys, `setup-node` without cache |

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

## License

MIT — Copyright (c) 2026 Yoan Carlos Licourt Acosta.
