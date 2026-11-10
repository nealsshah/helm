import {
  IsoDateTime,
  OrchestrationV2RuntimeRequest,
  OrchestrationV2ShellThreadStatus,
  OrchestratorMcpFailure,
  ThreadId,
  TrimmedNonEmptyString,
  WorkspaceAgentCommand,
  WorkspaceCheckpoint,
  WorkspaceSnapshot,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as McpSchema from "effect/ai/McpSchema";

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
  description: "Read tasks, decisions and open requests.",
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

const startTask = Tool.make("t3_workspace_start_task", {
  ...shared,
  description:
    "First Mate: start a task with a Second Mate by default. Set mode to direct only when the person asks for a worker without a Second Mate. Name a project by title, workspace path or ID, or omit project for the current project. Reuse itemId on retries.",
  parameters: Schema.Struct({
    itemId: TrimmedNonEmptyString,
    title: TrimmedNonEmptyString,
    brief: TrimmedNonEmptyString,
    mode: Schema.optional(Schema.Literals(["managed", "direct"])),
    project: Schema.optional(TrimmedNonEmptyString),
  }),
  success: Schema.Union([
    Schema.Struct({
      itemId: TrimmedNonEmptyString,
      secondMateThreadId: ThreadId,
      link: Schema.String,
    }),
    Schema.Struct({ itemId: TrimmedNonEmptyString, workerThreadId: ThreadId, link: Schema.String }),
  ]),
})
  .annotate(Tool.Destructive, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromSubagents);

const update = Tool.make("t3_workspace_update", {
  ...shared,
  description: "Manage tasks. Second Mates can answer worker requests.",
  parameters: Schema.Struct({ command: WorkspaceAgentCommand }),
  success: Schema.Struct({
    itemId: TrimmedNonEmptyString,
    secondMateThreadId: Schema.optional(ThreadId),
    link: Schema.optional(Schema.String),
  }),
}).annotate(Tool.Destructive, false);

const checkpoint = Tool.make("t3_workspace_checkpoint", {
  ...shared,
  description:
    "Report your stage, next action and any blocker. A card owner flags the person. A managed worker flags its Second Mate.",
  parameters: WorkspaceCheckpoint,
  success: Schema.Struct({ itemId: TrimmedNonEmptyString }),
}).annotate(Tool.Destructive, false);

export const WorkspaceToolkit = Toolkit.make(read, update, checkpoint, startTask);
