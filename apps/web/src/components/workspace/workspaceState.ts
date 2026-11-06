import { useAtomValue } from "@effect/atom-react";
import { threadKey } from "@t3tools/client-runtime/state/entities";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { PendingThreadRequests } from "@t3tools/client-runtime/state/thread-requests";
import type { EnvironmentId, WorkspaceCommand, WorkspaceSnapshot } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { AsyncResult, Atom } from "effect/reactivity";
import * as Option from "effect/Option";
import { useConnectedEnvironmentIds, useEnvironmentIdentities } from "../../state/environments";
import { environmentAtomList, environmentIdsKey } from "../../state/environmentAtomList";
import { environmentPresentations, environmentSummaries } from "../../state/presentation";
import { formatEnvironmentQueryError } from "../../state/query";
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

interface HostWorkspace {
  snapshot: WorkspaceSnapshot | null;
  error: string | null;
}

const hostWorkspace = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get): HostWorkspace => {
    const previous = Option.getOrNull(get.self<HostWorkspace>());
    const config = get(environmentPresentations.serverConfigsAtom).get(environmentId);
    if (!config) return previous ?? { snapshot: null, error: null };
    if (config.environment.capabilities.visualWorkspace !== true) {
      return { snapshot: null, error: "This server supports session conversations only." };
    }
    const query = get(serverEnvironment.workspaceLive({ environmentId, input: {} }));
    return {
      snapshot: AsyncResult.getOrElse(query, () => previous?.snapshot ?? null),
      error: query._tag === "Failure" ? formatEnvironmentQueryError(query.cause) : null,
    };
  }),
);
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
      snapshot.items.flatMap((item) => [
        item.primaryThreadId,
        ...item.sessions.map((s) => s.threadId),
      ]),
    );
    if (snapshot.orchestratorThreadId) threadIds.add(snapshot.orchestratorThreadId);
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
        (request) => request.status === "open" || request.status === "delivering",
      ),
    ) || [...get(workspaceShellsAtom).values()].some(shellNeedsAttention)
  );
});

interface ThreadRequestsState {
  shell: EnvironmentThreadShell;
  pending: PendingThreadRequests | null;
}
const threadStatesAtom = Atom.make((get) => {
  const next = new Map<string, ThreadRequestsState>();
  const previous = Option.getOrNull(get.self<Map<string, ThreadRequestsState>>());
  const connected = get(environmentSummaries.connectedEnvironmentIdsAtom);
  for (const [key, shell] of get(workspaceShellsAtom)) {
    let pending: PendingThreadRequests | null = null;
    if (shell.hasPendingApprovals || shell.hasPendingUserInput) {
      pending = connected.includes(shell.environmentId)
        ? get(
            environmentThreadDetails.pendingRequestsAtom({
              environmentId: shell.environmentId,
              threadId: shell.id,
            }),
          )
        : (previous?.get(key)?.pending ?? null);
    }
    next.set(key, { shell, pending });
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
      snapshot: host?.snapshot ?? null,
      error: host?.error ?? null,
    };
  });
  const items: BoardItem[] = hosts
    .flatMap((host) =>
      (host.snapshot?.items ?? []).map((item) => ({ environmentId: host.environmentId, item })),
    )
    .sort(
      (a, b) =>
        b.item.priority - a.item.priority ||
        a.item.createdAt.localeCompare(b.item.createdAt) ||
        a.item.id.localeCompare(b.item.id),
    );
  const requests: QueueEntry[] = hosts.flatMap((host) =>
    (host.snapshot?.requests ?? [])
      .filter((request) => request.status === "open" || request.status === "delivering")
      .map((request) => ({
        key: JSON.stringify([host.environmentId, "workflow", request.id]),
        environmentId: host.environmentId,
        itemId: request.itemId,
        threadId: request.threadId,
        kind: request.kind,
        prompt: request.prompt,
        createdAt: request.createdAt,
        request,
      })),
  );
  for (const { shell, pending } of threadStates) {
    if (!shellNeedsAttention(shell)) continue;
    const item = items.find(
      (entry) => entry.environmentId === shell.environmentId && itemHasThread(entry.item, shell.id),
    );
    requests.push(...nativeQueueEntries(shell, pending, item?.item.id ?? null));
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
