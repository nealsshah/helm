import {
  CommandId,
  MessageId,
  type ProjectId,
  ThreadId,
  WorkItem,
  WorkspaceError,
  type WorkspaceCommand,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as Semaphore from "effect/Semaphore";
import type * as SqlClient from "effect/sql/SqlClient";
import type { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import { unassignedWorkspaceDelegates } from "./VisualWorkspaceSchema.ts";

const isWorkspaceError = Schema.is(WorkspaceError);
const encodeItem = Schema.encodeEffect(Schema.fromJsonString(WorkItem));
export const secondMateId = (itemId: string) => ThreadId.make(`helm:second-mate:${itemId}`);
const failure = (message: string) => new WorkspaceError({ message });

export const ensureMateThread = Effect.fn("VisualWorkspace.ensureMateThread")(function* (
  threads: ThreadManagementService["Service"],
  sourceThreadId: ThreadId,
  leadId: ThreadId,
  title: string,
  destination?: ProjectId,
) {
  const { thread: source } = yield* threads.getThreadRecords(sourceThreadId, []);
  const projectId = destination ?? source.projectId;
  const existing = yield* threads.getThreadShell(leadId);
  if (existing) {
    if (
      existing.archivedAt ||
      existing.projectId !== projectId ||
      existing.creationSource !== "server"
    ) {
      return yield* failure("The Second Mate chat is unavailable.");
    }
  } else {
    yield* threads.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`helm:create:${leadId}`),
      threadId: leadId,
      projectId,
      title: `Second Mate · ${title}`,
      modelSelection: source.modelSelection,
      runtimeMode: source.runtimeMode,
      interactionMode: "default",
      branch: projectId === source.projectId ? source.branch : null,
      worktreePath: projectId === source.projectId ? source.worktreePath : null,
      createdBy: "agent",
      creationSource: "server",
    });
  }
  return projectId;
});

export function makeStartWorkspaceTask({
  sql,
  threads,
  lock,
  notify,
  newItem,
}: {
  sql: SqlClient.SqlClient;
  threads: ThreadManagementService["Service"];
  lock: Semaphore.Semaphore;
  notify: () => Effect.Effect<boolean>;
  newItem: (cmd: Extract<WorkspaceCommand, { type: "create" }>, timestamp: string) => WorkItem;
}) {
  return Effect.fn("VisualWorkspace.startTask")(function* (
    firstMateThreadId: ThreadId,
    task: { itemId: string; title: string; brief: string; project?: string | undefined },
  ) {
    const lead = secondMateId(task.itemId);
    const kickoff = MessageId.make(`helm:kickoff:${task.itemId}`);
    return yield* lock
      .withPermits(1)(
        Effect.gen(function* () {
          const [registered] =
            yield* sql`SELECT 1 FROM helm_orchestrators o JOIN orchestration_v2_projection_threads t USING(thread_id)
                WHERE o.thread_id=${firstMateThreadId} AND t.deleted_at IS NULL AND t.archived_at IS NULL`;
          if (!registered)
            return yield* failure("Only an open First Mate can start a workspace task.");
          const [saved] = yield* sql<{
            retired_at: string | null;
            primary_id: string;
            brief: string;
            lead_id: string | null;
          }>`SELECT json_extract(body,'$.retiredAt') AS retired_at, json_extract(body,'$.primaryThreadId') AS primary_id,
        json_extract(body,'$.scope') AS brief, json_extract(body,'$.secondMateThreadId') AS lead_id FROM helm_items WHERE id=${task.itemId}`;
          if (saved?.retired_at) return yield* failure("Restore the retired task first.");
          if (
            saved
              ? saved.lead_id !== lead || saved.primary_id !== lead
              : (yield* unassignedWorkspaceDelegates(sql, task.itemId)).length > 0
          ) {
            return yield* failure("This task ID already belongs to another task.");
          }
          let destination: ProjectId | undefined;
          if (task.project !== undefined) {
            const matches = yield* sql<{
              project_id: ProjectId;
            }>`SELECT project_id FROM projection_projects
              WHERE deleted_at IS NULL AND archived_at IS NULL
              AND (project_id=${task.project} OR workspace_root=${task.project} OR title=${task.project} COLLATE NOCASE)
              LIMIT 2`;
            if (!matches[0])
              return yield* failure(
                `No active project matches "${task.project}". Check the registered project name or path.`,
              );
            if (matches.length > 1)
              return yield* failure(
                `Multiple projects match "${task.project}". Use the project's full path or ID.`,
              );
            destination = matches[0].project_id;
          }
          const projectId = yield* ensureMateThread(
            threads,
            firstMateThreadId,
            lead,
            task.title,
            destination,
          );
          if (!saved) {
            const item = newItem(
              {
                type: "create",
                itemId: task.itemId,
                primaryThreadId: lead,
                title: task.title,
                scope: task.brief,
              },
              DateTime.formatIso(yield* DateTime.now),
            );
            const body = yield* encodeItem({ ...item, secondMateThreadId: lead });
            yield* sql.withTransaction(
              Effect.gen(function* () {
                yield* sql`INSERT INTO helm_items(id,body) VALUES (${task.itemId},${body})`;
                yield* sql`INSERT INTO helm_memberships(thread_id,item_id) VALUES (${lead},${task.itemId})`;
              }),
            );
            yield* notify();
          }
          const [sent] = yield* sql<{
            sender: string;
            text: string;
          }>`SELECT json_extract(payload_json,'$.senderThreadId') AS sender,
        json_extract(payload_json,'$.text') AS text FROM orchestration_v2_projection_messages WHERE thread_id=${lead} AND message_id=${kickoff}`;
          if (
            sent
              ? sent.sender !== firstMateThreadId || sent.text !== task.brief
              : saved && saved.brief !== task.brief
          ) {
            return yield* failure(
              "This task ID already has a different kickoff. Send a follow-up to its Second Mate.",
            );
          }
          if (!sent)
            yield* threads.sendToThread({
              projectId,
              threadId: lead,
              senderThreadId: firstMateThreadId,
              commandId: CommandId.make(kickoff),
              messageId: kickoff,
              text: task.brief,
              attachments: [],
              mode: "auto",
              createdBy: "agent",
              creationSource: "mcp",
            });
          return { itemId: task.itemId, secondMateThreadId: lead };
        }),
      )
      .pipe(
        Effect.mapError((error) =>
          isWorkspaceError(error)
            ? error
            : failure(error instanceof Error ? error.message : "Could not start this task."),
        ),
      );
  });
}
