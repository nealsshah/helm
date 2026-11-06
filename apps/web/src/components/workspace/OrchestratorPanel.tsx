import { useAtomValue } from "@effect/atom-react";
import type { ThreadId } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { MessageSquareIcon, PlusIcon, XIcon } from "lucide-react";
import { useRef, useState } from "react";
import { cn, newThreadId } from "../../lib/utils";
import { resolveProjectDefaultProviderModelSelection } from "../../providerInstances";
import { useProjects } from "../../state/entities";
import { environmentServerConfigsAtom, serverEnvironment } from "../../state/server";
import { threadEnvironment } from "../../state/threads";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { Button } from "../ui/button";
import { field, useDelivery } from "./WorkspaceForms";
import { WorkPanel } from "./WorkPanel";
import { useWorkspaceCommand, type WorkspaceState } from "./workspaceState";
import type { PanelTarget } from "./workspaceTab";

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
  const tabs = host.snapshot?.orchestratorThreadIds ?? [];
  const active = tabs.find((id) => id === selected) ?? tabs.at(-1);
  const shells = state.shells.filter((shell) => shell.environmentId === environmentId);
  const current = shells.find((shell) => shell.id === active);
  const projects = useProjects().filter((project) => project.environmentId === environmentId);
  const [projectId, setProjectId] = useState("");
  const project =
    projects.find((entry) => entry.id === (current?.projectId ?? projectId)) ?? projects[0];
  const config = useAtomValue(environmentServerConfigsAtom).get(environmentId);
  const allowed = useAtomValue(serverEnvironment.workspaceCommand.permissionAtom(environmentId));
  const create = useOrchestrationCommand(threadEnvironment.create, { reportFailure: false });
  const run = useWorkspaceCommand();
  const delivery = useDelivery();
  const pendingRegistration = useRef<ThreadId | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const open = (threadId: ThreadId) =>
    select({ environmentId, threadId, itemId: null, global: true });
  async function add(createdAt: string) {
    if (!project || !config)
      throw new Error("Open a project in this environment to start an orchestrator.");
    let threadId = pendingRegistration.current;
    if (!threadId) {
      const settings = resolveProjectSettings(config.settings, project.id, project).settings;
      const modelSelection =
        current?.modelSelection ??
        settings.defaultModelSelection ??
        resolveProjectDefaultProviderModelSelection(config.providers, config.settings, project.id);
      if (!modelSelection) throw new Error("Connect a provider to start an orchestrator.");
      threadId = newThreadId();
      const result = await create({
        environmentId,
        input: {
          threadId,
          projectId: project.id,
          title: "New orchestrator",
          modelSelection,
          runtimeMode: current?.runtimeMode ?? settings.defaultRuntimeMode,
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt,
        },
      });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      pendingRegistration.current = threadId;
    }
    await run(environmentId, { type: "orchestrator", threadId });
    pendingRegistration.current = null;
    open(threadId);
  }
  const disabled = !host.connected || !allowed || delivery.busy;
  return (
    <aside
      aria-label="Orchestrator"
      className="flex min-h-0 min-w-0 flex-col border-l border-border bg-background"
    >
      <div className="flex min-h-11 shrink-0 items-center gap-1 border-b border-border bg-muted/30 pr-1">
        <div
          ref={list}
          role="tablist"
          aria-label="Orchestrator sessions"
          className="flex min-w-0 items-stretch overflow-x-auto"
        >
          {tabs.map((id, index) => {
            const title = shells.find((shell) => shell.id === id)?.title ?? "Orchestrator";
            return (
              <div
                key={id}
                className={cn(
                  "flex shrink-0 items-center border-r border-b-2 border-r-border pr-1",
                  active === id ? "border-b-primary bg-background" : "border-b-transparent",
                )}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={active === id}
                  tabIndex={active === id ? 0 : -1}
                  ref={(node) => {
                    if (node && active === id)
                      node.scrollIntoView({ block: "nearest", inline: "nearest" });
                  }}
                  onClick={() => open(id)}
                  onKeyDown={(event) => {
                    const next =
                      event.key === "ArrowRight"
                        ? (index + 1) % tabs.length
                        : event.key === "ArrowLeft"
                          ? (index + tabs.length - 1) % tabs.length
                          : event.key === "Home"
                            ? 0
                            : event.key === "End"
                              ? tabs.length - 1
                              : -1;
                    if (next < 0) return;
                    event.preventDefault();
                    open(tabs[next]!);
                    list.current?.querySelectorAll<HTMLButtonElement>("[role=tab]")[next]?.focus();
                  }}
                  className="flex min-h-11 max-w-44 items-center gap-2 px-3 text-xs focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                >
                  <MessageSquareIcon className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate">{title}</span>
                </button>
                {active === id && (
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`Close tab ${title}`}
                    disabled={disabled}
                    onClick={() =>
                      void delivery.submit(async () => {
                        await run(environmentId, { type: "closeOrchestrator", threadId: id });
                        const neighbor = tabs[index + 1] ?? tabs[index - 1];
                        if (neighbor) open(neighbor);
                      })
                    }
                  >
                    <XIcon />
                  </Button>
                )}
              </div>
            );
          })}
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="New orchestrator session"
          disabled={disabled || !project}
          onClick={() => void delivery.submit(() => add(new Date().toISOString()))}
        >
          <PlusIcon />
        </Button>
        <div className="ml-auto">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Close orchestrator panel"
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
      {active ? (
        <WorkPanel
          key={active}
          state={state}
          target={{ environmentId, itemId: null, threadId: active, global: true }}
          select={select}
          close={close}
        />
      ) : (
        <div className="m-auto grid max-w-sm justify-items-center gap-3 p-5 text-center">
          <MessageSquareIcon aria-hidden="true" className="size-5 text-muted-foreground" />
          <h2 className="font-semibold">Orchestrator</h2>
          {projects.length > 1 && (
            <select
              aria-label="Project for new orchestrator"
              className={field}
              value={project?.id}
              onChange={(event) => setProjectId(event.target.value)}
            >
              {projects.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.title}
                </option>
              ))}
            </select>
          )}
          {project ? (
            <Button
              variant="outline"
              disabled={disabled}
              onClick={() => void delivery.submit(() => add(new Date().toISOString()))}
            >
              <PlusIcon />
              Start a session
            </Button>
          ) : (
            <p className="text-sm text-muted-foreground">
              Open a project to start an orchestrator.
            </p>
          )}
        </div>
      )}
    </aside>
  );
}
