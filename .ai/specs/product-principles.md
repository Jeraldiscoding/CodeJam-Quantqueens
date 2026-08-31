# Product Principles

> Traditional permissions define what an Agent may do. Our middleware also
> understands what it normally does, what its actions can affect, what it
> actually did, and when unusual permitted behavior should be interrupted.

## Runtime enforcement

The product is middleware. It must make decisions in the execution path before
protected side effects occur. UI warnings, reports, and graph views explain
backend decisions; they do not substitute for them.

## Graph-informed decisions

Direct capability is the authority boundary. The graph adds operational
context: reachability, dependency paths, sensitivity, and blast radius. A
permitted action can therefore become risky without becoming unauthorized.
Forward and reverse queries must be backend capabilities that policy can call.

## Behavioral learning

Declared capability, observed behavior, and historical baseline are separate.
A baseline is derived from trusted, persisted Run events and is compared with a
future action using a small number of deterministic, explainable signals.
Blocked or dangerous attempts must not silently become normal.

## Observability

Every important Run, delegation, action, policy, resource, and breaker
transition produces a structured, durable event with deterministic Run-local
ordering. The evidence must support audit, explanation, baseline calculation,
graph analysis, and future replay work.

## Explainability

Every authorization and risk decision records stable reason codes plus the
human-readable facts that caused it: actor, action, resource, graph path,
behavioral difference, decision, and effect. Scores without factors and paths
are insufficient.

## Non-technical usability

The primary explanation should be understandable without reading raw JSON or
security jargon. A user should quickly see what was attempted, why it was
unusual or far-reaching, whether anything happened, and what would have been
affected.

## Secure delegation

Delegation creates attributable execution context, not new authority. The
originating user and Run, parent Agent, child Agent, requested scope, and
effective capability intersection must survive through policy, events, graph
queries, and explanations.

## Product test

If removing the UI leaves no meaningful graph-informed, history-informed
intervention in the runtime path, the feature does not satisfy this product.
