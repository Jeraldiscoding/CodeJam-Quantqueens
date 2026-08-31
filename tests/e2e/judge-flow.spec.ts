import { expect, test } from "@playwright/test";

test("a judge can verify identity, graph safety, real effect prevention, and persisted evidence", async ({ page }) => {
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

  await expect(page.getByText("Guided safety proof is ready")).toBeVisible();
  await expect(page.getByText(/Protected actions below use the real middleware path now/)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Verify a protected Agent action" })).toBeVisible();
  await expect(page.getByText("Track B · The Bouncer")).toBeVisible();
  await expect(page.getByText(/Alice created Alice Boundary Judge/)).toBeVisible();

  const grantButton = page.getByRole("button", { name: "1. Grant Alice-only read" });
  const boundaryButton = page.getByRole("button", { name: "2. Prove Alice/Bob boundary" });
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
  await expect(page.getByRole("button", { name: "1. Alice-only permission ready" })).toBeDisabled();
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
  const boundaryProof = page.getByLabel("Track B permission boundary proof");
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
  await expect(page.getByRole("heading", { name: "What happened" })).toBeVisible();
  await expect(page.getByText(/was not permitted to read Bob's private records/i)).toBeVisible();

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
  await expect(page.getByRole("button", { name: "1. Alice-only permission ready" })).toBeDisabled();
  const seededBoundaryButton = page.getByRole("button", { name: "2. Prove Alice/Bob boundary" });
  await seededBoundaryButton.click();
  await expect(page.getByRole("button", { name: "3. Teach normal staging work" })).toBeEnabled();
  expect(managedStatuses.slice(2, 4)).toEqual([200, 403]);

  await page.getByRole("button", { name: "3. Teach normal staging work" }).click();
  await expect(page.getByRole("button", { name: "3. Normal staging learned" })).toBeDisabled();
  await expect(page.getByLabel("Permission decision")).toContainText("Allowed");
  await expect(page.getByLabel("Safety decision")).toContainText("Allowed");
  await expect(page.getByLabel("Resource effect")).toContainText("Completed");
  await expect(page.getByText("A staging pattern is ready for comparison")).toBeVisible();

  await page.getByRole("button", { name: "4. Try broader production change" }).click();
  await expect(page.getByLabel("Permission decision")).toContainText("Allowed");
  await expect(page.getByLabel("Safety decision")).toContainText("Blocked");
  await expect(page.getByLabel("Resource effect")).toContainText("Prevented");
  await expect(page.getByLabel("Safety stop active")).toBeVisible();
  const impact = page.locator(".security-impact-list");
  await expect(impact).toContainText("Deployment configuration");
  await expect(impact).toContainText("Production service");
  await expect(impact).toContainText("Customer dataset");
  await expect(page.getByLabel("Relevant impact path")).toContainText("Customer dataset");
  await expect(page.getByLabel("Persisted safety proof")).toContainText("Effect never claimed");

  await page.getByRole("button", { name: "View persistent Run timeline" }).click();
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
  await expect(page.getByLabel("Safety stop active")).toBeVisible();
  await expect(page.getByLabel("Safety decision")).toContainText("Blocked");
  await expect(page.getByLabel("Resource effect")).toContainText("Prevented");
  await expect(page.getByRole("heading", { name: "What happened" })).toBeVisible();
  const afterReload = await page.locator(".run-timeline-sequence").evaluateAll((nodes) =>
    nodes.map((node) => Number(node.textContent)),
  );
  expect(afterReload).toEqual(beforeReload);

  await page.getByRole("tab", { name: "Impact map" }).click();
  await expect(page.getByRole("heading", { name: "Impact field" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Select Customer dataset/ })).toBeVisible();
  await page.getByRole("button", { name: /Focus path to Customer dataset/ }).click();
  await expect(page.getByText(/Focused because you selected Customer dataset/)).toBeVisible();
});
