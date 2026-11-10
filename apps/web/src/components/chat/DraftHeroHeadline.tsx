import type { DraftId } from "~/composerDraftStore";
import { composerDraftHasUserContent, useComposerDraftStore } from "~/composerDraftStore";
import { type ScopedProjectRef } from "@t3tools/contracts";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import { useAtomValue } from "@effect/atom-react";
import { useRef } from "react";

import { shortcutLabelForCommand } from "~/keybindings";
import { primaryServerKeybindingsAtom } from "~/state/server";
import { useNewThreadHandler } from "~/hooks/useHandleNewThread";
import { useScratchProject } from "~/hooks/useScratchProject";
import { isTriagePrompt } from "~/hooks/useStartTriage";
import { useClientSettings } from "~/hooks/useSettings";
import { hasExplicitComposerModelSelection } from "~/lib/chatThreadActions";
import {
  deriveLogicalProjectKeyFromSettings,
  selectProjectGroupingSettings,
} from "@t3tools/client-runtime/state/project-grouping";
import { useProjects } from "~/state/entities";
import { useEnvironments, useEnvironmentProviders } from "~/state/environments";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { InlineButton } from "../ui/button";
import { ProjectPicker } from "./ProjectPicker";
import { DraftHeroProjectHeading } from "./DraftHeroProjectHeading";
import { TriageDraftHero } from "./TriageDraftHero";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { resolveProjectDefaultProviderModelSelection } from "../../providerInstances";
import { resolveNewThreadModelSelection } from "@t3tools/shared/usageLimits";

interface DraftHeroHeadlineProps {
  readonly projectLocked?: boolean;
  readonly firstMateDraftKey?: string;
  readonly draftId: DraftId | null;
  readonly activeProjectRef: ScopedProjectRef | null;
  readonly activeProjectTitle: string | null;
}

