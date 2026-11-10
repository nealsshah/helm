import { expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { ThreadId } from "./baseSchemas.ts";
import { type WorkItem, WorkspaceSnapshotRpc } from "./visualWorkspace.ts";

const encode = Schema.encodeSync(WorkspaceSnapshotRpc);
const decode = Schema.decodeUnknownSync(WorkspaceSnapshotRpc);

it("exchanges workspace snapshots with servers and clients using a single orchestrator", () => {
  const legacy = { orchestratorThreadId: "first", items: [], requests: [] };
  expect(decode(legacy).orchestratorThreadIds).toEqual(["first"]);
  expect(decode({ ...legacy, orchestratorThreadId: null }).orchestratorThreadIds).toEqual([]);
  const item: WorkItem = {
    id: "ticket",
    stage: "reviewing",
    title: "Inspect the change",
    primaryThreadId: ThreadId.make("reviewer"),
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    attention: "none",
    priority: 0,
    latestReport: null,
    scope: "",
    sessions: [],
    decisions: [],
    artifacts: [],
    dependencies: [],
  };
  const snapshot = {
    ...decode(legacy),
    requests: [
      {
        id: "reply",
        replyId: "run",
        itemId: item.id,
        threadId: item.primaryThreadId,
        kind: "attention" as const,
        prompt: "Reply ready",
        context: "Four letters.",
        choices: [],
        createdAt: item.updatedAt,
        status: "open" as const,
        response: null,
        resolvedAt: null,
      },
    ],
    items: [
      { ...item, directWorker: true as const },
      { ...item, id: "retired", retiredAt: item.updatedAt },
    ],
    orchestratorThreadIds: [ThreadId.make("first"), ThreadId.make("second")],
  };
  const wire = encode(snapshot);
  expect(wire.sessionAttention).toEqual([]);
  expect(wire.requests).toEqual([]);
  expect(wire.readyReplies?.[0]?.replyId).toBe("run");
  expect(wire.items.map((entry) => entry.id)).toEqual(["ticket"]);
  expect(wire.items[0]?.stage).toBe("qa");
  expect(wire.orchestratorThreadId).toBe("second");
  expect(decode(wire)).toEqual(snapshot);
});
