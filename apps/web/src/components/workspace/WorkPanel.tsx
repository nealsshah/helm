import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  ArrowLeftIcon,
  CheckIcon,
  ExternalLinkIcon,
  LayersIcon,
  LinkIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useEffectEvent, useState } from "react";
import { ComposerHandleContext } from "../../composerHandleContext";
import { serverEnvironment } from "../../state/server";
import ChatView from "../ChatView";
import { BackgroundThreadContext } from "../chat/backgroundThread";
import { Button } from "../ui/button";
import {
  Menu,
  MenuCheckboxItem,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { SessionProjectPicker } from "./SessionProjectPicker";
import { useDelivery } from "./WorkspaceForms";
import { runtimeLabel, safeArtifactUrl, stageLabel, usesSecondMate } from "./workspaceModel";
import { useWorkspaceCommand, type WorkspaceState } from "./workspaceState";
import type { PanelTarget } from "./workspaceTab";

function TaskTitle({
  environmentId,
  itemId,
  title,
  connected,
}: {
  environmentId: EnvironmentId;
  itemId: string;
  title: string;
  connected: boolean;
}) {
  const allowed = useAtomValue(serverEnvironment.workspaceCommand.permissionAtom(environmentId));
  const run = useWorkspaceCommand();
  const { submit, busy, error } = useDelivery();
  const [editing, setEditing] = useState(false);
  if (!editing || !connected || !allowed) {
    return (
      <h2 className="truncate text-sm font-semibold">
        {connected && allowed ? (
          <button
            type="button"
            className="block max-w-full cursor-text truncate text-left"
            aria-description="Double-click to rename task"
            onDoubleClick={() => setEditing(true)}
            onClick={(event) => {
              if (event.detail === 0) setEditing(true);
            }}
          >
            {title}
          </button>
        ) : (
          title
        )}
      </h2>
    );
  }
  const save = (value: string) => {
    const nextTitle = value.trim();
    if (!nextTitle || nextTitle === title) {
      setEditing(false);
      return;
    }
    void submit(async () => {
      await run(environmentId, { type: "update", itemId, title: nextTitle });
      setEditing(false);
    });
  };
  return (
    <>
      <input
        aria-label="Task title"
        className="w-full rounded-sm bg-background text-sm font-semibold ring-1 ring-ring"
        defaultValue={title}
        autoFocus
        onFocus={(event) => event.currentTarget.select()}
        readOnly={busy}
        onBlur={(event) => save(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || busy) return;
          if (event.key === "Escape") {
            event.preventDefault();
            event.currentTarget.value = title;
            setEditing(false);
          } else if (event.key === "Enter") {
            event.preventDefault();
            save(event.currentTarget.value);
          }
        }}
      />
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </>
  );
}

function PrepareSecondMate({
  environmentId,
  itemId,
}: {
  environmentId: EnvironmentId;
  itemId: string;
}) {
  const allowed = useAtomValue(serverEnvironment.workspaceCommand.permissionAtom(environmentId));
  const run = useWorkspaceCommand();
  const { submit, busy, error } = useDelivery();
  const open = () => submit(() => run(environmentId, { type: "ensureSecondMate", itemId }));
  const onOpen = useEffectEvent(open);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Opening a task provisions its persisted coordinator on the owning server.
  useEffect(() => {
    if (allowed) void onOpen();
  }, [allowed]);
  return (
    <div className="m-auto grid max-w-sm justify-items-center gap-2 p-4 text-center text-sm text-muted-foreground">
      <p role={error ? "alert" : "status"}>
        {!allowed
          ? "Workspace access is required to start this Second Mate."
          : error || "Opening Second Mate…"}
      </p>
      {allowed && error && (
        <Button variant="outline" size="sm" disabled={busy} onClick={() => void open()}>
          Try again
        </Button>
      )}
    </div>
  );
}

