import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { ClaudeProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import { expect, it } from "@effect/vitest";
import {
  CommandId,
  type OrchestrationV2Run,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  WorkspaceAgentCommand,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as CommandReceipts from "../orchestration-v2/CommandReceiptStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import { EventSinkV2 } from "../orchestration-v2/EventSink.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Replay from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Settings from "../serverSettings.ts";
import { makeVisualWorkspace } from "./VisualWorkspace.ts";
import { ensureWorkspaceSchema, workspaceRoleForThread } from "./VisualWorkspaceSchema.ts";

const dependencies = Layer.mergeAll(
  Replay.layerWithRegistry(
    { name: "helm-replies" },
    ProviderAdapterRegistry.layerFromAdapters(
      (
        [
          ["codex", CodexProviderCapabilitiesV2],
          ["claudeAgent", ClaudeProviderCapabilitiesV2],
        ] as const
      ).map(([driver, capabilities]) => ({
        instanceId: ProviderInstanceId.make(driver),
        driver: ProviderDriverKind.make(driver),
        getCapabilities: () => Effect.succeed(capabilities),
        planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
        openSession: () => Effect.die("Effect execution is disabled for workspace receipt tests."),
      })),
    ),
    { databaseLayer: Sqlite.layerMemory, runEffectWorker: false },
  ),
  CommandReceipts.layer.pipe(Layer.provide(Sqlite.layerMemory)),
  Sqlite.layerMemory,
  Settings.layerTest(),
  NodeCrypto.layer,
);
const testLayer = Threads.layer.pipe(Layer.provideMerge(dependencies));
const decodeCommand = Schema.decodeUnknownEffect(WorkspaceAgentCommand);
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
  const sql = yield* SqlClient.SqlClient;
  // Existing installations can have open questions that predate their task's Second Mate.
  yield* sql`INSERT INTO helm_requests(id,item_id,body) VALUES('question','build',${JSON.stringify({
    id: "question",
    itemId: "build",
    threadId: worker,
    kind: "question",
    prompt: "Which branch?",
    context: "",
    choices: [],
    status: "open",
    createdAt: DateTime.formatIso(yield* DateTime.now),
    resolvedAt: null,
    response: null,
  })})`;
  return w;
});

it.effect(
  "retires all sessions, including busy workers, and restores the task without restarting work",
  () =>
    Effect.gen(function* () {
      const workspace = yield* fixture;
      const t3 = yield* Orchestrator.OrchestratorV2;
      const lead = (yield* workspace.command({ type: "ensureSecondMate", itemId: "build" }))
        .items[0]!.secondMateThreadId!;
      for (const [id, title] of [
        ["active", "work"],
        ["queued", "follow up"],
      ] as const) {
        yield* t3.dispatch({
          type: "message.dispatch",
          threadId: worker,
          commandId: CommandId.make(id),
          messageId: MessageId.make(id),
          text: title,
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          createdBy: "user",
          creationSource: "web",
        });
      }
      const launchWorker = Effect.fnUntraced(function* (title: string) {
        const child = ThreadId.make(title);
        yield* t3.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`create-${title}`),
          threadId: child,
          projectId,
          title,
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "model" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdBy: "agent",
          creationSource: "mcp",
        });
        yield* t3.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`send-${title}`),
          threadId: child,
          senderThreadId: worker,
          messageId: MessageId.make(`send-${title}`),
          text: "Review",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "agent",
          creationSource: "mcp",
        });
        return child;
      });
      const grandchild = yield* launchWorker("nested");
      const separate = yield* launchWorker("separate");
      yield* workspace.command({
        type: "create",
        itemId: "other",
        title: "Independent task",
        primaryThreadId: separate,
      });
      const firstMate = yield* launchWorker("first-mate");
      yield* workspace.command({ type: "orchestrator", threadId: firstMate });

      const retire = { type: "retire", itemId: "build" } as const;
      expect(
        (yield* Effect.flip(workspace.command({ ...retire, onlyIfDone: true }))).message,
      ).toContain("Done");
      expect((yield* Effect.flip(workspace.command(retire, { threadId: lead }))).message).toContain(
        "person",
      );
      const snapshot = yield* workspace.command(retire);
      const original = snapshot.items[0]!;
      expect(original.retiredAt).toBeTruthy();
      for (const id of [primary, worker, lead, grandchild]) {
        const records = yield* t3.getThreadRecords(id, ["runs"]);
        expect(records.thread.settledOverride).toBe("settled");
        expect(
          records.runs.every((run) =>
            ["interrupted", "cancelled", "completed"].includes(run.status),
          ),
        ).toBe(true);
      }
      for (const id of [separate, firstMate]) {
        expect((yield* t3.getThreadRecords(id, [])).thread.settledOverride).toBeNull();
      }
      expect((yield* workspace.command(retire)).items[0]?.retiredAt).toBe(original.retiredAt);
      expect(yield* workspace.secondMateForWorker(worker)).toBeUndefined();
      expect(
        (yield* workspace.get({ includeWorkerRequests: true })).requests.some(
          (req) => req.status === "open",
        ),
      ).toBe(false);
      const late = yield* launchWorker("late");
      const restarted = yield* makeVisualWorkspace;
      yield* restarted.resumeWorkerQuestions();
      expect((yield* t3.getThreadRecords(late, [])).thread.settledOverride).toBe("settled");
      const restored = (yield* workspace.command({ type: "restore", itemId: "build" })).items[0]!;
      expect(restored.retiredAt).toBeUndefined();
      expect(restored.stage).toBe(original.stage);
      expect(restored.secondMateThreadId).toBe(lead);
      expect((yield* t3.getThreadRecords(worker, [])).thread.settledOverride).toBe("settled");
    }).pipe(Effect.provide(testLayer)),
);

