import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { threadRuntimeIsActive } from "@t3tools/client-runtime/state/models";
import type { PendingThreadRequests } from "@t3tools/client-runtime/state/thread-requests";
import {
  WorkspaceStage,
  type EnvironmentId,
  type ThreadId,
  type WorkItem,
} from "@t3tools/contracts";

export const stages = WorkspaceStage.literals;
export const stageLabel: Record<WorkItem["stage"], string> = {
  planning: "Planning",
  building: "Building",
  reviewing: "Reviewing",
  qa: "QA",
  complete: "Done",
};

export interface BoardItem {
  environmentId: EnvironmentId;
  item: WorkItem;
}

export interface QueueEntry {
  replyId?: string | undefined;
  key: string;
  environmentId: EnvironmentId;
  itemId: string | null;
  threadId: ThreadId;
  kind: string;
  prompt: string;
  createdAt: string;
}

export function itemHasThread(item: WorkItem, threadId: ThreadId) {
  return (
    item.secondMateThreadId === threadId ||
    item.primaryThreadId === threadId ||
    item.sessions.some((session) => session.threadId === threadId)
  );
}

export function outstandingDependencies(item: WorkItem, siblings: ReadonlyArray<WorkItem>) {
  return item.dependencies.flatMap((dependency) => {
    const target = siblings.find((sibling) => sibling.id === dependency.itemId);
    return target?.stage === "complete"
      ? []
      : [{ ...dependency, title: target?.title ?? dependency.itemId }];
  });
}

export function runtimeLabel(
  shell: EnvironmentThreadShell | undefined,
  connected: boolean,
  triaged = false,
) {
  if (!connected) return "Disconnected";
  if (!shell) return "Unavailable";
  if (shell.archivedAt || shell.deletedAt) return "Archived";
  if (shell.hasPendingApprovals) return "Awaiting input";
  if (shell.hasPendingUserInput) return triaged ? "Awaiting Second Mate" : "Awaiting input";
  if (shell.runtime?.status === "failed") return "Error";
  if (shell.runtime?.status === "queued") return "Queued";
  if (shell.runtime?.status === "waiting") return "Waiting";
  return threadRuntimeIsActive(shell.runtime) ? "Running" : "Idle";
}

export function shellNeedsAttention(shell: EnvironmentThreadShell, triaged: boolean) {
  if (triaged) return shell.hasPendingApprovals;
  return (
    shell.hasPendingUserInput ||
    shell.hasPendingApprovals ||
    shell.hasActionableProposedPlan ||
    shell.runtime?.status === "failed"
  );
}

export function nativeQueueEntries(
  shell: EnvironmentThreadShell,
  pending: PendingThreadRequests | null,
  itemId: string | null,
  triaged = false,
): QueueEntry[] {
  const result: QueueEntry[] = [];
  function add(id: string, kind: string, prompt: string, createdAt: string) {
    result.push({
      key: JSON.stringify([shell.environmentId, shell.id, kind, id]),
      environmentId: shell.environmentId,
      itemId,
      threadId: shell.id,
      kind,
      prompt,
      createdAt,
    });
  }
  for (const approval of pending?.approvals ?? []) {
    add(
      approval.requestId,
      "Approval",
      approval.detail || approval.reason || approval.requestKind,
      approval.createdAt,
    );
  }
  if (shell.hasPendingApprovals && !pending?.approvals.length) {
    add("pending", "Approval", "Approval needed", shell.updatedAt);
  }
  if (triaged) return result;
  for (const input of pending?.userInputs ?? []) {
    add(
      input.requestId,
      "Input",
      input.questions.map((question) => question.question).join(" • "),
      input.createdAt,
    );
  }
  if (shell.hasPendingUserInput && !pending?.userInputs.length) {
    add("pending", "Input", "Waiting for your input", shell.updatedAt);
  }
  if (shell.hasActionableProposedPlan)
    add("plan", "Review", "Review the proposed plan", shell.updatedAt);
  if (shell.runtime?.status === "failed")
    add(
      "failure",
      "Error",
      shell.runtime.lastError || "Inspect the failed run",
      shell.runtime.updatedAt,
    );
  return result;
}

export function safeArtifactUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : null;
  } catch {
    return null;
  }
}

export function sourceTime(at: string) {
  return new Date(at).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
