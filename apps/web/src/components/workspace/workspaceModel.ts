import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { threadRuntimeIsActive } from "@t3tools/client-runtime/state/models";
import type { PendingThreadRequests } from "@t3tools/client-runtime/state/thread-requests";
import {
  WorkspaceStage,
  workspaceOwnerThreadId,
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

export function usesSecondMate(item: WorkItem, hostSupportsSecondMate: boolean | undefined) {
  return !item.directWorker && Boolean(item.secondMateThreadId || hostSupportsSecondMate);
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

const cardStatuses = {
  working: { kind: "working", label: "Working" },
  waiting: { kind: "waiting", label: "Waiting" },
  needsYou: { kind: "needsYou", label: "Needs you" },
  paused: { kind: "paused", label: "Paused" },
  idle: { kind: "idle", label: "Idle" },
  done: { kind: "done", label: "Done" },
  disconnected: { kind: "unavailable", label: "Disconnected" },
  unavailable: { kind: "unavailable", label: "Unavailable" },
} as const;

export function workspaceCardStatus({
  item,
  sessions,
  connected,
  workerTriage,
}: {
  item: WorkItem;
  sessions: ReadonlyArray<EnvironmentThreadShell>;
  connected: boolean;
  workerTriage: boolean;
}) {
  if (!connected) return cardStatuses.disconnected;
  if (item.stage === "complete") return cardStatuses.done;
  const available = sessions.filter((session) => !session.archivedAt && !session.deletedAt);
  if (available.length === 0) return cardStatuses.unavailable;
  const ownerId = workspaceOwnerThreadId(item);
  const needsPerson = (session: EnvironmentThreadShell) =>
    session.hasPendingApprovals ||
    ((!workerTriage || session.id === ownerId) &&
      (session.hasPendingUserInput ||
        session.hasActionableProposedPlan ||
        (session.runtime?.status === "failed" && !session.limitRecovery?.autoResume)));
  if (available.some(needsPerson)) return cardStatuses.needsYou;
  if (
    available.some(
      (session) =>
        session.runtime?.status === "preparing" ||
        session.runtime?.status === "starting" ||
        (session.runtime?.status === "running" &&
          !session.blockedOnThreadWait &&
          !session.latestRun?.turnEnded),
    )
  )
    return cardStatuses.working;
  if (
    available.some(
      (session) =>
        session.hasPendingUserInput ||
        session.hasActionableProposedPlan ||
        (session.runtime?.status === "failed" && !session.limitRecovery?.autoResume),
    )
  )
    return { ...cardStatuses.waiting, label: "Waiting for Second Mate" };
  if (available.some((session) => session.limitRecovery?.autoResume)) {
    return { ...cardStatuses.waiting, label: "Waiting for provider" };
  }
  const background = available.flatMap((session) => session.pendingBackgroundTasks);
  if (background.some((task) => task.kind === "subagent")) {
    return { ...cardStatuses.waiting, label: "Waiting for workers" };
  }
  if (
    available.some(
      (session) =>
        session.runtime?.status === "queued" ||
        session.runtime?.status === "waiting" ||
        (session.runtime?.status === "running" &&
          (session.blockedOnThreadWait || session.latestRun?.turnEnded)) ||
        session.goal?.status === "active",
    ) ||
    background.some((task) => task.awaited || task.kind === "background_task")
  )
    return cardStatuses.waiting;
  if (available.some((session) => session.pullRequests.some((pr) => pr.watch))) {
    return { ...cardStatuses.waiting, label: "Waiting for PR updates" };
  }
  const latest = available.toSorted((a, b) =>
    (b.latestRun?.requestedAt ?? b.updatedAt).localeCompare(
      a.latestRun?.requestedAt ?? a.updatedAt,
    ),
  )[0];
  if (
    available.find((session) => session.id === ownerId)?.goal?.status === "paused" ||
    latest?.latestRun?.status === "interrupted" ||
    latest?.latestRun?.status === "cancelled" ||
    (latest?.latestRun?.status === "queued" && latest.runtime?.status === "idle")
  )
    return cardStatuses.paused;
  return cardStatuses.idle;
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
