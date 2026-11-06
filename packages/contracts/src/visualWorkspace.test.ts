import { expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { ThreadId } from "./baseSchemas.ts";
import { WorkspaceSnapshotRpc } from "./visualWorkspace.ts";

it("exchanges workspace snapshots with servers and clients using a single orchestrator", () => {
  const legacy = { orchestratorThreadId: "first", items: [], requests: [] };
  const decode = Schema.decodeUnknownSync(WorkspaceSnapshotRpc);
  expect(decode(legacy).orchestratorThreadIds).toEqual(["first"]);
  expect(decode({ ...legacy, orchestratorThreadId: null }).orchestratorThreadIds).toEqual([]);
  const snapshot = {
    ...decode(legacy),
    orchestratorThreadIds: [ThreadId.make("first"), ThreadId.make("second")],
  };
  const wire = Schema.encodeSync(WorkspaceSnapshotRpc)(snapshot);
  expect(wire.orchestratorThreadId).toBe("second");
  expect(decode(wire)).toEqual(snapshot);
});
