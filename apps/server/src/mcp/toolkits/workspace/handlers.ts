import { OrchestratorMcpFailure, type WorkspaceError } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import * as Workspace from "../../../workspace/VisualWorkspace.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { assertNotLinked } from "../../linkOrigin.ts";
import { assertFullAccess, assertLiveCaller, readCaller, unavailable } from "../../threadAccess.ts";
import { WorkspaceToolkit } from "./tools.ts";

const workspaceFailure = (error: WorkspaceError) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message: error.message });

export const layer = McpToolAccess.toLayer(WorkspaceToolkit, {
  t3_workspace_read: McpToolAccess.reads(({ itemId }) =>
    Effect.gen(function* () {
      const caller = yield* readCaller();
      yield* assertLiveCaller(caller);
      const actor = caller.scope.thread;
      const workspace = yield* Workspace.VisualWorkspace;
      const snapshot = yield* workspace.get().pipe(Effect.mapError(workspaceFailure));
      const managesBoard =
        actor === undefined ||
        (!actor.subagent && snapshot.orchestratorThreadIds.includes(actor.threadId));
      if (managesBoard) {
        yield* assertNotLinked(caller, "read this environment's full workspace");
        yield* assertFullAccess(
          caller,
          "Reading the full workspace requires full-access/default mode.",
        );
      }
      const items = snapshot.items.filter(
        (item) =>
          (itemId === undefined || item.id === itemId) &&
          (managesBoard ||
            item.primaryThreadId === actor?.threadId ||
            item.sessions.some((session) => session.threadId === actor?.threadId)),
      );
      const itemIds = new Set(items.map((item) => item.id));
      const threadIds = new Set(
        items.flatMap((item) => [
          item.primaryThreadId,
          ...item.sessions.map((session) => session.threadId),
        ]),
      );
      const all = managesBoard && itemId === undefined;
      const shells =
        all || threadIds.size > 0
          ? (yield* caller.threads
              .getShellSnapshot(all ? { location: "active" } : { threadIds: [...threadIds] })
              .pipe(Effect.mapError(unavailable))).threads
          : [];
      const sessions = yield* Effect.forEach(
        shells.filter(
          (shell) =>
            threadIds.has(shell.id) ||
            (all &&
              (shell.pendingRuntimeRequest ||
                shell.hasActionableProposedPlan ||
                shell.status === "failed")),
        ),
        (shell) =>
          Effect.gen(function* () {
            const pending =
              shell.pendingRuntimeRequest === null
                ? []
                : (yield* caller.threads
                    .getThreadRecords(shell.id, ["runtimeRequests"], {
                      runtimeRequestStatuses: ["pending"],
                    })
                    .pipe(Effect.mapError(unavailable))).runtimeRequests;
            return {
              threadId: shell.id,
              status: shell.status,
              updatedAt: DateTime.formatIso(shell.updatedAt),
              lastError: shell.lastError ?? null,
              reviewPlan: shell.hasActionableProposedPlan,
              pending: pending.map((entry) => ({
                id: entry.id,
                kind: entry.kind,
                createdAt: DateTime.formatIso(entry.createdAt),
              })),
            };
          }),
      );
      return {
        orchestratorThreadIds: managesBoard ? snapshot.orchestratorThreadIds : [],
        items,
        requests: snapshot.requests.filter((request) => itemIds.has(request.itemId)),
        sessions,
        callerThreadId: actor?.threadId ?? null,
      };
    }),
  ),
  t3_workspace_update: McpToolAccess.writesWithCapability(({ command }) =>
    Effect.gen(function* () {
      const caller = yield* readCaller();
      const actor = caller.scope.thread;
      if (actor === undefined || command.type !== "report") {
        if (actor?.subagent) {
          return yield* new OrchestratorMcpFailure({
            code: "capability_denied",
            message: "A subagent can only publish activity or request input.",
          });
        }
        yield* assertFullAccess(
          caller,
          "Managing the workspace requires full-access/default mode.",
        );
      }
      const workspace = yield* Workspace.VisualWorkspace;
      yield* workspace.command(command, actor).pipe(Effect.mapError(workspaceFailure));
      return { itemId: command.itemId };
    }),
  ),
});
