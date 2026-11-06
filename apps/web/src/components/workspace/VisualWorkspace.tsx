import { useRef, useState } from "react";
import type { ThreadId } from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  CircleDashedIcon,
  CircleCheckIcon,
  CircleDotIcon,
  ScanEyeIcon,
  Columns3Icon,
  InboxIcon,
  MessageSquareIcon,
  PlusIcon,
  XIcon,
} from "lucide-react";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { SidebarInset, SidebarTrigger } from "../ui/sidebar";
import { OrchestratorPanel } from "./OrchestratorPanel";
import { WorkspaceSidePane } from "./WorkspaceSidePane";
import { WorkPanel } from "./WorkPanel";
import { PanelTarget, useWorkspaceTabValue } from "./workspaceTab";
import * as Schema from "effect/Schema";
import { field, ItemCreate } from "./WorkspaceForms";
import {
  itemHasThread,
  outstandingDependencies,
  runtimeLabel,
  sourceTime,
  stageLabel,
  stages,
  type BoardItem,
  type QueueEntry,
} from "./workspaceModel";
import { useWorkspaceState } from "./workspaceState";

const stageIcons = {
  planning: CircleDashedIcon,
  building: CircleDotIcon,
  qa: ScanEyeIcon,
  complete: CircleCheckIcon,
};

function WorkCard({
  entry,
  sessions,
  dependencies,
  connected,
  host,
  selected,
  onClick,
}: {
  entry: BoardItem;
  sessions: EnvironmentThreadShell[];
  dependencies: ReturnType<typeof outstandingDependencies>;
  connected: boolean;
  host: string | undefined;
  selected: boolean;
  onClick: () => void;
}) {
  const { item } = entry;
  const primary = sessions.find((s) => s.id === item.primaryThreadId);
  const source =
    sessions.find((s) => s.hasPendingUserInput || s.hasPendingApprovals) ??
    sessions.find((s) => s.runtime?.status === "failed") ??
    sessions.find(
      (s) =>
        s.runtime?.status === "running" ||
        s.runtime?.status === "queued" ||
        s.runtime?.status === "preparing" ||
        s.runtime?.status === "starting",
    ) ??
    primary;
  const runtime = runtimeLabel(source, connected);
  const time = source?.runtime?.updatedAt ?? source?.updatedAt;
  const summary = item.latestReport?.text ?? item.scope;
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={cn(
        "grid w-full min-w-0 cursor-pointer gap-1.5 rounded-lg border px-3 py-2.5 text-left shadow-xs transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        selected
          ? "border-primary/55 bg-accent/60"
          : "border-border/65 bg-card hover:border-foreground/30 dark:bg-foreground/5 dark:hover:bg-foreground/8",
      )}
    >
      <span className="break-words text-sm font-medium leading-snug">{item.title}</span>
      {summary && item.stage !== "complete" && (
        <span className="line-clamp-2 break-words text-xs leading-relaxed text-muted-foreground">
          {summary}
        </span>
      )}
      {dependencies.map((dep) => (
        <span key={dep.itemId} className="truncate text-xs">
          Waiting on {dep.title} · {dep.owner}
        </span>
      ))}
      <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-2xs text-muted-foreground">
        {runtime !== "Idle" && (
          <span className="inline-flex items-center gap-1">
            <span
              aria-hidden="true"
              className={cn(
                "size-1.5 rounded-full",
                runtime === "Running"
                  ? "bg-success"
                  : runtime === "Error"
                    ? "bg-destructive"
                    : "bg-muted-foreground",
              )}
            />
            {runtime}
          </span>
        )}
        {item.attention !== "none" && <span className="capitalize">{item.attention}</span>}
        {host && <span className="truncate">{host}</span>}
        {time && <time dateTime={time}>{sourceTime(time)}</time>}
      </span>
    </button>
  );
}

const Target = Schema.NullOr(PanelTarget);

