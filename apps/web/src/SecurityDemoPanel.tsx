import { useCallback, useEffect, useState } from "react";
import {
  api,
  type BehavioralBaseline,
  type CircuitBreaker,
  type ManagedActionResult,
  type ResourceImpact,
  type SafetyEvidence,
} from "./api";
import type { Agent } from "./types";

const ALICE_PRIVATE_RESOURCE = "asset:alice-private-records";
const BOB_PRIVATE_RESOURCE = "asset:bob-private-records";
const STAGING_RESOURCE = "asset:staging-config";
const SHARED_RESOURCE = "asset:deployment-config";

interface BoundaryProof {
  ownedRunId: string;
  foreignRunId: string;
}

function resourceName(id: string): string {
  return id
    .replace(/^asset:/, "")
    .replaceAll("-", " ")
    .replace(/^./, (letter) => letter.toUpperCase());
}

function decisionCopy(result: ManagedActionResult): string {
  return result.outcome.risk?.explanation ??
    (result.outcome.authorization?.result === "DENY"
      ? "The authenticated user and Agent do not have permission for this resource. The protected adapter was never called."
      : result.outcome.result?.summary ?? "The protected action finished.");
}

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

function actionLabel(evidence: SafetyEvidence | null, result: ManagedActionResult | null): string {
  if (evidence) {
    const verb = evidence.action.capability === "CAN_READ"
      ? "Read"
      : evidence.action.capability === "CAN_CALL"
        ? "Call"
        : evidence.action.capability === "CAN_USE"
          ? "Use"
          : "Change";
    return `${verb} ${evidence.action.resourceLabel}`;
  }
  return result?.run.prompt || "Protected resource action";
}

