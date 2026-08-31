import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  ApiError,
  setAuthToken,
  type PromptAnalysis,
  type PromptGraphSuggestion,
} from "./api";
import { KnowledgeGraphPanel } from "./KnowledgeGraphPanel";
import { OverallGraphPanel } from "./OverallGraphPanel";
import { RunTimeline } from "./RunTimeline";
import { SecurityDemoPanel } from "./SecurityDemoPanel";
import type { Agent, AgentRun, Message, RunTimelineItem, SystemInfo } from "./types";

const RELEASE_GUARDIAN_ID = "d7b3a871-81e1-4965-9a88-bef875c3bb19";

const starterPrompts = [
  "Create a small TypeScript CLI that prints a weather summary from sample JSON.",
  "Inspect this workspace and explain what you would improve first.",
  "Build a responsive single-page todo app with tests.",
];

const emptyForm = {
  name: "",
  description: "",
  instructions:
    "Help me build and test software in this workspace. Keep changes small and explain the result.",
};

function formatTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function StatusPill({ status }: { status: Agent["status"] }) {
  return (
    <span className={"status status-" + status}>
      <span className="status-dot" />
      {status}
    </span>
  );
}

function Spinner() {
  return <span className="spinner" aria-label="Loading" />;
}

function wasSafelyPrevented(run: AgentRun): boolean {
  return run.status === "failed" && /blocked|denied|not permitted|permission|safety stop/i.test(run.error ?? "");
}

