import {
  resolveEnvironmentMachineKind,
  type EnvironmentId,
  type ScopedProjectRef,
} from "@t3tools/contracts";
import { scopedProjectKey } from "@t3tools/client-runtime/environment";
import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import { ChevronDownIcon, FolderPlusIcon, PlusIcon } from "lucide-react";
import { useAtomValue } from "@effect/atom-react";
import { useRef, useState } from "react";

import { openCommandPalette } from "~/commandPaletteBus";
import { shortcutLabelForCommand } from "~/keybindings";
import { primaryServerKeybindingsAtom } from "~/state/server";
import { useOrderWhileOpen } from "~/hooks/useOrderWhileOpen";
import { useProjectPin } from "~/hooks/useProjectGroupUpdate";
import { useScratchProject } from "~/hooks/useScratchProject";
import { useClientSettings } from "~/hooks/useSettings";
import {
  deriveLogicalProjectKeyFromSettings,
  pickableProjectGroups,
  selectProjectGroupingSettings,
} from "@t3tools/client-runtime/state/project-grouping";
import {
  buildSidebarProjectPickerEntries,
  buildSidebarProjectSnapshots,
  projectGroupsSpanEnvironments,
} from "~/sidebarProjectGrouping";
import { useProjects, useVisibleThreadShells, waitForProject } from "~/state/entities";
import { useEnvironments, usePrimaryEnvironmentId } from "~/state/environments";
import { ProjectEnvironmentBadge } from "../ProjectEnvironmentBadge";
import { ProjectFavicon } from "../ProjectFavicon";
import { isProjectPinShortcut, ProjectPinButton } from "../ProjectPinButton";
import { sortLogicalProjectsForSidebar } from "../Sidebar.logic";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxSearchInput,
  ComboboxTrigger,
  useComboboxFilter,
} from "../ui/combobox";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { Button, InlineButton } from "../ui/button";
import { DraftProjectName } from "./DraftProjectName";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
const ADD_PROJECT_VALUE = "add-project";

interface PickerItem {
  readonly value: string;
  readonly label: string;
}

