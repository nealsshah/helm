import type { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export const attachWorkspaceDescendants = (
  sql: SqlClient.SqlClient,
  itemId?: string,
  root?: ThreadId,
) =>
  sql`WITH RECURSIVE descendants(thread_id,item_id) AS (
      SELECT m.thread_id,m.item_id FROM helm_memberships m JOIN helm_items i ON i.id=m.item_id
      WHERE m.thread_id<>json_extract(i.body,'$.secondMateThreadId')
        ${itemId === undefined ? sql`` : sql`AND m.item_id=${itemId}`}
        ${root === undefined ? sql`` : sql`AND m.thread_id=${root}`}
      UNION SELECT c.child,d.item_id FROM descendants d JOIN helm_delegated_children c ON c.parent=d.thread_id
      WHERE NOT EXISTS(SELECT 1 FROM helm_memberships owned WHERE owned.thread_id=c.child)
        AND NOT EXISTS(SELECT 1 FROM helm_detached_workers removed WHERE removed.item_id=d.item_id AND removed.thread_id=c.child)
    ) INSERT OR IGNORE INTO helm_memberships(thread_id,item_id) SELECT thread_id,item_id FROM descendants`;

export const ensureWorkspaceSchema = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Fork-owned tables avoid taking a numbered migration from a future upstream release.
  yield* sql`CREATE TABLE IF NOT EXISTS helm_items (id TEXT PRIMARY KEY, body TEXT NOT NULL)`;
  yield* sql`CREATE TABLE IF NOT EXISTS helm_requests (
    id TEXT PRIMARY KEY, item_id TEXT NOT NULL REFERENCES helm_items(id), body TEXT NOT NULL,
    delivery_id TEXT
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS helm_requests_item ON helm_requests(item_id)`;
  const hadReplyReads =
    yield* sql`SELECT 1 FROM sqlite_schema WHERE type='table' AND name='helm_reply_reads'`;
  yield* sql`CREATE TABLE IF NOT EXISTS helm_reply_reads (thread_id TEXT PRIMARY KEY, ordinal INTEGER NOT NULL)`;
  if (hadReplyReads.length === 0) {
    // Preserve visits made before Helm tracked deliberate opens separately from passive chat visits.
    yield* sql`INSERT INTO helm_reply_reads(thread_id, ordinal)
      SELECT t.thread_id, MAX(r.ordinal) FROM helm_items i
      JOIN orchestration_v2_projection_threads t ON t.thread_id=json_extract(i.body,'$.secondMateThreadId')
      JOIN orchestration_v2_projection_runs r ON r.thread_id=t.thread_id
      WHERE r.completed_at<=json_extract(t.payload_json,'$.lastVisitedAt') GROUP BY t.thread_id`;
  }
  yield* sql`CREATE INDEX IF NOT EXISTS helm_human_prompts
    ON orchestration_v2_projection_messages(thread_id, created_at)
    WHERE role='user' AND json_extract(payload_json,'$.createdBy')='user'
      AND json_extract(payload_json,'$.scheduledTaskId') IS NULL
      AND json_extract(payload_json,'$.creationSource') IN ('web','mobile')`;
  yield* sql`CREATE VIEW IF NOT EXISTS helm_ready_replies AS
    SELECT i.id AS item_id,t.thread_id,r.run_id,r.ordinal,r.completed_at,
      substr(trim(json_extract(answer.payload_json,'$.text')),1,240) AS excerpt
    FROM helm_items i
    JOIN orchestration_v2_projection_threads t ON t.thread_id=json_extract(i.body,'$.secondMateThreadId')
    JOIN orchestration_v2_projection_messages prompt ON prompt.rowid=(
      SELECT rowid FROM orchestration_v2_projection_messages WHERE thread_id=t.thread_id
        AND role='user' AND json_extract(payload_json,'$.createdBy')='user'
        AND json_extract(payload_json,'$.scheduledTaskId') IS NULL
        AND json_extract(payload_json,'$.creationSource') IN ('web','mobile')
      ORDER BY created_at DESC,rowid DESC LIMIT 1)
    JOIN orchestration_v2_projection_runs r ON r.run_id=prompt.run_id AND r.status='completed'
    LEFT JOIN helm_reply_reads seen ON seen.thread_id=t.thread_id
    JOIN orchestration_v2_projection_messages answer ON answer.rowid=(
      SELECT rowid FROM orchestration_v2_projection_messages WHERE run_id=r.run_id AND role='assistant'
        AND streaming=0 AND (created_at>prompt.created_at OR (created_at=prompt.created_at AND rowid>prompt.rowid)) AND trim(json_extract(payload_json,'$.text'))<>''
      ORDER BY created_at DESC,rowid DESC LIMIT 1)
    WHERE t.archived_at IS NULL AND t.deleted_at IS NULL AND json_extract(i.body,'$.retiredAt') IS NULL
      AND r.completed_at IS NOT NULL AND r.ordinal>coalesce(seen.ordinal,-1)`;
  yield* sql`CREATE TABLE IF NOT EXISTS helm_orchestrators (thread_id TEXT PRIMARY KEY NOT NULL)`;
  yield* sql`CREATE TABLE IF NOT EXISTS helm_retained_workers (thread_id TEXT PRIMARY KEY, orchestrator_thread_id TEXT NOT NULL)`;
  yield* sql`CREATE INDEX IF NOT EXISTS helm_message_sender
    ON orchestration_v2_projection_messages(json_extract(payload_json,'$.senderThreadId'), thread_id)
    WHERE role='user' AND json_extract(payload_json,'$.senderThreadId') IS NOT NULL`;
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
  yield* sql`CREATE TABLE IF NOT EXISTS helm_retirement_queue (
    thread_id TEXT PRIMARY KEY, item_id TEXT NOT NULL REFERENCES helm_items(id)
  )`;
  yield* sql`CREATE TRIGGER IF NOT EXISTS helm_retired_worker AFTER INSERT ON helm_memberships
    WHEN EXISTS(SELECT 1 FROM helm_items WHERE id=NEW.item_id AND json_extract(body,'$.retiredAt') IS NOT NULL)
    BEGIN INSERT OR IGNORE INTO helm_retirement_queue(thread_id,item_id) VALUES(NEW.thread_id,NEW.item_id); END`;
  yield* sql`CREATE VIEW IF NOT EXISTS helm_worker_children(parent,child) AS
    SELECT json_extract(t.payload_json,'$.lineage.parentThreadId'),t.thread_id FROM orchestration_v2_projection_threads t
    WHERE json_extract(t.payload_json,'$.lineage.relationshipToParent')='subagent'
    UNION ALL
    SELECT json_extract(m.payload_json,'$.senderThreadId'),m.thread_id FROM orchestration_v2_projection_messages m
    JOIN orchestration_v2_projection_threads t ON t.thread_id=m.thread_id
    WHERE m.role='user' AND json_extract(m.payload_json,'$.senderThreadId') IS NOT NULL
      AND json_extract(m.payload_json,'$.creationSource')='mcp'
      AND json_extract(t.payload_json,'$.createdBy')='agent' AND json_extract(t.payload_json,'$.creationSource')='mcp'
      AND json_extract(t.payload_json,'$.lineage.parentThreadId') IS NULL
      AND m.message_id=(SELECT first.message_id FROM orchestration_v2_projection_messages first
        WHERE first.thread_id=m.thread_id ORDER BY first.created_at, first.rowid LIMIT 1)`;
  yield* sql`CREATE VIEW IF NOT EXISTS helm_late_retired_workers AS
    SELECT c.child,m.item_id FROM helm_worker_children c JOIN helm_memberships m ON m.thread_id=c.parent
    JOIN helm_items i ON i.id=m.item_id WHERE json_extract(i.body,'$.retiredAt') IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM helm_orchestrators o WHERE o.thread_id=c.child)`;
  yield* sql`CREATE TRIGGER IF NOT EXISTS helm_retired_child AFTER INSERT ON orchestration_v2_projection_threads
    WHEN json_extract(NEW.payload_json,'$.lineage.relationshipToParent')='subagent'
    BEGIN INSERT OR IGNORE INTO helm_memberships(thread_id,item_id)
      SELECT child,item_id FROM helm_late_retired_workers WHERE child=NEW.thread_id; END`;
  yield* sql`CREATE TRIGGER IF NOT EXISTS helm_retired_launch AFTER INSERT ON orchestration_v2_projection_messages
    WHEN NEW.role='user' AND json_extract(NEW.payload_json,'$.creationSource')='mcp'
      AND json_extract(NEW.payload_json,'$.senderThreadId') IS NOT NULL
    BEGIN INSERT OR IGNORE INTO helm_memberships(thread_id,item_id)
      SELECT child,item_id FROM helm_late_retired_workers WHERE child=NEW.thread_id; END`;
  yield* sql`CREATE UNIQUE INDEX IF NOT EXISTS helm_second_mate ON helm_items(json_extract(body,'$.secondMateThreadId'))`;
  yield* sql`CREATE TRIGGER IF NOT EXISTS helm_launched_worker AFTER INSERT ON orchestration_v2_projection_messages
    WHEN NEW.role='user' AND json_extract(NEW.payload_json,'$.creationSource')='mcp'
      AND json_extract(NEW.payload_json,'$.senderThreadId') IS NOT NULL
    BEGIN
      INSERT OR IGNORE INTO helm_memberships(thread_id,item_id)
      SELECT NEW.thread_id, i.id FROM helm_items i JOIN orchestration_v2_projection_threads t ON t.thread_id=NEW.thread_id
      WHERE json_extract(i.body,'$.secondMateThreadId')=json_extract(NEW.payload_json,'$.senderThreadId')
        AND json_extract(t.payload_json,'$.createdBy')='agent' AND json_extract(t.payload_json,'$.creationSource')='mcp'
        AND json_extract(t.payload_json,'$.lineage.parentThreadId') IS NULL
        AND NOT EXISTS(SELECT 1 FROM orchestration_v2_projection_messages m WHERE m.thread_id=NEW.thread_id AND m.rowid<>NEW.rowid);
    END`;
  yield* sql`CREATE TRIGGER IF NOT EXISTS helm_register_worker AFTER INSERT ON helm_memberships
    BEGIN
      UPDATE helm_items SET body=json_insert(body,'$.sessions[#]',json_object('threadId',NEW.thread_id,'role','Worker'))
      WHERE id=NEW.item_id AND NEW.thread_id<>json_extract(body,'$.primaryThreadId')
        AND NEW.thread_id<>json_extract(body,'$.secondMateThreadId')
        AND NOT EXISTS(SELECT 1 FROM json_each(body,'$.sessions') s WHERE json_extract(s.value,'$.threadId')=NEW.thread_id);
    END`;
  yield* sql`CREATE TABLE IF NOT EXISTS helm_detached_workers (
    item_id TEXT NOT NULL REFERENCES helm_items(id) ON DELETE CASCADE, thread_id TEXT NOT NULL,
    PRIMARY KEY(item_id,thread_id)
  )`;
  const inheritedWorkers =
    yield* sql`SELECT 1 FROM sqlite_schema WHERE type='trigger' AND name='helm_inherit_delegated_worker'`;
  if (inheritedWorkers.length === 0) {
    yield* sql`DROP TRIGGER IF EXISTS helm_delegated_worker`;
    yield* sql`CREATE VIEW IF NOT EXISTS helm_delegated_children(parent,child) AS
      SELECT json_extract(t.payload_json,'$.lineage.parentThreadId'),t.thread_id FROM orchestration_v2_projection_threads t
      WHERE json_extract(t.payload_json,'$.lineage.relationshipToParent')='subagent'
        AND NOT EXISTS(SELECT 1 FROM helm_orchestrators o WHERE o.thread_id IN (t.thread_id,json_extract(t.payload_json,'$.lineage.parentThreadId')))`;
    // The child's first provider turn already needs its role and its Second Mate.
    yield* sql`CREATE TRIGGER helm_inherit_delegated_worker AFTER INSERT ON orchestration_v2_projection_threads
      WHEN json_extract(NEW.payload_json,'$.lineage.relationshipToParent')='subagent'
      BEGIN INSERT OR IGNORE INTO helm_memberships(thread_id,item_id)
        SELECT c.child,m.item_id FROM helm_delegated_children c JOIN helm_memberships m ON m.thread_id=c.parent
        JOIN helm_items i ON i.id=m.item_id WHERE c.child=NEW.thread_id AND json_extract(i.body,'$.secondMateThreadId') IS NOT NULL;
      END`;
    // Direct lead delegations were already tracked. Repair only missing descendants of workers.
    yield* attachWorkspaceDescendants(sql);
  }
  yield* sql`CREATE VIEW IF NOT EXISTS helm_turn_plans AS
    SELECT DISTINCT run_id FROM orchestration_v2_projection_plans
    WHERE kind='proposed_plan' AND status='active' AND run_id IS NOT NULL`;
  yield* sql`DROP TRIGGER IF EXISTS helm_turn_checkpoint`;
  // The provider may yield without calling the board tool. Only structured plan evidence can change its stage.
  yield* sql`CREATE TRIGGER IF NOT EXISTS helm_lead_turn_checkpoint AFTER UPDATE OF status ON orchestration_v2_projection_runs
    WHEN NEW.status<>OLD.status AND NEW.status IN ('waiting','completed','interrupted','failed','cancelled')
    BEGIN
      UPDATE helm_items SET body=json_set(body,'$.stage','planning','$.updatedAt',COALESCE(NEW.completed_at,NEW.requested_at))
      WHERE id=(SELECT item_id FROM helm_memberships WHERE thread_id=NEW.thread_id)
        AND COALESCE(json_extract(body,'$.secondMateThreadId'),json_extract(body,'$.primaryThreadId'))=NEW.thread_id
        AND json_extract(body,'$.latestReport') IS NULL AND json_extract(body,'$.stage')='building'
        AND json_extract(body,'$.updatedAt')<=NEW.requested_at
        AND NEW.run_id IN (SELECT run_id FROM helm_turn_plans WHERE run_id=NEW.run_id);
    END`;
});