export default function App() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [system, setSystem] = useState<SystemInfo | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [prompt, setPrompt] = useState("");
  const [promptReview, setPromptReview] = useState<{
    content: string;
    analysis: PromptAnalysis;
    suggestion: PromptGraphSuggestion;
  } | null>(null);
  const [analyzingPrompt, setAnalyzingPrompt] = useState(false);
  const [activeRun, setActiveRun] = useState<AgentRun | null>(null);
  const [runEvents, setRunEvents] = useState<RunTimelineItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [authRequired, setAuthRequired] = useState<boolean | null>(null);
  const [authInput, setAuthInput] = useState("");
  const [workspaceView, setWorkspaceView] = useState<"graph" | "overall" | "playground">("graph");
  const messageEnd = useRef<HTMLDivElement>(null);
  const selectedIdRef = useRef<string | null>(null);
  const mountedRef = useRef(true);
  const pollingRunIds = useRef(new Set<string>());
  selectedIdRef.current = selectedId;

  const selected = useMemo(
    () => agents.find((agent) => agent.id === selectedId) ?? null,
    [agents, selectedId],
  );

  const refreshAgents = useCallback(async () => {
    const { agents: next } = await api.listAgents();
    setAgents(next);
    setSelectedId((current) =>
      current && next.some((agent) => agent.id === current)
        ? current
        : (next[0]?.id ?? null),
    );
  }, []);

  const refreshMessages = useCallback(async (agentId: string) => {
    const result = await api.messages(agentId);
    if (mountedRef.current && selectedIdRef.current === agentId) {
      setMessages(result.messages);
    }
  }, []);

  const bootstrap = useCallback(async () => {
    await Promise.all([refreshAgents(), api.system().then(setSystem)]);
  }, [refreshAgents]);

  useEffect(() => {
    mountedRef.current = true;
    void api
      .auth()
      .then(async ({ required }) => {
        if (!mountedRef.current) return;
        setAuthRequired(required);
        if (!required) await bootstrap();
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
    return () => {
      mountedRef.current = false;
    };
  }, [bootstrap]);

  useEffect(() => {
    setActiveRun(null);
    setRunEvents([]);
    setPromptReview(null);
    setShowSettings(false);
    if (!selectedId) {
      setMessages([]);
      return;
    }
    void Promise.all([refreshMessages(selectedId), api.runs(selectedId)])
      .then(async ([, result]) => {
        if (selectedIdRef.current !== selectedId) return;
        const latest = result.runs[0] ?? null;
        setActiveRun(latest);
        if (latest) {
          const timeline = await api.runEvents(latest.id);
          if (selectedIdRef.current === selectedId) setRunEvents(timeline.events);
        }
        if (latest && ["queued", "running"].includes(latest.status)) {
          void pollRun(latest.id, selectedId).catch((reason) =>
            setError(reason instanceof Error ? reason.message : String(reason)),
          );
        }
      })
      .catch((reason) =>
        setError(reason instanceof Error ? reason.message : String(reason)),
      );
  }, [refreshMessages, selectedId]);

  useEffect(() => {
    if (selected) {
      setForm({
        name: selected.name,
        description: selected.description,
        instructions: selected.instructions,
      });
    }
  }, [selected]);

  useEffect(() => {
    messageEnd.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, activeRun]);

  const createAgent = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { agent } = await api.createAgent(form);
      await refreshAgents();
      setSelectedId(agent.id);
      setShowCreate(false);
      setForm(emptyForm);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const saveAgent = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      await api.updateAgent(selected.id, form);
      await refreshAgents();
      setShowSettings(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const toggleAgent = async () => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      if (selected.status === "stopped") {
        await api.startAgent(selected.id);
      } else {
        await api.stopAgent(selected.id);
      }
      await refreshAgents();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const deleteAgent = async () => {
    if (!selected) return;
    if (!window.confirm(
      `Delete ${selected.name}? Its workspace will be archived, while completed Run audit history is retained.`,
    )) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.deleteAgent(selected.id);
      await refreshAgents();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const pollRun = async (runId: string, agentId: string) => {
    if (pollingRunIds.current.has(runId)) return;
    pollingRunIds.current.add(runId);
    try {
      while (mountedRef.current) {
        await new Promise((resolve) => window.setTimeout(resolve, 900));
        if (!mountedRef.current) return;
        const [result, timeline] = await Promise.all([
          api.run(runId),
          api.runEvents(runId),
        ]);
        if (selectedIdRef.current === agentId) setActiveRun(result.run);
        if (selectedIdRef.current === agentId) setRunEvents(timeline.events);
        if (!["queued", "running"].includes(result.run.status)) {
          await Promise.all([refreshMessages(agentId), refreshAgents()]);
          return;
        }
      }
    } finally {
      pollingRunIds.current.delete(runId);
    }
  };

  const resolveApproval = async (approve: boolean) => {
    if (!selected || !activeRun?.policy?.approvalRequestId) return;
    const approvalId = activeRun.policy.approvalRequestId;
    setBusy(true);
    setError(null);
    try {
      if (approve) {
        await api.approveRequest(approvalId, "Approved from the Launchpad console");
        const resumed = await api.resumeRun(activeRun.id);
        setActiveRun(resumed.run);
        await pollRun(resumed.run.id, selected.id);
      } else {
        await api.rejectRequest(approvalId, "Rejected from the Launchpad console");
        const refreshed = await api.run(activeRun.id);
        setActiveRun(refreshed.run);
        await refreshAgents();
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      await refreshAgents();
    } finally {
      setBusy(false);
    }
  };

  const dispatchMessage = async (agent: Agent, content: string) => {
    setError(null);
    try {
      const result = await api.sendMessage(agent.id, content);
      if (selectedIdRef.current === agent.id) {
        setMessages((current) => [...current, result.message]);
        setActiveRun(result.run);
        setRunEvents([]);
      }
      setAgents((current) =>
        current.map((agent) =>
          agent.id === result.run.agentId ? { ...agent, status: "busy" } : agent,
        ),
      );
      await pollRun(result.run.id, agent.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setActiveRun(null);
      await refreshAgents();
    }
  };

  const sendMessage = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selected || !prompt.trim()) return;
    const content = prompt.trim();
    setAnalyzingPrompt(true);
    setError(null);
    try {
      const { analysis } = await api.analyzePrompt(selected.id, content);
      const suggestion = analysis.suggestions[0];
      setPrompt("");
      if (suggestion) {
        setPromptReview({ content, analysis, suggestion });
        return;
      }
      await dispatchMessage(selected, content);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setAnalyzingPrompt(false);
    }
  };

  const confirmPromptRelationship = async () => {
    if (!selected || !promptReview) return;
    const pending = promptReview;
    setBusy(true);
    setError(null);
    try {
      await api.confirmPromptSuggestion(selected.id, pending.suggestion);
      setPromptReview(null);
      await dispatchMessage(selected, pending.content);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const continueWithoutRelationship = async () => {
    if (!selected || !promptReview) return;
    const content = promptReview.content;
    setPromptReview(null);
    await dispatchMessage(selected, content);
  };

  const openSecurityRun = async (runId: string) => {
    if (!selected) return;
    setError(null);
    try {
      const [run, timeline] = await Promise.all([api.run(runId), api.runEvents(runId)]);
      setActiveRun(run.run);
      setRunEvents(timeline.events);
      await refreshAgents();
      window.requestAnimationFrame(() => {
        document.getElementById("run-timeline-title")?.scrollIntoView({
          behavior: "smooth",
          block: "start",
        });
      });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const unlock = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setAuthToken(authInput);
    try {
      await bootstrap();
      setAuthRequired(false);
      setAuthInput("");
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 401) {
        setError("The access token is not valid.");
      } else {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    } finally {
      setBusy(false);
    }
  };

  if (authRequired === null) {
    return (
      <main className="auth-screen">
        <section className="auth-card" aria-live="polite">
          <div className="brand-mark">A</div>
          <span className="eyebrow">QuantQueens</span>
          <h1>Connecting to the control plane</h1>
          {error ? <div className="error-banner" role="alert">{error}</div> : <Spinner />}
        </section>
      </main>
    );
  }

  if (authRequired) {
    return (
      <main className="auth-screen">
        <form className="auth-card" onSubmit={unlock}>
          <div className="brand-mark">A</div>
          <span className="eyebrow">QuantQueens</span>
          <h1>Enter the access token</h1>
          <p>This shared demo token is configured by the platform operator.</p>
          {error && <div className="error-banner" role="alert">{error}</div>}
          <label>
            Access token
            <input
              autoFocus
              type="password"
              value={authInput}
              onChange={(event) => setAuthInput(event.target.value)}
              autoComplete="current-password"
              required
            />
          </label>
          <button className="button button-primary" disabled={busy || !authInput.trim()}>
            {busy ? <Spinner /> : "Open Launchpad"}
          </button>
        </form>
      </main>
    );
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">A</div>
          <div>
            <strong>QuantQueens</strong>
            <span>Agent safety middleware</span>
          </div>
        </div>

        <button
          className="button button-primary create-button"
          onClick={() => {
            setForm(emptyForm);
            setShowCreate(true);
          }}
        >
          <span>＋</span> Create Agent
        </button>

        <div className="sidebar-label">
          <span>Your Agents</span>
          <span>{agents.length}</span>
        </div>
        <nav className="agent-list">
          {agents.map((agent) => (
            <button
              className={"agent-card " + (agent.id === selectedId ? "selected" : "")}
              key={agent.id}
              aria-label={`Open ${agent.name}`}
              title={agent.name}
              onClick={() => setSelectedId(agent.id)}
            >
              <div className="agent-avatar">{agent.name.slice(0, 1).toUpperCase()}</div>
              <div className="agent-card-copy">
                <strong>{agent.name}</strong>
                <span>{agent.description || "Coding Agent"}</span>
              </div>
              <span className={"mini-dot mini-" + agent.status} />
            </button>
          ))}
          {agents.length === 0 && (
            <div className="empty-sidebar">
              <span>◇</span>
              Create your first coding Agent.
            </div>
          )}
        </nav>

        <div className="runtime-card">
          <span className="eyebrow">Runtime</span>
          <strong>{system?.runtime ?? "Checking…"}</strong>
          <span>
            {system?.arkModel ?? "Ark model not configured"}
            {system?.containerEngine ? " · " + system.containerEngine : ""}
          </span>
        </div>
      </aside>

      <main className="main">
        {!system?.arkConfigured || !system?.codexAvailable ? (
          <div className="config-banner config-banner-ready">
            <span>i</span>
            <div>
              <strong>Protected actions are available</strong>
              <p>
                Managed resource controls still use the live middleware path. Configure Codex only for free-form Agent chat.
              </p>
            </div>
          </div>
        ) : null}

        {error && (
          <div className="error-banner" role="alert">
            <span>{error}</span>
            <button onClick={() => setError(null)}>×</button>
          </div>
        )}

        {selected ? (
          <>
            <header className="agent-header">
              <div>
              <div className="header-title-row">
                <h1>{selected.name}</h1>
                <StatusPill status={selected.status} />
              </div>
              <p>{selected.description || "A Codex coding Agent in an isolated workspace."}</p>
              </div>
              <div className="header-actions">
                <button
                  className="button button-ghost"
                  onClick={() => setShowSettings((value) => !value)}
                  disabled={busy || selected.status === "busy"}
                >
                  Settings
                </button>
                <button
                  className="button button-ghost"
                  onClick={toggleAgent}
                  disabled={busy}
                >
                  {selected.status === "stopped" ? "Start" : "Stop"}
                </button>
                <button
                  className="button button-danger"
                  onClick={deleteAgent}
                  disabled={busy || selected.status === "busy"}
                >
                  Delete
                </button>
              </div>
            </header>

            {showSettings && (
              <form className="settings-panel" onSubmit={saveAgent}>
                <div className="settings-title">
                  <div>
                    <span className="eyebrow">Agent configuration</span>
                    <h2>Instructions and identity</h2>
                  </div>
                  <button type="button" onClick={() => setShowSettings(false)}>×</button>
                </div>
                <div className="form-grid">
                  <label>
                    Name
                    <input
                      value={form.name}
                      onChange={(event) => setForm({ ...form, name: event.target.value })}
                      required
                      maxLength={80}
                    />
                  </label>
                  <label>
                    Description
                    <input
                      value={form.description}
                      onChange={(event) =>
                        setForm({ ...form, description: event.target.value })
                      }
                      maxLength={500}
                    />
                  </label>
                </div>
                <label>
                  System instructions
                  <textarea
                    value={form.instructions}
                    onChange={(event) =>
                      setForm({ ...form, instructions: event.target.value })
                    }
                    rows={5}
                    maxLength={10_000}
                  />
                </label>
                <div className="panel-footer">
                  <code>{selected.workspacePath}</code>
                  <button className="button button-primary" disabled={busy}>
                    {busy ? <Spinner /> : "Save changes"}
                  </button>
                </div>
              </form>
            )}

            <div className="workspace-tabs" role="tablist" aria-label="Agent workspace views">
              <button
                className={workspaceView === "graph" ? "active" : ""}
                role="tab"
                aria-selected={workspaceView === "graph"}
                onClick={() => setWorkspaceView("graph")}
              >
                Impact map
              </button>
              <button
                className={workspaceView === "overall" ? "active" : ""}
                role="tab"
                aria-selected={workspaceView === "overall"}
                onClick={() => setWorkspaceView("overall")}
              >
                Network graph
              </button>
              <button
                className={workspaceView === "playground" ? "active" : ""}
                role="tab"
                aria-selected={workspaceView === "playground"}
                onClick={() => setWorkspaceView("playground")}
              >
                Playground
              </button>
            </div>

            {workspaceView === "graph" ? <KnowledgeGraphPanel key={selected.id} agent={selected} /> : workspaceView === "overall" ? <OverallGraphPanel /> : <section className="playground playground-security-demo">
              <div className="playground-topbar">
                <div>
                  <span className="eyebrow">
                    Agent protection
                  </span>
                  <h2>
                    Review and control resource actions
                  </h2>
                </div>
                <div className="session-info">
                  <span className="pulse" />
                  Middleware active
                </div>
              </div>

              <SecurityDemoPanel
                agent={selected}
                extendedDemo={selected.id === RELEASE_GUARDIAN_ID}
                onOpenRun={openSecurityRun}
              />

              <div className="messages">
                {messages.length === 0 && !activeRun ? (
                  <div className="welcome">
                    <div className="welcome-orbit">
                      <div>⌁</div>
                    </div>
                    <h3>What should {selected.name} build?</h3>
                    <p>
                      The Agent can inspect files, write code, run commands, and continue the
                      same Codex session across messages.
                    </p>
                    <div className="prompt-grid">
                      {starterPrompts.map((item) => (
                        <button key={item} onClick={() => setPrompt(item)}>
                          <span>↗</span>
                          {item}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : (
                  messages.map((message) => (
                    <article className={"message message-" + message.role} key={message.id}>
                      <div className="message-meta">
                        <strong>{message.role === "user" ? "You" : selected.name}</strong>
                        <span>{formatTime(message.createdAt)}</span>
                      </div>
                      <div className="message-body">{message.content}</div>
                    </article>
                  ))
                )}
                {activeRun && ["queued", "running"].includes(activeRun.status) && (
                  <article className="message message-assistant thinking">
                    <div className="message-meta">
                      <strong>{selected.name}</strong>
                      <span>working in the Agent workspace</span>
                    </div>
                    <div className="thinking-row">
                      <Spinner />
                      Codex is reading, editing, or running commands…
                    </div>
                  </article>
                )}
                {activeRun?.status === "awaiting_approval" && activeRun.policy && (
                  <article className="run-approval">
                    <div className="run-approval-heading">
                      <span aria-hidden="true">!</span>
                      <div>
                        <strong>This action needs human approval</strong>
                        <p>
                          {activeRun.policy.reasonCode === "SUSPICIOUS_REQUEST"
                            ? activeRun.policy.intentExplanation
                            : `The reachable systems total ${activeRun.policy.riskScore} risk points, above the review threshold of ${activeRun.policy.reviewThreshold}.`}
                          {" "}The Agent runtime has not started.
                        </p>
                      </div>
                    </div>
                    {(activeRun.policy.riskFactors ?? []).length > 0 && (
                      <div className="run-risk-breakdown" aria-label="Blast radius calculation">
                        {(activeRun.policy.riskFactors ?? []).map((factor) => (
                          <div key={factor.id}>
                            <span>{factor.label}<small>{factor.classification}</small></span>
                            <strong>+{factor.riskWeight}</strong>
                          </div>
                        ))}
                        <div className="run-risk-total"><span>Total blast radius</span><strong>{activeRun.policy.riskScore}</strong></div>
                      </div>
                    )}
                    <div className="run-approval-actions">
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void resolveApproval(true)}
                      >
                        Approve and run
                      </button>
                      <button
                        type="button"
                        className="ghost"
                        disabled={busy}
                        onClick={() => void resolveApproval(false)}
                      >
                        Reject
                      </button>
                    </div>
                  </article>
                )}
                {activeRun?.status === "failed" && (
                  <article className={`run-error ${wasSafelyPrevented(activeRun) ? "run-prevented" : ""}`}>
                    <strong>{wasSafelyPrevented(activeRun) ? "Action safely prevented" : "Run failed"}</strong>
                    <span>{activeRun.error}</span>
                    {wasSafelyPrevented(activeRun) && <small>The application is working: middleware ended this Run before a protected effect could occur.</small>}
                  </article>
                )}
                <RunTimeline events={runEvents} />
                <div ref={messageEnd} />
              </div>

              {promptReview && (
                <section className={`prompt-review prompt-review-${promptReview.analysis.intent}`} aria-labelledby="prompt-review-title">
                  <div className="prompt-review-copy">
                    <span className="eyebrow">Suggested from your request</span>
                    <h3 id="prompt-review-title">Confirm what this Agent may access</h3>
                    <p>{promptReview.suggestion.rationale} Confirming this adds the relationship to the graph so future risk decisions can be calculated automatically.</p>
                  </div>
                  <div className="prompt-review-fields">
                    <label>
                      Resource
                      <input value={promptReview.suggestion.label} disabled={Boolean(promptReview.suggestion.existingNodeId)} onChange={(event) => setPromptReview((current) => current ? { ...current, suggestion: { ...current.suggestion, label: event.target.value } } : current)} />
                    </label>
                    <label>
                      Access needed
                      <select value={promptReview.suggestion.capability} onChange={(event) => setPromptReview((current) => current ? { ...current, suggestion: { ...current.suggestion, capability: event.target.value as PromptGraphSuggestion["capability"] } } : current)}>
                        <option value="CAN_READ">Read</option>
                        <option value="CAN_WRITE">Write or change</option>
                        <option value="CAN_CALL">Call or deploy</option>
                        <option value="CAN_USE">Use credential</option>
                      </select>
                    </label>
                    <label>
                      Data sensitivity
                      <select disabled={Boolean(promptReview.suggestion.existingNodeId)} value={promptReview.suggestion.classification} onChange={(event) => setPromptReview((current) => current ? { ...current, suggestion: { ...current.suggestion, classification: event.target.value as PromptGraphSuggestion["classification"] } } : current)}>
                        <option value="public">Public</option>
                        <option value="internal">Internal</option>
                        <option value="confidential">Confidential</option>
                        <option value="restricted">Restricted</option>
                      </select>
                    </label>
                  </div>
                  <div className="prompt-review-actions">
                    <button className="button button-primary" type="button" onClick={() => void confirmPromptRelationship()} disabled={busy || !promptReview.suggestion.label.trim()}>{busy ? <Spinner /> : "Confirm and continue"}</button>
                    <button className="button button-ghost" type="button" onClick={() => void continueWithoutRelationship()} disabled={busy}>Not a protected resource</button>
                  </div>
                  <p className="prompt-review-note">Nothing is added silently. You can change the suggested access and sensitivity before continuing.</p>
                </section>
              )}

              <form className="composer" onSubmit={sendMessage}>
                <textarea
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      event.currentTarget.form?.requestSubmit();
                    }
                  }}
                  placeholder={
                    selected.status === "stopped"
                      ? "Start this Agent to continue…"
                      : "Describe what you want the Agent to do…"
                  }
                  disabled={
                    selected.status === "stopped" ||
                    selected.status === "busy" ||
                    activeRun != null &&
                      ["queued", "running", "awaiting_approval"].includes(activeRun.status) ||
                    promptReview != null
                  }
                  rows={3}
                />
                <div className="composer-footer">
                  <span>
                    {analyzingPrompt ? "Understanding request…" : `Enter to send · Shift + Enter for newline · ${system?.codexSandboxMode ?? "checking sandbox"}`}
                  </span>
                  <button
                    className="send-button"
                    disabled={
                      !prompt.trim() ||
                      analyzingPrompt ||
                      promptReview != null ||
                      selected.status === "stopped" ||
                      selected.status === "busy" ||
                      (activeRun != null &&
                        ["queued", "running", "awaiting_approval"].includes(activeRun.status))
                    }
                    aria-label="Send message"
                  >
                    ↑
                  </button>
                </div>
              </form>
            </section>}
          </>
        ) : (
          <div className="no-agent">
            <div className="no-agent-art">A</div>
            <span className="eyebrow">QuantQueens</span>
            <h1>Your runtime is ready for an Agent.</h1>
            <p>Create a workspace, give Codex a job, and continue the conversation here.</p>
            <button
              className="button button-primary"
              onClick={() => {
                setForm(emptyForm);
                setShowCreate(true);
              }}
            >
              Create your first Agent
            </button>
          </div>
        )}
      </main>

      {showCreate && (
        <div className="modal-backdrop" onMouseDown={() => setShowCreate(false)}>
          <form
            className="modal"
            onSubmit={createAgent}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="modal-heading">
              <div>
                <span className="eyebrow">New workspace</span>
                <h2>Create an Agent</h2>
                <p>Each Agent gets a persistent folder and a resumable Codex session.</p>
              </div>
              <button type="button" onClick={() => setShowCreate(false)}>×</button>
            </div>
            <label>
              Name
              <input
                autoFocus
                placeholder="Frontend Builder"
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
                required
                maxLength={80}
              />
            </label>
            <label>
              Description
              <input
                placeholder="Builds polished React prototypes"
                value={form.description}
                onChange={(event) =>
                  setForm({ ...form, description: event.target.value })
                }
                maxLength={500}
              />
            </label>
            <label>
              Instructions
              <textarea
                value={form.instructions}
                onChange={(event) =>
                  setForm({ ...form, instructions: event.target.value })
                }
                rows={6}
                maxLength={10_000}
              />
            </label>
            <div className="modal-footer">
              <button
                type="button"
                className="button button-ghost"
                onClick={() => setShowCreate(false)}
              >
                Cancel
              </button>
              <button className="button button-primary" disabled={busy}>
                {busy ? <Spinner /> : "Create Agent"}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
