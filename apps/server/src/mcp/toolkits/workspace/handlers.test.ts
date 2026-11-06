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
import { liveThreadsLayer } from "../../McpToolAccess.testkit.ts";
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
  orchestratorThreadId: unrelated,
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
        orchestratorThreadId: null,
        callerThreadId: worker,
      });
    }
  }).pipe(
    Effect.provideService(McpInvocationContext.McpInvocationContext, provider),
    Effect.provide(testLayer),
  ),
);

it.effect(
  "denies management to read-only clients and native subagents of the chosen orchestrator",
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
      }
    }).pipe(Effect.provide(testLayer)),
);
