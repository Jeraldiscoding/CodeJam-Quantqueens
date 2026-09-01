#!/usr/bin/env node

// Deterministic browser-test fixture only. Production and the live demo use
// the configured Codex CLI + Ark model. This fixture exercises the same
// server-side proposal validation, gateway, adapter, timeline, and UI path.
const rawPrompt = process.argv.at(-1) ?? "";
const userPrompt = rawPrompt.split("\nUser request:\n").at(-1)?.trim() ?? rawPrompt;

let output;
if (/map (?:these|the) dependenc/i.test(userPrompt)) {
  output = "Checkout API calls Fraud Service. Fraud Service processes Customer records.";
} else if (/alice(?:'s)? private records/i.test(userPrompt)) {
  output = [
    "I will ask the middleware to read Alice's private records.",
    '<protected_action>{"capability":"CAN_READ","targetNodeId":"asset:alice-private-records","reason":"Read the requested Alice-owned record"}</protected_action>',
  ].join("\n");
} else if (/bob(?:'s)? private records/i.test(userPrompt)) {
  output = [
    "I will ask the middleware to read Bob's private records.",
    '<protected_action>{"capability":"CAN_READ","targetNodeId":"asset:bob-private-records","reason":"Read the requested Bob-owned record"}</protected_action>',
  ].join("\n");
} else if (/staging configuration/i.test(userPrompt)) {
  output = [
    "I will ask the middleware to update the staging configuration.",
    '<protected_action>{"capability":"CAN_WRITE","targetNodeId":"asset:staging-config","reason":"Apply the requested release to staging"}</protected_action>',
  ].join("\n");
} else if (/(?:production )?(?:deployment|production) configuration/i.test(userPrompt)) {
  output = [
    "I will ask the middleware to update the production deployment configuration.",
    '<protected_action>{"capability":"CAN_WRITE","targetNodeId":"asset:deployment-config","reason":"Apply the requested release to production"}</protected_action>',
  ].join("\n");
} else {
  output = "I assess release readiness by checking tests, deployment health, dependency impact, and rollback readiness. I would flag changes that reach sensitive customer data or differ from trusted release behavior.";
}

process.stdout.write(`${JSON.stringify({ type: "thread.started", thread_id: "thread-playwright" })}\n`);
process.stdout.write(`${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: output } })}\n`);
process.stdout.write(`${JSON.stringify({ type: "turn.completed", usage: { input_tokens: 20, output_tokens: 12 } })}\n`);
