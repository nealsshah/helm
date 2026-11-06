import type { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export const ensureWorkspaceSchema = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Fork-owned tables avoid taking a numbered migration from a future upstream release.
  yield* sql`CREATE TABLE IF NOT EXISTS helm_items (id TEXT PRIMARY KEY, body TEXT NOT NULL)`;
  yield* sql`CREATE TABLE IF NOT EXISTS helm_requests (
    id TEXT PRIMARY KEY, item_id TEXT NOT NULL REFERENCES helm_items(id), body TEXT NOT NULL,
    delivery_id TEXT
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS helm_requests_item ON helm_requests(item_id)`;
  yield* sql`CREATE TABLE IF NOT EXISTS helm_orchestrators (thread_id TEXT PRIMARY KEY NOT NULL)`;
  const legacy = yield* sql`SELECT 1 FROM sqlite_schema WHERE type='table' AND name='helm_binding'`;
  if (legacy.length > 0) {
    yield* sql`INSERT OR IGNORE INTO helm_orchestrators(thread_id) SELECT thread_id FROM helm_binding`;
    yield* sql`DROP TABLE helm_binding`;
  }

  yield* sql`CREATE TABLE IF NOT EXISTS helm_memberships (
    thread_id TEXT PRIMARY KEY, item_id TEXT NOT NULL REFERENCES helm_items(id)
  )`;
});

export const workspaceOwnsThread = (sql: SqlClient.SqlClient, threadId: ThreadId) =>
  sql`SELECT 1 FROM helm_memberships WHERE thread_id=${threadId}`.pipe(
    Effect.map((rows) => rows.length > 0),
  );
