import type { GraphClassification } from "./graph-types.js";
import type { CapabilityRelation } from "./policy-store.js";

export type PromptIntent = "informational" | "action" | "suspicious";

export interface PromptIntentAnalysis {
  intent: PromptIntent;
  reasonCode: "INFORMATIONAL_REQUEST" | "ACTION_REQUEST" | "SUSPICIOUS_REQUEST";
  explanation: string;
  signals: string[];
}

export interface PromptResourceCandidate {
  label: string;
  capability: CapabilityRelation;
  classification: GraphClassification;
  rationale: string;
}

const suspiciousSignals: Array<[RegExp, string]> = [
  [/\b(?:bypass|disable|evade|circumvent)\b.{0,28}\b(?:security|approval|policy|guardrail|audit|logging)\b/i, "attempts to bypass a control"],
  [/\b(?:exfiltrate|steal|leak|dump)\b.{0,28}\b(?:data|database|credentials?|secrets?|tokens?|keys?)\b/i, "requests sensitive-data extraction"],
  [/\b(?:reveal|print|show|read)\b.{0,20}\b(?:api[ -]?keys?|passwords?|credentials?|secrets?|tokens?)\b/i, "requests secret material"],
  [/\b(?:rm\s+-rf|drop\s+(?:the\s+)?database|delete\s+all|wipe\s+(?:the\s+)?(?:database|system|logs?))\b/i, "requests a destructive operation"],
  [/\bignore\b.{0,24}\b(?:previous|system|security|policy|instructions?)\b/i, "attempts to override trusted instructions"],
];

const actionVerbs = [
  "access", "call", "change", "connect", "create", "delete", "deploy", "download",
  "edit", "execute", "fetch", "invoke", "modify", "publish", "query", "read", "release",
  "remove", "run", "send", "trigger", "update", "upload", "use", "write",
] as const;

const actionAlternation = actionVerbs.join("|");
const directAction = new RegExp(`^(?:please\\s+)?(?:${actionAlternation})\\b`, "i");
const conversationalAction = new RegExp(
  `^(?:can|could|would|will)\\s+you\\s+(?:please\\s+)?(?:${actionAlternation})\\b`,
  "i",
);
const compoundAction = new RegExp(
  `(?:\\b(?:and then|then|also|go ahead and|how about(?: you)?)\\s+)(?:${actionAlternation})\\b`,
  "i",
);
const informationalLead = /^(?:what|why|how|when|where|who|explain|summarize|describe|clarify|compare|tell me|help me understand|can you explain|could you explain)\b/i;
const conversationalOnly = /^(?:hi|hello|hey|good\s+(?:morning|afternoon|evening)|thanks|thank\s+you)[!.?]*$/i;

export function analyzePromptIntent(prompt: string): PromptIntentAnalysis {
  const normalized = prompt.trim().replace(/\s+/g, " ");
  const suspicious = suspiciousSignals
    .filter(([pattern]) => pattern.test(normalized))
    .map(([, label]) => label);
  if (suspicious.length > 0) {
    return {
      intent: "suspicious",
      reasonCode: "SUSPICIOUS_REQUEST",
      explanation: `Human review is required because the request ${suspicious.join(" and ")}.`,
      signals: suspicious,
    };
  }

  if (
    directAction.test(normalized) ||
    conversationalAction.test(normalized) ||
    compoundAction.test(normalized)
  ) {
    return {
      intent: "action",
      reasonCode: "ACTION_REQUEST",
      explanation: "The request asks the Agent to perform an operation, so its graph permissions and impact apply.",
      signals: ["direct action request"],
    };
  }

  if (
    conversationalOnly.test(normalized) ||
    informationalLead.test(normalized) ||
    /\?$/.test(normalized)
  ) {
    return {
      intent: "informational",
      reasonCode: "INFORMATIONAL_REQUEST",
      explanation: conversationalOnly.test(normalized)
        ? "The message is conversational and does not ask the Agent to perform an operation."
        : "The request asks for an explanation or summary and does not ask the Agent to perform an operation.",
      signals: [conversationalOnly.test(normalized) ? "conversation only" : "explanation-only request"],
    };
  }

  return {
    intent: "action",
    reasonCode: "ACTION_REQUEST",
    explanation: "The request is treated as actionable because it is not clearly limited to an explanation.",
    signals: ["action assumed when intent is unclear"],
  };
}

export function inferPromptCapability(prompt: string): CapabilityRelation {
  if (/\b(?:credentials?|secrets?|tokens?|api[ -]?keys?|authenticate|login)\b/i.test(prompt)) {
    return "CAN_USE";
  }
  if (/\b(?:deploy|release|call|invoke|trigger|publish)\b/i.test(prompt)) return "CAN_CALL";
  if (/\b(?:write|edit|update|modify|change|create|delete|remove|upload)\b/i.test(prompt)) {
    return "CAN_WRITE";
  }
  return "CAN_READ";
}

export function inferPromptClassification(
  label: string,
  prompt: string,
): GraphClassification {
  const text = `${label} ${prompt}`;
  if (/\b(?:customer|personal|pii|payroll|health|credentials?|secrets?|tokens?|keys?)\b/i.test(text)) {
    return "restricted";
  }
  if (/\b(?:production|financial|finance|confidential|private)\b/i.test(text)) {
    return "confidential";
  }
  if (/\bpublic\b/i.test(text)) return "public";
  return "internal";
}

const resourcePhrase = /\b((?:[a-z0-9-]+\s+){0,3}(?:dataset|database|api|service|configuration|config|bucket|repository|repo|credentials?|secrets?|ledger|report|files?|system))\b/i;
const leadingNoise = new RegExp(
  `^(?:(?:please|the|a|an|our|my|this|that|to|from|into|on|with|using|${actionAlternation})\\s+)+`,
  "i",
);

export function inferPromptResource(prompt: string): PromptResourceCandidate | null {
  const match = prompt.trim().replace(/\s+/g, " ").match(resourcePhrase);
  if (!match) return null;
  const label = match[1]!.replace(leadingNoise, "").trim();
  if (!label) return null;
  const displayLabel = label.charAt(0).toUpperCase() + label.slice(1);
  const capability = inferPromptCapability(prompt);
  const classification = inferPromptClassification(displayLabel, prompt);
  return {
    label: displayLabel,
    capability,
    classification,
    rationale: `The prompt mentions “${displayLabel}” and implies ${capability.replace("CAN_", "").toLowerCase()} access.`,
  };
}
