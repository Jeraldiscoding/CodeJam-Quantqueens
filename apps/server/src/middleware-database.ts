import { createHash } from "node:crypto";
import { chmod, mkdir } from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";
import { middlewareMigrations, type MiddlewareMigration } from "./middleware-migrations.js";

interface AppliedMigrationRow {
  version: number;
  name: string;
  checksum: string;
}

const checksum = (migration: MiddlewareMigration) =>
  createHash("sha256").update(migration.sql).digest("hex");

/** Owns the one SQLite connection shared by all middleware persistence adapters. */
export class MiddlewareDatabase {
  private database: Database.Database | null = null;

  constructor(readonly filePath: string) {}

  async initialize(): Promise<void> {
    if (this.database) return;

    await mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const database = new Database(this.filePath);
    this.database = database;

    try {
      database.pragma("busy_timeout = 5000");
      database.pragma("foreign_keys = ON");
      database.pragma("journal_mode = WAL");
      database.pragma("synchronous = NORMAL");
      this.applyMigrations(database);

      const violations = database.pragma("foreign_key_check") as unknown[];
      if (violations.length > 0) {
        throw new Error("middleware.db failed its foreign-key integrity check");
      }
      await chmod(this.filePath, 0o600);
    } catch (error) {
      database.close();
      this.database = null;
      throw error;
    }
  }

  get connection(): Database.Database {
    if (!this.database) {
      throw new Error("MiddlewareDatabase must be initialized before use");
    }
    return this.database;
  }

  transaction<T>(operation: () => T): T {
    return this.connection.transaction(() => {
      const result = operation();
      if (isPromiseLike(result)) {
        throw new Error("MiddlewareDatabase transactions must be synchronous");
      }
      return result;
    }).immediate();
  }

  close(): void {
    if (!this.database) return;
    this.database.close();
    this.database = null;
  }

  private applyMigrations(database: Database.Database): void {
    database.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        checksum TEXT NOT NULL,
        applied_at TEXT NOT NULL
      ) STRICT;
    `);

    for (const [index, migration] of middlewareMigrations.entries()) {
      const previous = middlewareMigrations[index - 1];
      if (!Number.isInteger(migration.version) || migration.version < 1) {
        throw new Error("Middleware migration versions must be positive integers");
      }
      if (previous && migration.version <= previous.version) {
        throw new Error("Middleware migrations must have unique, increasing versions");
      }
    }

    const knownVersions = new Set(middlewareMigrations.map(({ version }) => version));
    const appliedVersions = database
      .prepare("SELECT version FROM schema_migrations ORDER BY version")
      .all() as Array<{ version: number }>;
    const unknown = appliedVersions.find(({ version }) => !knownVersions.has(version));
    if (unknown) {
      throw new Error(
        `middleware.db contains unknown migration ${unknown.version}; use a compatible server version`,
      );
    }

    const findMigration = database.prepare(
      "SELECT version, name, checksum FROM schema_migrations WHERE version = ?",
    );
    const insertMigration = database.prepare(
      `INSERT INTO schema_migrations (version, name, checksum, applied_at)
       VALUES (?, ?, ?, ?)`,
    );

    for (const migration of middlewareMigrations) {
      const apply = database.transaction(() => {
        const applied = findMigration.get(migration.version) as AppliedMigrationRow | undefined;
        const expectedChecksum = checksum(migration);

        if (applied) {
          if (applied.name !== migration.name || applied.checksum !== expectedChecksum) {
            throw new Error(
              `Middleware migration ${migration.version} no longer matches the applied schema`,
            );
          }
          return;
        }

        database.exec(migration.sql);
        insertMigration.run(
          migration.version,
          migration.name,
          expectedChecksum,
          new Date().toISOString(),
        );
      });
      apply.immediate();
    }
  }
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    "then" in value &&
    typeof value.then === "function"
  );
}