it.effect("a worker privately asks a Second Mate, who can answer or ask the person", () =>
  Effect.gen(function* () {
    const workspace = yield* fixture;
    const checkpoint = {
      stage: "building",
      needsAttention: true,
      summary: "Which environment should I build for?",
    } as const;
    yield* workspace.checkpoint(worker, checkpoint);
    const snapshot = yield* workspace.get();
    const lead = snapshot.items[0]!.secondMateThreadId!;
    expect(lead).toBeDefined();
    expect(snapshot.requests).toEqual([]);
    const inbox = (yield* workspace.get({ includeWorkerRequests: true })).requests;
    const question = inbox.find((request) => request.prompt === checkpoint.summary)!;
    const t3 = yield* Orchestrator.OrchestratorV2;
    yield* workspace.checkpoint(worker, checkpoint);
    const sql = yield* SqlClient.SqlClient;
    // The request committed before its wake reached the lead.
    yield* sql`INSERT INTO helm_requests(id,item_id,body)
      SELECT 'missed-wake',item_id,json_set(body,'$.id','missed-wake') FROM helm_requests WHERE id=${question.id}`;
    const restarted = yield* makeVisualWorkspace;
    yield* restarted.resumeWorkerQuestions();
    yield* restarted.resumeWorkerQuestions();
    const messages = (yield* t3.getThreadRecords(lead, ["messages"])).messages;
    expect(messages.filter((message) => message.text.includes(question.id))).toHaveLength(1);
    expect(
      messages.find((message) => message.text.includes(question.id))?.notification?.priority,
    ).toBe("blocking");
    expect(messages.filter((message) => message.text.includes("missed-wake"))).toHaveLength(1);
    yield* workspace.checkpoint(lead, {
      ...checkpoint,
      summary: "Do you want the Mac release first?",
    });
    expect((yield* workspace.get()).requests.map((request) => request.threadId)).toEqual([lead]);
    const threads = yield* Threads.ThreadManagementService;
    yield* threads.sendToThread({
      projectId,
      threadId: lead,
      commandId: CommandId.make("answer-lead"),
      messageId: MessageId.make("answer-lead"),
      text: "Yes. Start with the Mac release.",
      attachments: [],
      mode: "queue",
      createdBy: "user",
      creationSource: "web",
    });
    expect((yield* workspace.get()).requests.map((request) => request.status)).toEqual([
      "accepted",
    ]);
    expect(
      (yield* workspace.get({ includeWorkerRequests: true })).requests.find(
        (request) => request.id === question.id,
      )?.status,
    ).toBe("open");
    const answer = {
      type: "respond",
      itemId: "build",
      requestId: question.id,
      response: "Target macOS.",
    } as const;
    expect(
      (yield* Effect.flip(workspace.command(answer, { threadId: primary }))).message,
    ).toContain("Second Mate");
    expect(
      (yield* Effect.flip(
        workspace.command({ ...answer, itemId: "another-task" }, { threadId: lead }),
      )).message,
    ).toContain("Second Mate");
    expect(
      (yield* Effect.flip(workspace.command(answer, { threadId: lead, subagent: true }))).message,
    ).toContain("Second Mate");
    yield* workspace.command(answer, { threadId: lead });
    yield* workspace.command(answer, { threadId: lead });
    const delivery = (yield* t3.getThreadRecords(worker, ["messages"])).messages;
    expect(delivery).toHaveLength(1);
    expect(delivery[0]).toMatchObject({ createdBy: "agent", senderThreadId: lead });
    expect(
      (yield* workspace.get({ includeWorkerRequests: true })).requests.find(
        (request) => request.id === question.id,
      )?.status,
    ).toBe("accepted");
  }).pipe(Effect.provide(testLayer)),
);

it.effect("opens one idle Second Mate for an existing task without replacing its workers", () =>
  Effect.gen(function* () {
    const workspace = yield* fixture;
    yield* workspace.command({
      type: "obsolete",
      requestId: "question",
      reason: "No pending decisions",
    });
    const command = { type: "ensureSecondMate", itemId: "build" } as const;
    const [first, second] = yield* Effect.all(
      [workspace.command(command), workspace.command(command)],
      { concurrency: "unbounded" },
    );
    expect(
      (yield* Effect.flip(workspace.command(command, { threadId: worker }))).message,
    ).toContain("First Mate");
    const item = first.items[0]!;
    const lead = item.secondMateThreadId!;
    expect(lead).toBeDefined();
    expect(second.items[0]?.secondMateThreadId).toBe(lead);
    expect(item.primaryThreadId).toBe(primary);
    expect(item.sessions).toEqual([{ threadId: worker, role: "review" }]);
    const t3 = yield* Orchestrator.OrchestratorV2;
    const records = yield* t3.getThreadRecords(lead, ["runs"], { includeWorkspaceRole: true });
    expect(records.workspaceRole).toBe("secondMate");
    expect(records.thread.modelSelection).toEqual({
      instanceId: "codex",
      model: "gpt-6.1-sol",
      options: [{ id: "reasoningEffort", value: "high" }],
    });
    expect(records.runs).toHaveLength(0);
    expect(records.thread.projectId).toBe(projectId);
    yield* t3.dispatch({
      type: "thread.archive",
      threadId: primary,
      commandId: CommandId.make("archive-source"),
    });
    yield* t3.dispatch({
      type: "thread.archive",
      threadId: lead,
      commandId: CommandId.make("archive-coordinator"),
    });
    const reopened = yield* makeVisualWorkspace;
    expect((yield* reopened.command(command)).items[0]?.secondMateThreadId).toBe(lead);
    expect((yield* t3.getThreadRecords(lead, [])).thread.archivedAt).toBeNull();
    yield* reopened.checkpoint(lead, {
      stage: "building",
      needsAttention: false,
      summary: "Coordinating two workers.",
    });
    yield* reopened.checkpoint(worker, {
      stage: "complete",
      needsAttention: false,
      summary: "Review finished.",
    });
    expect((yield* reopened.get()).items[0]?.stage).toBe("building");
    const update = { type: "update", itemId: "build", stage: "qa" } as const;
    yield* reopened.command(update, { threadId: lead });
    expect((yield* reopened.get()).items[0]?.stage).toBe("qa");
    expect(
      (yield* Effect.flip(reopened.command({ ...update, itemId: "elsewhere" }, { threadId: lead })))
        .message,
    ).toContain("own task");
    expect((yield* Effect.flip(reopened.command(update, { threadId: worker }))).message).toContain(
      "First Mate",
    );
  }).pipe(Effect.provide(testLayer)),
);

