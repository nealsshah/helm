import {
  IsoDateTime,
  OrchestrationV2RuntimeRequest,
  OrchestrationV2ShellThreadStatus,
  OrchestratorMcpFailure,
  ThreadId,
  TrimmedNonEmptyString,
  WorkspaceAgentCommand,
  WorkspaceRequest,
  WorkspaceSnapshot,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Workspace from "../../../workspace/VisualWorkspace.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagement.ThreadManagementService,
    Workspace.VisualWorkspace,
  ],
};

const read = Tool.make("t3_workspace_read", {
  ...shared,
  description: "Read the work board, decisions and attention requests. Filter by itemId.",
  parameters: Schema.Struct({ itemId: Schema.optional(TrimmedNonEmptyString) }),
  success: Schema.Struct({
    ...WorkspaceSnapshot.fields,
    callerThreadId: Schema.NullOr(ThreadId),
    sessions: Schema.Array(
      Schema.Struct({
        threadId: ThreadId,
        status: OrchestrationV2ShellThreadStatus,
        updatedAt: IsoDateTime,
        lastError: Schema.NullOr(Schema.String),
        reviewPlan: Schema.Boolean,
        pending: Schema.Array(
          Schema.Struct({
            id: OrchestrationV2RuntimeRequest.fields.id,
            kind: OrchestrationV2RuntimeRequest.fields.kind,
            createdAt: IsoDateTime,
          }),
        ),
      }),
    ),
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const update = Tool.make("t3_workspace_update", {
  ...shared,
  description:
    "Report progress or request human input on your assigned item using callerThreadId. Include stage in a report to move the card when the work changes phase. Every request needs a unique requestId, including the first attempt. Reuse it on retry. The workspace orchestrator can also manage work, sessions, dependencies and milestones.",
  parameters: Schema.Struct({ command: WorkspaceAgentCommand }),
  success: Schema.Struct({
    itemId: TrimmedNonEmptyString,
    request: Schema.optional(WorkspaceRequest),
  }),
}).annotate(Tool.Destructive, false);

export const WorkspaceToolkit = Toolkit.make(read, update);
