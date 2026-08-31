# Dependency security remediation report

Audit date: 2026-08-31

This report records the Task 2 dependency baseline, remediation, and residual
validation gaps. It supplements the historical findings in
`FULL_HACKATHON_CODEBASE_AUDIT.md`; it does not rewrite that before-state
evidence.

## Toolchain and audited surfaces

- Host audit toolchain: Node.js `v25.1.0`, npm `11.6.2`, Darwin arm64. The
  repository continues to require Node.js 22 or newer.
- Production image toolchain: Node.js `v22.23.2`, npm `10.9.8`, Codex CLI
  `0.111.0`.
- npm workspaces: the root manifest and lockfile, `apps/server/package.json`,
  and `apps/web/package.json`.
- Deployment dependencies: `Dockerfile`, `Dockerfile.runtime`,
  `docker-compose.yml`, and the Volcengine provider lock at
  `deploy/volcengine/.terraform.lock.hcl`.
- Pinned-tool review: the Docker build resolved `node:22-bookworm-slim` to the
  multi-platform digest recorded below; npm reports Codex CLI `0.151.0` as the
  current release while the image deliberately retains tested version
  `0.111.0`; the Terraform Registry currently lists Volcengine provider
  `0.0.68` while this repository retains its tested `0.0.58` lock.
- There are no alternate JavaScript lockfiles or Python, Go, or Rust
  application manifests in the repository.

## Before and after

Both the full and `--omit=dev` npm audits initially reported five high and one
moderate vulnerable packages. An isolated production install contained all six
because Vite and its React plugin were incorrectly declared as web runtime
dependencies.

| Dependency and path | Direct? | Severity / advisory | Before | Remediated state | Practical exposure before remediation |
| --- | --- | --- | --- | --- | --- |
| `@launchpad/server -> @fastify/static` | Direct | High: GHSA-83w8-p2f5-377r; moderate: GHSA-8pvw-jcv7-9cmj | `10.1.0` | Manifest floor `^10.1.2`; lock `10.1.3` | High. The production server registers the plugin at `/`; non-canonical path and route-guard handling is network reachable. Existing API authentication reduces some impact but is not a substitute for the patch. |
| `@fastify/static -> glob -> minimatch -> brace-expansion` | Transitive | High: GHSA-mh99-v99m-4gvg and GHSA-rgw5-rvv9-x895 | `5.0.7` | `5.0.9` | Low-to-moderate. The glob pattern is application-controlled during static setup, so an unauthenticated caller does not directly choose the expansion; it still shipped in production and was safely patchable. |
| `fastify -> @fastify/ajv-compiler/ajv -> fast-uri` and `fastify -> fast-json-stringify -> fast-uri` | Transitive | High: GHSA-v2hh-gcrm-f6hx and GHSA-7p8r-x3mc-p8w7 | `3.1.3`, `4.1.1` | `3.1.6`, `4.1.3` | Moderate. URI parsing participates in server schema validation/serialization. The application does not use it as a standalone URL authorization boundary, but crafted request data can reach Fastify validation paths. |
| `fastify -> find-my-way` | Transitive | High: GHSA-c96f-x56v-gq3h | `9.6.0` | `9.9.0` | Low under the current configuration because the server is not created with HTTP/2, the advisory prerequisite. It nevertheless shipped and was safely patchable. |
| `@launchpad/web -> vite -> postcss -> nanoid` | Transitive build tool | High: GHSA-2v37-7h3g-55p8 | `3.3.16`, classified production | `3.3.18`, classified development | Low. The vulnerable custom zero-size generator is not called by application code. Moving Vite to `devDependencies` also removes it from the runtime image. |
| `@launchpad/web -> vite -> postcss` | Transitive build tool | Moderate: GHSA-fxqj-rqcc-2cmp | `8.5.19`, classified production | `8.5.26`, classified development | Low. PostCSS processes repository-controlled CSS during the image build rather than untrusted runtime input. It no longer ships in the runtime image. |

The isolated production install decreased from 144 installed packages with six
advisories to 79 installed packages with zero advisories. The npm audit
production dependency count decreased from 139 to 81 after build tools were
classified correctly.

## Remediation rationale

- Raised only the direct `@fastify/static` security floor, within the existing
  major version.
- Updated affected transitive packages within their parents' declared
  compatible ranges. No npm override and no forced or breaking audit fix was
  used.
