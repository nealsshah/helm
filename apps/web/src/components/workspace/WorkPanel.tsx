import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, WorkItem, WorkspaceCommand } from "@t3tools/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { SessionTabs } from "./SessionTabs";
import { ExternalLinkIcon, XIcon } from "lucide-react";
import * as Schema from "effect/Schema";
import { type PanelTarget, useWorkspaceTabValue } from "./workspaceTab";
import { serverEnvironment } from "../../state/server";
import ChatView from "../ChatView";
import { ComposerHandleContext } from "../../composerHandleContext";
import { BackgroundThreadContext } from "../chat/backgroundThread";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { field, useDelivery } from "./WorkspaceForms";
import {
  itemHasThread,
  outstandingDependencies,
  runtimeLabel,
  safeArtifactUrl,
  sourceTime,
  stageLabel,
  stages,
} from "./workspaceModel";
import { useWorkspaceCommand, type WorkspaceState } from "./workspaceState";

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
  const { environmentId, itemId, threadId } = target;
  const navigate = useNavigate();
  const host = state.hosts.find((entry) => entry.environmentId === environmentId);
  const item = host?.snapshot?.items.find((entry) => entry.id === itemId);
  const shell = state.shells.find(
    (entry) => entry.environmentId === environmentId && entry.id === threadId,
  );
  const detached = Boolean(item && !itemHasThread(item, threadId));
  const nextThread = detached ? item?.primaryThreadId : threadId;
  const role = target.global
    ? "Orchestrator"
    : item?.primaryThreadId === threadId
      ? "Work conversation"
      : (item?.sessions.find((entry) => entry.threadId === threadId)?.role ?? "Session");
  const [detailsFor, setDetailsFor] = useState<string | null>(null);
  const itemKey = JSON.stringify([environmentId, itemId]);
  const showDetails = detailsFor === itemKey;
  const conversations = item
    ? [
        { threadId: item.primaryThreadId, role: "Primary" },
        ...item.sessions.filter((session) => session.threadId !== item.primaryThreadId),
      ]
    : [];
  const destination = `${role} · ${shell?.title ?? threadId}`;
  return (
    <aside
      role={target.global ? "tabpanel" : undefined}
      aria-label={target.global ? destination : "Work panel"}
      className={
        target.global
          ? "flex min-h-0 flex-1 flex-col"
          : "flex min-h-0 min-w-0 flex-col border-l border-border bg-background"
      }
    >
      {!target.global && (
        <div className="flex min-h-12 shrink-0 items-center gap-1.5 border-b border-border/70 px-3 py-2">
          <div className="min-w-0 flex-1">
            <p className="truncate text-2xs font-medium text-muted-foreground">
              {item ? stageLabel[item.stage] : "Session"}
              {state.hosts.length > 1 && ` · ${host?.label ?? environmentId}`}
            </p>
            <h2 className="truncate text-sm font-semibold">
              {item?.title ?? shell?.title ?? threadId}
            </h2>
          </div>
          {item && (
            <Button
              size="compact"
              variant={showDetails ? "secondary" : "ghost"}
              aria-expanded={showDetails}
              onClick={() => setDetailsFor(showDetails ? null : itemKey)}
            >
              Details
            </Button>
          )}
          <Link
            to="/$environmentId/$threadId"
            params={{ environmentId, threadId }}
            className="rounded p-1 text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset"
            aria-label="Open full session"
          >
            <ExternalLinkIcon size={16} />
          </Link>
          <Button variant="ghost" size="icon-sm" aria-label="Close work panel" onClick={close}>
            <XIcon />
          </Button>
        </div>
      )}
      <div className="max-h-[45%] shrink-0 overflow-auto">
        {item && showDetails && (
          <section
            aria-label="Ticket details"
            className="border-b border-border/70 px-4 py-3 text-sm"
          >
            <div className="grid gap-2">
              <p className="whitespace-pre-wrap text-muted-foreground">
                {item.scope || "No scope recorded."}
              </p>
              {outstandingDependencies(item, host?.snapshot?.items ?? []).map((dep) => (
                <p key={dep.itemId}>
                  Waiting on {dep.title} · {dep.owner}
                </p>
              ))}
              {item.decisions.map((decision) => (
                <p key={JSON.stringify([decision.createdAt, decision.author, decision.text])}>
                  {decision.text}{" "}
                  <small className="text-muted-foreground">
                    {decision.author} · {sourceTime(decision.createdAt)}
                  </small>
                </p>
              ))}
              {item.artifacts.map((artifact) => {
                const url = safeArtifactUrl(artifact.url);
                return (
                  <p key={artifact.url}>
                    {url ? (
                      <a className="underline" href={url} target="_blank" rel="noreferrer">
                        {artifact.label}
                      </a>
                    ) : (
                      <span>
                        {artifact.label} · {artifact.url}
                      </span>
                    )}
                  </p>
                );
              })}
              {item.latestReport && (
                <p className="whitespace-pre-wrap text-muted-foreground">
                  {item.latestReport.format === "legacy" ? "Legacy update" : "Worker update"} ·{" "}
                  {state.shells.find(
                    (s) =>
                      s.environmentId === environmentId && s.id === item.latestReport?.threadId,
                  )?.title ?? item.latestReport.threadId}{" "}
                  · {sourceTime(item.latestReport.reportedAt)}
                  <br />
                  {item.latestReport.text}
                </p>
              )}
              <ItemSettings item={item} environmentId={environmentId} state={state} />
            </div>
          </section>
        )}
      </div>
      {conversations.length > 1 && (
        <div className="shrink-0 border-b border-border/70 bg-muted/35 px-2">
          <SessionTabs
            label="Work conversations"
            selected={threadId}
            onSelect={(id) => select({ environmentId, itemId, threadId: id })}
            tabs={conversations.map((session) => {
              const source = state.shells.find(
                (entry) => entry.environmentId === environmentId && entry.id === session.threadId,
              );
              return {
                id: session.threadId,
                title: source?.title ?? session.role,
                description: `${session.role} · ${source?.title ?? session.threadId} · ${runtimeLabel(source, host?.connected ?? false)}`,
              };
            })}
          />
        </div>
      )}
      <div
        role={conversations.length > 1 ? "tabpanel" : undefined}
        aria-label={conversations.length > 1 ? destination : undefined}
        data-side-chat-pane
        className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
      >
        {shell && !detached ? (
          <BackgroundThreadContext value>
            <ComposerHandleContext value={null}>
              <ChatView
                environmentId={environmentId}
                threadId={threadId}
                routeKind="server"
                onDiffPanelOpen={() => {
                  void navigate({
                    to: "/$environmentId/$threadId",
                    params: { environmentId, threadId },
                  });
                }}
                reserveTitleBarControlInset={false}
                workspaceDestination={{ label: destination }}
              />
            </ComposerHandleContext>
          </BackgroundThreadContext>
        ) : (
          <div className="p-4 text-sm text-muted-foreground">
            {detached && <p className="mb-2">This worker is no longer linked to the work item.</p>}
            {!nextThread || (!shell && !detached) ? (
              "Session unavailable. Its workspace records are retained here."
            ) : (
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  select({
                    environmentId,
                    itemId,
                    threadId: nextThread,
                    ...(target.global ? { global: true } : {}),
                  })
                }
              >
                Open conversation
              </Button>
            )}
          </div>
        )}
      </div>
    </aside>
  );
}

