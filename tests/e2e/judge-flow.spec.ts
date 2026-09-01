import { expect, test, type Page, type Response } from "@playwright/test";

const RELEASE_GUARDIAN_ID = "d7b3a871-81e1-4965-9a88-bef875c3bb19";

interface LatestEvidence {
  run: { id: string };
  verdict: {
    permission: "ALLOW" | "DENY";
    safety: "ALLOW" | "WARN" | "BLOCK" | "NOT_EVALUATED";
    effect: "COMPLETED" | "PREVENTED" | "WAITING_FOR_REVIEW" | "FAILED" | "UNKNOWN";
  };
}

async function submitPrompt(page: Page, content: string) {
  let resolveRunResponse!: (response: Response) => void;
  const runResponsePromise = new Promise<Response>((resolve) => {
    resolveRunResponse = resolve;
  });
  const watchRun = (response: Response) => {
    if (
      response.url().endsWith(`/api/agents/${RELEASE_GUARDIAN_ID}/messages`) &&
      response.request().method() === "POST"
    ) {
      resolveRunResponse(response);
    }
  };
  page.on("response", watchRun);
  const responsePromise = page.waitForResponse((response) =>
    response.url().endsWith(`/api/agents/${RELEASE_GUARDIAN_ID}/prompt-requests`) &&
    response.request().method() === "POST",
  );
  const composer = page.getByPlaceholder("Describe what you want the Agent to do…");
  await composer.fill(content);
  await composer.press("Enter");
  const response = await responsePromise;
  expect(response.status()).toBe(200);
  const routed = await response.json() as { kind: string };
  if (routed.kind === "relationship_observation") {
    page.off("response", watchRun);
    return routed;
  }
  const runResponse = await runResponsePromise;
  page.off("response", watchRun);
  expect(runResponse.status()).toBe(202);
  const accepted = await runResponse.json() as { run: { id: string; prompt: string } };
  let run: { id: string; prompt: string; status: string } | null = null;
  await expect.poll(async () => {
    const current = await page.request.get(`/api/runs/${accepted.run.id}`);
    run = (await current.json()).run;
    return run!.status;
  }).toMatch(/^(?:completed|failed|cancelled|awaiting_approval)$/);
  let evidence: LatestEvidence | null = null;
  await expect.poll(async () => {
    const latest = await page.request.get(
      `/api/agents/${RELEASE_GUARDIAN_ID}/safety-evidence/latest`,
    );
    evidence = (await latest.json()).evidence;
    return evidence?.run?.id ?? null;
  }).toBe(accepted.run.id);
  return {
    kind: "agent_run",
    result: {
      run,
      outcome: {
        status: evidence!.verdict.effect === "COMPLETED"
          ? "executed"
          : evidence!.verdict.effect === "WAITING_FOR_REVIEW"
            ? "approval_required"
            : "denied",
        authorization: { result: evidence!.verdict.permission },
        risk: { result: evidence!.verdict.safety },
      },
    },
  };
}

