import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import { expect, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as SqlClient from "effect/sql/SqlClient";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as CommandReceipts from "../orchestration-v2/CommandReceiptStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Replay from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Settings from "../serverSettings.ts";
import { makeVisualWorkspace } from "./VisualWorkspace.ts";

const dependencies = Layer.mergeAll(
  Replay.layerWithRegistry(
    { name: "helm-replies" },
    ProviderAdapterRegistry.layerFromAdapters([
      {
        instanceId: ProviderInstanceId.make("codex"),
        driver: ProviderDriverKind.make("codex"),
        getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
        planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
        openSession: () => Effect.die("Effect execution is disabled for workspace receipt tests."),
      },
    ]),
    { databaseLayer: Sqlite.layerMemory, runEffectWorker: false },
  ),
  CommandReceipts.layer.pipe(Layer.provide(Sqlite.layerMemory)),
  Sqlite.layerMemory,
  Settings.layerTest(),
  NodeCrypto.layer,
);
const testLayer = Threads.layer.pipe(Layer.provideMerge(dependencies));
const primary = ThreadId.make("primary");
const worker = ThreadId.make("worker");
const projectId = ProjectId.make("workspace-test");
const fixture = Effect.gen(function* () {
  const t3 = yield* Orchestrator.OrchestratorV2;
  for (const id of [primary, worker]) {
    yield* t3.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`new-${id}`),
      threadId: id,
      projectId,
      title: id,
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "model" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
  }
  const w = yield* makeVisualWorkspace;
  yield* w.command({ type: "create", itemId: "build", primaryThreadId: primary, title: "Build" });
  yield* w.command({ type: "associate", itemId: "build", threadId: worker, role: "review" });
  yield* w.command(
    {
      type: "request",
      itemId: "build",
      requestId: "question",
      threadId: worker,
      kind: "question",
      prompt: "Which branch?",
    },
    { threadId: worker },
  );
  return w;
});