const NEW_THREAD_VALUE = "new-thread-in-project";
export function ProjectPicker({
  activeProjectRef,
  activeProjectTitle,
  environmentId,
  onSelect,
  disabled,
  compact = false,
  onNewThread,
}: {
  activeProjectRef: ScopedProjectRef | null;
  activeProjectTitle: string | null;
  environmentId?: EnvironmentId;
  onSelect: (project: EnvironmentProject, logicalProjectKey: string) => void;
  disabled?: boolean;
  compact?: boolean;
  onNewThread?: (() => void) | undefined;
}) {
  const allProjects = useProjects();
  const projects =
    environmentId === undefined
      ? allProjects
      : allProjects.filter((p) => p.environmentId === environmentId);
  const [pickerOpen, setPickerOpen] = useState(false);
  const threads = useVisibleThreadShells(pickerOpen);
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const projectSortOrder = useClientSettings((settings) => settings.sidebarProjectSortOrder);
  const openAddProject = () =>
    openCommandPalette({
      open: "add-project",
      ...(environmentId
        ? {
            addProjectTarget: {
              environmentId,
              onSelect: async (ref) => {
                const project = await waitForProject(ref);
                onSelect(
                  project,
                  deriveLogicalProjectKeyFromSettings(project, projectGroupingSettings),
                );
              },
            },
          }
        : {}),
    });
  const { scratchWorkspaceRootFor } = useScratchProject();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const [pickerQuery, setPickerQuery] = useState("");
  const pickerFilter = useComboboxFilter();
  const highlightedPickerValueRef = useRef<string | null>(null);
  const { canPinProjectGroup, toggleProjectGroupPin } = useProjectPin();

  const environmentLabelById = new Map(
    environments.map((environment) => [environment.environmentId, environment.label] as const),
  );
  const projectGroups = sortLogicalProjectsForSidebar(
    buildSidebarProjectSnapshots({
      projects,
      settings: projectGroupingSettings,
      primaryEnvironmentId,
      resolveEnvironmentLabel: (environmentId) => environmentLabelById.get(environmentId) ?? null,
    }),
    threads,
    projectSortOrder,
  );
  const showProjectEnvironments = projectGroupsSpanEnvironments(projectGroups);
  const environmentMachineById = new Map(
    environments.map(
      (environment) =>
        [
          environment.environmentId,
          resolveEnvironmentMachineKind(environment.serverConfig),
        ] as const,
    ),
  );
  const projectPickerEntries = buildSidebarProjectPickerEntries({
    groups: pickableProjectGroups(projectGroups),
    preferredProjectRef: activeProjectRef,
  });
  const projectEntryByKey = new Map(
    projectPickerEntries.map((entry) => [entry.group.projectKey, entry] as const),
  );
  const activeProjectGroup =
    activeProjectRef === null
      ? null
      : (projectGroups.find((group) =>
          group.memberProjectRefs.some(
            (projectRef) => scopedProjectKey(projectRef) === scopedProjectKey(activeProjectRef),
          ),
        ) ?? null);
  const activeProjectKey = activeProjectGroup?.projectKey ?? "";
  const canChooseProject = projectPickerEntries.length > 0;
  const menuEntries = projectPickerEntries.filter(
    ({ targetProject }) =>
      !isScratchProject(targetProject, scratchWorkspaceRootFor(targetProject.environmentId)),
  );
  const activeProject =
    activeProjectRef === null
      ? null
      : (projects.find(
          (project) =>
            project.environmentId === activeProjectRef.environmentId &&
            project.id === activeProjectRef.projectId,
        ) ?? null);
  const isScratchDraft =
    activeProject !== null &&
    isScratchProject(activeProject, scratchWorkspaceRootFor(activeProject.environmentId));

  // Pinning from a row keeps rows in place while the picker is open.
  const pickerItems: readonly PickerItem[] = useOrderWhileOpen(
    [
      ...menuEntries.map(({ group }) => ({ value: group.projectKey, label: group.displayName })),
      { value: ADD_PROJECT_VALUE, label: "Add project" },
      ...(onNewThread
        ? [{ value: NEW_THREAD_VALUE, label: `New thread in ${activeProjectTitle}` }]
        : []),
    ],
    (item) => item.value,
    pickerOpen,
  );
  const pickerSearch = pickerQuery.trim();
  const filteredPickerItems =
    pickerSearch.length === 0
      ? pickerItems
      : pickerItems.filter(
          (item) =>
            item.value !== ADD_PROJECT_VALUE &&
            pickerFilter.contains(item, pickerSearch, (candidate) => candidate.label),
        );
  const selectedPickerItem = pickerItems.find((item) => item.value === activeProjectKey) ?? null;

  return canChooseProject ? (
    <Combobox
      items={pickerItems}
      filteredItems={filteredPickerItems}
      autoHighlight
      itemToStringLabel={(item) => item.label}
      isItemEqualToValue={(a, b) => a.value === b.value}
      open={pickerOpen}
      onItemHighlighted={(item) => {
        highlightedPickerValueRef.current = item?.value ?? null;
      }}
      onOpenChange={(open) => {
        setPickerOpen(open);
        setPickerQuery("");
      }}
      value={selectedPickerItem}
      onValueChange={(item) => {
        if (!item) return;
        setPickerOpen(false);
        if (item.value === ADD_PROJECT_VALUE) {
          openAddProject();
          return;
        }
        if (item.value === NEW_THREAD_VALUE) {
          onNewThread?.();
          return;
        }
        const entry = projectEntryByKey.get(item.value);
        if (!entry || item.value === activeProjectKey) {
          return;
        }
        onSelect(entry.targetProject, entry.group.projectKey);
      }}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <ComboboxTrigger
              render={
                compact ? <Button variant="ghost" size="compact" /> : <InlineButton tone="picker" />
              }
              aria-label={compact ? `Session project: ${activeProjectTitle}` : undefined}
              disabled={disabled && !onNewThread}
              data-draft-project-trigger={compact ? undefined : ""}
              className="pointer-events-auto min-w-0 max-w-full align-baseline"
            />
          }
        >
          {compact && activeProject && (
            <ProjectFavicon project={activeProject} className="size-3.5 shrink-0" />
          )}
          {compact ? (
            <span className="max-w-24 truncate">{activeProjectTitle}</span>
          ) : (
            <DraftProjectName
              value={isScratchDraft ? "No project" : (activeProjectTitle ?? "Choose a project")}
              singleLine
            />
          )}
          {compact && <ChevronDownIcon aria-hidden="true" />}
        </TooltipTrigger>
        {activeProjectTitle && !isScratchDraft ? (
          <TooltipPopup side="top">{activeProjectTitle}</TooltipPopup>
        ) : null}
      </Tooltip>
      <ComboboxPopup align="center" className="w-72 overflow-hidden">
        <ComboboxSearchInput
          aria-label="Search projects"
          placeholder="Search projects..."
          value={pickerQuery}
          onChange={(event) => setPickerQuery(event.target.value)}
          onKeyDown={(event) => {
            const highlighted = highlightedPickerValueRef.current;
            const group = highlighted ? projectEntryByKey.get(highlighted)?.group : undefined;
            if (!group || !canPinProjectGroup(group) || !isProjectPinShortcut(event, keybindings)) {
              return;
            }
            event.preventDefault();
            event.stopPropagation();
            toggleProjectGroupPin(group);
          }}
        />
        <ComboboxEmpty>No matching projects.</ComboboxEmpty>
        <ComboboxList>
          {(item: PickerItem) => {
            const entry = projectEntryByKey.get(item.value);
            return (
              <ComboboxItem
                key={item.value}
                hideIndicator
                value={item}
                disabled={disabled && item.value !== NEW_THREAD_VALUE}
              >
                {item.value === ADD_PROJECT_VALUE ? (
                  <FolderPlusIcon className="size-4 shrink-0" />
                ) : item.value === NEW_THREAD_VALUE ? (
                  <PlusIcon className="size-4 shrink-0" />
                ) : entry ? (
                  <ProjectFavicon project={entry.group} className="size-4 shrink-0" />
                ) : null}
                <Tooltip>
                  <TooltipTrigger render={<span className="min-w-0 flex-1 text-sm" />}>
                    <DraftProjectName value={item.label} />
                  </TooltipTrigger>
                  <TooltipPopup side="top">{item.label}</TooltipPopup>
                </Tooltip>
                {entry && canPinProjectGroup(entry.group) ? (
                  <ProjectPinButton
                    name={entry.group.displayName}
                    pinned={entry.group.pinned}
                    shortcutLabel={shortcutLabelForCommand(keybindings, "thread.pin")}
                    onToggle={() => toggleProjectGroupPin(entry.group)}
                  />
                ) : null}
                {entry && showProjectEnvironments ? (
                  <ProjectEnvironmentBadge
                    group={entry.group}
                    primaryEnvironmentId={primaryEnvironmentId}
                    machineByEnvironmentId={environmentMachineById}
                  />
                ) : null}
              </ComboboxItem>
            );
          }}
        </ComboboxList>
      </ComboboxPopup>
    </Combobox>
  ) : (
    <button
      type="button"
      disabled={disabled}
      onClick={openAddProject}
      className="pointer-events-auto inline min-w-0 max-w-full cursor-pointer border-muted-foreground/35 border-b border-dotted text-muted-foreground/60 transition-colors hover:border-muted-foreground/60 hover:text-muted-foreground/80 focus-visible:rounded-sm focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
    >
      <DraftProjectName value={activeProjectTitle ?? "Add a project"} singleLine />
    </button>
  );
}