function ItemSettings({
  item,
  environmentId,
  state,
}: {
  item: WorkItem;
  environmentId: EnvironmentId;
  state: WorkspaceState;
}) {
  const run = useWorkspaceCommand();
  const allowed = useAtomValue(serverEnvironment.workspaceCommand.permissionAtom(environmentId));
  const delivery = useDelivery();
  const draftKey = JSON.stringify([environmentId, item.id]);
  const [session, setSession] = useWorkspaceTabValue(`worker.${draftKey}`, "", Schema.String);
  const [role, setRole] = useWorkspaceTabValue(`role.${draftKey}`, "", Schema.String);
  const choices = state.shells.filter(
    (shell) =>
      shell.environmentId === environmentId &&
      !shell.archivedAt &&
      !shell.deletedAt &&
      !state.items.some(
        (entry) => entry.environmentId === environmentId && itemHasThread(entry.item, shell.id),
      ),
  );
  const commit = (command: WorkspaceCommand) => delivery.submit(() => run(environmentId, command));
  return (
    <fieldset
      disabled={!allowed || delivery.busy}
      className="space-y-3 border-t border-border py-2"
    >
      <label className="flex items-center gap-2 text-xs">
        Stage
        <select
          value={item.stage}
          className={field}
          onChange={(event) => {
            const stage = stages.find((value) => value === event.target.value);
            if (stage) void commit({ type: "update", itemId: item.id, stage });
          }}
        >
          {stages.map((stage) => (
            <option key={stage} value={stage}>
              {stageLabel[stage]}
            </option>
          ))}
        </select>
      </label>
      <form
        className="flex flex-wrap gap-1"
        onSubmit={(event) => {
          event.preventDefault();
          const source = choices.find((s) => s.id === session);
          if (!source || !role.trim()) return;
          void delivery.submit(async () => {
            await run(environmentId, {
              type: "associate",
              itemId: item.id,
              threadId: source.id,
              role: role.trim(),
            });
            setSession("");
            setRole("");
          });
        }}
      >
        <select
          aria-label="Worker session"
          className={field}
          value={session}
          onChange={(e) => setSession(e.target.value)}
        >
          <option value="">Link worker session</option>
          {choices.map((s) => (
            <option key={s.id} value={s.id}>
              {s.title}
            </option>
          ))}
        </select>
        <Input
          aria-label="Worker role"
          placeholder="Role"
          value={role}
          onChange={(e) => setRole(e.target.value)}
        />
        <Button type="submit" variant="outline" size="sm" disabled={!session || !role.trim()}>
          Link session
        </Button>
      </form>
      {delivery.error && (
        <p role="alert" className="text-destructive">
          {delivery.error}
        </p>
      )}
    </fieldset>
  );
}
