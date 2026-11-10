import {
  CommandId,
  MessageId,
  RunId,
  type OrchestrationV2DomainEvent,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import { VisualWorkspace } from "./VisualWorkspace.ts";

const encodeReviewKey = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)));

type WorkerSignal = "question" | "plan" | "failure";

export const makeWorkerReview = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const workspace = yield* VisualWorkspace;
  const engine = yield* Orchestrator.OrchestratorV2;
  const review = Effect.fn("workspace.reviewWorkerSignal")(function* (
    worker: ThreadId,
    kind: WorkerSignal,
    id: string,
  ) {
    const lead = yield* workspace.secondMateForWorker(worker);
    if (!lead) return false;
    const key = yield* encodeReviewKey([lead, worker, kind, id]);
    const messageId = MessageId.make(`helm:worker-review:${key}`);
    const [delivered] = yield* sql`SELECT 1 FROM orchestration_v2_projection_messages
      WHERE message_id=${messageId} AND thread_id=${lead}`;
    if (delivered) return true;
    const instruction = {
      question: `Read the worker's question with t3_pending_request action read, threadId ${worker}, requestId ${id}. Answer with action respond if the task already establishes the answer. If it is still pending and needs the person's judgment, ask in your own chat and set your workspace checkpoint needsAttention to true. Relay their reply to that request.`,
      plan: `Review the proposed plan ${id} in worker chat ${worker} against the task. Give the worker direction, and flag your own chat only for a decision the person needs to make.`,
      failure: `Worker ${worker} reported a failed run (${id}). Check the current worker state and handle recovery. Flag your own chat only if the person needs to act.`,
    }[kind];
    yield* engine.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`server:worker-review:${key}`),
      threadId: lead,
      messageId,
      text: instruction,
      notification: {
        source: { kind: "subagent", childThreadId: worker },
        outcome: "updated",
        summary: `Worker ${kind} for Second Mate review`,
      },
      attachments: [],
      dispatchMode: { type: "queue_after_active" },
      createdBy: "agent",
      creationSource: "server",
    });
    return true;
  });

  const cancelQueuedQuestion = Effect.fn("workspace.cancelQueuedWorkerQuestion")(function* (
    worker: ThreadId,
    requestId: string,
  ) {
    const [queued] = yield* sql<{ thread_id: string; run_id: string }>`
      SELECT r.thread_id,r.run_id FROM helm_memberships m JOIN helm_items i ON i.id=m.item_id
      JOIN orchestration_v2_projection_runs r ON r.thread_id=json_extract(i.body,'$.secondMateThreadId')
      WHERE m.thread_id=${worker} AND r.status='queued' AND json_extract(r.payload_json,'$.userMessageId')=
        'helm:worker-review:' || json_array(r.thread_id,${worker},'question',${requestId})`;
    if (queued) {
      yield* engine.dispatch({
        type: "queued-run.cancel",
        threadId: ThreadId.make(queued.thread_id),
        runId: RunId.make(queued.run_id),
        commandId: CommandId.make(`server:cancel-worker-review:${queued.run_id}`),
      });
    }
    return false;
  });

  const handle = (event: OrchestrationV2DomainEvent) => {
    if (
      event.type === "thread.created" ||
      (event.type === "message.updated" &&
        event.payload.role === "user" &&
        event.payload.creationSource === "mcp")
    ) {
      return workspace.finishRetiredSession(event.threadId).pipe(Effect.as(false));
    }
    if (event.type === "runtime-request.updated" && event.payload.kind === "user_input") {
      return event.payload.status === "pending"
        ? review(event.threadId, "question", event.payload.id)
        : cancelQueuedQuestion(event.threadId, event.payload.id);
    }
    if (
      event.type === "plan.updated" &&
      event.payload.kind === "proposed_plan" &&
      event.payload.status === "active"
    )
      return review(event.threadId, "plan", event.payload.id);
    if (event.type === "run.updated" && event.payload.status === "failed")
      return review(event.threadId, "failure", event.payload.id);
    return Effect.succeed(false);
  };
  const recover = Effect.fn("workspace.recoverWorkerReviews")(function* () {
    yield* workspace
      .resumeWorkerQuestions()
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Recovering workspace questions failed", { cause }),
        ),
      );
    const signals = yield* sql<{ thread_id: string; kind: WorkerSignal; id: string }>`
      WITH signals(thread_id,kind,id) AS (
        SELECT thread_id,'question',runtime_request_id FROM orchestration_v2_projection_runtime_requests WHERE kind='user_input' AND status='pending'
        UNION ALL SELECT thread_id,'plan',plan_id FROM orchestration_v2_projection_plans WHERE kind='proposed_plan' AND status='active'
        UNION ALL SELECT r.thread_id,'failure',r.run_id FROM orchestration_v2_projection_runs r WHERE r.status='failed'
          AND NOT EXISTS(SELECT 1 FROM orchestration_v2_projection_runs newer WHERE newer.thread_id=r.thread_id AND newer.ordinal>r.ordinal)
      )
      SELECT s.* FROM signals s JOIN helm_memberships m ON m.thread_id=s.thread_id
      JOIN helm_items i ON i.id=m.item_id JOIN orchestration_v2_projection_threads t ON t.thread_id=s.thread_id
      WHERE t.archived_at IS NULL AND t.deleted_at IS NULL AND s.thread_id IS NOT json_extract(i.body,'$.secondMateThreadId')`;
    for (const signal of signals) {
      yield* review(ThreadId.make(signal.thread_id), signal.kind, signal.id).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Recovering a worker review failed", {
            threadId: signal.thread_id,
            cause,
          }),
        ),
      );
    }
  });
  return { handle, recover };
});