export function VisualWorkspace() {
  const state = useWorkspaceState();
  const [target, setTarget] = useWorkspaceTabValue("selected", null, Target);
  const [form, setForm] = useState<"new" | "orchestrator" | null>(null);
  const [storedEnvironment, setEnvironment] = useWorkspaceTabValue(
    "environment",
    "",
    Schema.String,
  );
  const lastConversation = useRef(new Map<string, ThreadId>());
  const [returnTo, setReturnTo] = useWorkspaceTabValue("return-to", null, Target);
  const environment = state.hosts.some((host) => host.environmentId === storedEnvironment)
    ? storedEnvironment
    : "";
  const visibleItems = state.items.filter(
    (entry) => !environment || entry.environmentId === environment,
  );
  const requests = state.requests.filter(
    (entry) => !environment || entry.environmentId === environment,
  );
  const queue = new Map<string, QueueEntry>();
  const waitingItems = new Set<string>();
  for (const entry of requests) {
    const key = JSON.stringify([entry.environmentId, entry.threadId]);
    if (!queue.has(key)) queue.set(key, entry);
    if (entry.itemId) waitingItems.add(JSON.stringify([entry.environmentId, entry.itemId]));
  }
  const cards = visibleItems.filter(
    ({ environmentId, item }) => !waitingItems.has(JSON.stringify([environmentId, item.id])),
  );
  const hosts = state.hosts.filter((host) => !environment || environment === host.environmentId);
  const orchestratorHost =
    (!form && target?.global
      ? state.hosts.find((host) => host.environmentId === target.environmentId)
      : null) ??
    hosts.find((host) => host.environmentId === target?.environmentId) ??
    hosts.find((host) => host.connected && host.snapshot) ??
    hosts[0];
  const hasPanel = form !== null || target !== null;
  function select(target: PanelTarget) {
    if (target.itemId) {
      lastConversation.current.set(
        JSON.stringify([target.environmentId, target.itemId]),
        target.threadId,
      );
    }
    setForm(null);
    setTarget(target);
  }
  function openItem({ environmentId, item }: BoardItem) {
    setReturnTo(null);
    const last = lastConversation.current.get(JSON.stringify([environmentId, item.id]));
    select({
      environmentId,
      itemId: item.id,
      threadId: last && itemHasThread(item, last) ? last : item.primaryThreadId,
    });
  }
  function close() {
    setForm(null);
    setTarget(returnTo);
    setReturnTo(null);
  }
  return (
    <SidebarInset className="@container/workspace h-dvh min-h-0 overflow-hidden">
      <header className="flex min-h-12 shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-2 md:px-5">
        <div className="flex items-center gap-2">
          <SidebarTrigger />
          <h1 className="text-base font-semibold tracking-tight">Workspace</h1>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              if (!target?.global) setReturnTo(target);
              setForm("orchestrator");
            }}
          >
            <MessageSquareIcon />
            Orchestrator
          </Button>
          <Button
            size="sm"
            onClick={() => {
              setReturnTo(target);
              setForm("new");
            }}
          >
            <PlusIcon />
            New item
          </Button>
        </div>
      </header>
      {hasPanel && (
        <div className="flex gap-2 border-b border-border px-3 py-1 @3xl/workspace:hidden">
          <Button
            size="compact"
            variant="ghost"
            onClick={() => {
              setReturnTo(null);
              setForm(null);
              setTarget(null);
            }}
          >
            <Columns3Icon /> Board
          </Button>
        </div>
      )}
      <div className="relative flex min-h-0 min-w-0 flex-1">
        <section
          className={cn(
            "flex min-h-0 min-w-0 flex-1 flex-col",
            hasPanel && "hidden @3xl/workspace:flex",
          )}
          aria-label="Workspace overview"
        >
          <section
            aria-label="Needs me"
            className="@container flex max-h-[40%] shrink-0 flex-col border-b border-border bg-background"
          >
            <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2">
              <h2 className="mr-auto flex items-center gap-2 text-sm font-semibold">
                <InboxIcon aria-hidden="true" className="size-4 text-muted-foreground" />
                Needs me
                <span className="text-xs font-normal tabular-nums text-muted-foreground">
                  {queue.size}
                </span>
              </h2>
              {state.hosts.length > 1 && (
                <select
                  aria-label="Filter environments"
                  className={field}
                  value={environment}
                  onChange={(e) => setEnvironment(e.target.value)}
                >
                  <option value="">All environments</option>
                  {state.hosts.map((host) => (
                    <option key={host.environmentId} value={host.environmentId}>
                      {host.label}
                    </option>
                  ))}
                </select>
              )}
            </div>
            {queue.size > 0 && (
              <ul className="flex min-h-0 snap-x snap-proximity items-stretch gap-3 overflow-x-auto overscroll-x-contain px-3 pb-3 scroll-px-3">
                {Array.from(queue, ([key, first]) => {
                  const { environmentId, itemId, threadId } = first;
                  const linked = visibleItems.find(
                    (entry) => entry.environmentId === environmentId && entry.item.id === itemId,
                  );
                  const session = state.shells.find(
                    (shell) => shell.environmentId === environmentId && shell.id === threadId,
                  );
                  const title = session?.title ?? linked?.item.title ?? threadId;
                  const hostLabel =
                    hosts.length > 1
                      ? hosts.find((host) => host.environmentId === environmentId)?.label
                      : null;
                  return (
                    <li key={key} className="flex w-72 max-w-[88%] shrink-0 snap-start">
                      <button
                        type="button"
                        aria-label={title}
                        aria-pressed={
                          target?.environmentId === environmentId && target.threadId === threadId
                        }
                        className="group relative grid w-full content-start gap-1.5 rounded-lg border border-warning/40 bg-card px-3 py-2.5 text-left shadow-xs hover:bg-muted/40 focus-visible:outline-2 focus-visible:outline-ring after:pointer-events-none after:absolute after:-inset-px after:rounded-[inherit] after:border-2 after:border-warning/80 after:opacity-60 motion-safe:after:animate-attention"
                        onClick={() => {
                          if (
                            target?.threadId !== threadId ||
                            target.environmentId !== environmentId
                          )
                            setReturnTo(target);
                          select({ environmentId, itemId, threadId });
                        }}
                      >
                        <span className="truncate text-2xs text-muted-foreground">
                          {linked ? stageLabel[linked.item.stage] : "Session"}
                          {linked && linked.item.title !== title && ` · ${linked.item.title}`}
                          {hostLabel && ` · ${hostLabel}`}
                        </span>
                        <span className="line-clamp-2 break-words text-sm font-semibold leading-snug group-hover:underline">
                          {title}
                        </span>
                        <span className="line-clamp-2 break-words text-xs leading-relaxed text-muted-foreground">
                          {first.prompt}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
          {hosts.map((host) =>
            host.error || !host.connected || !host.snapshot ? (
              <p
                className="border-b border-border px-4 py-2 text-xs"
                key={host.environmentId}
                role="status"
              >
                {host.label} ·{" "}
                {!host.connected ? "Disconnected" : (host.error ?? "Loading workspace…")}
              </p>
            ) : null,
          )}
          {visibleItems.length === 0 && (
            <div className="px-5 pt-5 text-sm text-muted-foreground">
              {state.hosts.length === 0
                ? "Connect an environment to see its work."
                : "Create a work item and choose its primary conversation."}
            </div>
          )}
          <div className="flex min-h-0 min-w-0 flex-1 gap-2.5 overflow-x-auto overflow-y-hidden p-3">
            {stages.map((stage) => {
              const StageIcon = stageIcons[stage];
              const entries = cards.filter((card) => card.item.stage === stage);
              return (
                <section
                  aria-label={stageLabel[stage]}
                  key={stage}
                  className="flex min-h-0 min-w-40 flex-1 flex-col rounded-xl bg-foreground/4 dark:bg-foreground/5"
                >
                  <h2 className="flex shrink-0 items-center gap-2 px-3 py-3 text-sm font-semibold">
                    <StageIcon
                      aria-hidden="true"
                      className={cn(
                        "size-3.5",
                        stage === "complete" ? "text-success" : "text-muted-foreground",
                      )}
                    />
                    <span>{stageLabel[stage]}</span>
                    <span className="text-xs font-normal tabular-nums text-muted-foreground">
                      {entries.length}
                    </span>
                  </h2>
                  <div className="grid min-h-0 content-start gap-2 overflow-y-auto overscroll-y-contain px-2 pb-2">
                    {entries.map((entry) => {
                      const { environmentId, item } = entry;
                      const host = hosts.find((entry) => entry.environmentId === environmentId);
                      return (
                        <WorkCard
                          key={JSON.stringify([environmentId, item.id])}
                          entry={entry}
                          dependencies={outstandingDependencies(item, host?.snapshot?.items ?? [])}
                          host={hosts.length > 1 ? (host?.label ?? environmentId) : undefined}
                          connected={host?.connected ?? false}
                          sessions={state.shells.filter(
                            (shell) =>
                              shell.environmentId === environmentId &&
                              itemHasThread(item, shell.id),
                          )}
                          selected={
                            target?.itemId === item.id && target.environmentId === environmentId
                          }
                          onClick={() => openItem(entry)}
                        />
                      );
                    })}
                  </div>
                </section>
              );
            })}
          </div>
        </section>
        {hasPanel && (
          <WorkspaceSidePane>
            {form === "orchestrator" || (!form && target?.global) ? (
              orchestratorHost ? (
                <OrchestratorPanel
                  key={orchestratorHost.environmentId}
                  state={state}
                  host={orchestratorHost}
                  selected={
                    target?.global && target.environmentId === orchestratorHost.environmentId
                      ? target.threadId
                      : undefined
                  }
                  select={select}
                  close={close}
                />
              ) : (
                <aside className="p-4">
                  Connect an environment to open Orchestrator.{" "}
                  <Button variant="ghost" onClick={close}>
                    Close
                  </Button>
                </aside>
              )
            ) : form === "new" ? (
              <aside className="overflow-auto border-l border-border bg-background">
                <div className="flex items-center justify-between border-b border-border px-4 py-3">
                  <h2 className="font-semibold">New work item</h2>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label="Close work panel"
                    onClick={close}
                  >
                    <XIcon />
                  </Button>
                </div>
                <ItemCreate
                  state={state}
                  onCreate={(environmentId, itemId, threadId) =>
                    select({ environmentId, itemId, threadId })
                  }
                />
              </aside>
            ) : (
              target && <WorkPanel state={state} target={target} close={close} select={select} />
            )}
          </WorkspaceSidePane>
        )}
      </div>
    </SidebarInset>
  );
}
