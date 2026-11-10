import { workspaceOwnerThreadId } from "@t3tools/contracts";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { useProject } from "../../state/entities";
import { ProjectFavicon } from "../ProjectFavicon";
import { useState } from "react";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  CircleDashedIcon,
  CircleCheckIcon,
  CircleDotIcon,
  ScanEyeIcon,
  Columns3Icon,
  InboxIcon,
  MessageSquareIcon,
  ArrowUpRightIcon,
} from "lucide-react";
import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import {
  AlertDialog,
  AlertDialogPopup,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogClose,
} from "../ui/alert-dialog";
import { useReadWorkspaceReply } from "./ReadWorkspaceReply";
import { RetiredTasksMenu } from "./RetiredTasksMenu";
import { TaskCardButton } from "./TaskCardButton";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "../../workspaceTitlebar";
import { SidebarInset, useSidebarVisibility } from "../ui/sidebar";
import { OrchestratorPanel } from "./OrchestratorPanel";
import { WorkspaceSidePane } from "./WorkspaceSidePane";
import { WorkPanel } from "./WorkPanel";
import { PanelTarget, useWorkspaceTabValue } from "./workspaceTab";
import * as Schema from "effect/Schema";
import { field, useDelivery } from "./WorkspaceForms";
import {
  itemHasThread,
  outstandingDependencies,
  runtimeLabel,
  sourceTime,
  stageLabel,
  usesSecondMate,
  stages,
  type BoardItem,
  type QueueEntry,
} from "./workspaceModel";
import { useWorkspaceCommand, useWorkspaceState } from "./workspaceState";

const stageIcons = {
  planning: CircleDashedIcon,
  building: CircleDotIcon,
  reviewing: PullRequestGlyph.pullRequest,
  qa: ScanEyeIcon,
  complete: CircleCheckIcon,
};

function CardTitle({
  title,
  session,
  compact = false,
}: {
  title: string;
  session: EnvironmentThreadShell | undefined;
  compact?: boolean;
}) {
  const project = useProject(
    session ? scopeProjectRef(session.environmentId, session.projectId) : null,
  );
  return (
    <span className="flex min-w-0 items-start gap-1.5 text-sm font-medium leading-snug">
      {project && !project.isScratch && (
        <Tooltip>
          <TooltipTrigger
            render={
              <span role="img" aria-label={project.title} className="mt-0.5 inline-flex shrink-0" />
            }
          >
            <ProjectFavicon project={project} className="size-3.5" />
          </TooltipTrigger>
          <TooltipPopup>{project.title}</TooltipPopup>
        </Tooltip>
      )}
      <span className={cn("min-w-0 break-words", compact && "line-clamp-2")}>{title}</span>
    </span>
  );
}

function WorkCard({
  entry,
  sessions,
  dependencies,
  workerTriage,
  connected,
  host,
  selected,
  onClick,
  onRetire,
  retirement,
}: {
  entry: BoardItem;
  sessions: EnvironmentThreadShell[];
  dependencies: ReturnType<typeof outstandingDependencies>;
  workerTriage: boolean;
  connected: boolean;
  host: string | undefined;
  selected: boolean;
  onClick: () => void;
  onRetire: (entry: BoardItem) => void;
  retirement: boolean;
}) {
  const { item } = entry;
  const primary = sessions.find((s) => s.id === item.primaryThreadId);
  const source =
    sessions.find((s) => s.hasPendingUserInput || s.hasPendingApprovals) ??
    sessions.find((s) => s.runtime?.status === "failed") ??
    sessions.find(
      (s) =>
        s.runtime?.status === "running" ||
        s.runtime?.status === "preparing" ||
        s.runtime?.status === "starting",
    ) ??
    sessions.find((s) => s.runtime?.status === "queued" || s.runtime?.status === "waiting") ??
    primary;
  const runtime = runtimeLabel(
    source,
    connected,
    workerTriage && source?.id !== item.secondMateThreadId,
  );
  const working = runtime === "Running";
  const time = source?.runtime?.updatedAt ?? source?.updatedAt;
  const summary = item.latestReport?.text ?? item.scope;
  return (
    <TaskCardButton
      entry={entry}
      environmentId={entry.environmentId}
      retirement={retirement}
      onRetire={onRetire}
      aria-pressed={selected}
      onOpen={onClick}
      className={cn(
        "grid w-full min-w-0 cursor-pointer gap-1.5 rounded-xl border px-3 py-2.5 text-left motion-safe:transition-[border-color,background-color,box-shadow] motion-safe:duration-150 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        selected
          ? "border-foreground/25 bg-foreground/5 ring-1 ring-inset ring-foreground/8"
          : "border-border/50 bg-card hover:border-foreground/20 hover:shadow-xs",
      )}
    >
      <CardTitle
        title={item.title}
        session={sessions.find((session) => session.id === item.secondMateThreadId) ?? primary}
      />
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
      <span className="flex flex-wrap items-center gap-x-2 gap-y-1 pt-0.5 text-2xs text-muted-foreground empty:hidden">
        {runtime !== "Idle" && (
          <span className="inline-flex items-center gap-1">
            <span
              aria-hidden="true"
              className={cn(
                "size-1.5 rounded-full",
                working
                  ? "bg-working motion-safe:animate-pulse"
                  : runtime === "Error"
                    ? "bg-destructive"
                    : "bg-muted-foreground",
              )}
            />
            {working ? "Working" : runtime}
          </span>
        )}
        {item.attention !== "none" && <span className="capitalize">{item.attention}</span>}
        {host && <span className="truncate">{host}</span>}
        {time && <time dateTime={time}>{sourceTime(time)}</time>}
      </span>
    </TaskCardButton>
  );
}

