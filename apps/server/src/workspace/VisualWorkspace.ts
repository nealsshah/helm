import * as SecureRandom from "effect/crypto/SecureRandom";
import {
  CommandId,
  MessageId,
  ProjectId,
  ThreadId,
  WorkItem,
  WorkspaceError,
  WorkspaceRequest,
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

export class VisualWorkspace extends Context.Service<
  VisualWorkspace,
  {
    readonly get: () => Effect.Effect<WorkspaceSnapshot, WorkspaceError>;
    readonly subscribe: () => Stream.Stream<WorkspaceSnapshot, WorkspaceError>;
    readonly command: (
      command: WorkspaceCommand,
      actor?: { threadId: ThreadId },
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
  const get = () =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const items = yield* sql<{ body: string }>`SELECT body FROM helm_items ORDER BY rowid`;
          const requests = yield* sql<{
            body: string;
          }>`SELECT body FROM helm_requests ORDER BY rowid`;
          return {
            orchestratorThreadIds: yield* orchestrators(),
            items: yield* Effect.forEach(items, (row) => decodeItem(row.body)),
            requests: yield* Effect.forEach(requests, (row) => decodeRequest(row.body)),
          } satisfies WorkspaceSnapshot;
        }),
      )
      .pipe(Effect.mapError(workspaceError));

  const subscribe = () =>
    Stream.unwrap(
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(changes);
        return Stream.concat(
          Stream.fromEffect(get()),
          Stream.fromSubscription(subscription).pipe(Stream.mapEffect(get)),
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
    if (owner && owner.item_id !== itemId)
      return yield* fail("This thread already belongs to another work item.");
    yield* sql`INSERT INTO helm_memberships(thread_id,item_id) VALUES (${threadId},${itemId}) ON CONFLICT DO NOTHING`;
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
  const respond = Effect.fn("VisualWorkspace.respond")(function* (id: string, response: string) {
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
        createdBy: "user",
        creationSource: "web",
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
    cmd: Exclude<WorkspaceCommand, { type: "respond" }>,
    actor?: { threadId: ThreadId },
  ) {
    if (actor) {
      if (
        cmd.type === "obsolete" ||
        cmd.type === "orchestrator" ||
        cmd.type === "closeOrchestrator"
      )
        return yield* fail("Only a person can change this setting or close a request.");
      if (cmd.type === "request" || cmd.type === "report") {
        if (cmd.threadId !== actor.threadId) return yield* fail("Publish from the calling thread.");
      } else if (!(yield* orchestrators()).includes(actor.threadId)) {
        return yield* fail(
          "Only a workspace orchestrator can manage workspace items. To move your assigned card, include stage in a report from your thread.",
        );
      }
    }
    if (cmd.type === "orchestrator") {
      yield* activeProject(cmd.threadId);
      yield* sql`INSERT INTO helm_orchestrators(thread_id) VALUES (${cmd.threadId}) ON CONFLICT DO NOTHING`;
      return;
    }
    if (cmd.type === "closeOrchestrator") {
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
      const item: WorkItem = {
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
      yield* sql`INSERT INTO helm_items(id,body) VALUES (${item.id},${yield* encodeItem(item)})`;
      yield* associate(item.primaryThreadId, item.id);
      return;
    }
    if (!row) return yield* fail("This work item does not exist.");
    let item = yield* decodeItem(row.body);
    const member = (id: ThreadId) =>
      item.primaryThreadId === id || item.sessions.some((session) => session.threadId === id);
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
        if (cmd.stage === "complete") {
          yield* sql`UPDATE helm_requests
            SET body=json_set(body,'$.status','obsolete','$.resolvedAt',${timestamp},
              '$.response','The worker marked this work complete.')
            WHERE item_id=${item.id} AND json_extract(body,'$.threadId')=${cmd.threadId}
              AND json_extract(body,'$.status')='open'`;
        }
        // Workers and imported files have independent clocks. Arrival at the owning server orders reports.
        item = {
          ...item,
          stage: cmd.stage ?? item.stage,
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
          if (!exists) return yield* fail("The dependency does not exist.");
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
      case "associate":
        yield* activeProject(cmd.threadId);
        if (cmd.threadId === item.primaryThreadId)
          return yield* fail("This thread is already the primary conversation.");
        yield* associate(cmd.threadId, item.id);
        item = {
          ...item,
          sessions: [
            ...item.sessions.filter((s) => s.threadId !== cmd.threadId),
            { threadId: cmd.threadId, role: cmd.role },
          ],
        };
        break;
      case "disassociate": {
        if (cmd.threadId === item.primaryThreadId)
          return yield* fail("The primary conversation must stay with its item.");
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
        yield* sql`DELETE FROM helm_memberships WHERE thread_id=${cmd.threadId} AND item_id=${item.id}`;
        item = { ...item, sessions: item.sessions.filter((s) => s.threadId !== cmd.threadId) };
        break;
      }
    }
    yield* sql`UPDATE helm_items SET body=${yield* encodeItem({ ...item, updatedAt: timestamp })} WHERE id=${item.id}`;
  });
  const command: VisualWorkspace["Service"]["command"] = (cmd, actor) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        if (!actor && (cmd.type === "respond" || cmd.type === "obsolete"))
          yield* reconcileAccepted(cmd.requestId);
        if (cmd.type === "respond") {
          if (actor) return yield* fail("Only a person can answer a request.");
          yield* respond(cmd.requestId, cmd.response).pipe(
            Effect.uninterruptible,
            Effect.ensuring(notify()),
          );
        } else {
          yield* sql.withTransaction(mutate(cmd, actor));
          yield* notify();
        }
        return yield* get();
      }).pipe(Effect.mapError(workspaceError)),
    );

  return { get, command, subscribe };
});
export const layer = Layer.effect(VisualWorkspace, makeVisualWorkspace);