it.effect(
  "concurrent answers commit one message to the source worker and no message to its primary conversation",
  () =>
    Effect.gen(function* () {
      const w = yield* fixture;
      const replies = yield* Effect.forEach(
        ["main", "release"],
        (response) =>
          w.command({ type: "respond", requestId: "question", response }).pipe(Effect.result),
        { concurrency: "unbounded" },
      );
      expect(replies.filter(Result.isSuccess)).toHaveLength(1);
      const request = (yield* w.get()).requests[0]!;
      expect(request.status).toBe("accepted");
      yield* w.command({ type: "respond", requestId: "question", response: request.response! });
      const t3 = yield* Orchestrator.OrchestratorV2;
      const target = yield* t3.getThreadRecords(worker, ["messages"]);
      expect(target.messages.map((m) => m.text)).toEqual([
        `Reply to "Which branch?"\n\n${request.response}`,
      ]);
      expect((yield* t3.getThreadRecords(primary, ["messages"])).messages).toHaveLength(0);
      const sql = yield* SqlClient.SqlClient;
      // The process died after the T3 message committed and before the workspace acknowledgement.
      yield* sql`UPDATE helm_requests SET body=json_set(body,'$.status','delivering','$.resolvedAt',NULL)`;
      const reopened = yield* makeVisualWorkspace;
      expect((yield* reopened.get()).requests[0]).toMatchObject({
        status: "accepted",
        response: request.response,
      });
      expect((yield* t3.getThreadRecords(worker, ["messages"])).messages).toHaveLength(1);
    }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "a reserved but unsent answer survives restart and only the original response may retry",
  () =>
    Effect.gen(function* () {
      yield* fixture;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE helm_requests SET delivery_id='interrupted',body=json_set(body,'$.status','delivering','$.response','main')`;
      const reopened = yield* makeVisualWorkspace;
      expect((yield* reopened.get()).requests[0]).toMatchObject({
        status: "delivering",
        response: "main",
      });
      expect(
        (yield* Effect.flip(
          reopened.command({ type: "respond", requestId: "question", response: "release" }),
        )).message,
      ).toContain("different answer");
      yield* reopened.command({ type: "respond", requestId: "question", response: "main" });
      const t3 = yield* Orchestrator.OrchestratorV2;
      expect((yield* t3.getThreadRecords(worker, ["messages"])).messages.map((m) => m.id)).toEqual([
        "helm:reply:interrupted",
      ]);
    }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "worker replacement preserves accepted scope and prevents stale responses and forged worker reports",
  () =>
    Effect.gen(function* () {
      const w = yield* fixture;
      yield* w.command({
        type: "decide",
        itemId: "build",
        author: "person",
        text: "Only ship the board",
      });
      yield* w.command({ type: "orchestrator", threadId: primary });
      expect(
        (yield* Effect.flip(
          w.command({ type: "update", itemId: "build", stage: "complete" }, { threadId: worker }),
        )).message,
      ).toContain("configured orchestrator");
      expect(
        (yield* Effect.flip(
          w.command(
            { type: "report", itemId: "build", threadId: primary, text: "done" },
            { threadId: worker },
          ),
        )).message,
      ).toContain("calling thread");
      yield* w.command(
        { type: "disassociate", itemId: "build", threadId: worker },
        { threadId: primary },
      );
      const after = yield* (yield* makeVisualWorkspace).get();
      expect(after.items[0]).toMatchObject({
        sessions: [],
        decisions: [{ text: "Only ship the board" }],
      });
      expect(after.requests[0]?.status).toBe("obsolete");
      expect(
        (yield* Effect.flip(
          w.command({ type: "respond", requestId: "question", response: "main" }),
        )).message,
      ).toContain("removed");
    }).pipe(Effect.provide(testLayer)),
);

it.effect("subscribers see new worker requests and reconnect with the same request IDs", () =>
  Effect.gen(function* () {
    const workspace = yield* fixture;
    const ready = yield* Deferred.make<void>();
    const updates = yield* workspace.subscribe().pipe(
      Stream.tap(() => Deferred.succeed(ready, undefined)),
      Stream.map((snapshot) => snapshot.requests.map((request) => request.id)),
      Stream.take(2),
      Stream.runCollect,
      Effect.forkChild,
    );
    yield* Deferred.await(ready);
    const command = {
      type: "request",
      itemId: "build",
      threadId: worker,
      kind: "review",
      prompt: "Review the branch?",
      requestId: "review-ready",
      choices: ["Ready", "Needs changes"],
    } as const;
    yield* workspace.command(command, { threadId: worker });
    expect(yield* Fiber.join(updates)).toEqual([["question"], ["question", "review-ready"]]);
    yield* workspace.command(command, { threadId: worker });
    expect(
      (yield* Effect.flip(
        workspace.command({ ...command, choices: ["Other"] }, { threadId: worker }),
      )).message,
    ).toContain("already uses");
    const restored = yield* (yield* makeVisualWorkspace)
      .subscribe()
      .pipe(Stream.take(1), Stream.runCollect);
    expect(restored[0]?.requests.map((request) => request.id)).toEqual([
      "question",
      "review-ready",
    ]);
  }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "closing a stalled delivery on an archived worker rejects even a late retry of its T3 command",
  () =>
    Effect.gen(function* () {
      const workspace = yield* fixture;
      const sql = yield* SqlClient.SqlClient;
      const t3 = yield* Orchestrator.OrchestratorV2;
      yield* sql`UPDATE helm_requests SET delivery_id='late',body=json_set(body,'$.status','delivering','$.response','main')`;
      yield* t3.dispatch({
        type: "thread.archive",
        commandId: CommandId.make("archive-before-close"),
        threadId: worker,
      });
      const closed = yield* workspace.command({
        type: "obsolete",
        requestId: "question",
        reason: "Worker retired.",
      });
      expect(closed.requests[0]).toMatchObject({ status: "obsolete", response: "Worker retired." });
      yield* t3.dispatch({
        type: "thread.unarchive",
        commandId: CommandId.make("restore-worker"),
        threadId: worker,
      });
      const threads = yield* Threads.ThreadManagementService;
      const error = yield* Effect.flip(
        threads.sendToThread({
          projectId,
          threadId: worker,
          commandId: CommandId.make("helm:reply:late"),
          messageId: MessageId.make("helm:reply:late"),
          attachments: [],
          createdBy: "user",
          creationSource: "web",
          mode: "auto",
          text: "main",
        }),
      );
      expect(error._tag).toBe("OrchestratorCommandPreviouslyRejectedError");
      expect((yield* t3.getThreadRecords(worker, ["messages"])).messages).toHaveLength(0);
    }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "closing or retrying after T3 accepted a reply restores that answer even after its worker is archived",
  () =>
    Effect.gen(function* () {
      const workspace = yield* fixture;
      const sql = yield* SqlClient.SqlClient;
      const t3 = yield* Orchestrator.OrchestratorV2;
      yield* workspace.command({ type: "respond", requestId: "question", response: "main" });
      yield* t3.dispatch({
        type: "thread.archive",
        commandId: CommandId.make("archive-after-send"),
        threadId: worker,
      });
      for (const cmd of [
        { type: "obsolete", requestId: "question", reason: "Too late" },
        { type: "respond", requestId: "question", response: "main" },
      ] as const) {
        yield* sql`UPDATE helm_requests SET body=json_set(body,'$.status','delivering','$.resolvedAt',NULL)`;
        expect((yield* workspace.command(cmd)).requests[0]).toMatchObject({
          status: "accepted",
          response: "main",
        });
      }
      expect((yield* t3.getThreadRecords(worker, ["messages"])).messages).toHaveLength(1);
    }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "the server orders observed reports independently of a worker's clock or file modification time",
  () =>
    Effect.gen(function* () {
      const workspace = yield* fixture;
      yield* workspace.command({
        type: "report",
        itemId: "build",
        threadId: worker,
        text: "Ahead clock",
        reportedAt: "2099-01-01T00:00:00Z",
      });
      for (const threadId of [primary, worker]) {
        const result = yield* workspace.command({
          type: "report",
          itemId: "build",
          threadId,
          text: "Observed now",
          format: "legacy",
          reportedAt: "2001-01-01T00:00:00Z",
        });
        expect(result.items[0]?.latestReport).toMatchObject({
          threadId,
          text: "Observed now",
          format: "legacy",
          reportedAt: "2001-01-01T00:00:00Z",
          receivedAt: expect.any(String),
        });
      }
    }).pipe(Effect.provide(testLayer)),
);
