import * as SecureRandom from "effect/crypto/SecureRandom";
import {
  CommandId,
  MessageId,
  ProjectId,
  ThreadId,
  WorkItem,
  WorkspaceError,
  WorkspaceRequest,
  workspaceOwnerThreadId,
  type WorkspaceCheckpoint,
  type WorkspaceCommand,
  type WorkspaceSnapshot,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import { EventSinkV2 } from "../orchestration-v2/EventSink.ts";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";

import { makeTaskRetirement } from "./RetireWorkspaceTask.ts";
import {
  ensureTaskOwnerThread,
  makeStartWorkspaceTask,
  secondMateId,
} from "./StartWorkspaceTask.ts";
import {
  attachWorkspaceDescendants,
  unassignedWorkspaceDelegates,
  workspaceItemIdForThread,
} from "./VisualWorkspaceSchema.ts";

const decodeItem = Schema.decodeUnknownEffect(Schema.fromJsonString(WorkItem));
const decodeRequest = Schema.decodeUnknownEffect(Schema.fromJsonString(WorkspaceRequest));
const encodeItem = Schema.encodeEffect(Schema.fromJsonString(WorkItem));
const encodeRequest = Schema.encodeEffect(Schema.fromJsonString(WorkspaceRequest));
const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));
const fail = (message: string) => new WorkspaceError({ message });
const isWorkspaceError = Schema.is(WorkspaceError);
const workspaceError = (error: unknown) =>
  isWorkspaceError(error)
    ? error
    : fail(error instanceof Error ? error.message : "Workspace storage failed.");

