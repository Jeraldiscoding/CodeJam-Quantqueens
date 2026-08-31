import { createHash } from "node:crypto";
import type { CapabilityRelation } from "./policy-store.js";

/**
 * Deterministic JSON. Object keys are emitted in sorted order so that the same
 * logical request always produces the same SHA-256 digest on any machine.
 */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalize(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`);
    return `{${entries.join(",")}}`;
  }
  throw new Error("Cannot canonicalize a non-JSON value");
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function digestOf(value: unknown): string {
  return sha256Hex(canonicalize(value ?? null));
}

export interface ProtectedActionIdentity {
  policyVersion: string;
  runId: string;
  agentNodeId: string;
  capability: CapabilityRelation;
  targetNodeId: string;
  /** Hash of the Agent's authorized subgraph at evaluation time. */
  graphRevision: string;
  /** Hash of the request payload, so an approval cannot be replayed on a different body. */
  payloadDigest: string;
}

/**
 * The request hash is the binding contract. An approval granted for one Run,
 * one payload, and one graph revision cannot be reused for anything else,
 * because the recomputed hash at execution time would no longer match.
 */
export function computeRequestHash(identity: ProtectedActionIdentity): string {
  return sha256Hex(canonicalize(identity));
}
