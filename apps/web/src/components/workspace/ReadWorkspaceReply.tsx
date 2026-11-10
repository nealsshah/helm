import { RegistryContext, useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ScopedThreadRef, WorkspaceRequest } from "@t3tools/contracts";
import { use, useEffect, useEffectEvent, useRef } from "react";
import { serverEnvironment } from "../../state/server";
import { toastManager } from "../ui/toast";
import { hostWorkspace } from "./workspaceHost";
import { useWorkspaceCommand } from "./workspaceState";

export function useReadWorkspaceReply() {
  const registry = use(RegistryContext);
  const command = useWorkspaceCommand();
  return (environmentId: EnvironmentId, itemId: string, replyId: string) => {
    if (!registry.get(serverEnvironment.workspaceCommand.permissionAtom(environmentId))) return;
    void command(environmentId, { type: "readReply", itemId, replyId }).catch((error: unknown) =>
      toastManager.add({
        type: "error",
        title: "Couldn’t mark reply as read",
        description: error instanceof Error ? error.message : undefined,
      }),
    );
  };
}

export function ReadWorkspaceReplyOnOpen({ threadRef }: { threadRef: ScopedThreadRef }) {
  const { environmentId, threadId } = threadRef;
  const request = useAtomValue(
    hostWorkspace(environmentId),
    (host): WorkspaceRequest | undefined | null =>
      host.snapshot
        ? (host.snapshot.requests.find(
            (request) =>
              request.threadId === threadId && request.replyId && request.status === "open",
          ) ?? null)
        : undefined,
  );
  const markRead = useEffectEvent(useReadWorkspaceReply());
  const inspected = useRef(false);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- A visible thread entry acknowledges the reply present when the workspace first loads.
  useEffect(() => {
    if (inspected.current || request === undefined) return;
    function inspect() {
      if (inspected.current || document.hidden) return;
      inspected.current = true;
      if (request?.replyId) markRead(environmentId, request.itemId, request.replyId);
    }
    inspect();
    if (inspected.current) return;
    document.addEventListener("visibilitychange", inspect);
    return () => document.removeEventListener("visibilitychange", inspect);
  }, [environmentId, request]);
  return null;
}
