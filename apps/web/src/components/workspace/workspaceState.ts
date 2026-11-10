import { useAtomValue } from "@effect/atom-react";
import { threadKey } from "@t3tools/client-runtime/state/entities";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { PendingThreadRequests } from "@t3tools/client-runtime/state/thread-requests";
import type { EnvironmentId, WorkspaceCommand } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { Atom } from "effect/reactivity";
import * as Option from "effect/Option";
import { useConnectedEnvironmentIds, useEnvironmentIdentities } from "../../state/environments";
import { environmentAtomList, environmentIdsKey } from "../../state/environmentAtomList";
import { environmentSummaries } from "../../state/presentation";
import { hostWorkspace, workspaceTriageRoles } from "./workspaceHost";
import { serverEnvironment } from "../../state/server";
import { environmentThreadShells, environmentThreadDetails } from "../../state/threads";
import { presentThreadShellFromProjection } from "../ChatView.logic";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  itemHasThread,
  shellNeedsAttention,
  nativeQueueEntries,
  type BoardItem,
  type QueueEntry,
} from "./workspaceModel";

const workspaceList = environmentAtomList("web-workspace-summaries", hostWorkspace);

const workspaceShellsAtom = Atom.make((get) => {
  const byThread = new Map<string, EnvironmentThreadShell>();
  const connected = get(environmentSummaries.connectedEnvironmentIdsAtom);
  for (const shell of get(environmentThreadShells.quietThreadShellsAtom)) {
    if (!shell.archivedAt && !shell.deletedAt)
      byThread.set(threadKey({ environmentId: shell.environmentId, threadId: shell.id }), shell);
  }
  const previous = Option.getOrNull(get.self<Map<string, EnvironmentThreadShell>>());
  for (const environmentId of get(environmentSummaries.environmentIdsAtom)) {
    const snapshot = get(hostWorkspace(environmentId)).snapshot;
    if (!snapshot) continue;
    const threadIds = new Set(
      snapshot.items.flatMap((item) =>
        item.retiredAt
          ? []
          : [
              item.primaryThreadId,
              ...(item.secondMateThreadId ? [item.secondMateThreadId] : []),
              ...item.sessions.map((s) => s.threadId),
            ],
      ),
    );
    for (const [id, role] of get(workspaceTriageRoles(environmentId))) {
      if (role === "retired") byThread.delete(threadKey({ environmentId, threadId: id }));
    }
    for (const threadId of snapshot.orchestratorThreadIds) threadIds.add(threadId);
    for (const threadId of threadIds) {
      const ref = { environmentId, threadId },
        key = threadKey(ref);
      if (byThread.has(key)) continue;
      const indexed = get(environmentThreadShells.quietThreadShellAtom(ref));
      if (indexed) {
        byThread.set(key, indexed);
        continue;
      }
      if (!connected.includes(environmentId)) {
        const kept = previous?.get(key);
        if (kept) byThread.set(key, kept);
        continue;
      }
      // Archived conversations can leave the shell index while their work item still owns them.
      const projection = get(environmentThreadDetails.quietThreadAtom(ref))?.projection;
      const updatedAt = get(environmentThreadDetails.updatedAtAtom(ref));
      if (projection && updatedAt)
        byThread.set(
          key,
          presentThreadShellFromProjection(environmentId, threadId, projection, {
            updatedAt,
            lastVisitedAt: get(environmentThreadDetails.lastVisitedAtAtom(ref)),
          }),
        );
    }
  }
  return byThread;
});

export const workspaceNeedsAttentionAtom = Atom.make((get) => {
  const ids = get(environmentSummaries.environmentIdsAtom);
  return (
    get(workspaceList(environmentIdsKey(ids))).some(({ snapshot }) =>
      snapshot?.requests.some(
        (request) =>
          (request.status === "open" || request.status === "delivering") &&
          !snapshot.items.some((item) => item.id === request.itemId && item.retiredAt),
      ),
    ) ||
    [...get(workspaceShellsAtom).values()].some((shell) =>
      shellNeedsAttention(
        shell,
        get(workspaceTriageRoles(shell.environmentId)).get(shell.id) === "worker",
      ),
    )
  );
});

