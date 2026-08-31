# Security policy

Volc Agent Launchpad is a hackathon proof of concept. Only the latest revision
on the default branch is supported.

## Report a vulnerability

Send the repository owner or event organizer the affected revision,
reproduction steps, impact, and suggested mitigation. Do not publish
credentials, personal data, or exploit details in an issue.

## Known limitations

- Shared demo token; no user identity, authorization, RBAC, or tenant isolation
- No CSRF protection
- No per-Agent container boundary in ECS mode
- Ordinary local containers, not hardened multi-tenant sandboxes
- Broad outbound network access
- Prompt-triggered command and file execution
- Unconfirmed prompt-derived observations can affect the same Agent's risk
  before review; they are text claims, not trusted runtime telemetry
- No per-tool interception after an allowed Codex Run starts
- No API rate limiting or operator lockout
- Production dependency audit currently reports unresolved high-severity items;
  see the full audit before exposing the service
- Ark key available to the server and active Runtime container
- Ark key stored in Terraform POC state

## Recently verified controls

- API authentication uses the matched route and a canonical pathname fallback;
  encoded unauthenticated GET and POST probes return `401`.
- Learned relationship traversal filters by the owning Agent and source node;
  one Agent's prompt observation cannot enter another Agent's Blast Radius.
- Regression coverage for both controls is part of the 82-test server suite.

These controls fix two concrete audit findings but do not turn the POC into a
multi-tenant security boundary. Remaining work is prioritized in the
[full audit](docs/FULL_HACKATHON_CODEBASE_AUDIT.md) and
[session report](docs/SESSION_IMPLEMENTATION_REPORT.md).

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
