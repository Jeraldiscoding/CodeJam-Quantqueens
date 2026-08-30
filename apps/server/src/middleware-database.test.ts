import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MiddlewareDatabase } from "./middleware-database.js";
import { middlewareMigrations } from "./middleware-migrations.js";

const temporaryDirectories: string[] = [];
const openDatabases: MiddlewareDatabase[] = [];

afterEach(async () => {
  for (const database of openDatabases.splice(0).reverse()) database.close();
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function createDatabase(): Promise<{
  database: MiddlewareDatabase;
  filePath: string;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-middleware-db-test-"));
  temporaryDirectories.push(root);
  const filePath = path.join(root, "nested-data", "middleware.db");
  const database = new MiddlewareDatabase(filePath);
  openDatabases.push(database);
  await database.initialize();
  return { database, filePath };
}

describe("MiddlewareDatabase", () => {
  it("creates the complete schema with WAL, foreign keys, indexes, and recorded migrations", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-middleware-db-test-"));
    temporaryDirectories.push(root);
    const filePath = path.join(root, "data", "middleware.db");
    const database = new MiddlewareDatabase(filePath);
    openDatabases.push(database);

    expect(() => database.connection).toThrow(/initialized before use/);
    await database.initialize();

    expect(database.connection.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(database.connection.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(database.connection.pragma("busy_timeout", { simple: true })).toBe(5_000);

    const tables = database.connection
      .prepare(`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
        ORDER BY name
      `)
      .all() as Array<{ name: string }>;
    expect(tables.map(({ name }) => name)).toEqual([
      "approval_events",
      "approval_requests",
      "graph_edges",
      "graph_nodes",
      "policy_action_claims",
      "policy_decisions",
      "schema_migrations",
    ]);

    const indexes = database.connection
      .prepare(`
        SELECT name FROM sqlite_master
        WHERE type = 'index' AND name NOT LIKE 'sqlite_autoindex_%'
        ORDER BY name
      `)
      .all() as Array<{ name: string }>;
    expect(indexes.map(({ name }) => name)).toEqual([
      "approval_events_request_idx",
      "approval_requests_status_idx",
      "graph_edges_run_idx",
      "graph_edges_source_idx",
      "graph_edges_target_idx",
      "policy_decisions_agent_idx",
      "policy_decisions_run_idx",
    ]);

    const applied = database.connection
      .prepare(`
        SELECT version, name, checksum, applied_at AS appliedAt
        FROM schema_migrations ORDER BY version
      `)
      .all() as Array<{
      version: number;
      name: string;
      checksum: string;
      appliedAt: string;
    }>;
    expect(applied.map(({ version, name }) => ({ version, name }))).toEqual(
      middlewareMigrations.map(({ version, name }) => ({ version, name })),
    );
    for (const migration of applied) {
      expect(migration.checksum).toMatch(/^[0-9a-f]{64}$/);
      expect(new Date(migration.appliedAt).toISOString()).toBe(migration.appliedAt);
    }

    expect((await stat(filePath)).mode & 0o777).toBe(0o600);
  });

  it("enforces foreign keys and reopens without reapplying migrations", async () => {
    const { database, filePath } = await createDatabase();
    const before = database.connection
      .prepare("SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version")
      .all();

    expect(() =>
      database.connection
        .prepare(`
          INSERT INTO graph_edges (
            id, source_id, target_id, relation, status, run_id, metadata_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          "edge:missing-endpoints",
          "agent:missing",
          "asset:missing",
          "CAN_READ",
          "authorized",
          null,
          "{}",
          "2026-08-30T00:00:00.000Z",
        ),
    ).toThrow(/FOREIGN KEY constraint failed/);

    await database.initialize();
    expect(
      database.connection
        .prepare("SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version")
        .all(),
    ).toEqual(before);

    database.close();
    expect(() => database.connection).toThrow(/initialized before use/);

    const reopened = new MiddlewareDatabase(filePath);
    openDatabases.push(reopened);
    await reopened.initialize();
    expect(reopened.connection.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(reopened.connection.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(
      reopened.connection
        .prepare("SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version")
        .all(),
    ).toEqual(before);
  });

  it("fails closed when an applied migration checksum no longer matches", async () => {
    const { database, filePath } = await createDatabase();
    database.connection
      .prepare("UPDATE schema_migrations SET checksum = ? WHERE version = ?")
      .run("0".repeat(64), middlewareMigrations[0]!.version);
    database.close();

    const reopened = new MiddlewareDatabase(filePath);
    openDatabases.push(reopened);
    await expect(reopened.initialize()).rejects.toThrow(/no longer matches the applied schema/);
    expect(() => reopened.connection).toThrow(/initialized before use/);
  });

  it("fails closed for unknown migrations and asynchronous transaction callbacks", async () => {
    const { database, filePath } = await createDatabase();
    expect(() => database.transaction(() => Promise.resolve())).toThrow(/must be synchronous/);

    database.connection
      .prepare(`
        INSERT INTO schema_migrations (version, name, checksum, applied_at)
        VALUES (?, ?, ?, ?)
      `)
      .run(999, "future_schema", "f".repeat(64), "2026-08-30T00:00:00.000Z");
    database.close();

    const reopened = new MiddlewareDatabase(filePath);
    openDatabases.push(reopened);
    await expect(reopened.initialize()).rejects.toThrow(/unknown migration 999/);
    expect(() => reopened.connection).toThrow(/initialized before use/);
  });
});