export function SecurityDemoPanel({
  agent,
  extendedDemo,
  onOpenRun,
}: {
  agent: Agent;
  extendedDemo: boolean;
  onOpenRun: (runId: string) => Promise<void>;
}) {
  const [baseline, setBaseline] = useState<BehavioralBaseline | null>(null);
  const [breaker, setBreaker] = useState<CircuitBreaker | null>(null);
  const [impact, setImpact] = useState<ResourceImpact | null>(null);
  const [lastResult, setLastResult] = useState<ManagedActionResult | null>(null);
  const [evidence, setEvidence] = useState<SafetyEvidence | null>(null);
  const [boundaryProof, setBoundaryProof] = useState<BoundaryProof | null>(null);
  const [capabilityReady, setCapabilityReady] = useState(false);
  const [working, setWorking] = useState<"configure" | "boundary" | "history" | "unusual" | "reset" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resetNotice, setResetNotice] = useState<string | null>(null);

  const refreshContext = useCallback(async () => {
    const [history, safetyStop, latestProof, graph] = await Promise.all([
      api.behaviorBaseline(agent.id),
      api.circuitBreaker(agent.id),
      api.latestSafetyEvidence(agent.id),
      api.graph(agent.id),
    ]);
    setBaseline(history.baseline);
    setBreaker(safetyStop.circuitBreaker);
    setEvidence(latestProof.evidence);
    setCapabilityReady(graph.graph.capabilityEdges.some((edge) =>
      edge.sourceId === `agent:${agent.id}` &&
      edge.targetId === ALICE_PRIVATE_RESOURCE &&
      edge.relation === "CAN_READ" &&
      edge.status === "authorized"));
  }, [agent.id]);

  useEffect(() => {
    setBoundaryProof(null);
    setLastResult(null);
    setImpact(null);
    setError(null);
    setResetNotice(null);
  }, [agent.id]);

  useEffect(() => {
    let current = true;
    void refreshContext().catch((reason) => {
      if (current) setError(reason instanceof Error ? reason.message : String(reason));
    });
    return () => { current = false; };
  }, [refreshContext]);

  const configureOwnershipBoundary = async () => {
    setWorking("configure");
    setError(null);
    setResetNotice(null);
    try {
      await api.createGraphRelationship(agent.id, {
        sourceId: `agent:${agent.id}`,
        targetId: ALICE_PRIVATE_RESOURCE,
        relation: "CAN_READ",
      });
      await refreshContext();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setWorking(null);
    }
  };

  const proveOwnershipBoundary = async () => {
    setWorking("boundary");
    setError(null);
    setResetNotice(null);
    try {
      const owned = await api.managedAction(
        agent.id,
        ALICE_PRIVATE_RESOURCE,
        "Read the authenticated user's private records",
        { capability: "CAN_READ" },
      );
      if (owned.outcome.status !== "executed") {
        throw new Error(`The expected Alice-owned read did not execute: ${decisionCopy(owned)}`);
      }

      const foreign = await api.managedAction(
        agent.id,
        BOB_PRIVATE_RESOURCE,
        "Attempt to read another user's private records",
        {
          capability: "CAN_READ",
          // Intentionally ignored by the server. Identity comes from the
          // authenticated request, never from caller-controlled JSON.
          claimedPrincipalId: "human:bob",
        },
      );
      if (
        foreign.outcome.status !== "denied" ||
        foreign.outcome.authorization?.result !== "DENY"
      ) {
        throw new Error("The cross-user read was not denied by backend authorization.");
      }

      setBoundaryProof({ ownedRunId: owned.run.id, foreignRunId: foreign.run.id });
      setLastResult(foreign);
      setImpact(null);
      await refreshContext();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setWorking(null);
    }
  };

  const establishHistory = async () => {
    setWorking("history");
    setError(null);
    setResetNotice(null);
    try {
      const minimum = baseline?.minimumHistory ?? 3;
      const existing = baseline?.eligibleRunCount ?? 0;
      const stagingAlreadyLearned = baseline?.normalScope.some(
        (scope) => scope.capability === "CAN_WRITE" && scope.targetNodeId === STAGING_RESOURCE,
      ) ?? false;
      // A prior Track B read is legitimate history, but it must not replace
      // the staging pattern used by the adaptive safety proof.
      const runsNeeded = stagingAlreadyLearned ? Math.max(0, minimum - existing) : minimum;
      let latest: ManagedActionResult | null = null;
      for (let index = 0; index < runsNeeded; index += 1) {
        latest = await api.managedAction(
          agent.id,
          STAGING_RESOURCE,
          `Trusted staging update ${index + 1}`,
        );
        if (latest.outcome.status !== "executed") {
          throw new Error(decisionCopy(latest));
        }
      }
      if (latest) setLastResult(latest);
      setImpact(null);
      await refreshContext();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setWorking(null);
    }
  };

  const tryUnusualAction = async () => {
    setWorking("unusual");
    setError(null);
    setResetNotice(null);
    try {
      const [result, affected] = await Promise.all([
        api.managedAction(agent.id, SHARED_RESOURCE, "Update shared production deployment settings"),
        api.resourceImpact(SHARED_RESOURCE),
      ]);
      setLastResult(result);
      setImpact(affected.downstream);
      await refreshContext();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setWorking(null);
    }
  };

  const resetSafetyStop = async () => {
    setWorking("reset");
    setError(null);
    try {
      const result = await api.resetCircuitBreaker(
        agent.id,
        "Reset by an operator from the protected action center",
      );
      setBreaker(result.circuitBreaker);
      await refreshContext();
      setResetNotice("Safety stop cleared. New actions can be evaluated again; the previous blocked decision remains below as audit evidence.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setWorking(null);
    }
  };

  const stagingLearned = baseline?.normalScope.some(
    (scope) => scope.capability === "CAN_WRITE" && scope.targetNodeId === STAGING_RESOURCE,
  ) ?? false;
  const trustedRunCount = baseline?.eligibleRunCount ?? 0;
  const minimumHistory = baseline?.minimumHistory ?? 3;
  const historyReady =
    trustedRunCount >= minimumHistory && stagingLearned;
  const authorization = evidence?.verdict.permission ?? lastResult?.outcome.authorization?.result;
  const safety = evidence?.verdict.safety ?? lastResult?.outcome.risk?.result;
  const effect = evidence?.verdict.effect ??
    (lastResult?.outcome.status === "executed" ? "COMPLETED" : lastResult ? "PREVENTED" : undefined);
  const persistedBoundaryRunId =
    evidence?.action.resourceId === BOB_PRIVATE_RESOURCE && evidence.verdict.permission === "DENY"
      ? evidence.run.id
      : null;
  const boundaryRunId = boundaryProof?.foreignRunId ?? persistedBoundaryRunId;
  const boundaryVerified = Boolean(boundaryProof || persistedBoundaryRunId || (extendedDemo && historyReady));
  const safetyStopActive = breaker?.state === "TRIPPED";
  const resultRunId = evidence?.run.id ?? lastResult?.run.id ?? null;
  const impactTargets = evidence?.impactAtDecision.targets.length
    ? evidence.impactAtDecision.targets
    : impact?.targets.map((target) => ({
      id: target.node.id,
      label: target.node.label,
      path: target.path.nodeIds.map((id) => resourceName(id)),
    })) ?? [];
  const impactPath = [...impactTargets]
    .sort((left, right) => right.path.length - left.path.length)[0]?.path ?? [];
  const baselineDetail = historyReady
    ? `Baseline ready · minimum ${minimumHistory} required`
    : stagingLearned
      ? `${Math.max(0, minimumHistory - trustedRunCount)} more trusted staging ${minimumHistory - trustedRunCount === 1 ? "Run" : "Runs"} needed`
      : `Build ${minimumHistory} safe staging Runs to establish normal behavior`;
  const guidance = agent.status === "stopped"
    ? {
        label: "Agent stopped",
        title: "Start the Agent to continue",
        detail: "Use Start in the Agent header. Stopped Agents cannot request protected resource actions.",
        tone: "blocked",
      }
    : safetyStopActive
      ? {
          label: "Recovery required",
          title: "Review the blocked action before continuing",
          detail: "All managed actions are paused. Open the audit timeline, then reset the safety stop only after reviewing why it tripped.",
          tone: "blocked",
        }
      : resetNotice
        ? {
            label: "Recovery complete",
            title: "Safety stop cleared; previous action not approved",
            detail: "New actions can be evaluated again. Repeating the same production request will run every check again and may be blocked again.",
            tone: "complete",
          }
      : !capabilityReady
        ? {
            label: `Next step · 1 of ${extendedDemo ? 4 : 2}`,
            title: "Grant one exact resource permission",
            detail: "This creates Alice-only read access. It does not grant access to Bob's records or any other resource.",
            tone: "next",
          }
        : !boundaryVerified
          ? {
              label: `Next step · 2 of ${extendedDemo ? 4 : 2}`,
              title: "Verify the identity boundary",
              detail: "Run one allowed Alice read and one denied Bob read through the live backend gateway.",
              tone: "next",
            }
          : extendedDemo && !historyReady
            ? {
                label: "Next step · 3 of 4",
                title: "Teach the middleware what normal looks like",
                detail: `Record ${minimumHistory} safe staging updates. Only completed protected Runs enter the trusted baseline.`,
                tone: "next",
              }
            : extendedDemo
              ? {
                  label: "Next step · 4 of 4",
                  title: "Test a broader production change",
                  detail: "The Agent has permission, but the middleware will compare this request with history and downstream impact before any effect.",
                  tone: "next",
                }
              : {
                  label: "Protection verified",
                  title: "The resource boundary worked",
                  detail: "Alice's read completed and Bob's read was denied before the protected adapter ran.",
                  tone: "complete",
                };
  const commonLockReason = agent.status === "stopped"
    ? "Start this Agent from the header first."
    : safetyStopActive
      ? "Locked while the safety stop is active. Review and reset it below."
      : working !== null
        ? "Waiting for the current protected action to finish."
        : null;
  const resultIsHistoricalBlock = safety === "BLOCK" && !safetyStopActive;
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
      ? safetyStopActive
        ? "Action safely prevented"
        : "Previous action was safely prevented"
      : safety === "WARN"
        ? "Waiting for human review"
        : effect === "COMPLETED"
          ? "Action completed safely"
          : "Action evaluated";
  const resultMeaning = authorization === "DENY"
    ? "The Agent lacked exact access. Safety analysis was unnecessary and the adapter was never called."
    : safety === "BLOCK"
      ? "Permission was valid, but trusted history, downstream impact, or the persistent safety stop prevented execution."
      : safety === "WARN"
        ? "The action is paused. It can proceed only through an exact, one-time human approval."
        : effect === "COMPLETED"
          ? "Identity, permission, and safety checks passed, so the protected adapter performed the action."
          : "The middleware evaluated the request without claiming an effect.";
  const rawDecisionExplanation = evidence?.verdict.explanation ?? (lastResult ? decisionCopy(lastResult) : "");
  const conciseDecisionExplanation = authorization === "DENY"
    ? `${agent.name} has no exact permission for ${evidence?.action.resourceLabel ?? "this resource"}. Nothing reached the protected adapter.`
    : safety === "BLOCK" && /already active/i.test(rawDecisionExplanation)
      ? "The persistent safety stop was already active, so this request was rejected immediately without attempting another effect."
      : safety === "BLOCK"
        ? `This request was outside the trusted staging pattern and could reach ${evidence?.impactAtDecision.blastRadius ?? impactTargets.length} ${evidence?.impactAtDecision.blastRadius === 1 ? "resource" : "resources"}. No execution claim was issued.`
        : safety === "WARN"
          ? "The request is unusual enough to require a human decision before execution."
          : effect === "COMPLETED"
            ? "The backend verified identity, exact permission, and safety before recording the protected effect."
            : rawDecisionExplanation;
  const nextActionCopy = authorization === "DENY"
    ? "Use a resource this Agent is allowed to access, or add an exact permission in the Impact map. This denied Run cannot be bypassed."
    : safetyStopActive
      ? "Open the timeline to review the evidence. Reset the safety stop only after review; repeating the same risky request can trip it again."
      : resultIsHistoricalBlock
        ? "The safety stop has been cleared. You may test a new or narrower action; the previous blocked decision remains as evidence."
        : effect === "COMPLETED"
          ? "Continue with the next highlighted step in the guided check."
          : "Follow the highlighted next step above.";

  return (
    <section className="security-demo" aria-labelledby="security-demo-title">
      <header className="security-demo-heading">
        <div>
          <span className="eyebrow">Policy enforcement</span>
          <h3 id="security-demo-title">Protected action center</h3>
          <p>
            {extendedDemo
              ? "Follow the four steps. Every button creates a real backend Run and shows whether the resource actually changed."
              : `Follow the two steps to give ${agent.name} one exact permission and prove that another user's data remains protected.`}
          </p>
        </div>
        <span
          className={`security-stop security-stop-${breaker?.state.toLowerCase() ?? "normal"}`}
          role="status"
          aria-label={`Protection status: ${safetyStopActive ? "safety stop active" : breaker?.state === "WARN" ? "review needed" : "ready"}`}
        >
          {safetyStopActive ? "Safety stop active" : breaker?.state === "WARN" ? "Human review needed" : "Ready to evaluate"}
        </span>
      </header>

      <div className="security-demo-context" aria-label="Active protection context">
        <div>
          <span>Who is acting</span>
          <strong>Alice → {agent.name}</strong>
          <small>Identity comes from the server, never from request text or headers</small>
        </div>
        <div>
          <span>{extendedDemo ? "Trusted behavior" : "Current access"}</span>
          <strong>{extendedDemo ? `${trustedRunCount} trusted ${trustedRunCount === 1 ? "Run" : "Runs"}` : capabilityReady ? "Alice-only read access" : "No resource access yet"}</strong>
          <small>
            {extendedDemo
              ? baselineDetail
              : capabilityReady ? "Bob's records remain outside this permission" : "Complete step 1 to add one exact permission"}
          </small>
        </div>
      </div>

      <div className={`security-guidance security-guidance-${guidance.tone}`} role="status">
        <span>{guidance.label}</span>
        <div><strong>{guidance.title}</strong><p>{guidance.detail}</p></div>
      </div>

      <div className="security-demo-workspace">
        <div className="security-action-panel">
          <div className="security-panel-label"><span>Guided protection check</span><small>Complete the steps in order</small></div>
          <ol className="security-demo-actions" aria-label="Protected action steps">
            <li className={`security-action ${capabilityReady ? "security-action-complete" : !commonLockReason ? "security-action-current" : ""}`} aria-label={`Step 1: Grant exact access, ${capabilityReady ? "complete" : "not complete"}`} aria-current={!capabilityReady && !commonLockReason ? "step" : undefined}>
              <div className="security-step-heading"><span className="security-step-number">{capabilityReady ? "✓" : "1"}</span><div><small>Step 1</small><strong>Grant exact access</strong></div><b>{capabilityReady ? "Complete" : !commonLockReason ? "Do this now" : "Locked"}</b></div>
              <p>Give this Agent read access to Alice's private records only.</p>
              <button
                className="button button-ghost"
                type="button"
                disabled={working !== null || capabilityReady || safetyStopActive || agent.status === "stopped"}
                onClick={() => void configureOwnershipBoundary()}
              >
                {working === "configure" ? "Adding permission…" : capabilityReady ? "Private-record access active" : "Grant private-record access"}
              </button>
              <small className="security-step-help">{capabilityReady ? "One exact CAN_READ capability is stored." : commonLockReason ?? "Ready — this does not grant wildcard access."}</small>
            </li>
            <li className={`security-action ${boundaryVerified ? "security-action-complete" : capabilityReady && !commonLockReason ? "security-action-current" : ""}`} aria-label={`Step 2: Verify identity boundary, ${boundaryVerified ? "complete" : "not complete"}`} aria-current={!boundaryVerified && capabilityReady && !commonLockReason ? "step" : undefined}>
              <div className="security-step-heading"><span className="security-step-number">{boundaryVerified ? "✓" : "2"}</span><div><small>Step 2</small><strong>Verify identity boundary</strong></div><b>{boundaryVerified ? "Complete" : capabilityReady && !commonLockReason ? "Do this now" : "Locked"}</b></div>
              <p>Compare an allowed Alice read with a forged cross-user request for Bob.</p>
              <button
                className="button button-ghost"
                type="button"
                disabled={working !== null || !capabilityReady || boundaryVerified || safetyStopActive || agent.status === "stopped"}
                onClick={() => void proveOwnershipBoundary()}
              >
                {working === "boundary" ? "Checking ownership…" : boundaryVerified ? "Resource boundary verified" : "Verify resource boundary"}
              </button>
              <small className="security-step-help">{boundaryVerified ? "Alice completed; Bob was denied before effect." : commonLockReason ?? (!capabilityReady ? "Complete step 1 first." : "Ready — this sends two protected backend requests.")}</small>
            </li>
            {extendedDemo && (
              <>
                <li className={`security-action ${historyReady ? "security-action-complete" : boundaryVerified && !commonLockReason ? "security-action-current" : ""}`} aria-label={`Step 3: Build trusted baseline, ${historyReady ? "complete" : "not complete"}`} aria-current={!historyReady && boundaryVerified && !commonLockReason ? "step" : undefined}>
                  <div className="security-step-heading"><span className="security-step-number">{historyReady ? "✓" : "3"}</span><div><small>Step 3</small><strong>Build trusted baseline</strong></div><b>{historyReady ? "Complete" : boundaryVerified && !commonLockReason ? "Do this now" : "Locked"}</b></div>
                  <p>Record safe staging work so the middleware has a normal pattern.</p>
                  <button
                    className="button button-ghost"
                    type="button"
                    disabled={working !== null || !boundaryVerified || historyReady || safetyStopActive || agent.status === "stopped"}
                    onClick={() => void establishHistory()}
                  >
                    {working === "history" ? "Recording safe actions…" : historyReady ? "Staging baseline ready" : "Build trusted baseline"}
                  </button>
                  <small className="security-step-help">{historyReady ? `${trustedRunCount} trusted Runs · minimum ${minimumHistory} met.` : commonLockReason ?? (!boundaryVerified ? "Complete step 2 first." : `${minimumHistory} completed staging Runs will be recorded.`)}</small>
                </li>
                <li className={`security-action security-action-emphasis ${historyReady && !commonLockReason ? "security-action-current" : ""}`} aria-label="Step 4: Test production change" aria-current={historyReady && !commonLockReason ? "step" : undefined}>
                  <div className="security-step-heading"><span className="security-step-number">4</span><div><small>Step 4</small><strong>Test a production change</strong></div><b>{historyReady && !commonLockReason ? "Do this now" : safetyStopActive ? "Paused" : "Locked"}</b></div>
                  <p>Try a permitted write that is broader than the trusted staging pattern.</p>
                  <button
                    className="button button-primary"
                    type="button"
                    disabled={working !== null || !historyReady || safetyStopActive || agent.status === "stopped"}
                    onClick={() => void tryUnusualAction()}
                  >
                    {working === "unusual" ? "Evaluating impact…" : "Request production update"}
                  </button>
                  <small className="security-step-help">{commonLockReason ?? (!historyReady ? "Complete step 3 first." : "Ready — permission, behavior, and impact will be evaluated before effect.")}</small>
                </li>
              </>
            )}
          </ol>

          {boundaryRunId && (
            <div className="security-boundary-proof" aria-label="Resource permission boundary">
              <div>
                <span aria-hidden="true">✓</span>
                <p><strong>Alice's private records</strong><small>Read completed through the protected adapter</small></p>
              </div>
              <div>
                <span aria-hidden="true">×</span>
                <p><strong>Bob's private records</strong><small>Permission denied; caller-supplied identity ignored</small></p>
              </div>
              <button type="button" onClick={() => void onOpenRun(boundaryRunId)}>
                Inspect denied Run
              </button>
            </div>
          )}
        </div>

        <div className={`security-demo-result security-demo-result-${resultTone}`} aria-live="polite" aria-busy={working !== null}>
          <div className="security-panel-label"><span>{resultIsHistoricalBlock ? "Previous blocked decision" : "Latest decision"}</span><small>Permission → safety → effect</small></div>
          {resetNotice && <div className="security-reset-notice" role="status"><strong>Safety stop reset</strong><p>{resetNotice}</p></div>}
          {error ? (
            <p className="security-demo-error" role="alert">{error}</p>
          ) : lastResult || evidence ? (
            <>
              <div className="security-result-heading"><span>Action evaluated</span><h4>{actionLabel(evidence, lastResult)}</h4></div>
              <div className={`security-result-summary security-result-summary-${resultTone}`}><strong>{resultTitle}</strong><p>{resultMeaning}</p></div>
              <dl className="security-decision-line">
                <div aria-label="Permission decision"><dt>Permission</dt><dd>{authorization === "ALLOW" ? "Allowed" : "Denied"}</dd></div>
                <div aria-label="Safety decision"><dt>Safety</dt><dd>{safetyLabel(safety)}</dd></div>
                <div aria-label="Resource effect"><dt>Resource</dt><dd>{effectLabel(effect)}</dd></div>
              </dl>
              <p className="security-decision-explanation">{conciseDecisionExplanation}</p>
              {rawDecisionExplanation && rawDecisionExplanation !== conciseDecisionExplanation && (
                <details className="security-policy-details"><summary>See full policy explanation</summary><p>{rawDecisionExplanation}</p></details>
              )}
              {impactTargets.length > 0 && (
                <div className="security-impact-list">
                  <span>Scope evaluated for this action</span>
                  <ul>{impactTargets.map((target) => <li key={target.id}>{target.label}</li>)}</ul>
                  {impactPath.length > 1 && (
                    <ol className="security-impact-path" aria-label="Relevant impact path">
                      {impactPath.map((label, index) => <li key={`${label}:${index}`}>{label}</li>)}
                    </ol>
                  )}
                </div>
              )}
              {evidence && (
                <div className="security-proof-line" aria-label="Persisted decision record">
                  <span>Decision record</span>
                  <strong>{evidence.timeline.eventCount} ordered events</strong>
                  <small>
                    Baseline {evidence.historicalContext ? `revision ${evidence.historicalContext.revision}` : "not used"}
                    {" · "}Impact {evidence.impactAtDecision.blastRadius} resources
                    {" · "}{evidence.effectEvidence.policyClaimed ? "Effect claim issued" : "Effect never claimed"}
                  </small>
                </div>
              )}
              <div className="security-next-action"><strong>What you can do next</strong><p>{nextActionCopy}</p></div>
              <div className="security-result-actions">
                {resultRunId && <button className="button button-ghost" type="button" onClick={() => void onOpenRun(resultRunId)}>
                  Review audit timeline
                </button>}
                {safetyStopActive && (
                  <button className="button button-ghost" type="button" disabled={working !== null} onClick={() => void resetSafetyStop()}>
                    {working === "reset" ? "Resetting…" : "Reset safety stop"}
                  </button>
                )}
              </div>
              {evidence && (
                <details className="security-coverage">
                  <summary>Coverage and limits</summary>
                  <p><strong>{evidence.coverage.label}.</strong> {evidence.coverage.guarantee}</p>
                  <p>{evidence.coverage.limitation}</p>
                </details>
              )}
            </>
          ) : (
            <div className="security-empty-result"><span>Nothing evaluated yet</span><strong>Your first decision will appear here</strong><p>Complete the highlighted step. This panel will then explain the exact action, the decision, and whether the resource changed.</p></div>
          )}
        </div>
      </div>
    </section>
  );
}
