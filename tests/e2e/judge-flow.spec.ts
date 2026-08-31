import { expect, test } from "@playwright/test";

test("a judge can verify identity, graph safety, real effect prevention, and persisted evidence", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const managedStatuses: number[] = [];
  const managedBodies: Array<Record<string, unknown>> = [];
  page.on("request", (request) => {
    if (!request.url().includes("/managed-actions") || request.method() !== "POST") return;
    managedBodies.push(request.postDataJSON() as Record<string, unknown>);
  });
  page.on("response", (response) => {
    if (response.url().includes("/managed-actions") && response.request().method() === "POST") {
      managedStatuses.push(response.status());
    }
  });

  await page.goto("/");
  await expect(page.getByText("QuantQueens", { exact: true }).first()).toBeVisible();

  // Required Track B demo: the user creates the exact Agent used for both the
  // allowed Alice read and the denied Bob read. This is not a seeded fixture.
  await page.locator("aside").getByRole("button", { name: /Create Agent/ }).click();
  const createForm = page.locator("form.modal");
  await expect(createForm.getByRole("heading", { name: "Create an Agent" })).toBeVisible();
  await createForm.getByLabel("Name").fill("Alice Boundary Judge");
  await createForm.getByLabel("Description").fill("Created live for the official Track B proof");
  await createForm.getByLabel("Instructions").fill("Use only explicitly granted resources.");
  const createdResponsePromise = page.waitForResponse((response) =>
    response.url().endsWith("/api/agents") &&
    response.request().method() === "POST" &&
    response.status() === 201);
  await createForm.getByRole("button", { name: "Create Agent", exact: true }).click();
  const createdResponse = await createdResponsePromise;
  const createdAgent = (await createdResponse.json()).agent as { id: string; name: string };
  await expect(page.getByRole("heading", { name: createdAgent.name, level: 1 })).toBeVisible();

  await page.getByRole("tab", { name: "Playground" }).click();

  await expect(page.getByText("Protected actions are available")).toBeVisible();
  await expect(page.getByText(/Managed resource controls still use the live middleware path/)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Review and control resource actions" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Protected action center" })).toBeVisible();
  await expect(page.getByText(/Configure Alice Boundary Judge's exact access/)).toBeVisible();

  const grantButton = page.getByRole("button", { name: "Grant private-record access" });
  const boundaryButton = page.getByRole("button", { name: "Verify resource boundary" });
  await expect(boundaryButton).toBeDisabled();
  await page.keyboard.press("Tab");
  await expect(grantButton).toBeFocused();
  const focusOutline = await grantButton.evaluate((element) => {
    const style = window.getComputedStyle(element);
    return { style: style.outlineStyle, width: Number.parseFloat(style.outlineWidth) };
  });
  expect(focusOutline.style).not.toBe("none");
  expect(focusOutline.width).toBeGreaterThanOrEqual(2);

  const grantResponsePromise = page.waitForResponse((response) =>
    response.url().includes(`/api/agents/${createdAgent.id}/graph/relationships`) &&
    response.request().method() === "POST");
  await grantButton.click();
  expect((await grantResponsePromise).status()).toBe(201);
  await expect(page.getByRole("button", { name: "Private-record access active" })).toBeDisabled();
  await expect(boundaryButton).toBeEnabled();

  const createdGraphResponse = await page.request.get(`/api/agents/${createdAgent.id}/graph`);
  expect(createdGraphResponse.status()).toBe(200);
  const createdGraph = (await createdGraphResponse.json()).graph as {
    owners: Array<{ id: string }>;
    capabilityEdges: Array<{ sourceId: string; targetId: string; relation: string }>;
  };
  expect(createdGraph.owners).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: "human:alice" }),
  ]));
  expect(createdGraph.capabilityEdges).toEqual(expect.arrayContaining([
    expect.objectContaining({
      sourceId: `agent:${createdAgent.id}`,
      targetId: "asset:alice-private-records",
      relation: "CAN_READ",
    }),
  ]));

  const createdOwnedResponsePromise = page.waitForResponse((response) =>
    response.url().includes(`/api/agents/${createdAgent.id}/managed-actions`) &&
    response.request().method() === "POST" && response.status() === 200);
  const createdDeniedResponsePromise = page.waitForResponse((response) =>
    response.url().includes(`/api/agents/${createdAgent.id}/managed-actions`) &&
    response.request().method() === "POST" && response.status() === 403);
  await boundaryButton.click();
  const createdOwnedBody = await (await createdOwnedResponsePromise).json() as {
    run: { id: string };
  };
  const createdDeniedBody = await (await createdDeniedResponsePromise).json() as {
    run: { id: string };
  };
  const boundaryProof = page.getByLabel("Resource permission boundary");
  await expect(boundaryProof).toContainText("Alice's private records");
  await expect(boundaryProof).toContainText("Read completed through the protected adapter");
  await expect(boundaryProof).toContainText("Bob's private records");
  await expect(boundaryProof).toContainText("Permission denied; caller-supplied identity ignored");
  await expect(page.getByLabel("Permission decision")).toContainText("Denied");
  await expect(page.getByLabel("Safety decision")).toContainText("Not needed");
  await expect(page.getByLabel("Resource effect")).toContainText("Prevented");
  expect(managedStatuses.slice(0, 2)).toEqual([200, 403]);
  expect(managedBodies[0]).toMatchObject({
    capability: "CAN_READ",
    targetNodeId: "asset:alice-private-records",
  });
  expect(managedBodies[1]).toMatchObject({
    capability: "CAN_READ",
    targetNodeId: "asset:bob-private-records",
    claimedPrincipalId: "human:bob",
  });

  const createdOwnedEventsResponse = await page.request.get(
    `/api/runs/${createdOwnedBody.run.id}/events`,
  );
  const createdOwnedEvents = (await createdOwnedEventsResponse.json()).events as Array<{
    type: string;
    actor: { principalId: string; agentId?: string; originPrincipalId?: string };
  }>;
  expect(createdOwnedEvents.find((event) => event.type === "ACTION_COMPLETED")?.actor).toMatchObject({
    principalId: `agent:${createdAgent.id}`,
    agentId: createdAgent.id,
    originPrincipalId: "human:alice",
  });
  const deniedEvidenceResponse = await page.request.get(
    `/api/agents/${createdAgent.id}/safety-evidence/latest`,
  );
  expect((await deniedEvidenceResponse.json()).evidence).toMatchObject({
    run: { id: createdDeniedBody.run.id },
    verdict: { permission: "DENY", effect: "PREVENTED" },
    effectEvidence: { policyClaimed: false },
  });

  await boundaryProof.getByRole("button", { name: "Inspect denied Run" }).click();
  const deniedTimeline = page.locator(".run-timeline");
  await expect(deniedTimeline.getByRole("heading", { name: "What happened" })).toBeVisible();
  await expect(page.getByText(/was not permitted to read Bob's private records/i)).toBeVisible();
  const deniedTimelineLayout = await deniedTimeline.evaluate((element) => {
    const messages = element.closest(".messages");
    const composer = document.querySelector(".composer");
    if (!messages || !composer) throw new Error("Expected the timeline, messages, and composer layout");
    const timelineRect = element.getBoundingClientRect();
    const messagesRect = messages.getBoundingClientRect();
    const composerRect = composer.getBoundingClientRect();
    return {
      timelineBottom: timelineRect.bottom,
      messagesBottom: messagesRect.bottom,
      composerTop: composerRect.top,
      messagesClientHeight: messages.clientHeight,
      messagesScrollHeight: messages.scrollHeight,
    };
  });
  expect(deniedTimelineLayout.timelineBottom).toBeLessThanOrEqual(
    deniedTimelineLayout.messagesBottom + 1,
  );
  expect(deniedTimelineLayout.messagesBottom).toBeLessThanOrEqual(
    deniedTimelineLayout.composerTop + 1,
  );
  expect(deniedTimelineLayout.messagesScrollHeight).toBeLessThanOrEqual(
    deniedTimelineLayout.messagesClientHeight + 1,
  );

  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(page.locator(".status")).toContainText("stopped");
  const stoppedAttempt = await page.request.post(
    `/api/agents/${createdAgent.id}/managed-actions`,
    { data: { capability: "CAN_READ", targetNodeId: "asset:alice-private-records" } },
  );
  expect(stoppedAttempt.status()).toBe(409);

  await page.reload();
  await expect(page.getByRole("heading", { name: createdAgent.name, level: 1 })).toBeVisible();
  await expect(page.locator(".status")).toContainText("stopped");
  const persistedGraphResponse = await page.request.get(`/api/agents/${createdAgent.id}/graph`);
  expect(((await persistedGraphResponse.json()).graph.capabilityEdges as Array<{ targetId: string }>))
    .toEqual(expect.arrayContaining([
      expect.objectContaining({ targetId: "asset:alice-private-records" }),
    ]));

  // Continue into the richer graph/history/breaker extension on the seeded
  // Agent only after the official creation/ownership proof has passed.
  const releaseGuardian = page.getByRole("button", { name: /Release Guardian/ });
  await releaseGuardian.click();
  await expect(page.getByRole("heading", { name: "Release Guardian", level: 1 })).toBeVisible();
  await page.getByRole("tab", { name: "Playground" }).click();
  await expect(page.getByRole("button", { name: "Private-record access active" })).toBeDisabled();
  const seededBoundaryButton = page.getByRole("button", { name: "Verify resource boundary" });
  await seededBoundaryButton.click();
  await expect(page.getByRole("button", { name: "Build trusted baseline" })).toBeEnabled();
  expect(managedStatuses.slice(2, 4)).toEqual([200, 403]);

  await page.getByRole("button", { name: "Build trusted baseline" }).click();
  await expect(page.getByRole("button", { name: "Staging baseline ready" })).toBeDisabled();
  await expect(page.getByLabel("Permission decision")).toContainText("Allowed");
  await expect(page.getByLabel("Safety decision")).toContainText("Allowed");
  await expect(page.getByLabel("Resource effect")).toContainText("Completed");
  await expect(page.getByText("A staging pattern is ready for comparison")).toBeVisible();

  await page.getByRole("button", { name: "Request production update" }).click();
  await expect(page.getByLabel("Permission decision")).toContainText("Allowed");
  await expect(page.getByLabel("Safety decision")).toContainText("Blocked");
  await expect(page.getByLabel("Resource effect")).toContainText("Prevented");
  await expect(page.getByLabel("Protection status: action blocked")).toBeVisible();
  const impact = page.locator(".security-impact-list");
  await expect(impact).toContainText("Deployment configuration");
  await expect(impact).toContainText("Production service");
  await expect(impact).toContainText("Customer dataset");
  await expect(page.getByLabel("Relevant impact path")).toContainText("Customer dataset");
  await expect(page.getByLabel("Persisted decision record")).toContainText("Effect never claimed");

  await page.getByRole("button", { name: "Open audit timeline" }).click();
  const timeline = page.locator(".run-timeline");
  await expect(timeline).toContainText(/was allowed to (change|write)/i);
  await expect(timeline).toContainText(/safety check blocked/i);
  await expect(timeline).toContainText(/blocked before anything changed/i);

  const beforeReload = await timeline.locator(".run-timeline-sequence").evaluateAll((nodes) =>
    nodes.map((node) => Number(node.textContent)),
  );
  expect(beforeReload.length).toBeGreaterThanOrEqual(8);
  expect(beforeReload).toEqual([...beforeReload].sort((left, right) => left - right));
  expect(new Set(beforeReload).size).toBe(beforeReload.length);

  await page.reload();
  if (!(await page.getByRole("heading", { name: "Release Guardian", level: 1 }).isVisible())) {
    await releaseGuardian.click();
  }
  await page.getByRole("tab", { name: "Playground" }).click();
  await expect(page.getByLabel("Protection status: action blocked")).toBeVisible();
  await expect(page.getByLabel("Safety decision")).toContainText("Blocked");
  await expect(page.getByLabel("Resource effect")).toContainText("Prevented");
  await expect(page.getByRole("heading", { name: "What happened" })).toBeVisible();
  const afterReload = await page.locator(".run-timeline-sequence").evaluateAll((nodes) =>
    nodes.map((node) => Number(node.textContent)),
  );
  expect(afterReload).toEqual(beforeReload);

  await page.getByRole("tab", { name: "Impact map" }).click();
  await expect(page.getByRole("heading", { name: "Impact map" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Select Customer dataset/ })).toBeVisible();
  await page.getByRole("button", { name: /Focus path to Customer dataset/ }).click();
  await expect(page.getByText(/Focused because you selected Customer dataset/)).toBeVisible();

  // The shared Network Graph must fetch the latest server state on demand,
  // rather than leaving the user with the first response rendered on mount.
  await page.getByRole("tab", { name: "Network graph" }).click();
  await expect(page.getByRole("heading", { name: "Network relationships" })).toBeVisible();
  const refreshedNodeLabel = "Refresh verification queue";
  await expect(page.getByRole("button", { name: `Inspect ${refreshedNodeLabel}` })).toHaveCount(0);
  const createNodeResponse = await page.request.post("/api/graph/nodes", {
    data: { type: "asset", label: refreshedNodeLabel, classification: "internal" },
  });
  expect(createNodeResponse.status()).toBe(201);
  const refreshResponsePromise = page.waitForResponse((response) =>
    response.url().endsWith("/api/graph") && response.request().method() === "GET");
  await page.getByRole("button", { name: "Refresh network" }).click();
  const refreshResponse = await refreshResponsePromise;
  expect(refreshResponse.status()).toBe(200);
  expect(await refreshResponse.request().headerValue("cache-control")).toBe("no-cache");
  await expect(page.getByRole("button", { name: `Inspect ${refreshedNodeLabel}` })).toBeVisible();
  await expect(page.getByRole("status")).toContainText("Updated");
  expect(pageErrors).toEqual([]);
});

