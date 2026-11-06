import { useRef, useState } from "react";
import type { ThreadId } from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  ArrowUpRightIcon,
  CheckIcon,
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
import { useWorkspaceState, type WorkspaceState } from "./workspaceState";

function WorkCard({
  entry,
  sessions,
  dependencies,
  requests,
  connected,
  host,
  selected,
  onClick,
}: {
  entry: BoardItem;
  sessions: EnvironmentThreadShell[];
  dependencies: ReturnType<typeof outstandingDependencies>;
  requests: QueueEntry[];
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
        {requests.length > 0 && (
          <span className="rounded bg-warning-surface px-1.5 py-0.5 font-medium text-warning-foreground">
            {requests.length} need{requests.length === 1 ? "s" : ""} you
          </span>
        )}
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

function RequestRow({
  entry,
  state,
  selected,
  open,
}: {
  entry: QueueEntry;
  state: WorkspaceState;
  selected: boolean;
  open: () => void;
}) {
  const item = state.items.find(
    (i) => i.environmentId === entry.environmentId && i.item.id === entry.itemId,
  );
  const shell = state.shells.find(
    (s) => s.environmentId === entry.environmentId && s.id === entry.threadId,
  );
  return (
    <button
      type="button"
      onClick={open}
      aria-pressed={selected}
      className={cn(
        "flex w-full items-start justify-between gap-2 rounded-lg border p-4 text-left hover:border-foreground/40 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        selected ? "border-foreground/50 bg-muted/40" : "border-border bg-card",
      )}
    >
      <span className="grid min-w-0 gap-1.5">
        <span className="flex flex-wrap items-baseline gap-2 text-xs">
          <strong className="capitalize text-warning-foreground">{entry.kind}</strong>
          <span className="text-muted-foreground">{item?.item.title ?? "Unlinked session"}</span>
        </span>
        <span className="line-clamp-3 whitespace-pre-line break-words text-sm font-medium">
          {entry.prompt}
        </span>
        {entry.request?.context && (
          <span className="line-clamp-2 text-xs text-muted-foreground">
            {entry.request.context}
          </span>
        )}
        <span className="text-xs text-muted-foreground">
          {shell?.title ?? entry.threadId} ·{" "}
          <time dateTime={entry.createdAt}>{sourceTime(entry.createdAt)}</time>
          {entry.request?.status === "delivering" ? " · Delivery pending" : ""}
        </span>
      </span>
      <ArrowUpRightIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
    </button>
  );
}

const boardColumns = ["needs-me", ...stages] as const;
const columnLabel = { ...stageLabel, "needs-me": "Needs me" };

const View = Schema.Literals(["board", "queue"]);
const Target = Schema.NullOr(PanelTarget);

export function VisualWorkspace() {
  const state = useWorkspaceState();
  const [view, setView] = useWorkspaceTabValue("view", "board", View);
  const [target, setTarget] = useWorkspaceTabValue("selected", null, Target);
  const [form, setForm] = useState<"new" | "global" | null>(null);
  const [completed, setCompleted] = useWorkspaceTabValue("show-completed", true, Schema.Boolean);
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
  const cards = visibleItems.map((entry) => {
    const pending = requests.filter(
      (request) =>
        request.environmentId === entry.environmentId && request.itemId === entry.item.id,
    );
    return { entry, pending, column: pending.length > 0 ? "needs-me" : entry.item.stage };
  });
  const hosts = state.hosts.filter((host) => !environment || environment === host.environmentId);
  const hasPanel = form !== null || target !== null;
  function select(target: PanelTarget) {
    if (target.itemId && !target.requestId && !target.nativeRequestId) {
      lastConversation.current.set(
        JSON.stringify([target.environmentId, target.itemId]),
        target.threadId,
      );
    }
    setForm(null);
    setTarget(target);
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
              setView("board");
              setForm(null);
              setTarget(null);
            }}
          >
            <Columns3Icon /> Board
          </Button>
          <Button
            size="compact"
            variant="ghost"
            onClick={() => {
              if (target) setReturnTo(target);
              setView("queue");
              setForm(null);
              setTarget(null);
            }}
          >
            <InboxIcon /> Needs you {requests.length}
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
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
            <div className="flex items-center gap-1 rounded-lg bg-muted p-0.5">
              <Button
                size="sm"
                variant={view === "board" ? "outline" : "ghost"}
                aria-pressed={view === "board"}
                onClick={() => setView("board")}
              >
                <Columns3Icon />
                Board
              </Button>
              <Button
                size="sm"
                variant={view === "queue" ? "outline" : "ghost"}
                aria-pressed={view === "queue"}
                onClick={() => setView("queue")}
              >
                <InboxIcon />
                Needs you <span className="tabular-nums">{requests.length}</span>
              </Button>
            </div>
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
            {view === "board" && (
              <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  checked={completed}
                  onChange={(e) => setCompleted(e.target.checked)}
                />
                Show done
              </label>
            )}
          </div>
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
          {view === "board" ? (
            <>
              {visibleItems.length === 0 && (
                <div className="px-5 pt-5 text-sm text-muted-foreground">
                  {state.hosts.length === 0
                    ? "Connect an environment to see its work."
                    : "Create a work item and choose its primary conversation."}
                </div>
              )}
              <div className="flex min-h-0 flex-1 gap-2 overflow-auto p-3">
                {boardColumns
                  .filter((stage) => stage !== "complete" || completed)
                  .map((stage) => {
                    const entries = cards.filter((card) => card.column === stage);
                    return (
                      <section
                        aria-label={columnLabel[stage]}
                        key={stage}
                        className={cn(
                          "min-h-full flex-1 rounded-lg bg-muted/40 p-2",
                          entries.length ? "min-w-44" : "min-w-24",
                        )}
                      >
                        <h2 className="mb-3 flex items-center justify-between gap-2 px-1 pt-1 text-xs font-semibold">
                          <span>{columnLabel[stage]}</span>
                          <span className="tabular-nums text-muted-foreground">
                            {entries.length}
                          </span>
                        </h2>
                        <div className="grid gap-2">
                          {entries.map(({ entry, pending }) => {
                            const { environmentId, item } = entry;
                            const host = hosts.find(
                              (entry) => entry.environmentId === environmentId,
                            );
                            return (
                              <WorkCard
                                key={JSON.stringify([environmentId, item.id])}
                                entry={entry}
                                dependencies={outstandingDependencies(
                                  item,
                                  host?.snapshot?.items ?? [],
                                )}
                                host={host?.label ?? environmentId}
                                connected={host?.connected ?? false}
                                sessions={state.shells.filter(
                                  (shell) =>
                                    shell.environmentId === environmentId &&
                                    itemHasThread(item, shell.id),
                                )}
                                requests={pending}
                                selected={
                                  target?.itemId === item.id &&
                                  target.environmentId === environmentId
                                }
                                onClick={() => {
                                  setReturnTo(null);
                                  const lastThreadId = lastConversation.current.get(
                                    JSON.stringify([environmentId, item.id]),
                                  );
                                  select({
                                    environmentId,
                                    itemId: item.id,
                                    threadId:
                                      lastThreadId && itemHasThread(item, lastThreadId)
                                        ? lastThreadId
                                        : item.primaryThreadId,
                                  });
                                }}
                              />
                            );
                          })}
                        </div>
                      </section>
                    );
                  })}
              </div>
            </>
          ) : (
            <div className="grid content-start gap-2 overflow-auto p-4">
              {requests.length === 0 &&
                hosts.length > 0 &&
                hosts.every((host) => host.connected && host.snapshot && !host.error) && (
                  <p className="flex items-center gap-2 rounded-lg border border-border p-4 text-sm text-muted-foreground">
                    <CheckIcon size={16} />
                    No outstanding requests.
                  </p>
                )}
              {requests.map((entry) => (
                <RequestRow
                  key={entry.key}
                  entry={entry}
                  state={state}
                  selected={
                    !!target &&
                    target.environmentId === entry.environmentId &&
                    (entry.request?.id
                      ? entry.request.id === target.requestId
                      : !!entry.nativeRequestId && entry.nativeRequestId === target.nativeRequestId)
                  }
                  open={() => {
                    if (target && !target.requestId && !target.nativeRequestId) setReturnTo(target);
                    select({
                      environmentId: entry.environmentId,
                      itemId: entry.itemId,
                      threadId: entry.threadId,
                      ...(entry.request ? { requestId: entry.request.id } : {}),
                      ...(entry.nativeRequestId ? { nativeRequestId: entry.nativeRequestId } : {}),
                    });
                  }}
                />
              ))}
            </div>
          )}
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