export function DraftHeroHeadline({
  firstMateDraftKey,
  projectLocked,
  draftId,
  activeProjectRef,
  activeProjectTitle,
}: DraftHeroHeadlineProps) {
  const projects = useProjects();
  const { environments } = useEnvironments();
  const providersByEnvironment = useEnvironmentProviders();
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const setLogicalProjectDraftThreadId = useComposerDraftStore(
    (store) => store.setLogicalProjectDraftThreadId,
  );
  const getComposerDraft = useComposerDraftStore((store) => store.getComposerDraft);
  // A boolean, so typing in a draft does not re-render the hero.
  const isTriageDraftPrompt = useComposerDraftStore((store) =>
    draftId ? isTriagePrompt(store.getComposerDraft(draftId)?.prompt ?? "") : false,
  );
  const applyStickyState = useComposerDraftStore((store) => store.applyStickyState);
  const setModelSelection = useComposerDraftStore((store) => store.setModelSelection);
  const { scratchEnvironmentId, scratchWorkspaceRootFor, openScratchProject } = useScratchProject();
  const openProjectDraft = useNewThreadHandler();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const activeProject =
    activeProjectRef === null
      ? null
      : (projects.find(
          (project) =>
            project.environmentId === activeProjectRef.environmentId &&
            project.id === activeProjectRef.projectId,
        ) ?? null);
  const scratchTargetEnvironmentId = scratchEnvironmentId(activeProjectRef?.environmentId ?? null);
  const scratchWorkspaceRoot = scratchWorkspaceRootFor(scratchTargetEnvironmentId);
  const isScratchDraft =
    activeProject !== null &&
    isScratchProject(activeProject, scratchWorkspaceRootFor(activeProject.environmentId));

  // The picker can change the draft's target while the no-project home is
  // still being opened; a stale continuation must not retarget it again. Picking
  // a project clears the pending request, and the draft session is compared
  // against the store when the scratch project arrives.
  const pendingScratchRef = useRef<symbol | null>(null);
  const draftTargetKey = () => {
    const session = draftId ? useComposerDraftStore.getState().getDraftSession(draftId) : null;
    return session
      ? `${session.environmentId}:${session.projectId}:${session.logicalProjectKey}`
      : null;
  };
  // Retargeting an empty draft would overwrite the project's draft and strand browser tabs.
  const selectProject = (project: (typeof projects)[number], logicalProjectKey: string) => {
    if (!draftId) {
      return;
    }
    if (firstMateDraftKey) {
      const session = useComposerDraftStore.getState().getDraftSession(draftId);
      if (session?.logicalProjectKey !== firstMateDraftKey || session.promotedTo) return;
    }
    pendingScratchRef.current = null;
    const currentDraft = getComposerDraft(draftId);
    if (!firstMateDraftKey && !composerDraftHasUserContent(currentDraft)) {
      void openProjectDraft(scopeProjectRef(project.environmentId, project.id));
      return;
    }
    setLogicalProjectDraftThreadId(
      firstMateDraftKey ?? logicalProjectKey,
      scopeProjectRef(project.environmentId, project.id),
      draftId,
    );
    if (!hasExplicitComposerModelSelection(currentDraft)) {
      applyStickyState(draftId);
      const environmentConfig = environments.find(
        (environment) => environment.environmentId === project.environmentId,
      )?.serverConfig;
      const environmentSettings = environmentConfig?.settings;
      const defaultSelection = environmentSettings
        ? resolveProjectSettings(environmentSettings, project.id, project).settings
            .defaultModelSelection
        : project.defaultModelSelection;
      const fallbackResolution = resolveNewThreadModelSelection({
        defaultSelection:
          defaultSelection ??
          (useComposerDraftStore.getState().stickyActiveProvider !== null || !environmentSettings
            ? null
            : resolveProjectDefaultProviderModelSelection(
                providersByEnvironment.get(project.environmentId) ?? [],
                environmentSettings,
                project.id,
              )),
        fallbackSelection: environmentSettings?.fallbackModelSelection ?? null,
        providers: providersByEnvironment.get(project.environmentId) ?? [],
        ...(environmentSettings ? { settings: environmentSettings } : {}),
        projectId: project.id,
        now: Date.now(),
      });
      const defaultModelSelection = fallbackResolution.fallback
        ? fallbackResolution.selection
        : defaultSelection;
      if (defaultModelSelection) {
        setModelSelection(draftId, defaultModelSelection, {
          replaceOptions: true,
        });
      }
    }
  };
  const startScratch = async (): Promise<boolean> => {
    if (scratchTargetEnvironmentId === null || isScratchDraft) {
      return false;
    }
    const request = Symbol("scratch");
    pendingScratchRef.current = request;
    const requestedTarget = draftTargetKey();
    const project = await openScratchProject(scratchTargetEnvironmentId);
    if (!project || pendingScratchRef.current !== request || draftTargetKey() !== requestedTarget) {
      return false;
    }
    pendingScratchRef.current = null;
    selectProject(project, deriveLogicalProjectKeyFromSettings(project, projectGroupingSettings));
    return true;
  };

  const hasResolvedProject = activeProjectTitle !== null;
  const canChooseProject = projects.some((project) => project.archivedAt == null);
  const projectSelector = (
    <ProjectPicker
      activeProjectRef={activeProjectRef}
      activeProjectTitle={activeProjectTitle}
      {...(firstMateDraftKey && activeProjectRef
        ? { environmentId: activeProjectRef.environmentId }
        : {})}
      disabled={Boolean(projectLocked)}
      onSelect={selectProject}
    />
  );
  const noProjectShortcut = shortcutLabelForCommand(keybindings, "chat.newWithoutProject");
  const orStartWithoutProject =
    scratchWorkspaceRoot !== null && !isScratchDraft && (hasResolvedProject || canChooseProject) ? (
      <Tooltip>
        <TooltipTrigger
          render={
            <InlineButton
              tone="muted"
              className="pointer-events-auto"
              onClick={() =>
                void startScratch().then((started) => {
                  if (started) {
                    document.querySelector<HTMLElement>("[data-draft-project-trigger]")?.focus();
                  }
                })
              }
            />
          }
        >
          or start without a project
        </TooltipTrigger>
        {noProjectShortcut ? <TooltipPopup side="bottom">{noProjectShortcut}</TooltipPopup> : null}
      </Tooltip>
    ) : null;

  if (isScratchDraft && isTriageDraftPrompt) {
    const environment = environments.find(
      (entry) => entry.environmentId === activeProject.environmentId,
    );
    return (
      <TriageDraftHero
        machineLabel={environment?.label ?? null}
        serverVersion={environment?.serverConfig?.environment.serverVersion ?? null}
      />
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col items-center">
      {hasResolvedProject && !isScratchDraft ? (
        <DraftHeroProjectHeading projectName={activeProjectTitle ?? "Choose a project"}>
          {projectSelector}
        </DraftHeroProjectHeading>
      ) : (
        <h1 className="w-full text-center font-normal text-2xl text-foreground tracking-tight sm:text-3xl">
          {isScratchDraft ? (
            <>What should we work on?</>
          ) : canChooseProject ? (
            <>{projectSelector} to start</>
          ) : (
            <>Add a project to start</>
          )}
        </h1>
      )}
      {firstMateDraftKey || scratchWorkspaceRoot === null ? null : (
        <p className="mt-2 flex h-6 w-full items-center justify-center text-sm">
          {isScratchDraft ? projectSelector : orStartWithoutProject}
        </p>
      )}
    </div>
  );
}
