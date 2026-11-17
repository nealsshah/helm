import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { CheckIcon } from "lucide-react";
import type { ComponentProps } from "react";
import { ensureLocalApi } from "../../localApi";
import { observeVisibleAnimation } from "../../lib/visibleAnimation";
import { cn } from "../../lib/utils";
import { serverEnvironment } from "../../state/server";
import { Button } from "../ui/button";
import type { BoardItem } from "./workspaceModel";

export function TaskCardButton({
  entry,
  environmentId,
  retirement,
  retiring = false,
  unreadCompletion = false,
  onRetire,
  onOpen,
  children,
  className,
  ...props
}: ComponentProps<"button"> & {
  entry: BoardItem | undefined;
  environmentId: EnvironmentId;
  retirement: boolean;
  retiring?: boolean;
  unreadCompletion?: boolean;
  onRetire: (entry: BoardItem) => void;
  onOpen: () => void;
}) {
  const allowed = useAtomValue(serverEnvironment.workspaceCommand.permissionAtom(environmentId));
  const available = entry && retirement && allowed && !retiring;
  const done = entry && retirement && allowed && entry.item.stage === "complete";
  async function menu(x: number, y: number) {
    if (!available) return;
    const action = await ensureLocalApi().contextMenu.show(
      [{ id: "retire", label: "Retire task", icon: "check" }],
      { x, y },
    );
    if (action === "retire") onRetire(entry);
  }

  return (
    <div
      className={cn(
        "relative flex w-full min-w-0",
        retiring && "pointer-events-none opacity-50 grayscale",
      )}
      aria-busy={retiring}
    >
      <button
        {...props}
        type="button"
        disabled={props.disabled || retiring}
        className={cn("relative", className, done && "pr-10")}
        aria-description={
          props["aria-description"] ??
          (unreadCompletion ? "Newly completed task. Open to mark as seen." : undefined)
        }
        onClick={onOpen}
        onContextMenu={(event) => {
          if (!available) return;
          event.preventDefault();
          void menu(event.clientX, event.clientY);
        }}
        onKeyDown={(event) => {
          if (
            !available ||
            !(event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))
          )
            return;
          event.preventDefault();
          const bounds = event.currentTarget.getBoundingClientRect();
          void menu(bounds.left, bounds.bottom);
        }}
      >
        {unreadCompletion && (
          <span
            aria-hidden="true"
            ref={observeVisibleAnimation}
            className="workspace-completion-pulse"
          />
        )}
        {children}
      </button>
      {done && (
        <span className="absolute right-1.5 top-1.5">
          <Button
            disabled={retiring}
            size="icon-xs"
            variant="ghost"
            aria-label={`Retire ${entry.item.title}`}
            title="Retire task"
            onClick={() => onRetire(entry)}
          >
            <CheckIcon />
          </Button>
        </span>
      )}
    </div>
  );
}
