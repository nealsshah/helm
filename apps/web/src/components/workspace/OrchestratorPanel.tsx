import { useAtomValue } from "@effect/atom-react";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { WORKSPACE_MATE_MODEL, type ThreadId } from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { PlusIcon, XIcon } from "lucide-react";
import { useEffect, useEffectEvent, useState } from "react";
import {
  DraftId,
  finalizePromotedDraftThreadByRef,
  resolveDraftPromotionNavigationTarget,
  useComposerDraftStore,
} from "../../composerDraftStore";
import { ComposerHandleContext } from "../../composerHandleContext";
import { newDraftId, newThreadId } from "../../lib/utils";
import { useProjects } from "../../state/entities";
import { environmentServerConfigsAtom, serverEnvironment } from "../../state/server";
import ChatView from "../ChatView";
import { BackgroundThreadContext } from "../chat/backgroundThread";
import { ProjectPicker } from "../chat/ProjectPicker";
import { Button } from "../ui/button";
import { firstMateDraftKey } from "./firstMateDraft";
import { SessionProjectPicker } from "./SessionProjectPicker";
import { useDelivery } from "./WorkspaceForms";
import { SessionTabs } from "./SessionTabs";
import { WorkPanel } from "./WorkPanel";
import { useWorkspaceCommand, type WorkspaceState } from "./workspaceState";
import type { PanelTarget } from "./workspaceTab";

function firstMateTitle(title: string | undefined) {
  return !title || title === "New orchestrator" ? "First Mate" : title;
}

