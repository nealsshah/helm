import type { ThreadStructure, ThreadStructureTurnItem } from "@t3tools/client-runtime/state/shell";
import {
  isWorkspaceCheckpointToolName,
  type RunId,
  type ThreadId,
  type TurnItemId,
} from "@t3tools/contracts";
import { htmlRenderFromToolItem, mcpAppFromToolItem } from "@t3tools/shared/toolOutput";

export function secondMateTranscript(
  projection: Pick<ThreadStructure, "runs" | "messages" | "visibleTurnItems">,
  firstMates: ReadonlyArray<ThreadId>,
) {
  const roots = new Map(projection.runs.map((run) => [run.userMessageId, run.id]));
  const internal = new Set<RunId>();
  const humanRoots = new Set<RunId>();
  const humanSteers = new Map<RunId, number>();
  function isWorkerMessage(createdBy: string, sender: ThreadId | undefined, messageId: string) {
    return (
      createdBy === "agent" &&
      sender !== undefined &&
      !firstMates.includes(sender) &&
      !messageId.startsWith("helm:kickoff:")
    );
  }
  for (const message of projection.messages) {
    const run = roots.get(message.id);
    if (!run) continue;
    if (
      isWorkerMessage(message.createdBy, message.senderThreadId, message.id) ||
      message.delegatedCompletion ||
      message.notification?.source.kind === "delegated_task" ||
      message.notification?.source.kind === "subagent"
    ) {
      internal.add(run);
    } else if (message.createdBy === "user") {
      humanRoots.add(run);
    }
  }
  const inProgress = new Set(
    projection.runs
      .filter((run) => ["preparing", "starting", "running", "queued"].includes(run.status))
      .map((run) => run.id),
  );
  const finalAnswer = new Map<RunId, TurnItemId>();
  const published = new Set<RunId>();
  for (const { item } of projection.visibleTurnItems) {
    const run = item.runId;
    if (!run) continue;
    if (
      item.type === "notification" &&
      (item.source.kind === "delegated_task" || item.source.kind === "subagent") &&
      !humanRoots.has(run)
    ) {
      internal.add(run);
    }
    if (item.type === "user_message") {
      if (
        isWorkerMessage(item.createdBy, item.senderThreadId, item.messageId) &&
        (item.inputIntent === "turn_start" || item.inputIntent === "queued_turn")
      ) {
        internal.add(run);
      }
      if (item.createdBy === "user") {
        if (item.inputIntent === "turn_start" || item.inputIntent === "queued_turn")
          internal.delete(run);
        else if (!humanSteers.has(run)) humanSteers.set(run, item.ordinal);
      }
    }
    if (item.type === "assistant_message") finalAnswer.set(run, item.id);
    if (
      item.type === "dynamic_tool" &&
      item.status === "completed" &&
      isWorkspaceCheckpointToolName(item.toolName)
    ) {
      const input = item.input;
      if (
        input &&
        typeof input === "object" &&
        (("publishReply" in input && input.publishReply === true) ||
          ("stage" in input && input.stage === "complete") ||
          ("needsAttention" in input && input.needsAttention === true))
      )
        published.add(run);
      else published.delete(run);
    }
  }
  function shows(item: ThreadStructureTurnItem) {
    const run = item.runId;
    if (item.type === "user_message")
      return (
        !isWorkerMessage(item.createdBy, item.senderThreadId, item.messageId) &&
        !(
          item.createdBy === "agent" &&
          run !== null &&
          internal.has(run) &&
          (item.inputIntent === "turn_start" || item.inputIntent === "queued_turn")
        )
      );
    if (
      item.type === "approval_request" ||
      item.type === "user_input_request" ||
      item.type === "link_request"
    )
      return true;
    if (
      item.type === "notification" &&
      (item.source.kind === "subagent" || item.source.kind === "delegated_task")
    )
      return false;
    const privateWork =
      run !== null && internal.has(run) && item.ordinal < (humanSteers.get(run) ?? Infinity);
    if (item.type === "assistant_message" && run !== null) {
      return (
        (!privateWork || published.has(run)) &&
        !inProgress.has(run) &&
        finalAnswer.get(run) === item.id
      );
    }
    if (privateWork) return false;
    if (item.type === "dynamic_tool")
      return Boolean(htmlRenderFromToolItem(item) || mcpAppFromToolItem(item));
    return (
      item.type !== "subagent" &&
      item.type !== "reasoning" &&
      item.type !== "todo_list" &&
      item.type !== "command_execution" &&
      item.type !== "file_search" &&
      item.type !== "web_search"
    );
  }
  return {
    shows,
    isPrivateRun: (run: RunId | null | undefined) =>
      run != null && internal.has(run) && !humanSteers.has(run),
  };
}

export type SecondMateTranscript = ReturnType<typeof secondMateTranscript>;