const Target = Schema.NullOr(PanelTarget);

export function VisualWorkspace() {
  const state = useWorkspaceState();
  const sidebarVisible = useSidebarVisibility();
  const command = useWorkspaceCommand();
  const readReply = useReadWorkspaceReply();
  const delivery = useDelivery();
  const [confirmation, setConfirmation] = useState<BoardItem | null>(null);
  const [storedTarget, setTarget] = useWorkspaceTabValue("selected", null, Target);
  const target =
    storedTarget?.itemId &&
    state.hosts.some(
      (host) =>
        host.environmentId === storedTarget.environmentId &&
        host.snapshot?.items.some((item) => item.id === storedTarget.itemId && item.retiredAt),
    )
      ? null
      : storedTarget;
  const [showOrchestrator, setShowOrchestrator] = useState(false);
  const [storedEnvironment, setEnvironment] = useWorkspaceTabValue(
    "environment",
    "",
    Schema.String,
  );
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
    if (!queue.has(key) || (queue.get(key)?.replyId && !entry.replyId)) queue.set(key, entry);
    if (entry.itemId) waitingItems.add(JSON.stringify([entry.environmentId, entry.itemId]));
  }
  const cards = visibleItems.filter(
    ({ environmentId, item }) => !waitingItems.has(JSON.stringify([environmentId, item.id])),
  );
  const hosts = state.hosts.filter((host) => !environment || environment === host.environmentId);
  const orchestratorHost =
    (!showOrchestrator && target?.global
      ? state.hosts.find((host) => host.environmentId === target.environmentId)
      : null) ??
    hosts.find((host) => host.environmentId === target?.environmentId) ??
    hosts.find((host) => host.connected && host.snapshot) ??
    hosts[0];
  const hasPanel = showOrchestrator || target !== null;
  function select(target: PanelTarget) {
    setShowOrchestrator(false);
    setTarget(target);
    if (target.worker || !target.itemId) return;
    const reply = state.requests.find(
      (request) =>
        request.environmentId === target.environmentId &&
        request.itemId === target.itemId &&
        request.threadId === target.threadId &&
        request.replyId,
    );
    if (reply?.replyId) readReply(target.environmentId, target.itemId, reply.replyId);
  }
  function openItem({ environmentId, item }: BoardItem) {
    setReturnTo(null);
    select({
      environmentId,
      itemId: item.id,
      threadId: item.secondMateThreadId ?? item.primaryThreadId,
    });
  }
  function retire(entry: BoardItem, onlyIfDone = false) {
    void delivery.submit(async () => {
      await command(entry.environmentId, {
        type: "retire",
        itemId: entry.item.id,
        ...(onlyIfDone ? { onlyIfDone: true } : {}),
      });
      setConfirmation(null);
      if (target?.itemId === entry.item.id && target.environmentId === entry.environmentId)
        setTarget(null);
      if (returnTo?.itemId === entry.item.id && returnTo.environmentId === entry.environmentId)
        setReturnTo(null);
    });
  }
  function requestRetirement(entry: BoardItem) {
    if (delivery.busy) return;
    if (entry.item.stage === "complete") retire(entry, true);
    else setConfirmation(entry);
  }
  function close() {
    setShowOrchestrator(false);
    if (returnTo) select(returnTo);
    else setTarget(null);
    setReturnTo(null);
  }
  return (
    <SidebarInset className="@container/workspace h-dvh min-h-0 overflow-hidden" tone="sidebar">
      <header
        className={cn(
          "drag-region flex min-h-(--workspace-topbar-height) shrink-0 flex-wrap items-center justify-between gap-2 px-3 py-2 md:px-5",
          COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
        )}
      >
        {!sidebarVisible && <h1 className="text-lg font-medium tracking-tight">Helm</h1>}
        <div className="ml-auto flex items-center gap-2">
          <RetiredTasksMenu hosts={hosts} />
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              if (!target?.global) setReturnTo(target);
              setShowOrchestrator(true);
            }}
          >
            <MessageSquareIcon />
            First Mate
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
              setShowOrchestrator(false);
              setTarget(null);
            }}
          >
            <Columns3Icon /> Board
          </Button>
        </div>
      )}
      <div className="relative mx-2 mb-2 flex min-h-0 min-w-0 flex-1 overflow-clip [--workspace-split-gap:--spacing(3)]">
        <section
          className={cn(
            "@container/board flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-2xl border border-border/70 bg-background shadow-xs",
            hasPanel && "invisible @3xl/workspace:visible",
          )}
          aria-label="Workspace overview"
        >
          <section aria-label="Needs me" className="@container flex max-h-[40%] shrink-0 flex-col">
            <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 px-5 pt-4 pb-2.5">
              <h2 className="mr-auto flex items-center gap-2 text-sm font-semibold">
                <InboxIcon
                  aria-hidden="true"
                  className={cn(
                    "size-4 text-muted-foreground",
                    queue.size > 0 &&
                      "text-workspace-attention-strong dark:text-workspace-attention",
                  )}
                />
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
              <ul className="flex min-h-0 snap-x snap-proximity items-stretch gap-3 overflow-x-auto overscroll-x-contain px-5 pb-3 scroll-px-5">
                {Array.from(queue, ([key, first]) => {
                  const { environmentId, itemId, threadId } = first;
                  const linked = visibleItems.find(
                    (entry) => entry.environmentId === environmentId && entry.item.id === itemId,
                  );
                  const session = state.shells.find(
                    (shell) => shell.environmentId === environmentId && shell.id === threadId,
                  );
                  const isOwner = linked && workspaceOwnerThreadId(linked.item) === threadId;
                  const title = isOwner
                    ? linked.item.title
                    : (session?.title ?? linked?.item.title ?? threadId);
                  const host = hosts.find((host) => host.environmentId === environmentId);
                  const hostLabel = hosts.length > 1 ? host?.label : null;
                  const viewingLead =
                    linked && !target?.worker && usesSecondMate(linked.item, host?.secondMate);
                  const viewingRequest =
                    !showOrchestrator &&
                    target?.environmentId === environmentId &&
                    target.itemId === itemId &&
                    (viewingLead ? linked.item.secondMateThreadId : target.threadId) === threadId;
                  return (
                    <li key={key} className="flex w-96 max-w-[90%] shrink-0 snap-start">
                      <TaskCardButton
                        entry={linked}
                        retirement={Boolean(host?.connected && host.retirement)}
                        environmentId={environmentId}
                        onRetire={requestRetirement}
                        aria-label={title}
                        aria-description={first.prompt}
                        aria-pressed={viewingRequest}
                        className="group grid w-full grid-cols-[minmax(0,1fr)_auto] content-start items-center gap-x-3 gap-y-1 rounded-xl border border-workspace-attention/30 bg-linear-to-br from-workspace-attention/10 via-workspace-attention/3 to-card px-3.5 py-3 text-left hover:border-workspace-attention/55 aria-pressed:border-workspace-attention/70 focus-visible:outline-2 focus-visible:outline-ring motion-safe:transition-colors"
                        onOpen={() => {
                          if (!viewingRequest) setReturnTo(target);
                          select({ environmentId, itemId, threadId, worker: !isOwner });
                        }}
                      >
                        <CardTitle title={title} session={session} compact />
                        <ArrowUpRightIcon
                          aria-hidden="true"
                          className="size-3.5 text-muted-foreground motion-safe:transition-transform motion-safe:group-hover:translate-x-px motion-safe:group-hover:-translate-y-px"
                        />
                        <span className="col-span-2 line-clamp-2 break-words text-xs leading-relaxed text-muted-foreground">
                          {first.prompt}
                        </span>
                        <span className="col-span-2 truncate pt-1 text-2xs text-muted-foreground">
                          {linked ? stageLabel[linked.item.stage] : "Session"}
                          {isOwner && (linked.item.directWorker ? " · Worker" : " · Second Mate")}
                          {linked && linked.item.title !== title && ` · ${linked.item.title}`}
                          {hostLabel && ` · ${hostLabel}`}
                        </span>
                      </TaskCardButton>
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
          {state.hosts.length === 0 && (
            <div className="px-5 pt-5 text-sm text-muted-foreground">
              Connect an environment to see its work.
            </div>
          )}
          <div className="flex min-h-0 min-w-0 flex-1 gap-3 overflow-x-auto overflow-y-hidden px-4 pt-2 pb-4">
            {stages.map((stage) => {
              const StageIcon = stageIcons[stage];
              const entries = cards.filter((card) => card.item.stage === stage);
              return (
                <section
                  aria-label={stageLabel[stage]}
                  key={stage}
                  className="flex min-h-0 min-w-40 flex-1 flex-col @2xl/board:min-w-0"
                >
                  <h2 className="flex shrink-0 items-center gap-2 border-b border-border/70 px-1 py-2.5 text-sm font-medium">
                    <StageIcon
                      aria-hidden="true"
                      className={cn(
                        "size-3.5",
                        stage === "complete" ? "text-success" : "text-muted-foreground",
                      )}
                    />
                    <span>{stageLabel[stage]}</span>
                    <span className="ml-auto text-xs font-normal tabular-nums text-muted-foreground">
                      {entries.length}
                    </span>
                  </h2>
                  <div className="grid min-h-0 content-start gap-2 overflow-y-auto overscroll-y-contain px-0.5 py-2.5">
                    {entries.map((entry) => {
                      const { environmentId, item } = entry;
                      const host = hosts.find((entry) => entry.environmentId === environmentId);
                      return (
                        <WorkCard
                          key={JSON.stringify([environmentId, item.id])}
                          entry={entry}
                          dependencies={outstandingDependencies(item, host?.snapshot?.items ?? [])}
                          host={hosts.length > 1 ? (host?.label ?? environmentId) : undefined}
                          workerTriage={Boolean(host?.workerTriage && item.secondMateThreadId)}
                          connected={host?.connected ?? false}
                          sessions={state.shells.filter(
                            (shell) =>
                              shell.environmentId === environmentId &&
                              itemHasThread(item, shell.id),
                          )}
                          selected={
                            target?.itemId === item.id && target.environmentId === environmentId
                          }
                          retirement={Boolean(host?.connected && host.retirement)}
                          onRetire={requestRetirement}
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
        <WorkspaceSidePane open={hasPanel}>
          {showOrchestrator || target?.global ? (
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
                Connect an environment to open First Mate.{" "}
                <Button variant="ghost" onClick={close}>
                  Close
                </Button>
              </aside>
            )
          ) : (
            target && <WorkPanel state={state} target={target} close={close} select={select} />
          )}
        </WorkspaceSidePane>
      </div>
      {delivery.error && !confirmation && (
        <p role="alert" className="px-4 py-2 text-sm text-destructive">
          {delivery.error}
        </p>
      )}
      <AlertDialog
        open={confirmation !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmation(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Retire {confirmation?.item.title}?</AlertDialogTitle>
            <AlertDialogDescription>
              This stops active work, settles the task’s sessions, and removes the card from the
              board.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {delivery.error && (
            <p role="alert" className="px-6 pb-3 text-sm text-destructive">
              {delivery.error}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" disabled={delivery.busy} />}>
              Cancel
            </AlertDialogClose>
            <Button
              disabled={delivery.busy}
              onClick={() => {
                if (confirmation) retire(confirmation);
              }}
            >
              Retire task
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </SidebarInset>
  );
}
