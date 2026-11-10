import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type WorkspaceSnapshot,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as Workspace from "../../../workspace/VisualWorkspace.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import { liveThreadShell, liveThreadsLayer } from "../../McpToolAccess.testkit.ts";
import * as WorkspaceHandlers from "./handlers.ts";
import { WorkspaceToolkit } from "./tools.ts";

const worker = ThreadId.make("worker");
const unrelated = ThreadId.make("unrelated");
const at = "2026-01-01T00:00:00.000Z";
const hiddenItem = {
  id: "private",
  title: "Other work",
  scope: "",
  stage: "planning",
  priority: 0,
  attention: "none",
  primaryThreadId: unrelated,
  sessions: [],
  artifacts: [],
  decisions: [],
  dependencies: [],
  latestReport: null,
  createdAt: at,
  updatedAt: at,
} as const;
const hiddenRequest = {
  id: "ask",
  itemId: hiddenItem.id,
  threadId: unrelated,
  kind: "question",
  prompt: "Private question?",
  context: "",
  choices: [],
  status: "open",
  createdAt: at,
  resolvedAt: null,
  response: null,
} as const;
const snapshot: WorkspaceSnapshot = {
  orchestratorThreadIds: [unrelated],
  items: [hiddenItem],
  requests: [hiddenRequest],
};
const provider: McpInvocationContext.McpInvocationScope = {
  requestNamespace: "test",
  environmentId: EnvironmentId.make("test"),
  issuedAt: 0,
  capabilities: new Set(["orchestration"]),
  client: undefined,
  thread: {
    threadId: worker,
    providerSessionId: "session",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
};
const testLayer = McpToolAccess.HandlersLayer.layer(WorkspaceHandlers.layer).pipe(
  Layer.provideMerge(liveThreadsLayer),
  Layer.provideMerge(
    Layer.mock(Workspace.VisualWorkspace)({ get: () => Effect.succeed(snapshot) }),
  ),
);

it.effect("keeps an explicit foreign item and its requests out of a worker's result", () =>
  Effect.gen(function* () {
    const toolkit = yield* WorkspaceToolkit;
    for (const input of [{}, { itemId: hiddenItem.id }]) {
      const replies = yield* toolkit
        .handle("t3_workspace_read", input)
        .pipe(Stream.unwrap, Stream.runCollect);
      expect(replies.at(-1)?.result).toEqual({
        items: [],
        requests: [],
        sessions: [],
        orchestratorThreadIds: [],
        callerThreadId: worker,
      });
    }
  }).pipe(
    Effect.provideService(McpInvocationContext.McpInvocationContext, provider),
    Effect.provide(testLayer),
  ),
);

it.effect("shows a Second Mate the existing task it leads and its worker chats", () =>
  Effect.gen(function* () {
    const toolkit = yield* WorkspaceToolkit;
    const replies = yield* toolkit
      .handle("t3_workspace_read", {})
      .pipe(Stream.unwrap, Stream.runCollect);
    expect(replies.at(-1)?.result).toMatchObject({
      items: [{ id: "owned" }],
      sessions: [{ threadId: "old-worker" }, { threadId: worker }],
      requests: [],
      orchestratorThreadIds: [],
    });
  }).pipe(
    Effect.provideService(McpInvocationContext.McpInvocationContext, provider),
    Effect.provide(
      McpToolAccess.HandlersLayer.layer(WorkspaceHandlers.layer).pipe(
        Layer.provideMerge(
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getThreadShell: (id) => Effect.succeed(liveThreadShell(id)),
            getShellSnapshot: () =>
              Effect.succeed({
                threads: [ThreadId.make("old-worker"), worker, unrelated].map((id) =>
                  liveThreadShell(id),
                ),
                archivedThreads: [],
                schemaVersion: 1,
                snapshotSequence: 0,
              }),
          }),
        ),
        Layer.provideMerge(
          Layer.mock(Workspace.VisualWorkspace)({
            get: () =>
              Effect.succeed({
                ...snapshot,
                items: [
                  ...snapshot.items,
                  {
                    ...hiddenItem,
                    id: "owned",
                    primaryThreadId: ThreadId.make("old-worker"),
                    secondMateThreadId: worker,
                  },
                ],
              }),
          }),
        ),
      ),
    ),
  ),
);

