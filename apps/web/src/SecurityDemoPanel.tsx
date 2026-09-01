import { useCallback, useEffect, useState } from "react";
import {
  api,
  type BehavioralBaseline,
  type CircuitBreaker,
  type SafetyEvidence,
} from "./api";
import type { Agent, AgentRun } from "./types";

type JourneyState = "done" | "current" | "blocked" | "muted";

function safetyLabel(value: SafetyEvidence["verdict"]["safety"] | undefined): string {
  if (value === "BLOCK") return "Blocked";
  if (value === "WARN") return "Needs review";
  if (value === "NOT_EVALUATED") return "Not needed";
  return value === "ALLOW" ? "Allowed" : "Waiting";
}

function effectLabel(value: SafetyEvidence["verdict"]["effect"] | undefined): string {
  if (value === "COMPLETED") return "Completed";
  if (value === "WAITING_FOR_REVIEW") return "Paused";
  if (value === "FAILED") return "Failed safely";
  return value === "PREVENTED" ? "Prevented" : "Waiting";
}

function actionLabel(evidence: SafetyEvidence): string {
  const verb = evidence.action.capability === "CAN_READ"
    ? "Read"
    : evidence.action.capability === "CAN_CALL"
      ? "Call"
      : evidence.action.capability === "CAN_USE"
        ? "Use"
        : "Change";
  return `${verb} ${evidence.action.resourceLabel}`;
}

