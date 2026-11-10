import type { EnvironmentId, ThreadId, WorkspaceSnapshot } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import * as Option from "effect/Option";
import { environmentPresentations } from "../../state/presentation";
import { formatEnvironmentQueryError } from "../../state/query";
import { serverEnvironment } from "../../state/server";

interface HostWorkspace {
  secondMate?: boolean;
  workerTriage?: boolean;
  retirement?: boolean;
  snapshot: WorkspaceSnapshot | null;
  error: string | null;
}

export const hostWorkspace = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get): HostWorkspace => {
    const previous = Option.getOrNull(get.self<HostWorkspace>());
    const config = get(environmentPresentations.serverConfigsAtom).get(environmentId);
    if (!config) return previous ?? { snapshot: null, error: null };
    if (config.environment.capabilities.visualWorkspace !== true) {
      return { snapshot: null, error: "This server supports session conversations only." };
    }
    const query = get(serverEnvironment.workspaceLive({ environmentId, input: {} }));
    return {
      retirement: config.environment.capabilities.workspaceRetirement === true,
      workerTriage: config.environment.capabilities.workspaceWorkerTriage === true,
      secondMate: config.environment.capabilities.workspaceSecondMate === true,
      snapshot: AsyncResult.getOrElse(query, () => previous?.snapshot ?? null),
      error: query._tag === "Failure" ? formatEnvironmentQueryError(query.cause) : null,
    };
  }),
);
export const workspaceTriageRoles = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) => {
    const host = get(hostWorkspace(environmentId));
    const roles = new Map<ThreadId, "worker" | "lead" | "retired">();

    for (const item of host.snapshot?.items ?? []) {
      if (item.retiredAt) {
        roles.set(item.primaryThreadId, "retired");
        if (item.secondMateThreadId) roles.set(item.secondMateThreadId, "retired");
        for (const session of item.sessions) roles.set(session.threadId, "retired");
        continue;
      }
      if (!host.workerTriage || !item.secondMateThreadId) continue;
      roles.set(item.primaryThreadId, "worker");
      for (const session of item.sessions) roles.set(session.threadId, "worker");
      roles.set(item.secondMateThreadId, "lead");
    }
    return roles;
  }),
);

export function triagesThreadInput(role: "worker" | "lead" | undefined, hasOwnInput: boolean) {
  return role === "worker" || (role === "lead" && !hasOwnInput);
}
