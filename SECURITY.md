# Security policy

Volc Agent Launchpad is a hackathon proof of concept. Only the latest revision
on the default branch is supported.

## Report a vulnerability

Send the repository owner or event organizer the affected revision,
reproduction steps, impact, and suggested mitigation. Do not publish
credentials, personal data, or exploit details in an issue.

## Known limitations

- Shared demo token maps to one server-configured human identity and role; there
  are no per-user sessions, identity-provider integration, or tenant isolation
- No CSRF protection
- No per-Agent container boundary in ECS mode
- Ordinary local containers, not hardened multi-tenant sandboxes
- Broad outbound network access
- Prompt-triggered command and file execution
- Unconfirmed prompt-derived observations can affect the same Agent's risk
  before review; they are text claims, not trusted runtime telemetry
- Managed protected actions use an exact SQLite resource adapter and are
  intercepted before the side effect. Ordinary tools launched inside an
  allowed Codex subprocess are still not intercepted individually by that
  adapter.
- No API rate limiting or operator lockout
- npm dependency audits are clean as of 2026-08-31; an approved local scan of
  the container OS and bundled Codex binary is still required before a
  production-security claim
- Ark key available to the server and active Runtime container
- Ark key stored in Terraform POC state

## Recently verified controls

- API authentication uses the matched route and a canonical pathname fallback;
  encoded unauthenticated GET and POST probes return `401`.
- Integrated protected actions resolve the stored human, Agent, and optional
  delegated Agent identity; enforce role plus exact graph capability; calculate
  downstream impact; compare trusted Run history; persist an explainable
  circuit-breaker decision; and only then permit the managed adapter claim.
- The authoritative principal role is checked again inside the same immediate
  SQLite transaction that creates the one-time execution claim, preventing a
  concurrent role downgrade from being raced by an already approved action.
- The managed SQLite adapter performs a second, effect-time check in the same
  transaction as the read/write: exact claim and payload, current principal,
  exact graph capability and ownership, the complete live delegation chain,
  correlated executable risk, managed-resource ownership, and breaker version.
  A durable receipt makes the exact effect idempotent.
- Only a durably recorded administrator may change capability/ownership graph
  facts or accept/reject learned safety facts through the integrated API.
- Agent creation, editing, start/stop, and conversational work require a
  durable operator or administrator role; deletion is administrator-only.
  Approval/rejection and safety-stop reset also re-read their allowed durable
  roles, so a process-local role cannot outlive a downgrade.
- A blocked managed action is covered by a real durable-state test: RBAC allows
  the write, behavior and graph impact block it, and the target resource remains
  unchanged. Delegated scope is intersected with both parent and child authority
  and revalidated for status, expiry, linkage, and depth on every request.
- Learned relationship traversal filters by the owning Agent and source node;
  one Agent's prompt observation cannot enter another Agent's Blast Radius.
- Regression coverage for these controls is part of the canonical server suite.
- The direct static-file dependency and its vulnerable server transitives are
  patched; Vite build tooling no longer ships in the production tree. See the
  [dependency security report](docs/DEPENDENCY_SECURITY_REPORT.md).

These controls do not turn the POC into a multi-tenant security boundary.
Remaining work is prioritized in the
[current weaknesses backlog](docs/CURRENT_WEAKNESSES.md); the full audit and
session report are retained as historical before-state evidence.

## Safe use

- Use a dedicated development machine or disposable ECS instance.
- Use a scoped, revocable Ark key and a unique `APP_AUTH_TOKEN`.
- Keep local use on loopback and restrict ECS Web and SSH CIDRs.
- Add HTTPS before sending the shared token over an untrusted network.
- Never mount production data or provide Volcengine account AK/SK to Agents.
- Stop the POC, destroy test resources, and revoke keys after the event.

Codex uses `workspace-write` when Landlock is available. On unsupported kernels,
startup warns and relies on the outer Docker or rootless Podman boundary. This
fallback is not tenant isolation.