- Moved Vite and `@vitejs/plugin-react` to `devDependencies`; both are required
  to build the browser bundle but not to serve the built assets.
- Regenerated the root npm lockfile through npm. Resolved hashes were not
  edited manually.
- Retained Node.js 22, `better-sqlite3@13.0.3`, the two Docker targets, and
  `@openai/codex@0.111.0`. The Codex package is exactly pinned and has only
  platform-binary optional dependencies. The official Codex advisory
  GHSA-w5fx-fh39-j5rw affects `0.2.0` through `0.38.0` and was fixed in
  `0.39.0`, so `0.111.0` is outside that vulnerable range. No published
  advisory justified an untested jump to current CLI `0.151.0`.
- Retained Volcengine provider `0.0.58`, which is exactly constrained and
  checksummed. The official registry contains newer `0.0.59` through `0.0.68`
  releases, but the provider publishes no useful per-release security
  changelog and no applicable advisory was established. Changing it without
  Terraform compatibility evidence would be unsafe.

## Verification

Successful checks:

- `npm ci`
- `npm audit --json` — zero findings
- `npm audit --omit=dev --json` — zero findings
- isolated clean `npm ci`, followed by `npm prune --omit=dev` — 79 packages,
  zero findings; Vite, its React plugin, PostCSS, and nanoid are absent
- `npm explain` / `npm ls` — all affected paths resolve to the versions above
- focused `apps/server/src/app.test.ts` authentication and encoded-path suite —
  3/3 tests passed
- focused authentication, graph isolation, policy/gateway, SQLite, and runner
  regression set — 9/9 files and 59/59 tests passed
- `docker compose config --quiet`
- production Docker build — successful; the production prune reported 82
  audited package records and zero findings
- production container health probe — `healthy`; `/api/health` returned 200
- runtime versions — Node.js `v22.23.2`, npm `10.9.8`, Codex CLI `0.111.0`
- canonical `npm run check` on the current integrated tree — 24/24 test files
  and 162/162 server tests passed, both workspace typechecks passed, and both
  production builds passed

## Residual validation gaps and follow-up

There are no remaining npm audit advisories at the time recorded above. The
following are validation or supply-chain gaps, not suppressed npm findings:

- The Docker base default is `node:22-bookworm-slim`, a moving tag. The build
  resolved it to Node.js `22.23.2` and multi-platform digest
  `sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5`.
  Release engineering should adopt an intentional digest-refresh process so a
  reproducible pin does not silently become permanently stale.
- Trivy, Grype, and Syft are not installed. Docker Scout is available, but its
  scan was not authorized because it may transmit the private image's derived
  SBOM or metadata to Docker. Release engineering should run an approved local
  container/OS scanner and triage Debian and bundled Codex binary findings
  before a production-security claim.
- Terraform is not installed in this environment, so provider initialization
  and provider-specific security scanning were not rerun. Version `0.0.58` is
  ten releases behind registry version `0.0.68`; the infrastructure owner
  should validate the exact lock on the deployment platform and review an
  upgrade in a separately tested infrastructure change rather than assuming
  newer means safer.
- npm audit does not analyze the compiled Codex platform binary. The runtime
  owner should monitor upstream Codex security releases and upgrade from
  `0.111.0` only with runner compatibility and sandbox regression evidence.
- The final runtime image intentionally omits the root lockfile and root/web
  manifests, so `npm ls` inside that final layer cannot reconstruct the
  workspace and reports packages as extraneous. The matching isolated
  build/prune tree and Docker build stage were audited successfully, but
  release engineering should use an approved image/SBOM scanner for final-layer
  inventory rather than treat in-container `npm ls` as evidence.

## Acceptance status

- **T2.1 VERIFIED:** both npm scopes, committed before-state paths, actual
  build/prune dependency classification, Docker/Codex pins, and the Terraform
  constraint/lock were inspected. Terraform execution itself remains the
  explicit tooling limitation above.
- **T2.2 VERIFIED:** every production high finding was remediated within
  compatible package ranges; clean install, manifest/lock consistency, path
  resolution, and zero-advisory after-state were reproduced without overrides
  or force upgrades.
- **T2.3 VERIFIED for the available environment:** the canonical check,
  focused security regressions, Compose configuration, production image build,
  native SQLite startup, health probe, and runtime tool versions all passed.
  Final-image OS/binary scanning and Terraform initialization remain assigned
  follow-ups, not suppressed findings.
