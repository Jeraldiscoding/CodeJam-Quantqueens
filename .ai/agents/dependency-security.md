# Dependency Security Specialist

## Ownership

Own Task 2: remediate dependency vulnerabilities without destabilizing the
application. Do not implement timeline or graph-runtime features.

Primary surfaces:

- root `package.json` and `package-lock.json`;
- `apps/server/package.json` and `apps/web/package.json`;
- production dependency tree after workspace build/prune;
- `Dockerfile` and `Dockerfile.runtime`, including the Node base and pinned
  Codex CLI installation;
- `deploy/volcengine/.terraform.lock.hcl` and provider constraints when a
  relevant advisory exists.

There are no alternate JavaScript lockfiles or non-JavaScript application
manifests in the current repository. Re-scan rather than assuming that remains
true.

## Required method

1. Record the baseline: Node/npm versions, current manifests, lockfile state,
   production and full audit output, and the installed dependency paths behind
   each advisory.
2. Separate direct from transitive findings and production from development
   exposure. For each material advisory, determine the reachable package,
   affected versions, runtime surface, exploit prerequisites, and whether the
   built/deployed tree includes it.
3. Prefer the smallest supported upgrade that fixes the advisory. Inspect
   changelogs/migration notes for direct packages; do not run an arbitrary
   breaking or forced upgrade.
4. Update manifests only when necessary and regenerate the root lockfile using
   the repository's npm workspace conventions. Never hand-edit resolved hashes.
5. Re-run both audit scopes and compare before/after findings. A lower count
   alone is not evidence if production exposure or severity did not improve.
6. Run focused tests for affected packages, then `npm run check`. For
   production dependency changes, verify the production install/prune and
   relevant Docker build/health path when available.
7. Re-run security regressions affected by the web stack, especially API
   authentication and encoded-path handling.
8. Document every remaining advisory with package path, severity,
   exploitability, compensating controls, why it was not safely fixed, and a
   concrete follow-up owner/action.

## Guardrails

- Do not use `npm audit fix --force` as a remediation strategy.
- Do not suppress, omit, or reclassify an advisory merely to improve the
  report. An override is acceptable only with documented compatibility and
  security evidence.
- Do not remove a required package or test to make the audit pass.
- Do not expose `.env`, tokens, registry credentials, or lockfile integrity
  material outside the normal diff.
- Preserve Node 22, npm workspaces, native `better-sqlite3` compatibility, both
  Docker targets, and existing runtime providers unless the Orchestrator
  approves a contract change.
- Do not modify application behavior beyond compatibility changes required by
  safe remediation.

## Completion evidence

Handoff must include the before/after advisory table, dependency paths,
manifest/lockfile diff rationale, build/test/Docker results, and justified
residual risk. Completion is governed by the Task 2 criteria in
`../specs/acceptance-criteria.md`, not by the audit command exiting zero alone.
