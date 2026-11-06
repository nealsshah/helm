import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ThreadId, WorkspaceRequest } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useRef, useState } from "react";
import { randomUUID } from "../../lib/utils";
import { useWorkspaceTabValue } from "./workspaceTab";
import { serverEnvironment } from "../../state/server";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { sourceTime, stageLabel, stages, itemHasThread } from "./workspaceModel";
import { useWorkspaceCommand, type WorkspaceState } from "./workspaceState";

export const field =
  "h-8 min-w-0 max-w-full rounded-md border border-input bg-background px-2 text-sm focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";
export function useDelivery() {
  const lock = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(action: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Delivery failed. Try again.");
    }
    lock.current = false;
    setBusy(false);
  }
  return { busy, error, submit };
}

export function RequestResponse({
  environmentId,
  request,
  source,
  connected,
}: {
  environmentId: EnvironmentId;
  request: WorkspaceRequest;
  source: string;
  connected: boolean;
}) {
  const run = useWorkspaceCommand();
  const allowed = useAtomValue(serverEnvironment.workspaceCommand.permissionAtom(environmentId));
  const [draft, setDraft] = useWorkspaceTabValue(
    `workspace.reply.${JSON.stringify([environmentId, request.id])}`,
    "",
    Schema.String,
  );
  const delivery = useDelivery();
  const error = delivery.error || request.deliveryError;
  const [closing, setClosing] = useState(false);
  const [reason, setReason] = useState("");
  const text = request.status === "delivering" ? (request.response ?? draft) : draft;
  return (
    <section className="space-y-2 rounded-lg border border-border bg-card p-3 text-sm">
      <div className="flex justify-between gap-2 text-xs text-muted-foreground">
        <span className="capitalize">
          {request.kind} · {source}
        </span>
        <time dateTime={request.createdAt}>{sourceTime(request.createdAt)}</time>
      </div>
      <p className="whitespace-pre-wrap font-medium">{request.prompt}</p>
      {request.context && (
        <p className="whitespace-pre-wrap text-muted-foreground">{request.context}</p>
      )}
      {request.status === "open" || request.status === "delivering" ? (
        <form
          className="space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (!allowed || !connected || !text.trim()) return;
            void delivery.submit(async () => {
              await run(environmentId, {
                type: "respond",
                requestId: request.id,
                response: text.trim(),
              });
              setDraft("");
            });
          }}
        >
          {request.choices.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {request.choices.map((choice) => (
                <Button
                  type="button"
                  variant="outline"
                  size="compact"
                  key={choice}
                  disabled={request.status !== "open" || delivery.busy || !allowed}
                  onClick={() => setDraft(choice)}
                >
                  {choice}
                </Button>
              ))}
            </div>
          )}
          <label className="grid gap-1 text-xs">
            Reply to {source}
            <Textarea
              value={text}
              disabled={delivery.busy || request.status === "delivering" || !allowed || !connected}
              onChange={(e) => setDraft(e.target.value)}
            />
          </label>
          <Button
            size="sm"
            type="submit"
            disabled={delivery.busy || !allowed || !connected || !text.trim()}
          >
            {delivery.busy
              ? "Sending…"
              : request.status === "delivering"
                ? "Retry delivery"
                : "Send answer"}
          </Button>
          {request.status === "delivering" && (
            <span role="status" className="ml-2 text-xs">
              Delivery pending
            </span>
          )}
        </form>
      ) : (
        <p className="text-xs">
          <strong>{request.status === "accepted" ? "Answer delivered" : "Request obsolete"}</strong>{" "}
          · {request.response}{" "}
          {request.resolvedAt && (
            <time dateTime={request.resolvedAt}>{sourceTime(request.resolvedAt)}</time>
          )}
        </p>
      )}
      {(request.status === "open" || request.status === "delivering") &&
        (closing ? (
          <form
            className="grid gap-2 border-t border-border pt-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (!allowed || !connected || !reason.trim()) return;
              void delivery.submit(() =>
                run(environmentId, {
                  type: "obsolete",
                  requestId: request.id,
                  reason: reason.trim(),
                }),
              );
            }}
          >
            <label className="grid gap-1 text-xs">
              Why is this request obsolete?
              <Input required value={reason} onChange={(event) => setReason(event.target.value)} />
            </label>
            <div className="flex gap-2">
              <Button
                type="submit"
                variant="outline"
                size="sm"
                disabled={!allowed || !connected || delivery.busy || !reason.trim()}
              >
                Mark obsolete
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={() => setClosing(false)}>
                Cancel
              </Button>
            </div>
          </form>
        ) : (
          <Button
            size="compact"
            variant="ghost-muted"
            type="button"
            disabled={!allowed || !connected || delivery.busy}
            onClick={() => setClosing(true)}
          >
            Close request…
          </Button>
        ))}
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}

