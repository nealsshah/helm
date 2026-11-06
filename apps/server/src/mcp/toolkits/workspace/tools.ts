import {
  IsoDateTime,
  OrchestrationV2RuntimeRequest,
  OrchestrationV2ShellThreadStatus,
  OrchestratorMcpFailure,
  ThreadId,
  TrimmedNonEmptyString,
  WorkspaceAgentCommand,
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
  description: "Read the work board, decisions and sessions needing attention. Filter by itemId.",
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
    "Report progress on your assigned item using callerThreadId. Set report.stage as work changes: planning for scope, building for changes, qa for checks or review, complete for verified delivery. To bring your session to Needs me for any human action, set report.needsAttention to true, summarize the reason in text and explain the next step in chat. A direct chat reply clears attention. Set needsAttention to false if you resume independently. The workspace orchestrator can also manage work, sessions, dependencies and milestones.",
  parameters: Schema.Struct({ command: WorkspaceAgentCommand }),
  success: Schema.Struct({
    itemId: TrimmedNonEmptyString,
  }),
}).annotate(Tool.Destructive, false);

export const WorkspaceToolkit = Toolkit.make(read, update);
