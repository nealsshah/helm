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
  yield* sql`CREATE INDEX IF NOT EXISTS helm_open_requests_thread ON helm_requests(json_extract(body,'$.threadId'))
    WHERE json_extract(body,'$.status')='open'`;
  yield* sql`CREATE VIEW IF NOT EXISTS helm_chat_replies AS
    SELECT message_id, thread_id, created_at FROM orchestration_v2_projection_messages
    WHERE role='user' AND message_id NOT GLOB 'helm:reply:*'
      AND json_extract(payload_json,'$.createdBy')='user'
      AND json_extract(payload_json,'$.creationSource') IN ('web','mobile')`;
  const installed =
    yield* sql`SELECT 1 FROM sqlite_schema WHERE type='trigger' AND name='helm_chat_reply'`;
  if (installed.length === 0) {
    yield* sql`UPDATE helm_requests AS r SET body=json_set(r.body,'$.status','accepted','$.resolvedAt',matched.replied_at)
      FROM (
        SELECT open.id, MIN(m.created_at) AS replied_at FROM helm_requests AS open JOIN helm_chat_replies AS m
          ON m.thread_id=json_extract(open.body,'$.threadId') AND m.created_at>json_extract(open.body,'$.createdAt')
        WHERE json_extract(open.body,'$.status')='open' GROUP BY open.id
      ) AS matched WHERE r.id=matched.id`;
    // A chat reply and its acknowledgement commit together, including replies sent while the board is closed.
    yield* sql`CREATE TRIGGER helm_chat_reply AFTER INSERT ON orchestration_v2_projection_messages
      WHEN NEW.role='user' AND EXISTS (SELECT 1 FROM helm_chat_replies WHERE message_id=NEW.message_id)
      BEGIN
        UPDATE helm_requests SET body=json_set(body,'$.status','accepted','$.resolvedAt',NEW.created_at)
        WHERE json_extract(body,'$.threadId')=NEW.thread_id AND json_extract(body,'$.status')='open'
          AND json_extract(body,'$.createdAt')<=NEW.created_at;
      END`;
  }

  yield* sql`CREATE TABLE IF NOT EXISTS helm_memberships (
    thread_id TEXT PRIMARY KEY, item_id TEXT NOT NULL REFERENCES helm_items(id)
  )`;
});

export const workspaceOwnsThread = (sql: SqlClient.SqlClient, threadId: ThreadId) =>
  sql`SELECT 1 FROM helm_memberships WHERE thread_id=${threadId}`.pipe(
    Effect.map((rows) => rows.length > 0),
  );