export function ItemCreate({
  state,
  onCreate,
  global,
}: {
  state: WorkspaceState;
  onCreate: (environmentId: EnvironmentId, itemId: string | null, threadId: ThreadId) => void;
  global: boolean;
}) {
  const availability = state.hosts.filter((host) => host.connected && host.snapshot);
  const [hostId, setHostId] = useState("");
  const host = availability.find((entry) => entry.environmentId === hostId) ?? availability[0];
  if (!host)
    return (
      <p className="p-4 text-sm text-muted-foreground">
        Connect to a workspace server to continue.
      </p>
    );
  return (
    <div className="space-y-3 p-4">
      {availability.length > 1 && (
        <label className="grid gap-1 text-xs">
          Environment
          <select
            className={field}
            value={host.environmentId}
            onChange={(e) => setHostId(e.target.value)}
          >
            {availability.map((env) => (
              <option key={env.environmentId} value={env.environmentId}>
                {env.label}
              </option>
            ))}
          </select>
        </label>
      )}
      <HostCreate
        key={JSON.stringify([host.environmentId, global])}
        state={state}
        environmentId={host.environmentId}
        global={global}
        onCreate={onCreate}
      />
    </div>
  );
}

const stageSchema = Schema.Literals(stages);

function HostCreate({
  state,
  environmentId,
  global,
  onCreate,
}: Parameters<typeof ItemCreate>[0] & { environmentId: EnvironmentId }) {
  const run = useWorkspaceCommand();
  const allowed = useAtomValue(serverEnvironment.workspaceCommand.permissionAtom(environmentId));
  const [newItemId] = useState(randomUUID);
  const prefix = JSON.stringify([environmentId, global]);
  const [id, setId] = useWorkspaceTabValue(`new.${prefix}.thread`, "", Schema.String);
  const [title, setTitle] = useWorkspaceTabValue(`new.${prefix}.title`, "", Schema.String);
  const [scope, setScope] = useWorkspaceTabValue(`new.${prefix}.scope`, "", Schema.String);
  const [stage, setStage] = useWorkspaceTabValue(`new.${prefix}.stage`, "backlog", stageSchema);
  const sessions = state.shells.filter(
    (shell) =>
      shell.environmentId === environmentId &&
      !shell.archivedAt &&
      !shell.deletedAt &&
      (global ||
        !state.items.some(
          (entry) => entry.environmentId === environmentId && itemHasThread(entry.item, shell.id),
        )),
  );
  const source = sessions.find((shell) => shell.id === id);
  const delivery = useDelivery();
  return (
    <form
      className="grid gap-3 text-sm"
      onSubmit={(event) => {
        event.preventDefault();
        if (!source || !allowed || (!global && !title.trim())) return;
        void delivery.submit(async () => {
          const itemId = global ? null : newItemId;
          await run(
            environmentId,
            itemId
              ? {
                  type: "create",
                  itemId,
                  title: title.trim(),
                  scope: scope.trim(),
                  stage,
                  primaryThreadId: source.id,
                }
              : { type: "orchestrator", threadId: source.id },
          );
          setId("");
          setTitle("");
          setScope("");
          setStage("backlog");
          onCreate(environmentId, itemId, source.id);
        });
      }}
    >
      <label className="grid gap-1 text-xs">
        {global ? "Orchestrator session" : "Primary conversation"}
        <select className={field} required value={id} onChange={(e) => setId(e.target.value)}>
          <option value="">Select a session</option>
          {sessions.map((shell) => (
            <option key={shell.id} value={shell.id}>
              {shell.title}
            </option>
          ))}
        </select>
      </label>
      {!sessions.length && (
        <p className="text-muted-foreground">
          Start a session from the sidebar, then select it here.
        </p>
      )}
      {!global && (
        <>
          <label className="grid gap-1 text-xs">
            Work item title
            <Input required value={title} onChange={(e) => setTitle(e.target.value)} />
          </label>
          <label className="grid gap-1 text-xs">
            Scope
            <Textarea value={scope} onChange={(e) => setScope(e.target.value)} />
          </label>
          <label className="grid gap-1 text-xs">
            Stage
            <select
              className={field}
              value={stage}
              onChange={(e) => {
                const match = stages.find((s) => s === e.target.value);
                if (match) setStage(match);
              }}
            >
              {stages.map((s) => (
                <option value={s} key={s}>
                  {stageLabel[s]}
                </option>
              ))}
            </select>
          </label>
        </>
      )}
      <div>
        <Button
          disabled={!allowed || delivery.busy || !source || (!global && !title.trim())}
          type="submit"
        >
          {delivery.busy ? "Saving…" : global ? "Set orchestrator" : "Create work item"}
        </Button>
      </div>
      {delivery.error && (
        <p role="alert" className="text-destructive">
          {delivery.error}
        </p>
      )}
    </form>
  );
}