it.effect("flags a completed Second Mate answer until the person opens it or follows up", () =>
  Effect.gen(function* () {
    const workspace = yield* fixture;
    yield* workspace.command({ type: "obsolete", requestId: "question", reason: "Handled" });
    const lead = (yield* workspace.command({ type: "ensureSecondMate", itemId: "build" })).items[0]!
      .secondMateThreadId!;
    const t3 = yield* Orchestrator.OrchestratorV2;
    const sink = yield* EventSinkV2;
    const ask = Effect.fnUntraced(function* (id: string, automated = false) {
      yield* t3.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(id),
        messageId: MessageId.make(id),
        threadId: lead,
        dispatchMode: { type: "start_immediately" },
        text: id,
        attachments: [],
        ...(automated
          ? { createdBy: "agent" as const, creationSource: "server" as const }
          : { createdBy: "user" as const, creationSource: "web" as const }),
      });
      const { messages, runs } = yield* t3.getThreadRecords(lead, ["messages", "runs"]);
      const prompt = messages.find((message) => message.id === id)!;
      const run = runs.find((candidate) => candidate.id === prompt.runId)!;
      const at = yield* DateTime.now;
      yield* sink.write({
        events: [
          {
            id: EventId.make(`answer:${id}`),
            type: "message.updated",
            threadId: lead,
            runId: run.id,
            occurredAt: at,
            payload: {
              ...prompt,
              id: MessageId.make(`answer:${id}`),
              role: "assistant",
              createdBy: "agent",
              creationSource: "provider",
              text: `Answer to ${id}`,
              streaming: false,
              createdAt: at,
              updatedAt: at,
            },
          },
        ],
      });
      return run;
    });
    const complete = (run: OrchestrationV2Run) =>
      Effect.gen(function* () {
        const at = yield* DateTime.now;
        yield* sink.write({
          events: [
            {
              id: EventId.make(`done:${run.id}`),
              type: "run.updated",
              threadId: lead,
              runId: run.id,
              occurredAt: at,
              payload: { ...run, status: "completed", completedAt: at },
            },
          ],
        });
      });
    const first = yield* ask("What should we do?");
    expect((yield* workspace.get()).requests).toHaveLength(0);
    const listening = yield* Deferred.make<void>();
    const flagged = yield* workspace.subscribe().pipe(
      Stream.tap(() => Deferred.succeed(listening, undefined)),
      Stream.filter((board) => board.requests.some((request) => request.replyId === first.id)),
      Stream.runHead,
      Effect.forkChild,
    );
    yield* Deferred.await(listening);
    yield* complete(first);
    expect((yield* workspace.get()).requests).toMatchObject([
      { replyId: first.id, prompt: "Reply ready" },
    ]);
    expect(Option.isSome(yield* Fiber.join(flagged))).toBe(true);
    expect(
      (yield* workspace.get({ includeWorkerRequests: true })).requests.some((r) => r.replyId),
    ).toBe(false);
    yield* t3.dispatch({
      type: "thread.visit",
      commandId: CommandId.make("passive-visit"),
      threadId: lead,
      visitedAt: DateTime.formatIso(yield* DateTime.now),
    });
    yield* workspace.checkpoint(lead, {
      stage: "building",
      needsAttention: false,
      summary: "Answered",
    });
    yield* complete(yield* ask("background worker finished", true));
    expect((yield* workspace.get()).requests[0]?.replyId).toBe(first.id);
    yield* TestClock.adjust("1 second");
    const next = yield* ask("What comes next?");
    expect((yield* workspace.get()).requests).toHaveLength(0);
    yield* complete(next);
    yield* workspace.command({ type: "readReply", itemId: "build", replyId: first.id });
    expect((yield* workspace.get()).requests[0]?.replyId).toBe(next.id);
    yield* workspace.command({ type: "readReply", itemId: "build", replyId: next.id });
    expect((yield* (yield* makeVisualWorkspace).get()).requests).toHaveLength(0);
    const internal = yield* ask("Review a worker update", true);
    const at = yield* DateTime.now;
    const messages = (yield* t3.getThreadRecords(lead, ["messages"])).messages;
    const source = messages.find((message) => message.id === internal.userMessageId)!;
    yield* sink.write({
      events: [
        {
          id: EventId.make("user-steered"),
          type: "message.updated",
          threadId: lead,
          runId: internal.id,
          occurredAt: at,
          payload: {
            ...source,
            id: MessageId.make("user-steer"),
            text: "Which do you recommend?",
            createdBy: "user",
            creationSource: "mobile",
            createdAt: at,
            updatedAt: at,
          },
        },
        {
          id: EventId.make("steer-answered"),
          type: "message.updated",
          threadId: lead,
          runId: internal.id,
          occurredAt: at,
          payload: {
            ...source,
            id: MessageId.make("answer-steer"),
            text: "Start a new task.",
            role: "assistant",
            createdBy: "agent",
            creationSource: "provider",
            createdAt: at,
            updatedAt: at,
          },
        },
      ],
    });
    yield* complete(internal);
    expect((yield* workspace.get()).requests).toMatchObject([
      { replyId: internal.id, context: "Start a new task." },
    ]);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("replaces a deleted Second Mate when the task is reopened", () =>
  Effect.gen(function* () {
    const workspace = yield* fixture;
    const t3 = yield* Orchestrator.OrchestratorV2;
    const open = { type: "ensureSecondMate", itemId: "build" } as const;
    yield* workspace.command({ type: "orchestrator", threadId: worker });
    const first = (yield* workspace.command(open, { threadId: worker })).items[0]!
      .secondMateThreadId!;
    yield* t3.dispatch({
      type: "thread.delete",
      threadId: first,
      commandId: CommandId.make("remove-lead"),
    });
    const after = (yield* workspace.command(open)).items[0]!;
    expect(after.secondMateThreadId).toBeTruthy();
    expect(after.secondMateThreadId).not.toBe(first);
    expect(after.primaryThreadId).toBe(primary);
    expect(after.sessions).toEqual([{ threadId: worker, role: "review" }]);
    expect((yield* workspace.command(open)).items[0]?.secondMateThreadId).toBe(
      after.secondMateThreadId,
    );
  }).pipe(Effect.provide(testLayer)),
);

it.effect("attaches a Second Mate's delegated and top-level workers to the same task", () =>
  Effect.gen(function* () {
    const workspace = yield* fixture;
    yield* workspace.command({
      type: "obsolete",
      requestId: "question",
      reason: "Resolved before delegation",
    });
    const board = yield* workspace.command({ type: "ensureSecondMate", itemId: "build" });
    const lead = board.items[0]!.secondMateThreadId!;
    const t3 = yield* Orchestrator.OrchestratorV2;
    const child = ThreadId.make("feature-work");
    yield* t3.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create-feature"),
      threadId: child,
      projectId,
      title: "Build feature",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "model" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "agent",
      creationSource: "mcp",
    });
    for (const [threadId, id, senderThreadId] of [
      [lead, "lead-prompt", undefined],
      [child, "worker-prompt", lead],
    ] as const) {
      yield* t3.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(id),
        threadId,
        senderThreadId,
        messageId: MessageId.make(id),
        text: "Build the feature",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        createdBy: senderThreadId ? "agent" : "user",
        creationSource: senderThreadId ? "mcp" : "web",
      });
    }
    const { runs } = yield* t3.getThreadRecords(lead, ["runs"]);
    yield* t3.dispatch({
      type: "delegated_task.request",
      commandId: CommandId.make("delegate-review"),
      parentThreadId: lead,
      parentRunId: runs[0]!.id,
      parentNodeId: runs[0]!.rootNodeId!,
      title: "Review feature",
      task: "Check the changes",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "model" },
      runtimeMode: "full-access",
      interactionMode: "default",
      createdBy: "agent",
      creationSource: "mcp",
    });
    const delegated = (yield* t3.getThreadRecords(lead, ["subagents"])).subagents[0]!
      .childThreadId!;
    const delegateFromChild = Effect.fnUntraced(function* (commandId: string) {
      const childRun = (yield* t3.getThreadRecords(child, ["runs"])).runs[0]!;
      yield* t3.dispatch({
        type: "delegated_task.request",
        commandId: CommandId.make(commandId),
        parentThreadId: child,
        parentRunId: childRun.id,
        parentNodeId: childRun.rootNodeId!,
        title: commandId,
        task: "Inspect the design",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "model" },
        runtimeMode: "full-access",
        interactionMode: "default",
        createdBy: "agent",
        creationSource: "mcp",
      });
      return (yield* t3.getThreadRecords(child, ["subagents"])).subagents.find(
        (s) => s.title === commandId,
      )!.childThreadId!;
    });
    const sql = yield* SqlClient.SqlClient;
    yield* sql`DROP TRIGGER helm_inherit_delegated_worker`;
    const legacy = yield* delegateFromChild("legacy-review");
    expect(yield* workspace.secondMateForWorker(legacy)).toBeUndefined();
    yield* sql.withTransaction(ensureWorkspaceSchema);
    expect(yield* workspace.secondMateForWorker(legacy)).toBe(lead);
    const nested = yield* delegateFromChild("architecture-review");
    const snapshot = yield* workspace.get();
    expect(snapshot.items).toHaveLength(1);
    expect(snapshot.items[0]?.sessions.map((s) => s.threadId)).toEqual([
      worker,
      child,
      delegated,
      legacy,
      nested,
    ]);
    expect(yield* workspace.secondMateForWorker(nested)).toBe(lead);
    for (const threadId of [child, delegated, nested]) {
      expect(
        yield* workspace.checkpoint(threadId, {
          stage: "reviewing",
          needsAttention: false,
          summary: "Checking",
        }),
      ).toBe("build");
    }
    expect((yield* workspace.get()).items[0]?.stage).toBe("planning");
    yield* workspace.command({ type: "disassociate", itemId: "build", threadId: nested });
    yield* workspace.command({ type: "disassociate", itemId: "build", threadId: child });
    const beforeLink = yield* delegateFromChild("preexisting-review");
    expect(yield* workspace.secondMateForWorker(beforeLink)).toBeUndefined();
    yield* workspace.command({
      type: "associate",
      itemId: "build",
      threadId: child,
      role: "Builder",
    });
    expect(yield* workspace.secondMateForWorker(beforeLink)).toBe(lead);
    yield* sql.withTransaction(ensureWorkspaceSchema);
    expect(yield* workspace.secondMateForWorker(nested)).toBeUndefined();
  }).pipe(Effect.provide(testLayer)),
);

