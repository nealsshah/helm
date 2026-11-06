import type { ThreadId } from "@t3tools/contracts";
import { MessageSquareIcon, XIcon } from "lucide-react";
import { useRef } from "react";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

interface SessionTab {
  id: ThreadId;
  title: string;
  description?: string;
}

export function SessionTabs({
  label,
  tabs,
  selected,
  onSelect,
  onClose,
  closeDisabled,
}: {
  label: string;
  tabs: readonly SessionTab[];
  selected: ThreadId | undefined;
  onSelect: (id: ThreadId) => void;
  onClose?: (id: ThreadId) => void;
  closeDisabled?: boolean;
}) {
  const list = useRef<HTMLDivElement>(null);
  const focusable = tabs.find((tab) => tab.id === selected)?.id ?? tabs[0]?.id;
  return (
    <div
      ref={list}
      role="tablist"
      aria-label={label}
      className="flex min-w-0 gap-1 overflow-x-auto overscroll-x-contain py-1"
    >
      {tabs.map(({ id, title, description }, index) => {
        const active = id === selected;
        return (
          <div
            key={id}
            className={cn(
              "flex shrink-0 items-center rounded-md",
              active
                ? "bg-background text-foreground shadow-xs ring-1 ring-inset ring-border/75"
                : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    role="tab"
                    aria-selected={active}
                    tabIndex={id === focusable ? 0 : -1}
                    ref={(node) => {
                      if (active) node?.scrollIntoView({ block: "nearest", inline: "nearest" });
                    }}
                    onClick={() => onSelect(id)}
                    onKeyDown={(event) => {
                      let next;
                      switch (event.key) {
                        case "ArrowRight":
                          next = (index + 1) % tabs.length;
                          break;
                        case "ArrowLeft":
                          next = (index + tabs.length - 1) % tabs.length;
                          break;
                        case "Home":
                          next = 0;
                          break;
                        case "End":
                          next = tabs.length - 1;
                          break;
                        default:
                          return;
                      }
                      event.preventDefault();
                      list.current
                        ?.querySelectorAll<HTMLButtonElement>('[role="tab"]')
                        [next]?.focus();
                      onSelect(tabs[next]!.id);
                    }}
                    className="flex h-8 max-w-44 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                  />
                }
              >
                <MessageSquareIcon aria-hidden="true" className="size-3.5 shrink-0" />
                <span className="truncate">{title}</span>
              </TooltipTrigger>
              <TooltipPopup>{description ?? title}</TooltipPopup>
            </Tooltip>
            {active && onClose && (
              <span className="pr-1">
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`Close tab ${title}`}
                  disabled={closeDisabled}
                  onClick={() => onClose(id)}
                >
                  <XIcon />
                </Button>
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
