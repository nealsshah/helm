import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { CheckIcon } from "lucide-react";
import { useEffect, useRef, type ComponentProps } from "react";
import { ensureLocalApi } from "../../localApi";
import { cn } from "../../lib/utils";
import { serverEnvironment } from "../../state/server";
import { Button } from "../ui/button";
import type { BoardItem } from "./workspaceModel";

export function TaskCardButton({
  entry,
  environmentId,
  retirement,
  panelOpen,
  onRetire,
  onOpen,
  children,
  className,
  ...props
}: ComponentProps<"button"> & {
  entry: BoardItem | undefined;
  environmentId: EnvironmentId;
  retirement: boolean;
  panelOpen: boolean;
  onRetire: (entry: BoardItem) => void;
  onOpen: () => void;
}) {
  const allowed = useAtomValue(serverEnvironment.workspaceCommand.permissionAtom(environmentId));
  const available = entry && retirement && allowed;
  const done = available && entry.item.stage === "complete";
  const pendingOpen = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- A removed card must cancel its pending navigation timer.
  useEffect(() => () => clearTimeout(pendingOpen.current), []);

  async function menu(x: number, y: number) {
    clearTimeout(pendingOpen.current);
    if (!available) return;
    const action = await ensureLocalApi().contextMenu.show(
      [{ id: "retire", label: "Retire task", icon: "check" }],
      { x, y },
    );
    if (action === "retire") onRetire(entry);
  }

  return (
    <div className="relative flex w-full min-w-0">
      <button
        {...props}
        type="button"
        className={cn(className, done && "pr-10")}
        onClick={(event) => {
          if (!available || done || event.detail === 0 || panelOpen) {
            onOpen();
            return;
          }
          // Opening the panel moves the card out from under a second click.
          clearTimeout(pendingOpen.current);
          if (event.detail === 1) pendingOpen.current = setTimeout(onOpen, 350);
        }}
        onDoubleClick={(event) => {
          if (available && !done) void menu(event.clientX, event.clientY);
        }}
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
        {children}
      </button>
      {done && (
        <span className="absolute right-1.5 top-1.5">
          <Button
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