it.effect("migrates the current orchestrator and keeps each tab's authority until closed", () =>
  Effect.gen(function* () {
    const workspace = yield* fixture;
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE helm_binding (id INTEGER PRIMARY KEY CHECK (id=1), thread_id TEXT NOT NULL)`;
    yield* sql`INSERT INTO helm_binding VALUES (1,${primary})`;
    yield* sql.withTransaction(ensureWorkspaceSchema);
    for (const threadId of [worker, primary]) {
      yield* workspace.command({ type: "orchestrator", threadId });
    }
    const reopened = yield* makeVisualWorkspace;
    expect((yield* reopened.get()).orchestratorThreadIds).toEqual([primary, worker]);
    const update = { type: "update", itemId: "build", title: "Ship" } as const;
    for (const threadId of [primary, worker]) yield* reopened.command(update, { threadId });
    yield* reopened.command({ type: "closeOrchestrator", threadId: primary });
    yield* sql.withTransaction(ensureWorkspaceSchema);
    expect((yield* reopened.get()).orchestratorThreadIds).toEqual([worker]);
    expect((yield* Effect.flip(reopened.command(update, { threadId: primary }))).message).toContain(
      "First Mate",
    );
    yield* reopened.command(update, { threadId: worker });
  }).pipe(Effect.provide(testLayer)),
);

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
      ).toContain("First Mate");
      expect(
        (yield* Effect.flip(
          w.command(
            { type: "report", itemId: "build", threadId: primary, text: "done", stage: "complete" },
            { threadId: worker },
          ),
        )).message,
      ).toContain("calling thread");
      yield* w.command(
        { type: "disassociate", itemId: "build", threadId: worker },
        { threadId: primary },
      );
      expect(
        (yield* Effect.flip(
          w.command(
            { type: "report", itemId: "build", threadId: worker, text: "done", stage: "complete" },
            { threadId: worker },
          ),
        )).message,
      ).toContain("not associated");
      const after = yield* (yield* makeVisualWorkspace).get();
      expect(after.items[0]).toMatchObject({
        stage: "planning",
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

it.effect("shows an orchestrator delegation live and keeps worker reports on the same card", () =>
  Effect.gen(function* () {
    const workspace = yield* fixture;
    yield* workspace.command({ type: "orchestrator", threadId: primary });
    const t3 = yield* Orchestrator.OrchestratorV2;
    yield* t3.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("start-delegating"),
      threadId: primary,
      messageId: MessageId.make("delegate"),
      text: "Research the results",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
    const { runs } = yield* t3.getThreadRecords(primary, ["runs"]);
    const ready = yield* Deferred.make<void>();
    const liveCard = yield* workspace.subscribe().pipe(
      Stream.tap(() => Deferred.succeed(ready, undefined)),
      Stream.map((snapshot) => snapshot.items.find((item) => item.title === "Research results")),
      Stream.filter((item) => item !== undefined),
      Stream.runHead,
      Effect.forkChild,
    );
    yield* Deferred.await(ready);
    yield* t3.dispatch({
      type: "delegated_task.request",
      commandId: CommandId.make("delegate-research"),
      parentThreadId: primary,
      parentRunId: runs[0]!.id,
      parentNodeId: runs[0]!.rootNodeId!,
      title: "Research results",
      task: "Research the results",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "model" },
      runtimeMode: "full-access",
      interactionMode: "default",
      createdBy: "agent",
      creationSource: "mcp",
    });
    const card = (yield* workspace.get()).items.find((item) => item.title === "Research results");
    expect(card).toBeDefined();
    expect(Option.getOrUndefined(yield* Fiber.join(liveCard))).toEqual(card);
    const open = { type: "ensureSecondMate", itemId: card!.id } as const;
    const opened = yield* workspace.command(open);
    const task = opened.items.find((item) => item.id === card!.id)!;
    expect(task.secondMateThreadId).toBeDefined();
    expect(task.primaryThreadId).toBe(card!.primaryThreadId);
    const reported = yield* workspace.command(
      {
        type: "report",
        itemId: card!.id,
        threadId: card!.primaryThreadId,
        text: "Ready for review",
        stage: "qa",
        needsAttention: true,
      },
      { threadId: card!.primaryThreadId },
    );
    expect(
      reported.items.filter((item) => item.primaryThreadId === card!.primaryThreadId),
    ).toMatchObject([{ id: card!.id, stage: card!.stage }]);
    expect(reported.requests.some((request) => request.itemId === card!.id)).toBe(false);
    expect(
      (yield* workspace.get({ includeWorkerRequests: true })).requests.some(
        (request) => request.itemId === card!.id,
      ),
    ).toBe(true);
    const reopened = yield* workspace.command(open);
    expect(reopened.requests).toEqual(reported.requests);
    expect(reopened.items.find((item) => item.id === card!.id)?.secondMateThreadId).toBe(
      task.secondMateThreadId,
    );
  }).pipe(Effect.provide(testLayer)),
);

it.effect("shows a top-level worker in Building as soon as the orchestrator starts it", () =>
  Effect.gen(function* () {
    const workspace = yield* fixture;
    yield* workspace.command({ type: "orchestrator", threadId: primary });
    const t3 = yield* Orchestrator.OrchestratorV2;
    const threadId = ThreadId.make("top-level-research");
    yield* t3.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create-research"),
      threadId,
      projectId,
      title: "Weekly leaders",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "model" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "agent",
      creationSource: "mcp",
    });
    const ready = yield* Deferred.make<void>();
    const live = yield* workspace.subscribe().pipe(
      Stream.tap(() => Deferred.succeed(ready, undefined)),
      Stream.filter((snapshot) => snapshot.items.some((item) => item.primaryThreadId === threadId)),
      Stream.runHead,
      Effect.forkChild,
    );
    yield* Deferred.await(ready);
    yield* t3.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("start-research"),
      threadId,
      messageId: MessageId.make("research-prompt"),
      senderThreadId: primary,
      text: "Research weekly leaders",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "agent",
      creationSource: "mcp",
    });
    const snapshot = yield* workspace.get();
    expect(snapshot.items.find((item) => item.primaryThreadId === threadId)).toMatchObject({
      stage: "building",
      title: "Weekly leaders",
    });
    expect(Option.getOrUndefined(yield* Fiber.join(live))).toEqual(snapshot);
    yield* workspace.command({ type: "closeOrchestrator", threadId: primary });
    const afterClosing = yield* (yield* makeVisualWorkspace).get();
    expect(afterClosing.orchestratorThreadIds).not.toContain(primary);
    expect(afterClosing.items.find((item) => item.primaryThreadId === threadId)).toEqual(
      snapshot.items.find((item) => item.primaryThreadId === threadId),
    );
    const [run] = (yield* t3.getThreadRecords(threadId, ["runs"])).runs;
    const completedAt = yield* DateTime.now;
    const sink = yield* EventSinkV2;
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO orchestration_v2_projection_plans
      (plan_id, thread_id, run_id, node_id, kind, status, payload_json)
      VALUES ('research-plan', ${threadId}, ${run!.id}, 'research-node', 'proposed_plan', 'active', '{}')`;
    const subscribed = yield* Deferred.make<void>();
    const reviewed = yield* workspace.subscribe().pipe(
      Stream.tap(() => Deferred.succeed(subscribed, undefined)),
      Stream.filter((next) =>
        next.items.some((item) => item.primaryThreadId === threadId && item.stage === "planning"),
      ),
      Stream.runHead,
      Effect.forkChild,
    );
    yield* Deferred.await(subscribed);
    yield* sink.write({
      events: [
        {
          id: EventId.make("complete-research"),
          type: "run.updated",
          threadId,
          runId: run!.id,
          occurredAt: completedAt,
          payload: { ...run!, status: "completed", completedAt },
        },
      ],
    });
    const reopened = yield* (yield* makeVisualWorkspace).get();
    expect(reopened.items.find((item) => item.primaryThreadId === threadId)?.stage).toBe(
      "planning",
    );
    expect(Option.getOrUndefined(yield* Fiber.join(reviewed))).toEqual(reopened);
    yield* t3.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("follow-up-research"),
      threadId,
      messageId: MessageId.make("follow-up-research"),
      text: "Remove the first result.",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
    expect(
      (yield* workspace.get()).items.find((item) => item.primaryThreadId === threadId)?.stage,
    ).toBe("building");
    yield* workspace.checkpoint(threadId, {
      stage: "reviewing",
      needsAttention: false,
      summary: "Checking the results",
    });
    const before = yield* workspace.get();
    expect(before.items.find((item) => item.primaryThreadId === threadId)?.canReassignPrimary).toBe(
      true,
    );
    const linked = yield* workspace.command({
      type: "associate",
      itemId: "build",
      threadId,
      role: "Research",
    });
    expect(linked.items.map((item) => item.id)).toEqual(["build"]);
    expect(linked.items[0]?.latestReport).toEqual(
      before.items.find((item) => item.primaryThreadId === threadId)?.latestReport,
    );

    expect(
      yield* workspace.checkpoint(threadId, {
        stage: "qa",
        needsAttention: false,
        summary: "Checking results",
      }),
    ).toBe("build");
  }).pipe(Effect.provide(testLayer)),
);

