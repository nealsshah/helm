import { useRef, useState } from "react";
import type { ThreadId } from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  Columns3Icon,
  InboxIcon,
  MessageSquareIcon,
  PlusIcon,
  XIcon,
} from "lucide-react";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { SidebarInset, SidebarTrigger } from "../ui/sidebar";
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
  host: string;
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
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={cn(
        "group grid w-full gap-3 rounded-lg border bg-background p-3 text-left shadow-xs hover:border-foreground/35 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        selected ? "border-foreground/55 ring-1 ring-inset ring-foreground/15" : "border-border",
      )}
    >
      <span className="grid gap-1">
        <span className="truncate text-2xs text-muted-foreground">{host}</span>
        <span className="break-words text-sm font-semibold leading-snug">{item.title}</span>
      </span>
      {item.scope && (
        <span className="line-clamp-2 text-xs leading-relaxed text-muted-foreground">
          {item.scope}
        </span>
      )}
      {dependencies.map((dep) => (
        <span key={dep.itemId} className="truncate text-xs">
          Waiting on {dep.title} · {dep.owner}
        </span>
      ))}
      {item.latestReport && (
        <span className="line-clamp-2 text-xs text-muted-foreground">
          {item.latestReport.format === "legacy" ? "Legacy update" : "Reported"} ·{" "}
          {item.latestReport.text}
        </span>
      )}
      <span className="flex flex-wrap items-center gap-1 text-2xs">
        {item.attention !== "none" && (
          <span className="rounded bg-muted px-1.5 py-0.5 capitalize">{item.attention}</span>
        )}
        <span className="inline-flex items-center gap-1 text-muted-foreground">
          <span
            aria-hidden="true"
            className={cn(
              "size-1.5 rounded-full",
              runtime === "Running"
                ? "bg-success"
                : runtime === "Error"
                  ? "bg-destructive"
                  : "bg-muted-foreground/50",
            )}
          />
          {runtime}
        </span>
      </span>
      {time && (
        <span className="truncate text-3xs text-muted-foreground">
          {source?.title} · <time dateTime={time}>{sourceTime(time)}</time>
        </span>
      )}
    </button>
  );
}

const Target = Schema.NullOr(PanelTarget);

export function VisualWorkspace() {
  const state = useWorkspaceState();
  const [target, setTarget] = useWorkspaceTabValue("selected", null, Target);
  const [form, setForm] = useState<"new" | "global" | null>(null);
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
    <SidebarInset className="h-dvh min-h-0 overflow-hidden">
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
              setReturnTo(target);
              setForm("global");
            }}
          >
            <MessageSquareIcon />
            Global direction
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
        <div className="flex gap-2 border-b border-border px-3 py-1 lg:hidden">
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
      <div
        className={cn(
          "relative grid min-h-0 flex-1",
          hasPanel && "lg:grid-cols-[minmax(0,1fr)_minmax(24rem,45%)]",
        )}
      >
        <section
          className={cn("flex min-h-0 min-w-0 flex-col", hasPanel && "hidden lg:flex")}
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
                        aria-pressed={target?.environmentId === environmentId && target.threadId === threadId}
                        className="group relative grid w-full content-start gap-1.5 rounded-lg border border-warning/40 bg-card px-3 py-2.5 text-left shadow-xs hover:bg-muted/40 focus-visible:outline-2 focus-visible:outline-ring after:pointer-events-none after:absolute after:-inset-px after:rounded-[inherit] after:border-2 after:border-warning/80 after:opacity-60 motion-safe:after:animate-attention"
                        onClick={() => {
                          if (target?.threadId !== threadId || target.environmentId !== environmentId) setReturnTo(target);
                          select({ environmentId, itemId, threadId });
                        }}
                      >
                        <span className="truncate text-2xs text-muted-foreground">
                          {linked ? stageLabel[linked.item.stage] : "Session"}
                          {linked && linked.item.title !== title && ` · ${linked.item.title}`}
                          {hostLabel && ` · ${hostLabel}`}
                        </span>
                        <span className="line-clamp-2 break-words text-sm font-semibold leading-snug group-hover:underline">{title}</span>
                        <span className="line-clamp-2 break-words text-xs leading-relaxed text-muted-foreground">{first.prompt}</span>
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
          <div className="flex min-h-0 flex-1 gap-2 overflow-auto p-3">
            {stages.map((stage) => {
              const entries = cards.filter((card) => card.item.stage === stage);
              return (
                <section
                  aria-label={stageLabel[stage]}
                  key={stage}
                  className={cn(
                    "min-h-full flex-1 rounded-lg bg-muted/40 p-2",
                    entries.length ? "min-w-44" : "min-w-24",
                  )}
                >
                  <h2 className="mb-3 flex items-center justify-between gap-2 px-1 pt-1 text-xs font-semibold">
                    <span>{stageLabel[stage]}</span>
                    <span className="tabular-nums text-muted-foreground">{entries.length}</span>
                  </h2>
                  <div className="grid gap-2">
                    {entries.map((entry) => {
                      const { environmentId, item } = entry;
                      const host = hosts.find((entry) => entry.environmentId === environmentId);
                      return (
                        <WorkCard
                          key={JSON.stringify([environmentId, item.id])}
                          entry={entry}
                          dependencies={outstandingDependencies(item, host?.snapshot?.items ?? [])}
                          host={host?.label ?? environmentId}
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
        {form ? (
          <aside className="overflow-auto border-l border-border bg-background">
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <h2 className="font-semibold">
                {form === "new" ? "New work item" : "Global direction"}
              </h2>
              <Button size="icon-sm" variant="ghost" aria-label="Close work panel" onClick={close}>
                <XIcon />
              </Button>
            </div>
            {form === "global" &&
              state.hosts.flatMap((host) => {
                const id = host.snapshot?.orchestratorThreadId;
                if (!id) return [];
                return (
                  <div className="p-4 pb-0" key={host.environmentId}>
                    <Button
                      variant="outline"
                      onClick={() =>
                        select({
                          environmentId: host.environmentId,
                          itemId: null,
                          threadId: id,
                          global: true,
                        })
                      }
                    >
                      <MessageSquareIcon />
                      {host.label} ·{" "}
                      {state.shells.find(
                        (s) => s.environmentId === host.environmentId && s.id === id,
                      )?.title ?? "Open orchestrator"}
                    </Button>
                  </div>
                );
              })}
            <ItemCreate
              state={state}
              global={form === "global"}
              onCreate={(environmentId, itemId, threadId) =>
                select({ environmentId, itemId, threadId, global: form === "global" })
              }
            />
          </aside>
        ) : (
          target && <WorkPanel state={state} target={target} close={close} select={select} />
        )}
      </div>
    </SidebarInset>
  );
}