function newItem(cmd: Extract<WorkspaceCommand, { type: "create" }>, timestamp: string): WorkItem {
  return {
    id: cmd.itemId,
    title: cmd.title,
    scope: cmd.scope ?? "",
    stage: cmd.stage ?? "planning",
    primaryThreadId: cmd.primaryThreadId,
    priority: 0,
    attention: "none",
    sessions: [],
    dependencies: [],
    decisions: [],
    artifacts: [],
    latestReport: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export class VisualWorkspace extends Context.Service<
  VisualWorkspace,
  {
    readonly startTask: ReturnType<typeof makeStartWorkspaceTask>;
    readonly get: (options?: {
      includeWorkerRequests?: boolean;
    }) => Effect.Effect<WorkspaceSnapshot, WorkspaceError>;
    readonly finishRetiredSession: (threadId: ThreadId) => Effect.Effect<void, WorkspaceError>;
    readonly resumeWorkerQuestions: () => Effect.Effect<void, WorkspaceError>;
    readonly secondMateForWorker: (
      threadId: ThreadId,
    ) => Effect.Effect<ThreadId | undefined, WorkspaceError>;
    readonly subscribe: () => Stream.Stream<WorkspaceSnapshot, WorkspaceError>;
    readonly checkpoint: (
      threadId: ThreadId,
      decision: WorkspaceCheckpoint,
    ) => Effect.Effect<string, WorkspaceError>;
    readonly command: (
      command: WorkspaceCommand,
      actor?: { threadId: ThreadId; subagent?: boolean },
    ) => Effect.Effect<WorkspaceSnapshot, WorkspaceError>;
  }
>()("t3/workspace/VisualWorkspace") {}

export const makeVisualWorkspace = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const threads = yield* ThreadManagementService;
  const eventSink = yield* EventSinkV2;
  const random = yield* SecureRandom.SecureRandom;
  const changes = yield* PubSub.sliding<void>(1);
  const lock = yield* Semaphore.make(1);
  const finishRetirements = yield* makeTaskRetirement;

  // The user message survives command receipt pruning; it also proves accepted delivery.
  const reconcileAccepted = (id?: string) => sql`UPDATE helm_requests AS r
    SET body=json_remove(json_set(r.body,'$.status','accepted','$.resolvedAt',m.created_at),'$.deliveryError')
    FROM orchestration_v2_projection_messages AS m
    WHERE json_extract(r.body,'$.status')='delivering' AND m.role='user'
      AND m.message_id='helm:reply:' || r.delivery_id
      AND m.thread_id=json_extract(r.body,'$.threadId')
      ${id === undefined ? sql`` : sql`AND r.id=${id}`}`;
  yield* reconcileAccepted().pipe(Effect.orDie);
  const orchestrators = () =>
    sql<{ thread_id: string }>`SELECT o.thread_id FROM helm_orchestrators AS o
      JOIN orchestration_v2_projection_threads AS t ON t.thread_id=o.thread_id
      WHERE t.deleted_at IS NULL AND t.archived_at IS NULL ORDER BY o.rowid`.pipe(
      Effect.map((rows) => rows.map((row) => ThreadId.make(row.thread_id))),
    );
  // An explicit ticket or worker association takes precedence over an inferred delegation card.
  const delegatedItems = Effect.fn("VisualWorkspace.delegatedItems")(function* (id?: string) {
    const rows = yield* unassignedWorkspaceDelegates(sql, id);
    return rows.map((row) => ({
      ...newItem(
        {
          type: "create",
          itemId: row.thread_id,
          primaryThreadId: ThreadId.make(row.thread_id),
          title: row.title,
          stage: row.stage,
        },
        row.created_at,
      ),
      canReassignPrimary: true,
      updatedAt: row.updated_at,
    }));
  });
  const get = (options?: { includeWorkerRequests?: boolean }) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const items = yield* sql<{ body: string }>`SELECT body FROM helm_items ORDER BY rowid`;
          const requests = yield* sql<{
            body: string;
          }>`SELECT r.body FROM helm_requests r JOIN helm_items i ON i.id=r.item_id
            ${
              options?.includeWorkerRequests
                ? sql``
                : sql`WHERE json_extract(i.body,'$.secondMateThreadId') IS NULL
              OR json_extract(r.body,'$.threadId')=json_extract(i.body,'$.secondMateThreadId')`
            }
            ORDER BY r.rowid`;
          const replies = options?.includeWorkerRequests
            ? []
            : yield* sql<{
                item_id: string;
                thread_id: string;
                run_id: string;
                completed_at: string;
                excerpt: string;
              }>`SELECT item_id,thread_id,run_id,completed_at,excerpt FROM helm_owner_ready_replies`;
          return {
            orchestratorThreadIds: yield* orchestrators(),
            items: [
              ...(yield* Effect.forEach(items, (row) => decodeItem(row.body))),
              ...(yield* delegatedItems()),
            ],
            requests: [
              ...(yield* Effect.forEach(requests, (row) => decodeRequest(row.body))),
              ...replies.map((reply): WorkspaceRequest => ({
                id: `helm:reply-ready:${reply.run_id}`,
                itemId: reply.item_id,
                threadId: ThreadId.make(reply.thread_id),
                replyId: reply.run_id,
                kind: "attention",
                prompt: "Reply ready",
                context: reply.excerpt,
                choices: [],
                createdAt: reply.completed_at,
                status: "open",
                response: null,
                resolvedAt: null,
              })),
            ],
          } satisfies WorkspaceSnapshot;
        }),
      )
      .pipe(Effect.mapError(workspaceError));

  const subscribe = () =>
    Stream.unwrap(
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(changes);
        const afterSequence = yield* eventSink
          .latestSequence()
          .pipe(Effect.mapError(workspaceError));
        const messages = eventSink.stream({ afterSequence, eventType: "message.updated" }).pipe(
          Stream.filter(
            ({ event }) =>
              event.type === "message.updated" &&
              event.payload.role === "user" &&
              ((event.payload.createdBy === "user" &&
                (event.payload.creationSource === "web" ||
                  event.payload.creationSource === "mobile")) ||
                (event.payload.creationSource === "mcp" &&
                  event.payload.senderThreadId !== undefined)),
          ),
          Stream.mapError(workspaceError),
        );
        const delegations = eventSink.stream({ afterSequence, eventType: "subagent.updated" }).pipe(
          Stream.filter(
            ({ event }) =>
              event.type === "subagent.updated" &&
              event.payload.origin === "app_owned" &&
              event.payload.childThreadId !== null,
          ),
          Stream.mapError(workspaceError),
        );
        const completed = eventSink.stream({ afterSequence, eventType: "run.updated" }).pipe(
          Stream.filter(
            ({ event }) =>
              event.type === "run.updated" &&
              ["waiting", "completed", "failed", "interrupted", "cancelled"].includes(
                event.payload.status,
              ),
          ),
          Stream.filterEffect(({ event }) =>
            workspaceItemIdForThread(sql, event.threadId).pipe(
              Effect.map((id) => id !== undefined),
            ),
          ),
          Stream.mapError(workspaceError),
        );
        return Stream.concat(
          Stream.fromEffect(get()),
          Stream.merge(
            Stream.fromSubscription(subscription),
            Stream.merge(Stream.merge(messages, delegations), completed),
          ).pipe(Stream.mapEffect(() => get())),
        );
      }),
    );
  const activeProject = Effect.fn("VisualWorkspace.activeProject")(function* (threadId: ThreadId) {
    const [row] = yield* sql<{
      project_id: string;
    }>`SELECT project_id FROM orchestration_v2_projection_threads
      WHERE thread_id=${threadId} AND deleted_at IS NULL AND archived_at IS NULL`;
    if (!row) return yield* fail("The destination conversation is missing or archived.");
    return ProjectId.make(row.project_id);
  });
  const associate = Effect.fn("VisualWorkspace.associate")(function* (
    threadId: ThreadId,
    itemId: string,
  ) {
    const [owner] = yield* sql<{
      item_id: string;
    }>`SELECT item_id FROM helm_memberships WHERE thread_id=${threadId}`;
    if (owner && owner.item_id !== itemId) {
      const [row] = yield* sql<{
        body: string;
      }>`SELECT body FROM helm_items WHERE id=${owner.item_id}`;
      const source = row && (yield* decodeItem(row.body));
      if (
        !source?.canReassignPrimary ||
        source.secondMateThreadId ||
        source.primaryThreadId !== threadId
      )
        return yield* fail("This thread already belongs to another work item.");
      yield* sql`UPDATE helm_requests SET item_id=${itemId},body=json_set(body,'$.itemId',${itemId})
        WHERE item_id=${owner.item_id}`;
      yield* sql`UPDATE helm_memberships SET item_id=${itemId} WHERE thread_id=${threadId}`;
      yield* sql`DELETE FROM helm_items WHERE id=${owner.item_id}`;
      return source.latestReport;
    }
    yield* sql`INSERT INTO helm_memberships(thread_id,item_id) VALUES (${threadId},${itemId}) ON CONFLICT DO NOTHING`;
    return null;
  });
  const materializeDelegate = Effect.fn("VisualWorkspace.materializeDelegate")(function* (
    id: string,
  ) {
    const [item] = yield* delegatedItems(id);
    if (item) {
      yield* sql`INSERT INTO helm_items(id,body) VALUES (${item.id},${yield* encodeItem(item)})`;
      yield* associate(item.primaryThreadId, item.id);
    }
    return item;
  });
  const readRequest = Effect.fn("VisualWorkspace.readRequest")(function* (id: string) {
    const [row] = yield* sql<{
      body: string;
      delivery_id: string | null;
    }>`SELECT body, delivery_id FROM helm_requests WHERE id=${id}`;
    if (!row) return yield* fail("This request no longer exists.");
    return { request: yield* decodeRequest(row.body), deliveryId: row.delivery_id };
  });
  const saveRequest = Effect.fn("VisualWorkspace.saveRequest")(function* (
    request: WorkspaceRequest,
    deliveryId: string | null,
    reservedId?: string,
  ) {
    yield* sql`UPDATE helm_requests SET body=${yield* encodeRequest(request)}, delivery_id=${deliveryId}
      WHERE id=${request.id} ${reservedId === undefined ? sql`` : sql`AND delivery_id=${reservedId} AND json_extract(body,'$.status')='delivering'`}`;
  });
  const notify = () => PubSub.publish(changes, undefined);
  const reserveReply = Effect.fn("VisualWorkspace.reserveReply")(function* (
    id: string,
    response: string,
  ) {
    const { request, deliveryId: existingId } = yield* readRequest(id);
    if (request.status === "obsolete")
      return yield* fail(request.response ?? "This request is obsolete.");
    if (request.status === "accepted") {
      if (request.response === response) return null;
      return yield* fail("Another answer was already accepted.");
    }
    if (request.status === "delivering" && request.response !== response)
      return yield* fail(
        "Delivery of a different answer has already started. Retry the original response.",
      );
    if (existingId && request.status === "delivering") {
      const [receipt] = yield* sql<{
        status: string;
        accepted_at: string;
      }>`SELECT status,accepted_at FROM orchestration_command_receipts
        WHERE command_id=${`helm:reply:${existingId}`} AND aggregate_kind='thread' AND aggregate_id=${request.threadId}`;
      if (receipt?.status === "accepted") {
        yield* saveRequest(
          {
            ...request,
            status: "accepted",
            resolvedAt: receipt.accepted_at,
            deliveryError: undefined,
          },
          existingId,
          existingId,
        );
        return null;
      }
    }
    const projectId = yield* activeProject(request.threadId);
    const deliveryId = existingId ?? (yield* random.uuidV4());
    yield* saveRequest(
      { ...request, status: "delivering", response, deliveryError: undefined },
      deliveryId,
    );
    return { request, deliveryId, projectId };
  });
  const respond = Effect.fn("VisualWorkspace.respond")(function* (
    id: string,
    response: string,
    sender?: ThreadId,
  ) {
    const reserved = yield* sql.withTransaction(reserveReply(id, response));
    if (!reserved) return;
    const { request, deliveryId, projectId } = reserved;
    const commandId = CommandId.make(`helm:reply:${deliveryId}`);
    yield* notify();
    // A crash between T3's commit and ours retries the same receipt and message identity.
    yield* threads
      .sendToThread({
        projectId,
        threadId: request.threadId,
        commandId,
        messageId: MessageId.make(commandId),
        text: `Reply to "${request.prompt}"\n\n${response}`,
        attachments: [],
        mode: "auto",
        ...(sender
          ? { senderThreadId: sender, createdBy: "agent" as const, creationSource: "mcp" as const }
          : { createdBy: "user" as const, creationSource: "web" as const }),
      })
      .pipe(
        Effect.catch((error) =>
          Effect.gen(function* () {
            const [prior] = yield* sql<{
              status: string;
            }>`SELECT status FROM orchestration_command_receipts
        WHERE command_id=${commandId} AND aggregate_kind='thread' AND aggregate_id=${request.threadId}`;
            if (prior?.status === "accepted") return;
            const detail = error.message || "T3 could not confirm delivery.";
            if (
              prior?.status === "rejected" ||
              error._tag === "ThreadManagementProviderInstanceDisabledError" ||
              error._tag === "OrchestratorCommandRejectedError"
            ) {
              yield* saveRequest(
                { ...request, status: "open", response: null, deliveryError: detail },
                null,
                deliveryId,
              );
            } else {
              yield* saveRequest(
                {
                  ...request,
                  status: "delivering",
                  response,
                  deliveryError: `${detail} Retry the original answer.`,
                },
                deliveryId,
                deliveryId,
              );
            }
            return yield* fail(detail);
          }),
        ),
      );
    yield* saveRequest(
      {
        ...request,
        status: "accepted",
        response,
        resolvedAt: yield* now,
        deliveryError: undefined,
      },
      deliveryId,
      deliveryId,
    );
  });

  const mutate = Effect.fn("VisualWorkspace.mutate")(function* (
    cmd: Exclude<WorkspaceCommand, { type: "respond" | "ensureSecondMate" | "restore" | "retire" }>,
    actor?: { threadId: ThreadId },
    checkpoint = false,
  ) {
    if (actor) {
      if (
        cmd.type === "obsolete" ||
        cmd.type === "orchestrator" ||
        cmd.type === "closeOrchestrator" ||
        cmd.type === "readReply"
      )
        return yield* fail("Only a person can change this setting or close a request.");
      if (cmd.type === "request" || cmd.type === "report") {
        if (cmd.threadId !== actor.threadId) return yield* fail("Publish from the calling thread.");
      } else if (!(yield* orchestrators()).includes(actor.threadId)) {
        const [lead] =
          yield* sql`SELECT 1 FROM helm_task_owners WHERE item_id=${cmd.itemId} AND thread_id=${actor.threadId}`;
        if (!lead || (cmd.type !== "update" && cmd.type !== "artifact" && cmd.type !== "decide"))
          return yield* fail(
            "Only a First Mate can manage the whole board. A task owner manages its own task.",
          );
      }
    }
    if (cmd.type === "orchestrator") {
      yield* activeProject(cmd.threadId);
      yield* sql`INSERT INTO helm_orchestrators(thread_id) VALUES (${cmd.threadId}) ON CONFLICT DO NOTHING`;
      return;
    }
    if (cmd.type === "closeOrchestrator") {
      for (const worker of yield* unassignedWorkspaceDelegates(sql, undefined, cmd.threadId)) {
        yield* sql`INSERT OR IGNORE INTO helm_retained_workers(thread_id,orchestrator_thread_id)
          VALUES (${worker.thread_id},${cmd.threadId})`;
      }
      yield* sql`DELETE FROM helm_orchestrators WHERE thread_id=${cmd.threadId}`;
      return;
    }
    if (cmd.type === "obsolete") {
      const { request, deliveryId } = yield* readRequest(cmd.requestId);
      if (request.status === "obsolete" || request.status === "accepted") return;
      if (request.status === "delivering" && deliveryId) {
        // Reserve rejection in the same transaction as the close. A concurrent T3 commit
        // either wins and keeps its answer, or sees this receipt before writing any message.
        const receipt = yield* eventSink.commitRejectedCommand({
          commandId: CommandId.make(`helm:reply:${deliveryId}`),
          threadId: request.threadId,
          commandType: "message.dispatch",
          rejectedAt: yield* DateTime.now,
          error: cmd.reason,
        });
        if (receipt.status === "accepted") {
          yield* saveRequest(
            {
              ...request,
              status: "accepted",
              resolvedAt: DateTime.formatIso(receipt.acceptedAt),
              deliveryError: undefined,
            },
            deliveryId,
          );
          return;
        }
      }
      yield* saveRequest(
        {
          ...request,
          status: "obsolete",
          response: cmd.reason,
          resolvedAt: yield* now,
          deliveryError: undefined,
        },
        null,
      );
      return;
    }
    if (cmd.type === "readReply") {
      yield* sql`INSERT INTO helm_reply_reads(thread_id,ordinal)
        SELECT thread_id,ordinal FROM helm_owner_ready_replies WHERE item_id=${cmd.itemId} AND run_id=${cmd.replyId}
        ON CONFLICT(thread_id) DO UPDATE SET ordinal=MAX(excluded.ordinal,helm_reply_reads.ordinal)`;
      return;
    }
    const timestamp = yield* now;
    const [row] = yield* sql<{ body: string }>`SELECT body FROM helm_items WHERE id=${cmd.itemId}`;
    if (cmd.type === "create") {
      if (row) {
        const existing = yield* decodeItem(row.body);
        if (existing.primaryThreadId !== cmd.primaryThreadId)
          return yield* fail("This work item already exists.");
        return;
      }
      yield* activeProject(cmd.primaryThreadId);
      const item = newItem(cmd, timestamp);
      yield* sql`INSERT INTO helm_items(id,body) VALUES (${item.id},${yield* encodeItem(item)})`;
      const report = yield* associate(item.primaryThreadId, item.id);
      if (report)
        yield* sql`UPDATE helm_items SET body=${yield* encodeItem({ ...item, latestReport: report })} WHERE id=${item.id}`;
      return;
    }
    const existing = row ? yield* decodeItem(row.body) : yield* materializeDelegate(cmd.itemId);
    if (!existing) return yield* fail("This work item does not exist.");
    if (existing.retiredAt) return yield* fail("Restore the retired task first.");
    let item =
      cmd.type === "report" || cmd.type === "request"
        ? existing
        : { ...existing, canReassignPrimary: undefined };
    const member = (id: ThreadId) =>
      item.primaryThreadId === id ||
      item.secondMateThreadId === id ||
      item.sessions.some((session) => session.threadId === id);
    switch (cmd.type) {
      case "request": {
        if (!member(cmd.threadId))
          return yield* fail("The source thread is not associated with this item.");
        yield* activeProject(cmd.threadId);
        const [duplicate] = yield* sql<{
          body: string;
        }>`SELECT body FROM helm_requests WHERE id=${cmd.requestId}`;
        if (duplicate) {
          const existing = yield* decodeRequest(duplicate.body);
          if (
            existing.itemId !== item.id ||
            existing.threadId !== cmd.threadId ||
            existing.prompt !== cmd.prompt ||
            existing.kind !== cmd.kind ||
            existing.context !== (cmd.context ?? "") ||
            !Equal.equals(existing.choices, cmd.choices ?? [])
          )
            return yield* fail("Another request already uses this ID.");
          return;
        }
        const request: WorkspaceRequest = {
          id: cmd.requestId,
          itemId: item.id,
          threadId: cmd.threadId,
          kind: cmd.kind,
          prompt: cmd.prompt,
          context: cmd.context ?? "",
          choices: cmd.choices ?? [],
          createdAt: timestamp,
          status: "open",
          response: null,
          resolvedAt: null,
        };
        yield* sql`INSERT INTO helm_requests(id,item_id,body) VALUES (${request.id},${item.id},${yield* encodeRequest(request)})`;
        return;
      }
      case "report": {
        if (!member(cmd.threadId))
          return yield* fail("The reporting thread is not associated with this item.");
        const reportedAt = cmd.reportedAt ?? timestamp;
        if (!Number.isFinite(Date.parse(reportedAt)))
          return yield* fail("Use a valid report timestamp.");
        if (cmd.stage === "complete" || cmd.needsAttention === false) {
          yield* sql`UPDATE helm_requests
            SET body=json_set(body,'$.status','obsolete','$.resolvedAt',${timestamp},
              '$.response',${cmd.stage === "complete" ? "The worker marked this work complete." : "The worker resumed."})
            WHERE item_id=${item.id} AND json_extract(body,'$.threadId')=${cmd.threadId}
              AND json_extract(body,'$.status')='open'
              ${checkpoint && cmd.stage !== "complete" ? sql`AND json_extract(body,'$.kind')='attention'` : sql``}`;
        }
        if (cmd.needsAttention === true && cmd.stage !== "complete") {
          const [existing] = yield* sql<{ body: string }>`SELECT body FROM helm_requests
            WHERE item_id=${item.id} AND json_extract(body,'$.threadId')=${cmd.threadId}
              AND json_extract(body,'$.kind')='attention' AND json_extract(body,'$.status')='open'`;
          if (existing) {
            const attention = yield* decodeRequest(existing.body);
            yield* saveRequest({ ...attention, prompt: cmd.text }, null);
          } else {
            const attention: WorkspaceRequest = {
              id: yield* random.uuidV4(),
              itemId: item.id,
              threadId: cmd.threadId,
              kind: "attention",
              prompt: cmd.text,
              context: "",
              choices: [],
              status: "open",
              response: null,
              createdAt: timestamp,
              resolvedAt: null,
            };
            yield* sql`INSERT INTO helm_requests(id,item_id,body)
              VALUES (${attention.id},${item.id},${yield* encodeRequest(attention)})`;
          }
        }
        const owner = workspaceOwnerThreadId(item);
        // Workers and imported files have independent clocks. Arrival at the owning server orders reports.
        item = {
          ...item,
          stage: owner && cmd.threadId !== owner ? item.stage : (cmd.stage ?? item.stage),
          latestReport: {
            threadId: cmd.threadId,
            text: cmd.text,
            format: cmd.format ?? "progress",
            reportedAt,
            receivedAt: timestamp,
          },
        };
        break;
      }
      case "update": {
        for (const dependency of cmd.dependencies ?? []) {
          if (dependency.itemId === item.id) return yield* fail("An item cannot depend on itself.");
          const [exists] = yield* sql`SELECT id FROM helm_items WHERE id=${dependency.itemId}`;
          if (!exists && !(yield* materializeDelegate(dependency.itemId)))
            return yield* fail("The dependency does not exist.");
          yield* sql`UPDATE helm_items SET body=json_remove(body,'$.canReassignPrimary') WHERE id=${dependency.itemId} AND json_extract(body,'$.canReassignPrimary')=1`;
        }
        item = {
          ...item,
          title: cmd.title ?? item.title,
          scope: cmd.scope ?? item.scope,
          stage: cmd.stage ?? item.stage,
          attention: cmd.attention ?? item.attention,
          priority: cmd.priority ?? item.priority,
          dependencies: cmd.dependencies ?? item.dependencies,
        };
        break;
      }
      case "artifact": {
        if (!URL.canParse(cmd.url) || !["https:", "http:"].includes(new URL(cmd.url).protocol))
          return yield* fail("Use an HTTP or HTTPS artifact link.");
        item = {
          ...item,
          artifacts: [
            ...item.artifacts.filter((a) => a.url !== cmd.url),
            { label: cmd.label, url: cmd.url },
          ],
        };
        break;
      }
      case "decide":
        item = {
          ...item,
          decisions: [
            ...item.decisions,
            { text: cmd.text, author: cmd.author, createdAt: timestamp },
          ],
        };
        break;
      case "associate": {
        if (item.directWorker) return yield* fail("Direct tasks have a single worker.");
        yield* activeProject(cmd.threadId);
        if (cmd.threadId === item.primaryThreadId || cmd.threadId === item.secondMateThreadId)
          return yield* fail("This thread already belongs to the task.");
        const report = yield* associate(cmd.threadId, item.id);
        yield* sql`DELETE FROM helm_detached_workers WHERE item_id=${item.id} AND thread_id=${cmd.threadId}`;
        if (
          report &&
          (!item.latestReport ||
            (report.receivedAt ?? report.reportedAt) >=
              (item.latestReport.receivedAt ?? item.latestReport.reportedAt))
        ) {
          item = { ...item, latestReport: report };
        }
        item = {
          ...item,
          sessions: [
            ...item.sessions.filter((s) => s.threadId !== cmd.threadId),
            { threadId: cmd.threadId, role: cmd.role },
          ],
        };
        break;
      }
      case "disassociate": {
        if (cmd.threadId === item.primaryThreadId || cmd.threadId === item.secondMateThreadId)
          return yield* fail("The primary conversation and Second Mate must stay with their task.");
        const requests = yield* sql<{
          body: string;
        }>`SELECT body FROM helm_requests WHERE item_id=${item.id}`;
        for (const r of requests) {
          const req = yield* decodeRequest(r.body);
          if (req.threadId !== cmd.threadId) continue;
          if (req.status === "delivering")
            return yield* fail("Confirm pending answer delivery before removing this worker.");
          if (req.status === "open")
            yield* saveRequest(
              {
                ...req,
                status: "obsolete",
                response: "The source worker was removed.",
                resolvedAt: timestamp,
              },
              null,
            );
        }
        yield* sql`INSERT OR IGNORE INTO helm_detached_workers(item_id,thread_id)
          SELECT item_id,thread_id FROM helm_memberships WHERE item_id=${item.id} AND thread_id=${cmd.threadId}`;
        yield* sql`DELETE FROM helm_memberships WHERE thread_id=${cmd.threadId} AND item_id=${item.id}`;
        item = { ...item, sessions: item.sessions.filter((s) => s.threadId !== cmd.threadId) };
        break;
      }
    }
    yield* sql`UPDATE helm_items SET body=${yield* encodeItem({ ...item, updatedAt: timestamp })} WHERE id=${item.id}`;
    if (cmd.type === "associate") yield* attachWorkspaceDescendants(sql, item.id, cmd.threadId);
  });
  const ensureSecondMate = Effect.fn("VisualWorkspace.ensureSecondMate")(function* (
    itemId: string,
    workerThreadId?: ThreadId,
  ) {
    const [row] = yield* sql<{ body: string }>`SELECT body FROM helm_items WHERE id=${itemId}`;
    const item = row ? yield* decodeItem(row.body) : (yield* delegatedItems(itemId))[0];
    if (!item) return yield* fail("This task does not exist.");
    if (item.retiredAt) {
      if (workerThreadId) return;
      return yield* fail("Restore the retired task first.");
    }
    if (item.directWorker) {
      if (workerThreadId) return;
      return yield* fail("Open this task’s worker conversation directly.");
    }
    const previous = item.secondMateThreadId;
    if (previous && previous === workerThreadId) return;
    let lead = secondMateId(item.id);
    if (previous) {
      const [state] = yield* sql<{
        archived_at: string | null;
        deleted_at: string | null;
      }>`SELECT archived_at, deleted_at FROM orchestration_v2_projection_threads WHERE thread_id=${previous}`;
      if (!state) return yield* fail("The Second Mate chat is missing.");
      if (!state.deleted_at) {
        if (state.archived_at) {
          yield* threads.dispatch({
            type: "thread.unarchive",
            commandId: CommandId.make(yield* random.uuidV4()),
            threadId: previous,
          });
        }
        return previous;
      }
      lead = ThreadId.make(`helm:replacement-mate:${previous}`);
    }

    yield* ensureTaskOwnerThread(
      threads,
      previous ?? item.primaryThreadId,
      lead,
      item.title,
      "Second Mate",
    );
    yield* sql.withTransaction(
      Effect.gen(function* () {
        if (!row && !(yield* materializeDelegate(itemId)))
          return yield* fail("This task is unavailable.");
        if (previous) {
          yield* sql`DELETE FROM helm_memberships WHERE thread_id=${previous} AND item_id=${itemId}`;
          yield* sql`UPDATE helm_requests SET body=json_set(body,'$.status','obsolete','$.resolvedAt',${yield* now},'$.response','The source chat was deleted.')
          WHERE item_id=${itemId} AND json_extract(body,'$.threadId')=${previous} AND json_extract(body,'$.status')='open'`;
        }
        const primaryThreadId = previous === item.primaryThreadId ? lead : item.primaryThreadId;
        yield* sql`UPDATE helm_items SET body=json_set(json_remove(body,'$.canReassignPrimary'),'$.secondMateThreadId',${lead},'$.primaryThreadId',${primaryThreadId}) WHERE id=${item.id}`;
        yield* associate(lead, item.id);
        yield* attachWorkspaceDescendants(sql, item.id);
      }),
    );
    return lead;
  });

  const reviewWorkerRequests = Effect.fn("VisualWorkspace.reviewWorkerRequests")(function* (
    itemId?: string,
  ) {
    const rows = yield* sql<{
      body: string;
      lead: string;
      message_id: string;
    }>`SELECT r.body, t.thread_id AS lead,
      'helm:worker-question:' || json_array(t.thread_id,r.id) AS message_id
      FROM helm_requests r JOIN helm_items i ON i.id=r.item_id
      JOIN orchestration_v2_projection_threads t ON t.thread_id=json_extract(i.body,'$.secondMateThreadId')
      WHERE t.deleted_at IS NULL AND t.archived_at IS NULL AND json_extract(i.body,'$.retiredAt') IS NULL
        AND json_extract(r.body,'$.status')='open' AND json_extract(r.body,'$.threadId')<>t.thread_id
        ${itemId === undefined ? sql`` : sql`AND i.id=${itemId}`}
        AND NOT EXISTS(SELECT 1 FROM orchestration_v2_projection_messages m
          WHERE m.thread_id=t.thread_id AND m.message_id='helm:worker-question:' || json_array(t.thread_id,r.id))
      ORDER BY r.rowid`;
    for (const row of rows) {
      const request = yield* decodeRequest(row.body);
      const dispatch = threads.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(row.message_id),
        messageId: MessageId.make(row.message_id),
        threadId: ThreadId.make(row.lead),
        text: `A worker needs a decision. Use t3_workspace_read on item ${request.itemId} to read request ${request.id}. If still open, answer via t3_workspace_update command respond. Ask the person here and flag your own checkpoint only if you need their input.`,
        notification: {
          source: { kind: "subagent", childThreadId: request.threadId },
          outcome: "updated",
          priority: "blocking",
          summary: "Worker requested a decision",
        },
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "agent",
        creationSource: "server",
      });
      if (itemId !== undefined) yield* dispatch;
      else
        yield* dispatch.pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Resuming a worker question failed", {
              requestId: request.id,
              cause,
            }),
          ),
        );
    }
  });

  const secondMateForWorker = (threadId: ThreadId) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const id = yield* workspaceItemIdForThread(sql, threadId);
        if (!id) return;
        const lead = yield* ensureSecondMate(id, threadId);
        if (lead) {
          yield* reviewWorkerRequests(id);
          yield* notify();
        }
        return lead;
      }).pipe(Effect.mapError(workspaceError)),
    );

  const setRetirement = Effect.fn("VisualWorkspace.setRetirement")(function* (
    cmd: Extract<WorkspaceCommand, { type: "retire" | "restore" }>,
  ) {
    const [row] = yield* sql<{ body: string }>`SELECT body FROM helm_items WHERE id=${cmd.itemId}`;
    const item = row ? yield* decodeItem(row.body) : yield* materializeDelegate(cmd.itemId);
    if (!item) return yield* fail("This task does not exist.");
    if (cmd.type === "restore") {
      if (!item.retiredAt) return;
      yield* sql`DELETE FROM helm_retirement_queue WHERE item_id=${item.id}`;
      yield* sql`UPDATE helm_items SET body=json_remove(json_set(body,'$.updatedAt',${yield* now}),'$.retiredAt') WHERE id=${item.id}`;
      return;
    }
    if (item.retiredAt) return;
    if (cmd.onlyIfDone && item.stage !== "complete")
      return yield* fail("This task is no longer Done. Open Retire task again to confirm.");
    yield* reconcileAccepted();
    const deliveries = yield* sql<{
      id: string;
    }>`SELECT id FROM helm_requests WHERE item_id=${item.id} AND json_extract(body,'$.status')='delivering'`;
    for (const { id } of deliveries)
      yield* mutate({ type: "obsolete", requestId: id, reason: "Task retired." });
    yield* sql`INSERT INTO helm_reply_reads(thread_id,ordinal)
      SELECT thread_id,ordinal FROM helm_owner_ready_replies WHERE item_id=${item.id}
      ON CONFLICT(thread_id) DO UPDATE SET ordinal=MAX(excluded.ordinal,helm_reply_reads.ordinal)`;
    const retiredAt = yield* now;
    yield* sql`UPDATE helm_items SET body=json_remove(json_set(body,'$.retiredAt',${retiredAt},'$.updatedAt',${retiredAt}),'$.canReassignPrimary') WHERE id=${item.id}`;
    yield* sql`WITH RECURSIVE members(id) AS (
      SELECT m.thread_id FROM helm_memberships m WHERE m.item_id=${item.id}
        AND NOT EXISTS(SELECT 1 FROM helm_orchestrators o WHERE o.thread_id=m.thread_id)
      UNION SELECT c.child FROM members parent JOIN helm_worker_children c ON c.parent=parent.id
      WHERE NOT EXISTS(SELECT 1 FROM helm_memberships owned WHERE owned.thread_id=c.child AND owned.item_id<>${item.id})
        AND NOT EXISTS(SELECT 1 FROM helm_orchestrators o WHERE o.thread_id=c.child)
      ) INSERT OR IGNORE INTO helm_memberships(thread_id,item_id) SELECT id,${item.id} FROM members`;
    yield* sql`INSERT OR IGNORE INTO helm_retirement_queue(thread_id,item_id) SELECT m.thread_id,m.item_id FROM helm_memberships m WHERE m.item_id=${item.id}
        AND NOT EXISTS(SELECT 1 FROM helm_orchestrators o WHERE o.thread_id=m.thread_id)`;
    yield* sql`UPDATE helm_requests SET body=json_set(body,'$.status','obsolete','$.resolvedAt',${retiredAt},'$.response','Task retired.') WHERE item_id=${item.id} AND json_extract(body,'$.status')='open'`;
  });

  const command: VisualWorkspace["Service"]["command"] = (cmd, actor) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        if (cmd.type === "respond" || (!actor && cmd.type === "obsolete"))
          yield* reconcileAccepted(cmd.requestId);
        if (cmd.type === "retire" || cmd.type === "restore") {
          if (actor) return yield* fail("Only a person can retire or restore a task.");
          yield* sql.withTransaction(setRetirement(cmd));
          if (cmd.type === "retire")
            yield* finishRetirements({ itemId: cmd.itemId }).pipe(Effect.ensuring(notify()));
          else yield* notify();
        } else if (cmd.type === "ensureSecondMate") {
          if (actor && !(yield* orchestrators()).includes(actor.threadId))
            return yield* fail("Only a First Mate or a person can open a task's Second Mate.");
          yield* ensureSecondMate(cmd.itemId);
          yield* reviewWorkerRequests(cmd.itemId);
          yield* notify();
        } else if (cmd.type === "respond") {
          const { request } = yield* readRequest(cmd.requestId);
          const [task] = yield* sql<{
            lead: string | null;
          }>`SELECT json_extract(body,'$.secondMateThreadId') AS lead FROM helm_items WHERE id=${request.itemId}`;
          if (
            actor &&
            (actor.subagent ||
              !task?.lead ||
              task.lead !== actor.threadId ||
              request.threadId === actor.threadId ||
              cmd.itemId !== request.itemId)
          )
            return yield* fail("Only the task's Second Mate can answer its worker's request.");
          if (!actor && task?.lead && task.lead !== request.threadId)
            return yield* fail("Send your answer to the task's Second Mate.");
          yield* respond(cmd.requestId, cmd.response, actor?.threadId).pipe(
            Effect.uninterruptible,
            Effect.ensuring(notify()),
          );
        } else {
          const asks =
            cmd.type === "request" ||
            (cmd.type === "report" && cmd.needsAttention === true && cmd.stage !== "complete");
          if (
            asks &&
            (!actor || actor.threadId === cmd.threadId) &&
            (yield* workspaceItemIdForThread(sql, cmd.threadId)) === cmd.itemId
          )
            yield* ensureSecondMate(cmd.itemId, cmd.threadId);
          yield* sql.withTransaction(mutate(cmd, actor));
          if (asks || cmd.type === "associate") yield* reviewWorkerRequests(cmd.itemId);
          yield* notify();
        }
        return yield* get();
      }).pipe(Effect.mapError(workspaceError)),
    );

  const checkpoint = Effect.fn("VisualWorkspace.checkpoint")(function* (
    threadId: ThreadId,
    decision: WorkspaceCheckpoint,
  ) {
    if (decision.stage === "complete" && decision.needsAttention) {
      return yield* fail("Choose the current stage while a person still needs to act.");
    }
    const result = yield* lock
      .withPermits(1)(
        Effect.gen(function* () {
          const id = yield* workspaceItemIdForThread(sql, threadId);
          if (!id) return yield* fail("This session has no assigned workspace item.");
          if (decision.needsAttention) yield* ensureSecondMate(id, threadId);
          const result = yield* sql.withTransaction(
            Effect.gen(function* () {
              const [current] = yield* sql`SELECT 1 FROM helm_items i WHERE i.id=${id}
              AND (json_extract(i.body,'$.stage')=${decision.stage} OR (SELECT thread_id FROM helm_task_owners WHERE item_id=${id})<>${threadId})
              AND json_extract(i.body,'$.latestReport.threadId')=${threadId}
              AND json_extract(i.body,'$.latestReport.text')=${decision.summary}
              AND EXISTS(SELECT 1 FROM helm_requests r WHERE r.item_id=i.id
                AND json_extract(r.body,'$.threadId')=${threadId}
                AND json_extract(r.body,'$.kind')='attention' AND json_extract(r.body,'$.status')='open')=${Number(decision.needsAttention)}`;
              if (current) return { id, changed: false };
              yield* mutate(
                {
                  type: "report",
                  itemId: id,
                  threadId,
                  stage: decision.stage,
                  needsAttention: decision.needsAttention,
                  text: decision.summary,
                },
                { threadId },
                true,
              );
              return { id, changed: true };
            }),
          );
          if (decision.needsAttention) yield* reviewWorkerRequests(id);
          return result;
        }),
      )
      .pipe(Effect.mapError(workspaceError));
    if (result.changed) yield* notify();
    return result.id;
  });
  return {
    get,
    finishRetiredSession: (threadId: ThreadId) =>
      lock.withPermits(1)(
        finishRetirements({ threadId }).pipe(Effect.mapError(workspaceError), Effect.asVoid),
      ),
    resumeWorkerQuestions: () =>
      lock.withPermits(1)(
        finishRetirements().pipe(
          Effect.andThen(reviewWorkerRequests()),
          Effect.mapError(workspaceError),
        ),
      ),
    secondMateForWorker,
    command,
    subscribe,
    checkpoint,
    startTask: makeStartWorkspaceTask({ sql, threads, lock, notify, newItem }),
  };
});
export const layer = Layer.effect(VisualWorkspace, makeVisualWorkspace);
