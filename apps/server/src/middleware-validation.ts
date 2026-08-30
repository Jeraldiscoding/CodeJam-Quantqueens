const MAX_JSON_BYTES = 65_536;
const unsafeKeySuffixes = [
  "password",
  "passphrase",
  "secret",
  "clientsecret",
  "apikey",
  "accesskey",
  "authorization",
  "cookie",
  "jwt",
  "sessionid",
  "token",
  "accesstoken",
  "refreshtoken",
  "authtoken",
  "privatekey",
  "credential",
  "credentials",
] as const;

export type MiddlewareStoreErrorCode =
  | "VALIDATION"
  | "CONFLICT"
  | "NOT_FOUND"
  | "INVALID_TRANSITION";

export class MiddlewareStoreError extends Error {
  constructor(
    readonly code: MiddlewareStoreErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "MiddlewareStoreError";
  }
}

export function assertNonEmptyText(value: string, field: string, maxLength = 180): void {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maxLength) {
    throw new MiddlewareStoreError(
      "VALIDATION",
      `${field} must contain between 1 and ${maxLength} characters`,
    );
  }
  if (value.includes("\0")) {
    throw new MiddlewareStoreError("VALIDATION", `${field} must not contain a null byte`);
  }
}

export function assertIsoTimestamp(value: string, field: string): void {
  const parsed = new Date(value);
  if (!value || Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new MiddlewareStoreError("VALIDATION", `${field} must be an ISO-8601 UTC timestamp`);
  }
}

export function assertOneOf<T extends string>(
  value: string,
  allowed: readonly T[],
  field: string,
): asserts value is T {
  if (!allowed.includes(value as T)) {
    throw new MiddlewareStoreError("VALIDATION", `${field} contains an unsupported value`);
  }
}

export function serializeSafeJsonObject(
  value: Record<string, unknown>,
  field: string,
): string {
  if (!isPlainObject(value)) {
    throw new MiddlewareStoreError("VALIDATION", `${field} must be a JSON object`);
  }
  validateJsonValue(value, field, new Set<object>(), 0);

  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new MiddlewareStoreError("VALIDATION", `${field} must be valid JSON`);
  }
  if (Buffer.byteLength(serialized, "utf8") > MAX_JSON_BYTES) {
    throw new MiddlewareStoreError(
      "VALIDATION",
      `${field} must be no larger than ${MAX_JSON_BYTES} bytes`,
    );
  }
  return serialized;
}

export function parseJsonObject(value: string, field: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isPlainObject(parsed)) throw new Error("not an object");
    return parsed;
  } catch {
    throw new Error(`Stored ${field} is not a valid JSON object`);
  }
}

export function rethrowSqliteConstraint(
  error: unknown,
  duplicateMessage: string,
  invalidMessage: string,
): never {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code: unknown }).code)
      : "";
  if (code === "SQLITE_CONSTRAINT_PRIMARYKEY" || code === "SQLITE_CONSTRAINT_UNIQUE") {
    throw new MiddlewareStoreError("CONFLICT", duplicateMessage);
  }
  if (code.startsWith("SQLITE_CONSTRAINT")) {
    throw new MiddlewareStoreError("VALIDATION", invalidMessage);
  }
  throw error;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validateJsonValue(
  value: unknown,
  path: string,
  ancestors: Set<object>,
  depth: number,
): void {
  if (depth > 16) {
    throw new MiddlewareStoreError("VALIDATION", `${path} exceeds the maximum nesting depth`);
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new MiddlewareStoreError("VALIDATION", `${path} contains a non-finite number`);
    }
    return;
  }
  if (typeof value !== "object") {
    throw new MiddlewareStoreError("VALIDATION", `${path} contains a non-JSON value`);
  }
  if (ancestors.has(value)) {
    throw new MiddlewareStoreError("VALIDATION", `${path} contains a circular reference`);
  }

  ancestors.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => validateJsonValue(item, `${path}[${index}]`, ancestors, depth + 1));
  } else if (isPlainObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      const normalizedKey = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
      if (unsafeKeySuffixes.some((suffix) => normalizedKey.endsWith(suffix))) {
        throw new MiddlewareStoreError(
          "VALIDATION",
          `${path}.${key} looks like a secret-bearing field and is not allowed`,
        );
      }
      validateJsonValue(item, `${path}.${key}`, ancestors, depth + 1);
    }
  } else {
    throw new MiddlewareStoreError("VALIDATION", `${path} contains a non-JSON object`);
  }
  ancestors.delete(value);
}