it.effect("returns the Second Mate chat for both new and existing tasks", () =>
  Effect.gen(function* () {
    const toolkit = yield* WorkspaceToolkit;
    const created = yield* toolkit
      .handle("t3_workspace_start_task", {
        itemId: "export",
        title: "Export",
        brief: "Add CSV export",
      })
      .pipe(Stream.unwrap, Stream.runCollect);
    const direct = yield* toolkit
      .handle("t3_workspace_start_task", {
        itemId: "csv",
        title: "Export",
        brief: "Add CSV export",
        mode: "direct",
      })
      .pipe(Stream.unwrap, Stream.runCollect);
    expect(direct.at(-1)?.result).toEqual({
      itemId: "csv",
      workerThreadId: "csv-worker",
      link: "<t3-thread://v2/test/csv-worker>",
    });
    const opened = yield* toolkit
      .handle("t3_workspace_update", { command: { type: "ensureSecondMate", itemId: "export" } })
      .pipe(Stream.unwrap, Stream.runCollect);
    for (const replies of [created, opened]) {
      expect(replies.at(-1)?.result).toEqual({
        itemId: "export",
        secondMateThreadId: "lead",
        link: "<t3-thread://v2/test/lead>",
      });
    }
  }).pipe(
    Effect.provideService(McpInvocationContext.McpInvocationContext, provider),
    Effect.provide(
      McpToolAccess.HandlersLayer.layer(WorkspaceHandlers.layer).pipe(
        Layer.provideMerge(liveThreadsLayer),
        Layer.provideMerge(
          Layer.mock(Workspace.VisualWorkspace)({
            startTask: (_caller, task) =>
              task.mode === "direct"
                ? Effect.succeed({
                    itemId: task.itemId,
                    threadId: ThreadId.make("csv-worker"),
                    workerThreadId: ThreadId.make("csv-worker"),
                  })
                : Effect.succeed({
                    itemId: task.itemId,
                    threadId: ThreadId.make("lead"),
                    secondMateThreadId: ThreadId.make("lead"),
                  }),
            command: () =>
              Effect.succeed({
                ...snapshot,
                items: [{ ...hiddenItem, id: "export", secondMateThreadId: ThreadId.make("lead") }],
              }),
          }),
        ),
      ),
    ),
  ),
);

it.effect("lets an approval-required Second Mate relay a response to its worker", () =>
  Effect.gen(function* () {
    const toolkit = yield* WorkspaceToolkit;
    const command = {
      type: "respond",
      itemId: "owned",
      requestId: "worker-question",
      response: "Use the task's default.",
    } as const;
    const results = yield* toolkit
      .handle("t3_workspace_update", { command })
      .pipe(Stream.unwrap, Stream.runCollect);
    expect(results.at(-1)?.result).toEqual({ itemId: "owned" });
  }).pipe(
    Effect.provideService(McpInvocationContext.McpInvocationContext, provider),
    Effect.provide(
      McpToolAccess.HandlersLayer.layer(WorkspaceHandlers.layer).pipe(
        Layer.provideMerge(
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getThreadShell: (id) =>
              Effect.succeed(liveThreadShell(id, { runtimeMode: "approval-required" })),
          }),
        ),
        Layer.provideMerge(
          Layer.mock(Workspace.VisualWorkspace)({
            command: (command, actor) => {
              expect(command).toMatchObject({
                type: "respond",
                itemId: "owned",
                requestId: "worker-question",
              });
              expect(actor?.threadId).toBe(worker);
              return Effect.succeed(snapshot);
            },
          }),
        ),
      ),
    ),
  ),
);

it.effect(
  "denies management to read-only clients and native subagents of a registered orchestrator",
  () =>
    Effect.gen(function* () {
      const toolkit = yield* WorkspaceToolkit;
      const scopes: McpInvocationContext.McpInvocationScope[] = [
        {
          ...provider,
          thread: undefined,
          client: { access: "read-only", label: "reader", sessionId: "reader" },
        },
        {
          ...provider,
          thread: {
            threadId: unrelated,
            providerSessionId: "child",
            providerInstanceId: ProviderInstanceId.make("codex"),
            subagent: true,
          },
        },
      ];
      for (const scope of scopes) {
        const result = yield* toolkit
          .handle("t3_workspace_update", {
            command: { type: "update", itemId: hiddenItem.id, stage: "complete" },
          })
          .pipe(
            Stream.unwrap,
            Stream.runCollect,
            Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
          );
        expect(result.at(-1)?.result).toMatchObject({ code: "capability_denied" });
        const creation = yield* toolkit
          .handle("t3_workspace_start_task", {
            itemId: "another",
            title: "Another task",
            brief: "Implement export",
          })
          .pipe(
            Stream.unwrap,
            Stream.runCollect,
            Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
          );
        expect(creation.at(-1)?.result).toMatchObject({ code: "capability_denied" });
      }
    }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "rejects workspace checkpoints from a replaced provider or an unprivileged credential",
  () =>
    Effect.gen(function* () {
      const toolkit = yield* WorkspaceToolkit;
      for (const [scope, code] of [
        [{ ...provider, capabilities: new Set<never>() }, "capability_denied"],
        [
          {
            ...provider,
            thread: {
              ...provider.thread!,
              providerInstanceId: ProviderInstanceId.make("replaced"),
            },
          },
          "parent_not_active",
        ],
      ] as const) {
        const replies = yield* toolkit
          .handle("t3_workspace_checkpoint", {
            stage: "building",
            needsAttention: false,
            summary: "Working on the fix",
          })
          .pipe(
            Stream.unwrap,
            Stream.runCollect,
            Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
          );
        expect(replies.at(-1)?.result).toMatchObject({ code });
      }
    }).pipe(Effect.provide(testLayer)),
);
