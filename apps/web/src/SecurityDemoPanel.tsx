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
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setWorking(null);
    }
  };

  const stagingLearned = baseline?.normalScope.some(
    (scope) => scope.capability === "CAN_WRITE" && scope.targetNodeId === STAGING_RESOURCE,
  ) ?? false;
  const historyReady =
    (baseline?.eligibleRunCount ?? 0) >= (baseline?.minimumHistory ?? 3) && stagingLearned;
  const authorization = evidence?.verdict.permission ?? lastResult?.outcome.authorization?.result;
  const safety = evidence?.verdict.safety ?? lastResult?.outcome.risk?.result;
  const effect = evidence?.verdict.effect ??
    (lastResult?.outcome.status === "executed" ? "COMPLETED" : lastResult ? "PREVENTED" : undefined);
  const impactTargets = evidence?.impactAtDecision.targets.length
    ? evidence.impactAtDecision.targets
    : impact?.targets.map((target) => ({
      id: target.node.id,
      label: target.node.label,
      path: target.path.nodeIds.map((id) => resourceName(id)),
    })) ?? [];
  const impactPath = [...impactTargets]
    .sort((left, right) => right.path.length - left.path.length)[0]?.path ?? [];

  return (
    <section className="security-demo" aria-labelledby="security-demo-title">
      <header className="security-demo-heading">
        <div>
          <span className="eyebrow">Policy enforcement</span>
          <h3 id="security-demo-title">Protected action center</h3>
          <p>
            {extendedDemo
              ? "Access, trusted behavior, and downstream impact are evaluated before a managed resource can change."
              : `Configure ${agent.name}'s exact access, then verify that authenticated ownership still protects another user's data.`}
          </p>
        </div>
        <span
          className={`security-stop security-stop-${breaker?.state.toLowerCase() ?? "normal"}`}
          role="status"
          aria-label={`Protection status: ${breaker?.state === "TRIPPED" ? "action blocked" : breaker?.state === "WARN" ? "review needed" : "ready"}`}
        >
          {breaker?.state === "TRIPPED" ? "Action blocked" : breaker?.state === "WARN" ? "Review needed" : "Protection ready"}
        </span>
      </header>

      <div className="security-demo-context" aria-label="Active protection context">
        <div>
          <span>Authenticated path</span>
          <strong>Alice → {agent.name}</strong>
          <small>{capabilityReady ? "One exact Alice-data permission is active" : "No resource permission has been granted yet"}</small>
        </div>
        <div>
          <span>{extendedDemo ? "Behavior baseline" : "Resource boundary"}</span>
          <strong>{extendedDemo ? `${baseline?.eligibleRunCount ?? 0} trusted Runs` : "Alice only"}</strong>
          <small>
            {extendedDemo
              ? (historyReady ? "A staging pattern is ready for comparison" : `Needs ${baseline?.minimumHistory ?? 3} normal staging Runs`)
              : "Changing a claimed user ID cannot grant Bob's access"}
          </small>
        </div>
      </div>

      <div className="security-demo-workspace">
        <div className="security-action-panel">
          <div className="security-panel-label"><span>Managed controls</span><small>Each control calls the live policy and resource path.</small></div>
          <div className="security-demo-actions" aria-label="Protected action controls">
            <div className="security-action">
              <span>Access</span>
              <button
                className="button button-ghost"
                type="button"
                disabled={working !== null || capabilityReady || breaker?.state === "TRIPPED" || agent.status === "stopped"}
                onClick={() => void configureOwnershipBoundary()}
              >
                {working === "configure" ? "Adding permission…" : capabilityReady ? "Private-record access active" : "Grant private-record access"}
              </button>
              <small>Store one exact Alice-only read capability.</small>
            </div>
            <div className="security-action">
              <span>Identity</span>
              <button
                className="button button-ghost"
                type="button"
                disabled={working !== null || !capabilityReady || breaker?.state === "TRIPPED" || agent.status === "stopped"}
                onClick={() => void proveOwnershipBoundary()}
              >
                {working === "boundary" ? "Checking ownership…" : boundaryProof ? "Resource boundary verified" : "Verify resource boundary"}
              </button>
              <small>Compare an owned read with a cross-user attempt.</small>
            </div>
            {extendedDemo && (
              <>
                <div className="security-action">
                  <span>Behavior</span>
                  <button
                    className="button button-ghost"
                    type="button"
                    disabled={working !== null || !boundaryProof || historyReady || breaker?.state === "TRIPPED" || agent.status === "stopped"}
                    onClick={() => void establishHistory()}
                  >
                    {working === "history" ? "Recording safe actions…" : historyReady ? "Staging baseline ready" : "Build trusted baseline"}
                  </button>
                  <small>Record successful staging work as normal scope.</small>
                </div>
                <div className="security-action security-action-emphasis">
                  <span>Production</span>
                  <button
                    className="button button-primary"
                    type="button"
                    disabled={working !== null || !historyReady || breaker?.state === "TRIPPED" || agent.status === "stopped"}
                    onClick={() => void tryUnusualAction()}
                  >
                    {working === "unusual" ? "Evaluating impact…" : "Request production update"}
                  </button>
                  <small>Evaluate a broader change before any effect.</small>
                </div>
              </>
            )}
          </div>

          {boundaryProof && (
            <div className="security-boundary-proof" aria-label="Resource permission boundary">
              <div>
                <span aria-hidden="true">✓</span>
                <p><strong>Alice's private records</strong><small>Read completed through the protected adapter</small></p>
              </div>
              <div>
                <span aria-hidden="true">×</span>
                <p><strong>Bob's private records</strong><small>Permission denied; caller-supplied identity ignored</small></p>
              </div>
              <button type="button" onClick={() => void onOpenRun(boundaryProof.foreignRunId)}>
                Inspect denied Run
              </button>
            </div>
          )}
        </div>

        <div className="security-demo-result" aria-live="polite" aria-busy={working !== null}>
          <div className="security-panel-label"><span>Latest decision</span><small>Permission → safety → effect</small></div>
          {error ? (
            <p className="security-demo-error" role="alert">{error}</p>
          ) : lastResult || evidence ? (
            <>
              <dl className="security-decision-line">
                <div aria-label="Permission decision"><dt>Permission</dt><dd>{authorization === "ALLOW" ? "Allowed" : "Denied"}</dd></div>
                <div aria-label="Safety decision"><dt>Safety</dt><dd>{safetyLabel(safety)}</dd></div>
                <div aria-label="Resource effect"><dt>Resource</dt><dd>{effectLabel(effect)}</dd></div>
              </dl>
              <p>{evidence?.verdict.explanation ?? (lastResult ? decisionCopy(lastResult) : "")}</p>
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
              <div className="security-result-actions">
                <button className="button button-ghost" type="button" onClick={() => void onOpenRun(evidence?.run.id ?? lastResult!.run.id)}>
                  Open audit timeline
                </button>
                {breaker?.state === "TRIPPED" && (
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
            <div className="security-empty-result"><strong>No decision yet</strong><p>Start with an exact private-record permission. Every managed action will show its access verdict, safety verdict, and real resource effect here.</p></div>
          )}
        </div>
      </div>
    </section>
  );
}
