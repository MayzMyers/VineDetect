import { readFile } from "node:fs/promises";
import path from "node:path";
import { pool } from "./pool.js";
import { readdir } from "node:fs/promises";

async function main() {
  const migrationsRoot = path.resolve(process.cwd(), "migrations");
  const migrationFiles = (await readdir(migrationsRoot))
    .filter((file) => file.endsWith(".sql"))
    .sort();

  const client = await pool.connect();
  const lockName = "vinedetect-recognize-schema-migrations-v1";
  try {
    // Compose restarts and overlapping developer commands must never replay DDL
    // concurrently. Session-level locking also covers migrations that manage
    // their own BEGIN/COMMIT blocks.
    await client.query("SELECT pg_advisory_lock(hashtext($1))", [lockName]);
    await client.query(`CREATE SCHEMA IF NOT EXISTS meta;
      CREATE TABLE IF NOT EXISTS meta.recognize_schema_migrations (
        filename TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
    const applied = new Set<string>((await client.query<{ filename: string }>(
      "SELECT filename FROM meta.recognize_schema_migrations",
    )).rows.map((row) => row.filename));
    for (const file of migrationFiles) {
      if (applied.has(file)) continue;
      const sql = await readFile(path.join(migrationsRoot, file), "utf8");
      try {
        await client.query(sql);
        await client.query(
          "INSERT INTO meta.recognize_schema_migrations (filename) VALUES ($1) ON CONFLICT (filename) DO NOTHING",
          [file],
        );
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`Migration ${file} failed: ${detail}`, { cause: error });
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext($1))", [lockName]).catch(() => undefined);
    client.release();
  }

  await pool.end();
  console.log("recognize-service migrations applied");
}

main().catch(async (error) => {
  console.error(error);
  await pool.end();
  process.exit(1);
});
