# Repository Agent Entry Point

Before doing any work in this repository, read and follow
[`/.ai/AGENTS.md`](.ai/AGENTS.md). It is the canonical global engineering
contract for humans, primary agents, and delegated agents.

When assigned a named role, also read that role's file under
[`/.ai/agents/`](.ai/agents/) and the shared contracts and acceptance criteria
under [`/.ai/specs/`](.ai/specs/). Role files specialize the global rules; they
do not override product principles, architecture contracts, or evidence gates.

The repository owner's final audit request explicitly opened the execution
phase for Tasks 2, 4, and 6. Work in that audit must still follow the scoped
specialist -> integration -> critic evidence loop in `/.ai/AGENTS.md` and the
release gate in `/.ai/specs/acceptance-criteria.md`.

That opening is not standing authorization for unrelated or future changes.
After the audit, a new implementation phase still requires a current user
request and an Orchestrator-assigned scope; inspection and Markdown contract
maintenance remain safe defaults when execution has not been opened.