interface ThreadRequestsState {
  shell: EnvironmentThreadShell;
  pending: PendingThreadRequests | null;
  triaged: boolean;
}
const threadStatesAtom = Atom.make((get) => {
  const next = new Map<string, ThreadRequestsState>();
  const previous = Option.getOrNull(get.self<Map<string, ThreadRequestsState>>());
  const connected = get(environmentSummaries.connectedEnvironmentIdsAtom);
  for (const [key, shell] of get(workspaceShellsAtom)) {
    let pending: PendingThreadRequests | null = null;
    const triaged = get(workspaceTriageRoles(shell.environmentId)).get(shell.id) === "worker";
    if (shell.hasPendingApprovals || (!triaged && shell.hasPendingUserInput)) {
      pending = connected.includes(shell.environmentId)
        ? get(
            environmentThreadDetails.pendingRequestsAtom({
              environmentId: shell.environmentId,
              threadId: shell.id,
            }),
          )
        : (previous?.get(key)?.pending ?? null);
    }
    next.set(key, { shell, pending, triaged });
  }
  return next;
});

export function useWorkspaceState() {
  const environments = useEnvironmentIdentities();
  const connected = useConnectedEnvironmentIds();
  const queries = useAtomValue(
    workspaceList(environmentIdsKey(environments.map((env) => env.environmentId))),
  );
  const threadStates = [...useAtomValue(threadStatesAtom).values()];
  const hosts = environments.map((env, index) => {
    const host = queries[index];
    return {
      ...env,
      connected: connected.includes(env.environmentId),
      secondMate: host?.secondMate === true,
      workerTriage: host?.workerTriage === true,
      retirement: host?.retirement === true,
      sessionOnly: host?.sessionOnly === true,
      snapshot: host?.snapshot ?? null,
      error: host?.error ?? null,
    };
  });
  const items: BoardItem[] = hosts
    .flatMap((host) =>
      (host.snapshot?.items ?? [])
        .filter((item) => !item.retiredAt)
        .map((item) => ({ environmentId: host.environmentId, item })),
    )
    .sort(
      (a, b) =>
        b.item.priority - a.item.priority ||
        a.item.createdAt.localeCompare(b.item.createdAt) ||
        a.item.id.localeCompare(b.item.id),
    );
  const requests: QueueEntry[] = hosts.flatMap((host) =>
    (host.snapshot?.requests ?? [])
      .filter(
        (request) =>
          (request.status === "open" || request.status === "delivering") &&
          !host.snapshot?.items.some((item) => item.id === request.itemId && item.retiredAt),
      )
      .map((request) => ({
        key: JSON.stringify([host.environmentId, "workflow", request.id]),
        environmentId: host.environmentId,
        itemId: request.itemId,
        threadId: request.threadId,
        kind: request.kind,
        replyId: request.replyId,
        prompt: request.prompt,
        createdAt: request.createdAt,
      })),
  );
  for (const { shell, pending, triaged } of threadStates) {
    if (!shellNeedsAttention(shell, triaged)) continue;
    const item = items.find(
      (entry) => entry.environmentId === shell.environmentId && itemHasThread(entry.item, shell.id),
    );
    requests.push(...nativeQueueEntries(shell, pending, item?.item.id ?? null, triaged));
  }
  requests.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.key.localeCompare(b.key));
  return { hosts, items, requests, shells: threadStates.map(({ shell }) => shell) };
}

export function useWorkspaceCommand() {
  const run = useAtomCommand(serverEnvironment.workspaceCommand, { reportFailure: false });
  return async (environmentId: EnvironmentId, command: WorkspaceCommand) => {
    const result = await run({ environmentId, input: { command } });
    if (result._tag === "Failure") {
      const cause = squashAtomCommandFailure(result);
      throw new Error(
        cause instanceof Error ? cause.message : "The workspace command was interrupted.",
      );
    }
  };
}
export type WorkspaceState = ReturnType<typeof useWorkspaceState>;