it.effect.each([true, false])(
  "checks a proposed plan at yield and preserves a reported stage (%s)",
  (reported) =>
    Effect.gen(function* () {
      const workspace = yield* fixture;
      yield* workspace.command({ type: "update", itemId: "build", stage: "building" });
      const t3 = yield* Orchestrator.OrchestratorV2;
      yield* t3.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("propose"),
        messageId: MessageId.make("propose"),
        threadId: primary,
        text: "Prepare the next step",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      });
      const [run] = (yield* t3.getThreadRecords(primary, ["runs"])).runs;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO orchestration_v2_projection_plans
      (plan_id,thread_id,run_id,node_id,kind,status,payload_json)
      VALUES ('next-plan',${primary},${run!.id},'next-node','proposed_plan','active','{}')`;
      if (reported)
        yield* workspace.checkpoint(primary, {
          stage: "building",
          needsAttention: false,
          summary: "Applying the approved fix",
        });
      const sink = yield* EventSinkV2;
      yield* sink.write({
        events: [
          {
            id: EventId.make("yield-plan"),
            type: "run.updated",
            threadId: primary,
            runId: run!.id,
            occurredAt: yield* DateTime.now,
            payload: { ...run!, status: "waiting" },
          },
        ],
      });
      expect((yield* workspace.get()).items[0]?.stage).toBe(reported ? "building" : "planning");
    }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "subscribers receive only Second Mate requests after an existing task gains its lead",
  () =>
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
      expect(yield* Fiber.join(updates)).toEqual([["question"], []]);
      yield* workspace.command(command, { threadId: worker });
      expect(
        (yield* Effect.flip(
          workspace.command({ ...command, choices: ["Other"] }, { threadId: worker }),
        )).message,
      ).toContain("already uses");
      const restored = yield* (yield* makeVisualWorkspace)
        .subscribe()
        .pipe(Stream.take(1), Stream.runCollect);
      expect(restored[0]?.requests).toEqual([]);
      expect(
        (yield* workspace.get({ includeWorkerRequests: true })).requests.map(
          (request) => request.id,
        ),
      ).toEqual(["question", "review-ready"]);
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
  "completion retires the reporting worker's open questions without sending another reply",
  () =>
    Effect.gen(function* () {
      const workspace = yield* fixture;
      const complete = (threadId: ThreadId) =>
        workspace.command(
          { type: "report", itemId: "build", threadId, text: "Finished", stage: "complete" },
          { threadId },
        );
      expect((yield* complete(primary)).requests[0]?.status).toBe("open");
      expect((yield* complete(worker)).requests[0]?.status).toBe("obsolete");
      const t3 = yield* Orchestrator.OrchestratorV2;
      expect((yield* t3.getThreadRecords(worker, ["messages"])).messages).toHaveLength(0);
    }).pipe(Effect.provide(testLayer)),
);

it.effect("reads legacy cards and accepts stage reports from older clients", () =>
  Effect.gen(function* () {
    const workspace = yield* fixture;
    const sql = yield* SqlClient.SqlClient;
    for (const [previous, current] of [
      ["backlog", "planning"],
      ["shaping", "planning"],
      ["review", "qa"],
    ] as const) {
      yield* sql`UPDATE helm_items SET body=json_set(body,'$.stage',${previous}) WHERE id='build'`;
      expect((yield* workspace.get()).items[0]?.stage).toBe(current);
      const report = yield* decodeCommand({
        type: "report",
        threadId: worker,
        itemId: "build",
        stage: previous,
        text: "Progress",
      });
      yield* workspace.command(report, { threadId: worker });
      const [stored] = yield* sql<{
        stage: string;
      }>`SELECT json_extract(body,'$.stage') AS stage FROM helm_items WHERE id='build'`;
      expect(stored?.stage).toBe(current);
    }
  }).pipe(Effect.provide(testLayer)),
);

it.effect("assigned workers move a card forward and back when their report changes its stage", () =>
  Effect.gen(function* () {
    const workspace = yield* fixture;
    for (const [threadId, stage, summary, needsAttention] of [
      [primary, "reviewing", "Inspecting the diff", false],
      [worker, "building", "Fixing a review finding", false],
      [worker, "reviewing", "Waiting on the reviewer", false],
      [worker, "qa", "Preparing the preview environment", false],
      [worker, "qa", "Checking the change in preview", false],
      [worker, "building", "Fixing the preview regression", false],
    ] as const) {
      expect(yield* workspace.checkpoint(threadId, { stage, summary, needsAttention })).toBe(
        "build",
      );
      const result = yield* workspace.get();
      yield* TestClock.adjust("1 second");
      yield* workspace.checkpoint(threadId, { stage, summary, needsAttention });
      expect(yield* workspace.get()).toEqual(result);
      expect(result.requests.find((entry) => entry.id === "question")?.status).toBe("open");
      expect(result.items[0]).toMatchObject({ stage, latestReport: { threadId, text: summary } });
      expect(
        result.requests.some(
          (request) => request.kind === "attention" && request.status === "open",
        ),
      ).toBe(needsAttention);
    }
    expect(
      (yield* Effect.flip(
        workspace.checkpoint(worker, {
          stage: "complete",
          needsAttention: true,
          summary: "Needs a decision",
        }),
      )).message,
    ).toContain("current stage");
    expect(
      (yield* Effect.flip(
        workspace.checkpoint(ThreadId.make("unrelated"), {
          stage: "building",
          needsAttention: false,
          summary: "No board access",
        }),
      )).message,
    ).toContain("no assigned");
    yield* workspace.command(
      { type: "report", itemId: "build", threadId: primary, text: "Fix in progress" },
      { threadId: primary },
    );
    const saved = yield* (yield* makeVisualWorkspace).get();
    expect(saved.items[0]).toMatchObject({
      stage: "building",
      latestReport: { text: "Fix in progress" },
    });
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

it.effect(
  "a direct chat reply clears only its session's open attention without a second delivery",
  () =>
    Effect.gen(function* () {
      const workspace = yield* fixture;
      const threads = yield* Threads.ThreadManagementService;
      const signal = yield* decodeCommand({
        type: "report",
        itemId: "build",
        threadId: worker,
        text: "Connect the phone.",
        needsAttention: true,
      });
      yield* workspace.command(signal, { threadId: worker });
      const send = (threadId: ThreadId, id: string, createdBy: "user" | "agent") =>
        threads.sendToThread({
          projectId,
          threadId,
          commandId: CommandId.make(id),
          messageId: MessageId.make(id),
          text: "Connected.",
          attachments: [],
          mode: "auto",
          createdBy,
          creationSource: createdBy === "user" ? "web" : "mcp",
        });
      yield* send(primary, "elsewhere", "user");
      yield* send(worker, "agent-update", "agent");
      const pending = (yield* workspace.get({ includeWorkerRequests: true })).requests;
      expect(pending.map((entry) => [entry.kind, entry.status])).toEqual([
        ["question", "open"],
        ["attention", "open"],
      ]);
      yield* send(worker, "direct", "user");
      const snapshot = yield* workspace.get({ includeWorkerRequests: true });
      expect(snapshot.requests.map((entry) => entry.status)).toEqual(["accepted", "accepted"]);
      expect(snapshot.items[0]?.stage).toBe("planning");
      const t3 = yield* Orchestrator.OrchestratorV2;
      expect((yield* t3.getThreadRecords(worker, ["messages"])).messages.map((m) => m.id)).toEqual([
        "agent-update",
        "direct",
      ]);
    }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "a First Mate starts a task with one Second Mate and delivers the brief once across retries",
  () =>
    Effect.gen(function* () {
      const workspace = yield* fixture;
      const task = {
        itemId: "release-fix",
        title: "Release fix",
        brief: "Have a worker fix the release.",
      };
      expect((yield* Effect.flip(workspace.startTask(worker, task))).message).toContain(
        "First Mate",
      );
      yield* workspace.command({ type: "orchestrator", threadId: primary });
      const [first, repeated] = yield* Effect.all(
        [workspace.startTask(primary, task), workspace.startTask(primary, task)],
        { concurrency: "unbounded" },
      );
      const target = ProjectId.make("destination-project");
      const t3 = yield* Orchestrator.OrchestratorV2;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES(${target},'Atlas','/tmp/atlas','[]','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')`;
      const other = { ...task, itemId: "other-project-task", project: "atlas" };
      const started = yield* workspace.startTask(primary, other);
      const destination = yield* t3.getThreadRecords(started.threadId, ["messages"]);
      expect(destination.thread.projectId).toBe(target);
      expect(destination.thread.worktreePath).toBeNull();
      expect(destination.messages.map((m) => m.text)).toEqual([task.brief]);
      expect(yield* workspace.startTask(primary, { ...other, project: "/tmp/atlas" })).toEqual(
        started,
      );
      expect(
        (yield* Effect.flip(workspace.startTask(primary, { ...other, project: "nonexistent" })))
          .message,
      ).toContain("No active project");
      expect(first).toEqual(repeated);
      const saved = (yield* workspace.get()).items.filter((item) => item.id === task.itemId);
      expect(saved).toMatchObject([
        {
          primaryThreadId: first.threadId,
          secondMateThreadId: first.threadId,
          sessions: [],
        },
      ]);
      const threads = yield* Threads.ThreadManagementService;
      const { messages } = yield* threads.getThreadRecords(first.threadId, ["messages"]);
      expect(messages.map((message) => message.text)).toEqual([task.brief]);
      const reopened = yield* makeVisualWorkspace;
      expect(yield* reopened.startTask(primary, task)).toEqual(first);
      expect(
        (yield* Effect.flip(reopened.startTask(primary, { ...task, itemId: "build" }))).message,
      ).toContain("already");
    }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "a direct task's worker owns its card and asks the person without creating a Second Mate",
  () =>
    Effect.gen(function* () {
      const workspace = yield* fixture;
      const sql = yield* SqlClient.SqlClient;
      const t3 = yield* Orchestrator.OrchestratorV2;
      yield* workspace.command({ type: "orchestrator", threadId: primary });
      const task = {
        itemId: "direct",
        title: "Fix a label",
        brief: "Fix the label.",
        mode: "direct",
      } as const;
      const { threadId } = yield* workspace.startTask(primary, task);
      expect(yield* (yield* makeVisualWorkspace).startTask(primary, task)).toEqual({
        itemId: task.itemId,
        threadId,
        workerThreadId: threadId,
      });
      expect(
        (yield* Effect.flip(workspace.startTask(primary, { ...task, mode: "managed" }))).message,
      ).toContain("already");
      const owner = yield* t3.getThreadRecords(threadId, ["messages"]);
      expect(owner.thread.modelSelection).toMatchObject({
        instanceId: "claudeAgent",
        model: "claude-opus-5-5",
      });
      expect(owner.messages.map((message) => message.text)).toEqual([task.brief]);
      expect(yield* workspaceRoleForThread(sql, threadId)).toBe("directWorker");
      expect(
        (yield* Effect.flip(
          workspace.command({ type: "update", itemId: "build", stage: "complete" }, { threadId }),
        )).message,
      ).toContain("own task");
      expect(
        (yield* Effect.flip(workspace.command({ type: "ensureSecondMate", itemId: task.itemId })))
          .message,
      ).toContain("worker");
      expect(yield* workspace.secondMateForWorker(threadId)).toBeUndefined();
      const report = {
        stage: "qa",
        summary: "Which label should ship?",
        needsAttention: true,
      } as const;
      yield* workspace.checkpoint(threadId, report);
      const board = yield* workspace.get();
      const card = board.items.find((item) => item.id === task.itemId)!;
      expect(card).toMatchObject({
        directWorker: true,
        primaryThreadId: threadId,
        stage: "qa",
        sessions: [],
      });
      expect(card.secondMateThreadId).toBeUndefined();
      const request = board.requests.find((entry) => entry.itemId === task.itemId)!;
      expect(request).toMatchObject({ threadId, prompt: report.summary, status: "open" });
      yield* workspace.command({ type: "respond", requestId: request.id, response: "Use Save." });
      expect((yield* t3.getThreadRecords(threadId, ["messages"])).messages.at(-1)?.text).toContain(
        "Use Save.",
      );
      yield* workspace.checkpoint(threadId, {
        stage: "complete",
        summary: "Verified Save.",
        needsAttention: false,
      });
      const retired = yield* workspace.command({
        type: "retire",
        itemId: task.itemId,
        onlyIfDone: true,
      });
      expect(retired.items.find((item) => item.id === task.itemId)?.retiredAt).toBeTruthy();
      const restored = yield* workspace.command({ type: "restore", itemId: task.itemId });
      expect(restored.items.find((item) => item.id === task.itemId)).toMatchObject({
        primaryThreadId: threadId,
        directWorker: true,
        stage: "complete",
      });
    }).pipe(Effect.provide(testLayer)),
);