export const unassignedWorkspaceDelegates = (
  sql: SqlClient.SqlClient,
  id?: string,
  orchestrator?: ThreadId,
) =>
  sql<{
    thread_id: string;
    title: string;
    created_at: string;
    updated_at: string;
    stage: "planning" | "building" | "complete";
  }>`WITH sources(parent,child) AS (
      SELECT thread_id, NULL FROM helm_orchestrators ${orchestrator === undefined ? sql`` : sql`WHERE thread_id=${orchestrator}`}
      UNION ALL
      SELECT r.orchestrator_thread_id, r.thread_id FROM helm_retained_workers r
      WHERE NOT EXISTS(SELECT 1 FROM helm_orchestrators o WHERE o.thread_id=r.orchestrator_thread_id)
        ${id === undefined ? sql`` : sql`AND r.thread_id=${id}`}
        ${orchestrator === undefined ? sql`` : sql`AND r.orchestrator_thread_id=${orchestrator}`}
    ), workers AS (
      SELECT s.child_thread_id AS thread_id, s.updated_at,
        CASE WHEN s.status='completed' THEN 'complete' ELSE 'building' END AS stage
      FROM sources o JOIN orchestration_v2_projection_subagents s ON s.thread_id=o.parent
      WHERE s.origin='app_owned' AND (o.child IS NULL OR o.child=s.child_thread_id)
      UNION ALL
      SELECT m.thread_id, COALESCE(run.completed_at, run.requested_at, m.created_at),
        CASE WHEN run.status IN ('waiting','completed','interrupted','failed','cancelled')
          AND EXISTS(SELECT 1 FROM helm_turn_plans WHERE run_id=run.run_id) THEN 'planning' ELSE 'building' END
      FROM sources o JOIN orchestration_v2_projection_messages m
        ON json_extract(m.payload_json,'$.senderThreadId')=o.parent AND (o.child IS NULL OR o.child=m.thread_id)
      JOIN orchestration_v2_projection_threads root ON root.thread_id=m.thread_id
      LEFT JOIN orchestration_v2_projection_runs run ON run.run_id=(
        SELECT latest.run_id FROM orchestration_v2_projection_runs latest
        WHERE latest.thread_id=m.thread_id ORDER BY latest.ordinal DESC LIMIT 1
      )
      WHERE m.role='user' AND json_extract(m.payload_json,'$.senderThreadId') IS NOT NULL
        AND json_extract(m.payload_json,'$.creationSource')='mcp'
        AND json_extract(root.payload_json,'$.creationSource')='mcp'
        AND json_extract(root.payload_json,'$.createdBy')='agent'
        AND json_extract(root.payload_json,'$.lineage.parentThreadId') IS NULL
        AND m.message_id=(SELECT first.message_id FROM orchestration_v2_projection_messages first
          WHERE first.thread_id=m.thread_id ORDER BY first.created_at, first.rowid LIMIT 1)
    )
    SELECT t.thread_id, t.title, t.created_at, w.updated_at, w.stage
      FROM workers w JOIN orchestration_v2_projection_threads t ON t.thread_id=w.thread_id
      WHERE t.deleted_at IS NULL AND t.archived_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM helm_memberships m WHERE m.thread_id=t.thread_id)
        AND NOT EXISTS (SELECT 1 FROM helm_items i WHERE i.id=t.thread_id)
        ${id === undefined ? sql`` : sql`AND t.thread_id=${id}`}`;

export const workspaceItemIdForThread = (sql: SqlClient.SqlClient, threadId: ThreadId) =>
  sql<{ item_id: string }>`SELECT item_id FROM helm_memberships WHERE thread_id=${threadId}`.pipe(
    Effect.flatMap((rows) =>
      rows[0]
        ? Effect.succeed(rows[0].item_id)
        : unassignedWorkspaceDelegates(sql, threadId).pipe(
            Effect.map((delegates) => delegates[0]?.thread_id),
          ),
    ),
  );

export const workspaceRoleForThread = Effect.fn("VisualWorkspace.roleForThread")(function* (
  sql: SqlClient.SqlClient,
  threadId: ThreadId,
) {
  const [lead] = yield* sql<{
    role: "firstMate" | "secondMate";
  }>`SELECT 'firstMate' AS role FROM helm_orchestrators WHERE thread_id=${threadId}
    UNION ALL SELECT 'secondMate' FROM helm_items WHERE json_extract(body,'$.secondMateThreadId')=${threadId} LIMIT 1`;
  if (lead) return lead.role;
  return (yield* workspaceItemIdForThread(sql, threadId)) === undefined
    ? undefined
    : ("worker" as const);
});