export function OrchestratorPanel({
  state,
  host,
  selected,
  select,
  close,
}: {
  state: WorkspaceState;
  host: WorkspaceState["hosts"][number];
  selected: ThreadId | undefined;
  select: (target: PanelTarget) => void;
  close: () => void;
}) {
  const environmentId = host.environmentId;
  const registered = host.snapshot?.orchestratorThreadIds ?? [];
  const draftKey = firstMateDraftKey(environmentId);
  const draftId = useComposerDraftStore(
    (store) => store.logicalProjectDraftThreadKeyByLogicalProjectKey[draftKey],
  );
  const draft = useComposerDraftStore((store) =>
    draftId ? store.getDraftSession(DraftId.make(draftId)) : null,
  );
  const shells = state.shells.filter((shell) => shell.environmentId === environmentId);
  const [reserved, setReserved] = useState<ThreadId | null>(null);
  if (draft && reserved !== draft.threadId) setReserved(draft.threadId);
  if (!draft && reserved && registered.includes(reserved)) setReserved(null);
  const arriving =
    reserved && shells.find((shell) => shell.id === reserved)?.latestUserMessageAt
      ? reserved
      : null;
  const localId = draft?.threadId ?? arriving;
  const tabs = localId && !registered.includes(localId) ? [...registered, localId] : registered;
  const active = tabs.find((id) => id === selected) ?? tabs.at(-1);
  const launched =
    draft && registered.includes(draft.threadId)
      ? resolveDraftPromotionNavigationTarget({
          serverThreadRef: scopeThreadRef(environmentId, draft.threadId),
          serverThread: shells.find((shell) => shell.id === draft.threadId),
          backgroundSubmissionPending: false,
        })?.threadId
      : null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Both the workspace registration and the persisted turn must arrive before releasing the panel's draft.
  useEffect(() => {
    if (launched) finalizePromotedDraftThreadByRef(scopeThreadRef(environmentId, launched));
  }, [environmentId, launched]);
  const current = shells.find((shell) => shell.id === active);
  const projects = useProjects().filter(
    (project) =>
      project.environmentId === environmentId && !project.archivedAt && !project.isScratch,
  );
  const defaultProject =
    projects.find((project) => project.id === current?.projectId) ?? projects[0];
  const config = useAtomValue(environmentServerConfigsAtom).get(environmentId);
  const supported = config?.environment.capabilities.firstMateDraftLaunch === true;
  const allowed = useAtomValue(serverEnvironment.workspaceCommand.permissionAtom(environmentId));
  const run = useWorkspaceCommand();
  const delivery = useDelivery();
  const disabled = !host.connected || !allowed || delivery.busy;
  const open = (threadId: ThreadId) =>
    select({ environmentId, threadId, itemId: null, global: true });
  function startDraft(project: EnvironmentProject) {
    if (!config || !supported || disabled) return;
    const store = useComposerDraftStore.getState();
    const existing = store.logicalProjectDraftThreadKeyByLogicalProjectKey[draftKey];
    const session = existing ? store.getDraftSession(DraftId.make(existing)) : null;
    if (session) {
      open(session.threadId);
      return;
    }
    const threadId = newThreadId();
    const id = newDraftId();
    store.setLogicalProjectDraftThreadId(draftKey, scopeProjectRef(environmentId, project.id), id, {
      threadId,
      envMode: "local",
      environmentSelection: "manual",
      runtimeMode: resolveProjectSettings(config.settings, project.id, project).settings
        .defaultRuntimeMode,
    });
    store.applyStickyState(id);
    store.setModelSelection(id, WORKSPACE_MATE_MODEL, { explicit: true, replaceOptions: true });
    open(threadId);
  }
  const empty = Boolean(host.snapshot && !active && supported && !disabled && defaultProject);
  const openEmptyDraft = useEffectEvent(() => {
    if (defaultProject) startDraft(defaultProject);
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- An empty workspace panel opens its composer in the persisted draft store.
  useEffect(() => {
    if (empty) openEmptyDraft();
  }, [empty]);
  const draftActive = draft && draft.threadId === active && !launched;
  return (
    <aside aria-label="First Mate" className="flex min-h-0 min-w-0 flex-col bg-background">
      <div className="flex min-h-12 shrink-0 items-center gap-1 border-b border-border/70 bg-muted/35 px-2">
        <SessionTabs
          label="First Mate sessions"
          tabs={tabs.map((id) => ({
            id,
            title:
              draft?.threadId === id && !launched
                ? "New First Mate"
                : firstMateTitle(shells.find((shell) => shell.id === id)?.title),
          }))}
          selected={active}
          onSelect={open}
          closeDisabled={disabled || Boolean(draftActive && draft.promotedTo)}
          onClose={(id) =>
            void delivery.submit(async () => {
              const index = tabs.indexOf(id);
              if (draftId && id === draft?.threadId && !registered.includes(id)) {
                useComposerDraftStore.getState().clearDraftThread(DraftId.make(draftId));
                if (tabs.length === 1) close();
              } else {
                await run(environmentId, { type: "closeOrchestrator", threadId: id });
              }
              const neighbor = tabs[index + 1] ?? tabs[index - 1];
              if (neighbor) open(neighbor);
            })
          }
        />
        {active && !draftActive && !defaultProject && supported && (
          <ProjectPicker
            compact
            activeProjectRef={null}
            activeProjectTitle={null}
            environmentId={environmentId}
            disabled={disabled}
            onSelect={startDraft}
          />
        )}
        {active && !draftActive && defaultProject && (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="New First Mate session"
            disabled={disabled || !supported}
            title={supported ? undefined : "Update this environment to start a First Mate."}
            onClick={() => startDraft(defaultProject)}
          >
            <PlusIcon />
          </Button>
        )}
        <div className="ml-auto flex min-w-0 shrink-0 items-center gap-1">
          {active && current && !draftActive && (
            <SessionProjectPicker
              environmentId={environmentId}
              threadId={active}
              projectId={current.projectId}
            />
          )}
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Close First Mate panel"
            onClick={close}
          >
            <XIcon />
          </Button>
        </div>
      </div>
      {delivery.error && (
        <p role="alert" className="px-4 py-2 text-sm text-destructive">
          {delivery.error}
        </p>
      )}
      {draftActive && draftId && supported && allowed ? (
        <div
          data-side-chat-pane
          className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
        >
          <BackgroundThreadContext value>
            <ComposerHandleContext value={null}>
              <ChatView
                key={draftId}
                routeKind="draft"
                environmentId={environmentId}
                threadId={draft.threadId}
                draftId={DraftId.make(draftId)}
                workspaceDestination={{ label: "First Mate" }}
                reserveTitleBarControlInset={false}
              />
            </ComposerHandleContext>
          </BackgroundThreadContext>
        </div>
      ) : active && (registered.includes(active) || active === arriving) ? (
        <WorkPanel
          key={active}
          state={state}
          target={{ environmentId, itemId: null, threadId: active, global: true }}
          select={select}
          close={close}
        />
      ) : (
        <div className="m-auto grid max-w-sm justify-items-center gap-3 p-5 text-center">
          {!supported ? (
            <p className="text-sm text-muted-foreground">
              Update this environment to start a First Mate.
            </p>
          ) : disabled ? (
            <p className="text-sm text-muted-foreground">
              A connection with workspace access is required to start a First Mate.
            </p>
          ) : !defaultProject ? (
            <ProjectPicker
              activeProjectRef={null}
              activeProjectTitle={null}
              environmentId={environmentId}
              onSelect={startDraft}
            />
          ) : null}
        </div>
      )}
    </aside>
  );
}