test("a judge can prompt a real Agent, inspect enforcement, and trace graph impact", async ({ page }) => {
  const pageErrors: string[] = [];
  const promptBodies: Array<Record<string, unknown>> = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("request", (request) => {
    if (!request.url().endsWith("/prompt-requests") || request.method() !== "POST") return;
    promptBodies.push(request.postDataJSON() as Record<string, unknown>);
  });

  await page.goto("/");
  await expect(page.getByText("QuantQueens", { exact: true }).first()).toBeVisible();
  await page.locator("aside").getByRole("button", { name: /Release Guardian/ }).click();
  await page.getByRole("tab", { name: "Playground" }).click();

  await expect(page.getByRole("heading", { name: "Ask naturally. Inspect every decision." })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Protected action center" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Run activity" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "View audit trail" }).first()).toBeDisabled();

  const allowedPrompt = "Read Alice's private records.";
  const allowed = await submitPrompt(page, allowedPrompt);
  expect(allowed).toMatchObject({
    kind: "agent_run",
    result: {
      run: { prompt: allowedPrompt },
      outcome: {
        status: "executed",
        authorization: { result: "ALLOW" },
        risk: { result: "ALLOW" },
      },
    },
  });
  await expect(page.getByText(allowedPrompt, { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "Request journey" })).toBeVisible();
  await expect(page.getByLabel("Protected request journey")).toContainText("Gateway completed the effect");
  await expect(page.getByLabel("Permission decision")).toContainText("Allowed");
  await expect(page.getByLabel("Safety decision")).toContainText("Allowed");
  await expect(page.getByLabel("Resource effect")).toContainText("Completed");
  await expect(page.getByText("Action completed through the gateway")).toBeVisible();
  await expect(page.getByText("Effect claim issued")).toBeVisible();
  await page.getByRole("button", { name: "Close run activity" }).click();
  await expect(page.getByRole("heading", { name: "Request journey" })).toHaveCount(0);
  await page.getByRole("button", { name: "Run activity" }).click();
  await expect(page.getByRole("heading", { name: "Request journey" })).toBeVisible();

  const deniedPrompt = "Read Bob's private records.";
  const denied = await submitPrompt(page, deniedPrompt);
  expect(denied).toMatchObject({
    kind: "agent_run",
    result: {
      run: { prompt: deniedPrompt },
      outcome: {
        status: "denied",
        authorization: { result: "DENY" },
      },
    },
  });
  await expect(page.getByText(deniedPrompt, { exact: true }).first()).toBeVisible();
  await expect(page.getByLabel("Permission decision")).toContainText("Denied");
  await expect(page.getByLabel("Safety decision")).toContainText("Not needed");
  await expect(page.getByLabel("Resource effect")).toContainText("Prevented");
  await expect(page.getByText("Access denied before the resource")).toBeVisible();
  await expect(page.getByText("Effect never claimed")).toBeVisible();
  expect(promptBodies.slice(0, 2)).toEqual([
    { content: allowedPrompt },
    { content: deniedPrompt },
  ]);
  for (const body of promptBodies.slice(0, 2)) {
    expect(body).not.toHaveProperty("capability");
    expect(body).not.toHaveProperty("targetNodeId");
    expect(body).not.toHaveProperty("principalId");
  }

  const deniedRunId = denied.result!.run!.id;
  const deniedEvidenceResponse = await page.request.get(
    `/api/agents/${RELEASE_GUARDIAN_ID}/safety-evidence/latest`,
  );
  expect((await deniedEvidenceResponse.json()).evidence).toMatchObject({
    run: { id: deniedRunId },
    verdict: { permission: "DENY", effect: "PREVENTED" },
    effectEvidence: { policyClaimed: false, durableStateChangedByThisAction: false },
  });

  await page.getByRole("button", { name: "View audit trail" }).first().click();
  const deniedTimeline = page.locator(".run-timeline");
  await expect(deniedTimeline.getByRole("heading", { name: "What happened" })).toBeVisible();
  await expect(deniedTimeline).toContainText(/not permitted to read Bob's private records/i);
  const deniedSequences = await deniedTimeline.locator(".run-timeline-sequence").evaluateAll((nodes) =>
    nodes.map((node) => Number(node.textContent)),
  );
  expect(deniedSequences).toEqual([...deniedSequences].sort((left, right) => left - right));
  expect(new Set(deniedSequences).size).toBe(deniedSequences.length);

  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(page.locator(".status")).toContainText("stopped");
  const stoppedAttempt = await page.request.post(
    `/api/agents/${RELEASE_GUARDIAN_ID}/messages`,
    { data: { content: "Update the staging configuration." } },
  );
  expect(stoppedAttempt.status()).toBe(409);
  await page.reload();
  if (!(await page.getByRole("heading", { name: "Release Guardian", level: 1 }).isVisible())) {
    await page.locator("aside").getByRole("button", { name: /Release Guardian/ }).click();
  }
  await expect(page.locator(".status")).toContainText("stopped");
  await page.getByRole("button", { name: "Start", exact: true }).click();
  await expect(page.locator(".status")).toContainText("ready");
  await page.getByRole("tab", { name: "Playground" }).click();

  for (let index = 1; index <= 3; index += 1) {
    const staging = await submitPrompt(
      page,
      `Update the staging configuration to release 2.4.${index}.`,
    );
    expect(staging).toMatchObject({
      kind: "agent_run",
      result: {
        outcome: {
          status: "executed",
          authorization: { result: "ALLOW" },
          risk: { result: "ALLOW" },
        },
      },
    });
  }
  await expect(page.getByText(/trusted Runs form/).first()).toContainText(/[3-9]/);

  const productionPrompt = "Update the production deployment configuration to release 2.5.0.";
  const reviewable = await submitPrompt(page, productionPrompt);
  expect(reviewable).toMatchObject({
    kind: "agent_run",
    result: {
      run: { status: "awaiting_approval" },
      outcome: {
        status: "approval_required",
        authorization: { result: "ALLOW" },
        risk: { result: "WARN" },
      },
    },
  });
  await expect(page.getByLabel("Permission decision")).toContainText("Allowed");
  await expect(page.getByLabel("Safety decision")).toContainText("Needs review");
  await expect(page.getByLabel("Resource effect")).toContainText("Paused");
  await expect(page.getByText("Paused for human review")).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve and continue" })).toBeVisible();
  await expect(page.getByText(/No resource has changed/i)).toBeVisible();
  const impact = page.locator(".security-impact-list");
  await expect(impact).toContainText("Deployment configuration");
  await expect(impact).toContainText("Production service");
  await expect(impact).toContainText("Customer dataset");
  await expect(page.getByLabel("Relevant impact path")).toContainText("Customer dataset");
  await expect(page.getByLabel("Persisted decision record")).toContainText("Impact 5 resources");
  await expect(page.getByLabel("Persisted decision record")).toContainText("Effect never claimed");
  await page.getByText("How the impact map works").click();
  await expect(page.getByText(/Nodes.*are people/i)).toBeVisible();

  await page.getByRole("button", { name: "Approve and continue" }).click();
  await expect(page.getByText("Approved and completed")).toBeVisible();
  await expect(page.getByLabel("Resource effect")).toContainText("Completed");
  await expect(page.getByLabel("Persisted decision record")).toContainText("Effect claim issued");
  await expect(page.getByLabel("Protected request journey")).toContainText("Human review approved");

  await page.getByRole("button", { name: "View audit trail" }).first().click();
  const reviewedTimeline = page.locator(".run-timeline");
  await expect(reviewedTimeline).toContainText(/was allowed to (change|write)/i);
  await expect(reviewedTimeline).toContainText(/approval/i);
  await expect(reviewedTimeline).toContainText(/completed/i);

  await page.reload();
  if (!(await page.getByRole("heading", { name: "Release Guardian", level: 1 }).isVisible())) {
    await page.locator("aside").getByRole("button", { name: /Release Guardian/ }).click();
  }
  await page.getByRole("tab", { name: "Playground" }).click();
  await expect(page.getByLabel("Protection status: ready")).toBeVisible();
  await expect(page.getByText(productionPrompt, { exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: "View audit trail" }).first().click();
  await expect(page.locator(".run-timeline")).toContainText(/completed/i);

  await page.getByRole("button", { name: "Open impact map" }).click();
  await expect(page.getByRole("heading", { name: "Impact map" })).toBeVisible();
  await page.getByRole("button", { name: /Focus path to Customer dataset/ }).click();
  await expect(page.getByText(/Focused because you selected Customer dataset/)).toBeVisible();

  await page.getByRole("tab", { name: "Playground" }).click();
  const relationship = await submitPrompt(
    page,
    "Deployment configuration calls Incident API.",
  );
  expect(relationship.kind).toBe("relationship_observation");
  await expect(page.getByText("New relationship found")).toBeVisible();
  await expect(page.getByText(/remains quarantined until a person confirms it/i)).toBeVisible();
  await page.getByRole("button", { name: "Show in network graph" }).click();
  await expect(page.getByRole("heading", { name: "Network relationships" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Inspect Incident API" })).toBeVisible();
  await expect(page.getByLabel(/pending observations/)).toContainText("1 pending");
  const refreshedNodeLabel = "Refresh verification queue";
  const createNodeResponse = await page.request.post("/api/graph/nodes", {
    data: { type: "asset", label: refreshedNodeLabel, classification: "internal" },
  });
  expect(createNodeResponse.status()).toBe(201);
  await page.getByRole("button", { name: "Refresh network" }).click();
  await expect(page.getByRole("button", { name: `Inspect ${refreshedNodeLabel}` })).toBeVisible();
  await expect(page.getByRole("status")).toContainText("Updated");
  expect(pageErrors).toEqual([]);
});

test("a newly created Agent grows quarantined graph context from its model output", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto("/");

  const createdResponsePromise = page.waitForResponse((response) =>
    response.url().endsWith("/api/agents") && response.request().method() === "POST",
  );
  await page.getByRole("button", { name: /Create Agent/ }).first().click();
  const createForm = page.locator("form.modal");
  await createForm.getByLabel("Name").fill("Dependency Scout");
  await createForm.getByLabel("Description").fill("Maps service dependencies from Agent work");
  await createForm.getByLabel("Instructions").fill("Describe technical relationships precisely. Never infer permission from topology.");
  await createForm.getByRole("button", { name: "Create Agent" }).click();
  const createdResponse = await createdResponsePromise;
  expect(createdResponse.status()).toBe(201);
  const agent = (await createdResponse.json()).agent as { id: string };

  await expect(page.getByRole("heading", { name: "Dependency Scout", level: 1 })).toBeVisible();
  const emptyImpactMap = page.locator("svg.knowledge-graph");
  await expect(emptyImpactMap.getByRole("button", { name: "Select Dependency Scout" })).toBeVisible();
  await expect(emptyImpactMap.getByRole("button", { name: /Alice/ })).toHaveCount(0);
  await page.getByRole("tab", { name: "Playground" }).click();
  const prompt = "Map these dependencies in two plain sentences: Checkout API -> Fraud Service -> Customer records. Use the verbs calls and processes.";
  const acceptedResponsePromise = page.waitForResponse((response) =>
    response.url().endsWith(`/api/agents/${agent.id}/messages`) &&
    response.request().method() === "POST",
  );
  const composer = page.getByPlaceholder("Describe what you want the Agent to do…");
  await composer.fill(prompt);
  await composer.press("Enter");
  const acceptedResponse = await acceptedResponsePromise;
  expect(acceptedResponse.status()).toBe(202);
  const run = (await acceptedResponse.json()).run as { id: string };

  await expect.poll(async () => {
    const response = await page.request.get(`/api/runs/${run.id}`);
    return (await response.json()).run.status;
  }).toBe("completed");
  await expect(page.getByText("New relationships found")).toBeVisible();
  await expect(page.getByText(/2 relationships extracted from the Agent's response/i)).toBeVisible();

  const observationsResponse = await page.request.get(`/api/agents/${agent.id}/observations`);
  const observations = (await observationsResponse.json()).observations as Array<{
    runId?: string;
    sourceKind: string;
    state: string;
    relation: string;
  }>;
  expect(observations).toEqual(expect.arrayContaining([
    expect.objectContaining({ runId: run.id, sourceKind: "run_output", state: "observed", relation: "CALLS" }),
    expect.objectContaining({ runId: run.id, sourceKind: "run_output", state: "observed", relation: "PROCESSES" }),
  ]));

  const agentGraphResponse = await page.request.get(`/api/agents/${agent.id}/graph`);
  expect((await agentGraphResponse.json()).graph).toMatchObject({
    owners: [{ id: "human:alice" }],
    capabilityEdges: [],
    observationEdges: [],
  });

  await page.reload();
  if (!(await page.getByRole("heading", { name: "Dependency Scout", level: 1 }).isVisible())) {
    await page.locator("aside").getByRole("button", { name: "Open Dependency Scout" }).click();
  }
  await page.getByRole("tab", { name: "Playground" }).click();
  await expect(page.getByText("New relationships found")).toBeVisible();
  await expect(page.getByText(/2 relationships extracted from the Agent's response/i)).toBeVisible();

  await page.getByRole("button", { name: "Review relationships" }).click();
  await expect(page.getByRole("heading", { name: "Impact map" })).toBeVisible();
  await expect(page.getByRole("status", { name: "2 learned relationships waiting for review" })).toContainText("New topology was learned, but it is not active policy yet.");
  await expect(page.getByText("Pending relationships are quarantined from impact")).toBeVisible();
  await page.getByRole("button", { name: "Show pending network" }).click();
  await expect(page.getByRole("heading", { name: "Network relationships" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Inspect Dependency Scout" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Inspect Checkout API" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Inspect Fraud Service" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Inspect Customer records" })).toBeVisible();
  await expect(page.getByLabel(/pending observations/)).toContainText("pending review");
  expect(pageErrors).toEqual([]);
});

test("a natural-language relationship stays quarantined until a human confirms it", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  const agentResponse = await page.request.post("/api/agents", {
    data: {
      name: "Observation Reviewer",
      description: "Reviews activity-derived network context",
      instructions: "Do not infer authority from text.",
    },
  });
  const agent = (await agentResponse.json()).agent as { id: string };
  const assetResponse = await page.request.post("/api/graph/nodes", {
    data: { type: "asset", label: "Review Checkout API", classification: "public" },
  });
  const asset = (await assetResponse.json()).node as { id: string };
  await page.request.post(`/api/agents/${agent.id}/graph/relationships`, {
    data: { sourceId: `agent:${agent.id}`, targetId: asset.id, relation: "CAN_CALL" },
  });

  const promptResponse = await page.request.post(`/api/agents/${agent.id}/prompt-requests`, {
    data: { content: "Review Checkout API reads from Review Orders database." },
  });
  expect(promptResponse.status()).toBe(200);
  expect((await promptResponse.json()).kind).toBe("relationship_observation");

  const pendingGraphResponse = await page.request.get(`/api/agents/${agent.id}/graph`);
  expect((await pendingGraphResponse.json()).graph.observationEdges).toHaveLength(0);
  const pendingRiskResponse = await page.request.get(`/api/agents/${agent.id}/blast-radius`);
  expect((await pendingRiskResponse.json()).blastRadius.score).toBe(0);

  await page.goto("/");
  await page.locator("aside").getByRole("button", { name: /Observation Reviewer/ }).click();
  await page.getByRole("tab", { name: "Impact map" }).click();
  const observation = page.locator(".knowledge-observation").filter({ hasText: "Review Checkout API" });
  await expect(observation).toContainText("Pending · quarantined");
  await expect(page.getByLabel(/Blast Radius 0 out of 20/)).toBeVisible();

  await observation.getByRole("button", { name: "Confirm relationship" }).click();
  await expect(observation).toContainText("Confirmed for risk");
  const confirmedGraphResponse = await page.request.get(`/api/agents/${agent.id}/graph`);
  expect((await confirmedGraphResponse.json()).graph.observationEdges).toHaveLength(1);
  const confirmedRiskResponse = await page.request.get(`/api/agents/${agent.id}/blast-radius`);
  expect((await confirmedRiskResponse.json()).blastRadius.score).toBeGreaterThan(0);

  await observation.getByRole("button", { name: "Reject" }).click();
  await expect(observation).toHaveCount(0);
  const rejectedRiskResponse = await page.request.get(`/api/agents/${agent.id}/blast-radius`);
  expect((await rejectedRiskResponse.json()).blastRadius.score).toBe(0);
  expect(pageErrors).toEqual([]);
});

test("prompt, audit, impact, and network surfaces fit a narrow viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.locator("aside").getByRole("button", { name: /Open Release Guardian/ }).click();

  const expectNoHorizontalOverflow = async () => {
    const dimensions = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
    }));
    expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth);
  };

  await page.getByRole("tab", { name: "Playground" }).click();
  await expect(page.getByRole("heading", { name: "Ask naturally. Inspect every decision." })).toBeVisible();
  await expect(page.getByRole("button", { name: /^(Run activity|Hide run activity)$/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /audit trail/i }).first()).toBeVisible();
  await submitPrompt(page, "Read Alice's private records.");
  await expect(page.getByRole("heading", { name: "Request journey" })).toBeVisible();
  await expectNoHorizontalOverflow();

  await page.getByRole("tab", { name: "Impact map" }).click();
  await expect(page.getByRole("heading", { name: "Impact map" })).toBeVisible();
  await expectNoHorizontalOverflow();

  await page.getByRole("tab", { name: "Network graph" }).click();
  await expect(page.getByRole("heading", { name: "Network relationships" })).toBeVisible();
  await expectNoHorizontalOverflow();
});