test("activity-derived relationships stay quarantined until a human confirms them", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  const agentResponse = await page.request.post("/api/agents", {
    data: {
      name: "Observation Reviewer",
      description: "Reviews activity-derived network context",
      instructions: "Do not infer authority from text.",
    },
  });
  expect(agentResponse.status()).toBe(201);
  const agent = (await agentResponse.json()).agent as { id: string };

  const assetResponse = await page.request.post("/api/graph/nodes", {
    data: { type: "asset", label: "Checkout API", classification: "public" },
  });
  expect(assetResponse.status()).toBe(201);
  const asset = (await assetResponse.json()).node as { id: string };
  const permissionResponse = await page.request.post(
    `/api/agents/${agent.id}/graph/relationships`,
    { data: { sourceId: `agent:${agent.id}`, targetId: asset.id, relation: "CAN_CALL" } },
  );
  expect(permissionResponse.status()).toBe(201);

  const messageResponse = await page.request.post(`/api/agents/${agent.id}/messages`, {
    data: { content: "Checkout API reads from Orders database." },
  });
  expect(messageResponse.status()).toBe(202);

  await expect.poll(async () => {
    const response = await page.request.get(`/api/agents/${agent.id}/observations`);
    return ((await response.json()).observations as unknown[]).length;
  }).toBe(1);

  const pendingGraphResponse = await page.request.get(`/api/agents/${agent.id}/graph`);
  expect((await pendingGraphResponse.json()).graph.observationEdges).toHaveLength(0);
  const pendingRiskResponse = await page.request.get(`/api/agents/${agent.id}/blast-radius`);
  expect((await pendingRiskResponse.json()).blastRadius.score).toBe(0);

  await page.goto("/");
  await page.locator("aside").getByRole("button", { name: /Observation Reviewer/ }).click();
  await page.getByRole("tab", { name: "Impact map" }).click();
  await expect(page.getByRole("heading", { name: "Relationship observations" })).toBeVisible();
  const observation = page.locator(".knowledge-observation").filter({ hasText: "Checkout API" });
  await expect(observation).toContainText("Pending · quarantined");
  await expect(page.getByLabel(/Blast Radius 0 out of 20/)).toBeVisible();

  const confirmResponsePromise = page.waitForResponse((response) =>
    response.url().includes(`/api/agents/${agent.id}/observations/`) &&
    response.url().endsWith("/confirm") && response.request().method() === "POST");
  await observation.getByRole("button", { name: "Confirm relationship" }).click();
  expect((await confirmResponsePromise).status()).toBe(200);
  await expect(observation).toContainText("Confirmed for risk");

  const confirmedGraphResponse = await page.request.get(`/api/agents/${agent.id}/graph`);
  expect((await confirmedGraphResponse.json()).graph.observationEdges).toHaveLength(1);
  const confirmedRiskResponse = await page.request.get(`/api/agents/${agent.id}/blast-radius`);
  expect((await confirmedRiskResponse.json()).blastRadius.score).toBeGreaterThan(0);

  const rejectResponsePromise = page.waitForResponse((response) =>
    response.url().includes(`/api/agents/${agent.id}/observations/`) &&
    response.url().endsWith("/reject") && response.request().method() === "POST");
  await observation.getByRole("button", { name: "Reject" }).click();
  expect((await rejectResponsePromise).status()).toBe(200);
  await expect(observation).toHaveCount(0);
  const rejectedRiskResponse = await page.request.get(`/api/agents/${agent.id}/blast-radius`);
  expect((await rejectedRiskResponse.json()).blastRadius.score).toBe(0);
  expect(pageErrors).toEqual([]);
});

test("final operator surfaces remain aligned at a narrow viewport", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
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
  await expect(page.getByRole("heading", { name: "Protected action center" })).toBeVisible();
  await expect(page.locator(".security-action")).toHaveCount(4);
  await expectNoHorizontalOverflow();

  await page.getByRole("tab", { name: "Impact map" }).click();
  await expect(page.getByRole("heading", { name: "Impact map" })).toBeVisible();
  await expectNoHorizontalOverflow();

  await page.getByRole("tab", { name: "Network graph" }).click();
  await expect(page.getByRole("heading", { name: "Network relationships" })).toBeVisible();
  await expectNoHorizontalOverflow();
  expect(pageErrors).toEqual([]);
});
