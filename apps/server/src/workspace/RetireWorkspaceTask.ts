import { CommandId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as SqlClient from "effect/sql/SqlClient";
import {
  isActiveRun,
  ThreadManagementService,
} from "../orchestration-v2/ThreadManagementService.ts";

export const makeTaskRetirement = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const threads = yield* ThreadManagementService;
  const random = yield* SecureRandom.SecureRandom;

  const settle = Effect.fn("VisualWorkspace.settleRetiredSession")(function* (threadId: ThreadId) {
    const shell = yield* threads.getThreadShell(threadId);
    if (!shell || shell.archivedAt || shell.deletedAt) return;
    yield* threads.dispatch({
      type: "thread.stop",
      commandId: CommandId.make(yield* random.uuidV4()),
      threadId,
      reason: "Workspace task retired.",
      stopDelegatedTasks: false,
    });
    const { runs } = yield* threads.getThreadRecords(threadId, ["runs"]);
    for (const run of runs) {
      if (run.status === "queued") {
        yield* threads.dispatch({
          type: "queued-run.cancel",
          threadId,
          runId: run.id,
          commandId: CommandId.make(yield* random.uuidV4()),
        });
      } else if (isActiveRun(run)) {
        yield* threads.forceStopThread({ threadId, runId: run.id });
      }
    }
    const { runtimeRequests } = yield* threads.getThreadRecords(threadId, ["runtimeRequests"], {
      runtimeRequestStatuses: ["pending"],
    });
    for (const request of runtimeRequests) {
      if (request.responseCapability.type === "live") {
        yield* threads.dispatch({
          type: "runtime-request.respond",
          threadId,
          requestId: request.id,
          decision: "cancel",
          commandId: CommandId.make(yield* random.uuidV4()),
        });
      }
    }
    yield* threads.dispatch({
      type: "thread.settle",
      threadId,
      commandId: CommandId.make(yield* random.uuidV4()),
    });
  });

  return Effect.fn("VisualWorkspace.finishTaskRetirements")(function* (filter?: {
    itemId?: string;
    threadId?: ThreadId;
  }) {
    const pending = yield* sql<{
      thread_id: string;
    }>`SELECT q.thread_id FROM helm_retirement_queue q
      JOIN helm_items i ON i.id=q.item_id WHERE json_extract(i.body,'$.retiredAt') IS NOT NULL
      ${filter?.itemId ? sql`AND q.item_id=${filter.itemId}` : sql``}
      ${filter?.threadId ? sql`AND q.thread_id=${filter.threadId}` : sql``}
      ORDER BY q.thread_id IS NOT json_extract(i.body,'$.secondMateThreadId'),q.rowid`;
    for (const row of pending) {
      const finish = settle(ThreadId.make(row.thread_id)).pipe(
        Effect.andThen(sql`DELETE FROM helm_retirement_queue WHERE thread_id=${row.thread_id}`),
      );
      if (filter?.itemId) yield* finish;
      else
        yield* finish.pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Could not settle a retired workspace session", {
              threadId: row.thread_id,
              cause,
            }),
          ),
        );
    }
  });
});