export function WorkPanel({
  state,
  target,
  select,
  close,
}: {
  state: WorkspaceState;
  target: PanelTarget;
  select: (target: PanelTarget) => void;
  close: () => void;
}) {
  const { environmentId, itemId } = target;
  const navigate = useNavigate();
  const host = state.hosts.find((entry) => entry.environmentId === environmentId);
  const item = host?.snapshot?.items.find((entry) => entry.id === itemId);
  const hasLead = item !== undefined && usesSecondMate(item, host?.secondMate);
  const workers = item
    ? [
        ...(item.primaryThreadId !== item.secondMateThreadId
          ? [{ threadId: item.primaryThreadId, role: "Worker" }]
          : []),
        ...item.sessions.filter(
          (session) =>
            session.threadId !== item.primaryThreadId &&
            session.threadId !== item.secondMateThreadId,
        ),
      ]
    : [];
  const worker = workers.find((session) => session.threadId === target.threadId);
  const openLead = hasLead && (!target.worker || target.threadId === item?.secondMateThreadId);
  const detached = Boolean(
    item &&
    !worker &&
    !openLead &&
    !state.requests.some(
      (request) =>
        request.environmentId === environmentId &&
        request.itemId === itemId &&
        request.threadId === target.threadId,
    ),
  );
  const threadId = openLead
    ? item?.secondMateThreadId
    : itemId && !item
      ? undefined
      : target.threadId;
  const shellFor = (id: typeof threadId) =>
    state.shells.find((entry) => entry.environmentId === environmentId && entry.id === id);
  const shell = shellFor(threadId);
  const needsLead = openLead && (!shell || shell.archivedAt != null || shell.deletedAt != null);
  const destination = target.global
    ? "First Mate"
    : openLead
      ? "Second Mate"
      : item || target.worker
        ? "Worker"
        : undefined;
  const workerRows = workers.flatMap((session) => {
    const source = shellFor(session.threadId);
    if (
      session.threadId !== item?.primaryThreadId &&
      (!source ||
        (source.lineage.relationshipToParent === "subagent" &&
          source.lineage.parentThreadId !== item?.secondMateThreadId))
    ) {
      return [];
    }
    const status = runtimeLabel(
      source,
      host?.connected ?? false,
      host?.workerTriage && !!item?.secondMateThreadId,
    );
    return [{ ...session, title: source?.title ?? session.role, status }];
  });
  const activeWorkers = workerRows.filter((row) => row.status === "Running");
  const orderedWorkers = [
    ...activeWorkers,
    ...workerRows.filter((row) => row.status !== "Running"),
  ];
  return (
    <aside
      role={target.global ? "tabpanel" : undefined}
      aria-label={target.global ? destination : "Work panel"}
      className={
        target.global
          ? "flex min-h-0 flex-1 flex-col"
          : "flex min-h-0 min-w-0 flex-col bg-background"
      }
    >
      {!target.global && (
        <div className="flex min-h-12 shrink-0 items-center gap-1 border-b border-border/70 px-3 py-2">
          <div className="min-w-0 flex-1">
            <p className="truncate text-2xs font-medium text-muted-foreground">
              {item ? stageLabel[item.stage] : "Session"}
              {state.hosts.length > 1 && ` · ${host?.label ?? environmentId}`}
            </p>
            {item ? (
              <TaskTitle
                key={JSON.stringify([environmentId, item.id])}
                environmentId={environmentId}
                itemId={item.id}
                title={item.title}
                connected={host?.connected === true}
              />
            ) : (
              <h2 className="truncate text-sm font-semibold">{shell?.title ?? "Task"}</h2>
            )}
          </div>
          {shell && (
            <SessionProjectPicker
              environmentId={environmentId}
              projectId={shell.projectId}
              threadId={shell.id}
            />
          )}
          {item && hasLead && !openLead && (
            <Button
              variant="ghost"
              size="compact"
              onClick={() =>
                select({
                  environmentId,
                  itemId,
                  threadId: item.secondMateThreadId ?? item.primaryThreadId,
                })
              }
            >
              <ArrowLeftIcon /> Second Mate
            </Button>
          )}
          {item && workerRows.length > 0 && (hasLead || workerRows.length > 1) && (
            <Menu>
              <MenuTrigger
                render={<Button variant="ghost" size="compact" />}
                aria-label={`Workers (${workerRows.length})${activeWorkers.length ? `, ${activeWorkers.length} working` : ""}`}
              >
                <LayersIcon aria-hidden="true" />
                <span>{workerRows.length}</span>
                {activeWorkers.length > 0 && (
                  <span
                    aria-hidden="true"
                    className="size-1.5 rounded-full bg-working motion-safe:animate-pulse"
                  />
                )}
              </MenuTrigger>
              <MenuPopup align="end">
                {openLead && (
                  <>
                    <MenuCheckboxItem
                      closeOnClick
                      checked={target.showWorkerActivity === true}
                      onCheckedChange={(checked) =>
                        select({ ...target, showWorkerActivity: checked })
                      }
                    >
                      Show worker activity
                    </MenuCheckboxItem>
                    <MenuSeparator />
                  </>
                )}
                {orderedWorkers.map((session) => {
                  const working = session.status === "Running";
                  return (
                    <MenuItem
                      key={session.threadId}
                      onClick={() =>
                        select({ environmentId, itemId, threadId: session.threadId, worker: true })
                      }
                    >
                      <span className={working ? "min-w-0" : "min-w-0 text-muted-foreground"}>
                        <span className="block max-w-72 truncate">{session.title}</span>
                        <span className="flex items-center gap-1 text-xs text-muted-foreground">
                          {working && (
                            <>
                              <span
                                aria-hidden="true"
                                className="size-1.5 shrink-0 rounded-full bg-working motion-safe:animate-pulse"
                              />
                              <span className="sr-only">Working</span>
                            </>
                          )}
                          {session.role}
                          {!working && session.status !== "Idle" && ` · ${session.status}`}
                        </span>
                      </span>
                      {session.threadId === threadId && <CheckIcon className="ml-auto" />}
                    </MenuItem>
                  );
                })}
              </MenuPopup>
            </Menu>
          )}
          {item && item.artifacts.length > 0 && (
            <Menu>
              <MenuTrigger
                render={<Button variant="ghost" size="icon-sm" />}
                aria-label="Task artifacts"
              >
                <LinkIcon />
              </MenuTrigger>
              <MenuPopup align="end">
                {item.artifacts.map((artifact) => {
                  const url = safeArtifactUrl(artifact.url);
                  return url ? (
                    <MenuItem
                      key={artifact.url}
                      render={<a href={url} target="_blank" rel="noreferrer" />}
                    >
                      {artifact.label}
                    </MenuItem>
                  ) : (
                    <MenuItem key={artifact.url} disabled>
                      {artifact.label} · {artifact.url}
                    </MenuItem>
                  );
                })}
              </MenuPopup>
            </Menu>
          )}
          {threadId && !needsLead && (
            <Link
              to="/$environmentId/$threadId"
              params={{ environmentId, threadId }}
              state={{ fromWorkspace: true }}
              className="rounded p-1 text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset"
              aria-label="Open full session"
            >
              <ExternalLinkIcon size={16} />
            </Link>
          )}
          <Button variant="ghost" size="icon-sm" aria-label="Close work panel" onClick={close}>
            <XIcon />
          </Button>
        </div>
      )}
      <div
        data-side-chat-pane
        className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
      >
        {threadId && shell && !detached && !needsLead ? (
          <BackgroundThreadContext value>
            <ComposerHandleContext value={null}>
              <ChatView
                key={JSON.stringify([environmentId, threadId])}
                environmentId={environmentId}
                threadId={threadId}
                routeKind="server"
                onDiffPanelOpen={() => {
                  void navigate({
                    to: "/$environmentId/$threadId",
                    params: { environmentId, threadId },
                    state: { fromWorkspace: true },
                  });
                }}
                reserveTitleBarControlInset={false}
                showWorkerActivity={openLead && target.showWorkerActivity === true}
                workspaceDestination={{ label: destination }}
              />
            </ComposerHandleContext>
          </BackgroundThreadContext>
        ) : needsLead && item && host?.connected && host.secondMate ? (
          <PrepareSecondMate
            key={JSON.stringify([environmentId, item.id])}
            environmentId={environmentId}
            itemId={item.id}
          />
        ) : (
          <p role="status" className="p-4 text-sm text-muted-foreground">
            {!host?.connected
              ? "Environment disconnected."
              : itemId && !host.snapshot
                ? "Loading task…"
                : threadId && openLead
                  ? "Opening Second Mate…"
                  : detached
                    ? "This worker is no longer linked to the task."
                    : "Session unavailable."}
          </p>
        )}
      </div>
    </aside>
  );
}
