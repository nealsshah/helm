import type { ComponentProps } from "react";
import type { ResizableWidthHandlers } from "~/hooks/useResizableWidth";
import { cn } from "~/lib/utils";

interface Props extends Pick<
  ComponentProps<"div">,
  "tabIndex" | "onKeyDown" | "aria-valuenow" | "aria-valuemin" | "aria-valuemax"
> {
  handlers: ResizableWidthHandlers;
  className?: string;
  label?: string;
  variant?: "line" | "grip";
}

export function RightPanelResizeHandle({
  handlers,
  className,
  label,
  variant = "line",
  ...separatorProps
}: Props) {
  return (
    <div
      role="separator"
      aria-label={label}
      aria-orientation="vertical"
      {...separatorProps}
      className={cn(
        "group absolute inset-y-0 z-20 cursor-col-resize select-none",
        variant === "line"
          ? "-left-1 w-2"
          : "right-[calc(100%+1px)] w-(--workspace-split-gap) items-center justify-center outline-none",
        className,
      )}
      {...handlers}
    >
      <span
        aria-hidden
        className={
          variant === "line"
            ? "pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-transparent transition-colors duration-150 group-hover:bg-border group-focus-visible:bg-primary/60 group-active:bg-primary/60"
            : "pointer-events-none h-8 w-1 rounded-full bg-muted-foreground/30 group-hover:bg-muted-foreground/65 group-focus-visible:bg-ring group-active:scale-y-110 motion-safe:transition-[background-color,scale] motion-safe:duration-200 motion-safe:ease-workspace-resize"
        }
      />
    </div>
  );
}