function principalLabel(principalId: string): string {
  const value = principalId.split(":").at(-1) ?? principalId;
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function permissionDetail(evidence: SafetyEvidence, agent: Agent): string {
  const capability = evidence.action.capability.replace("CAN_", "").toLowerCase();
  if (evidence.verdict.permission === "ALLOW") {
    return `${agent.name} has an exact ${capability} permission for ${evidence.action.resourceLabel}, and the authenticated operator's role allows that capability.`;
  }
  if (evidence.verdict.permissionReasonCode === "RESOURCE_OWNED_BY_ANOTHER_PRINCIPAL") {
    return `${evidence.action.resourceLabel} belongs to another person. Ownership and nearby graph connections cannot give ${agent.name} permission to access it.`;
  }
  if (evidence.verdict.permissionReasonCode === "NO_AGENT_CAPABILITY") {
    return `${agent.name} has no exact ${capability} permission edge to ${evidence.action.resourceLabel}. Indirect graph paths never create authority.`;
  }
  return `The authenticated identity, Agent permission, or delegated scope does not allow this ${capability} request (${evidence.verdict.permissionReasonCode}).`;
}

function JourneyStep({
  number,
  state,
  title,
  detail,
}: {
  number: number;
  state: JourneyState;
  title: string;
  detail: string;
}) {
  const marker = state === "done" ? "✓" : state === "blocked" ? "×" : number;
  return (
    <li className={`journey-step journey-step-${state}`}>
      <span className="journey-step-marker" aria-hidden="true">{marker}</span>
      <div>
        <strong>{title}</strong>
        <p>{detail}</p>
      </div>
    </li>
  );
}

export function SecurityDemoPanel({
  agent,
  activeRun,
  pendingPrompt,
  requestInFlight,
  refreshToken,
  onClose,
  onOpenRun,
  onShowImpact,
  onShowNetwork,
}: {
  agent: Agent;
  activeRun: AgentRun | null;
  pendingPrompt: string;
  requestInFlight: boolean;
  refreshToken: number;
  onClose: () => void;
  onOpenRun: (runId: string) => Promise<void>;
  onShowImpact: () => void;
  onShowNetwork: () => void;
}) {
  const [baseline, setBaseline] = useState<BehavioralBaseline | null>(null);
  const [breaker, setBreaker] = useState<CircuitBreaker | null>(null);
  const [evidence, setEvidence] = useState<SafetyEvidence | null>(null);
  const [resetting, setResetting] = useState(false);
  const [resetNotice, setResetNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refreshContext = useCallback(async () => {
    const [history, safetyStop, latestProof] = await Promise.all([
      api.behaviorBaseline(agent.id),
      api.circuitBreaker(agent.id),
      api.latestSafetyEvidence(agent.id),
    ]);
    setBaseline(history.baseline);
    setBreaker(safetyStop.circuitBreaker);
    setEvidence(latestProof.evidence);
  }, [agent.id]);

  useEffect(() => {
    setResetNotice(null);
    setError(null);
    void refreshContext().catch((reason) =>
      setError(reason instanceof Error ? reason.message : String(reason)),
    );
  }, [refreshContext, refreshToken, activeRun?.id, activeRun?.status]);

  const resetSafetyStop = async () => {
    setResetting(true);
    setError(null);
    try {
      const result = await api.resetCircuitBreaker(
        agent.id,
        "Reset after reviewing the blocked prompt and its audit trail",
      );
      setBreaker(result.circuitBreaker);
      setResetNotice("Safety stop cleared. The blocked Run remains in the audit trail, and the next request will be evaluated again.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setResetting(false);
    }
  };

  const isRouting = requestInFlight && (!activeRun || activeRun.prompt !== pendingPrompt);
  const currentEvidence = !isRouting && activeRun && evidence?.run.id === activeRun.id
    ? evidence
    : null;
  const isProtectedRun = Boolean(currentEvidence) || activeRun?.kind === "managed_action";
  const isCodexRun = !isRouting && Boolean(activeRun) && !currentEvidence;

  const safetyStopActive = breaker?.state === "TRIPPED";
  const authorization = currentEvidence?.verdict.permission;
  const safety = currentEvidence?.verdict.safety;
  const effect = currentEvidence?.verdict.effect;
  const trustedRuns = baseline?.eligibleRunCount ?? 0;
  const impactTargets = currentEvidence?.impactAtDecision.targets ?? [];
  const impactPath = [...impactTargets]
    .sort((left, right) => right.path.length - left.path.length)[0]?.path ?? [];

  const resultTone = authorization === "DENY"
    ? "denied"
    : safety === "BLOCK"
      ? "blocked"
      : effect === "COMPLETED"
        ? "completed"
        : "neutral";
  const resultTitle = authorization === "DENY"
    ? "Access denied before the resource"
    : safety === "BLOCK"
      ? "Authorized, but stopped as unsafe"
      : safety === "WARN"
        ? effect === "COMPLETED"
          ? "Approved and completed"
          : "Paused for human review"
        : effect === "COMPLETED"
          ? "Action completed through the gateway"
          : "Checking the protected request";

  const codexWorking = activeRun?.status === "queued" || activeRun?.status === "running";
  const codexCompleted = activeRun?.status === "completed";
  const codexFailed = activeRun?.status === "failed" || activeRun?.status === "cancelled";
  const runtimeStarted = Boolean(activeRun?.startedAt);
  const readOnlyPlanner = activeRun?.policy?.reasonCode === "READ_ONLY_PLANNING_BEFORE_ACTION_GATE";

  const panelTitle = isRouting
    ? "Understanding your request"
    : isProtectedRun
      ? "Request journey"
      : "Agent activity";
  const statusText = isRouting
    ? "Interpreting"
    : isProtectedRun
      ? safetyStopActive
        ? "Safety stop active"
        : breaker?.state === "WARN"
          ? "Review needed"
          : "Gateway checked"
      : codexWorking
        ? "Model working"
        : codexCompleted
          ? "Response ready"
          : codexFailed
            ? "Run ended"
            : "Starting";

  return (
    <aside className="security-demo run-activity-panel" aria-labelledby="run-activity-title">
      <header className="run-activity-heading">
        <div>
          <span className="eyebrow">{isProtectedRun ? "Protected request" : "Live Agent Run"}</span>
          <h3 id="run-activity-title">{panelTitle}</h3>
        </div>
        <button className="run-activity-close" type="button" onClick={onClose} aria-label="Close run activity">×</button>
      </header>

      <div className="run-activity-status-row">
        <span
          className={`security-stop security-stop-${safetyStopActive ? "tripped" : breaker?.state.toLowerCase() ?? "normal"}`}
          role="status"
          aria-label={isProtectedRun
            ? `Protection status: ${safetyStopActive ? "safety stop active" : breaker?.state === "WARN" ? "review needed" : "ready"}`
            : `Agent status: ${statusText.toLowerCase()}`}
        >
          <span className={isRouting || codexWorking ? "status-motion" : "status-still"} />
          {statusText}
        </span>
        {activeRun && <small>Run {activeRun.id.slice(0, 8)}</small>}
      </div>

      <div className="run-activity-prompt">
        <span>{isProtectedRun ? "Requested action" : "Your prompt"}</span>
        <strong>{pendingPrompt || activeRun?.prompt || "Waiting for a prompt"}</strong>
      </div>

      {error && <p className="security-demo-error" role="alert">{error}</p>}
      {resetNotice && (
        <div className="security-reset-notice" role="status">
          <strong>Recovery recorded</strong>
          <p>{resetNotice}</p>
        </div>
      )}

      {isRouting && (
        <ol className="journey-list" aria-label="Request routing progress">
          <JourneyStep number={1} state="done" title="Prompt received" detail="The server received the words you entered. No trusted identity or verdict came from the browser." />
          <JourneyStep number={2} state="current" title="Choosing the safe runtime" detail="Protected-resource requests give Codex a read-only planning turn. Other work continues through the configured Agent runtime." />
          <JourneyStep number={3} state="muted" title="Run the correct path" detail="The next stage will appear from the backend result, not from a simulated timer." />
        </ol>
      )}

      {isCodexRun && activeRun && (
        <>
          <ol className="journey-list" aria-label="Agent Run progress">
            <JourneyStep number={1} state="done" title="Run attributed" detail={`The authenticated operator asked ${agent.name}. The prompt and Run ID are persisted.`} />
            <JourneyStep
              number={2}
              state={runtimeStarted ? "done" : codexFailed ? "blocked" : "current"}
              title={activeRun.status === "awaiting_approval" ? "Waiting for approval" : "Codex runtime started"}
              detail={activeRun.status === "awaiting_approval"
                ? "The model has not started because the pre-run policy paused this Run."
                : runtimeStarted
                  ? readOnlyPlanner
                    ? "Codex is interpreting a protected request in a read-only runtime; it cannot reach the managed resource directly."
                    : "Codex is running in the configured Agent runtime with this Agent's workspace."
                  : "The Run is waiting for the runtime."}
            />
            <JourneyStep
              number={3}
              state={codexWorking ? "current" : codexCompleted ? "done" : codexFailed ? "blocked" : "muted"}
              title={codexWorking ? "Model is working" : "Model work finished"}
              detail={codexWorking
                ? readOnlyPlanner
                  ? "Codex is choosing at most one bounded Resource and capability proposal. The server will treat it as untrusted input."
                  : "Codex is reasoning, inspecting its workspace, or using its available tools."
                : codexCompleted
                  ? "The model completed this turn and the conversation was updated."
                  : "No successful model result was recorded."}
            />
            <JourneyStep
              number={4}
              state={codexCompleted ? "done" : codexFailed ? "blocked" : "muted"}
              title={codexCompleted ? "Response ready" : codexFailed ? "Run stopped" : "Return the response"}
              detail={codexCompleted
                ? "The Agent's answer is visible in the conversation."
                : codexFailed
                  ? activeRun.error ?? "The Run ended without a response."
                  : "This completes only when the backend records the Run outcome."}
            />
          </ol>
          <div className="security-result-actions">
            <button className="button button-ghost" type="button" onClick={() => void onOpenRun(activeRun.id)}>View audit trail</button>
          </div>
        </>
      )}

      {activeRun?.kind === "managed_action" && !currentEvidence && (
        <ol className="journey-list" aria-label="Protected request progress">
          <JourneyStep number={1} state="done" title="Managed action identified" detail="The server matched the prompt to a known resource and exact capability." />
          <JourneyStep number={2} state="current" title="Loading decision evidence" detail="The recorded identity, graph, policy, and gateway outcome are being retrieved." />
        </ol>
      )}

      {currentEvidence && (
        <>
          <div className={`security-result-summary security-result-summary-${resultTone}`}>
            <strong>{resultTitle}</strong>
            <p>{currentEvidence.verdict.explanation}</p>
          </div>

          <dl className="security-decision-line">
            <div aria-label="Permission decision"><dt>Permission</dt><dd>{authorization === "ALLOW" ? "Allowed" : "Denied"}</dd></div>
            <div aria-label="Safety decision"><dt>Safety</dt><dd>{safetyLabel(safety)}</dd></div>
            <div aria-label="Resource effect"><dt>Resource</dt><dd>{effectLabel(effect)}</dd></div>
          </dl>

          <ol className="journey-list journey-list-managed" aria-label="Protected request journey">
            <JourneyStep number={1} state="done" title="Codex proposed the action" detail={`${actionLabel(currentEvidence)} The real model planned read-only; the server validated its bounded proposal before policy.`} />
            <JourneyStep number={2} state="done" title="Verified who is asking" detail={`${principalLabel(currentEvidence.identity.originPrincipalId)} → ${agent.name} → Run ${currentEvidence.run.id.slice(0, 8)}`} />
            <JourneyStep
              number={3}
              state={authorization === "DENY" ? "blocked" : "done"}
              title={authorization === "DENY" ? "Permission denied" : "Exact permission found"}
              detail={permissionDetail(currentEvidence, agent)}
            />
            <JourneyStep
              number={4}
              state={authorization === "DENY" ? "muted" : "done"}
              title={authorization === "DENY" ? "Impact check not needed" : `Mapped ${currentEvidence.impactAtDecision.blastRadius} affected resources`}
              detail={authorization === "DENY" ? "Denied actions cannot be rescued by a low risk score." : impactPath.length > 1 ? impactPath.join(" → ") : "The backend traversed downstream dependencies before execution."}
            />
            <JourneyStep
              number={5}
              state={authorization === "DENY" ? "muted" : safety === "BLOCK" ? "blocked" : safety === "WARN" && effect !== "COMPLETED" ? "current" : "done"}
              title={authorization === "DENY" ? "History check not needed" : safety === "BLOCK" ? "Risk exceeded the hard-stop threshold" : safety === "WARN" ? effect === "COMPLETED" ? "Human review approved" : "Human review required" : "Behavior matched the safety rules"}
              detail={authorization === "DENY"
                ? "Safety is evaluated only after authorization."
                : `${trustedRuns} trusted ${trustedRuns === 1 ? "Run forms" : "Runs form"} this Agent's current baseline. ${currentEvidence.verdict.explanation}`}
            />
            <JourneyStep
              number={6}
              state={effect === "COMPLETED" ? "done" : effect === "WAITING_FOR_REVIEW" ? "current" : "blocked"}
              title={effect === "COMPLETED" ? "Gateway completed the effect" : effect === "WAITING_FOR_REVIEW" ? "Gateway paused the effect" : "Gateway prevented the effect"}
              detail={effect === "COMPLETED" ? "A one-time claim was verified before the managed adapter changed durable state." : "No managed resource effect was claimed or executed."}
            />
          </ol>

          {impactTargets.length > 0 && (
            <div className="security-impact-list">
              <span>Potentially affected</span>
              <ul>{impactTargets.map((target) => <li key={target.id}>{target.label}</li>)}</ul>
              {impactPath.length > 1 && (
                <ol className="security-impact-path" aria-label="Relevant impact path">
                  {impactPath.map((label, index) => <li key={`${label}:${index}`}>{label}</li>)}
                </ol>
              )}
            </div>
          )}

          <div className="security-proof-line" aria-label="Persisted decision record">
            <span>Persisted proof</span>
            <strong>{currentEvidence.timeline.eventCount} events</strong>
            <small>
              Baseline {currentEvidence.historicalContext ? `revision ${currentEvidence.historicalContext.revision}` : "not used"}
              {" · "}Impact {currentEvidence.impactAtDecision.blastRadius} resources
              {" · "}{currentEvidence.effectEvidence.policyClaimed ? "Effect claim issued" : "Effect never claimed"}
            </small>
          </div>

          <details className="security-graph-explainer">
            <summary>How the impact map works</summary>
            <p><strong>Nodes</strong> are people, Agents, configurations, services, datasets, and Runs. <strong>Edges</strong> record ownership, exact access, deployment, processing, and confirmed dependencies. The backend follows those edges before the gateway decides whether an effect may happen.</p>
          </details>

          <div className="security-result-actions">
            <button className="button button-ghost" type="button" onClick={() => void onOpenRun(currentEvidence.run.id)}>View audit trail</button>
            <button className="button button-ghost" type="button" onClick={onShowImpact}>Open impact map</button>
            <button className="button button-ghost" type="button" onClick={onShowNetwork}>Open network graph</button>
            {safetyStopActive && <button className="button button-ghost" type="button" disabled={resetting} onClick={() => void resetSafetyStop()}>{resetting ? "Clearing…" : "Clear stop and re-check"}</button>}
          </div>

          <details className="security-coverage">
            <summary>Coverage and limits</summary>
            <p><strong>{currentEvidence.coverage.label}.</strong> {currentEvidence.coverage.guarantee}</p>
            <p>{currentEvidence.coverage.limitation}</p>
          </details>
        </>
      )}
    </aside>
  );
}
