import { type CSSProperties, type ReactNode, useState } from "react";
import { RESIZABLE_WIDTH_PROPERTY, useResizableWidth } from "~/hooks/useResizableWidth";
import { observeResize } from "~/lib/observeResize";
import { RightPanelResizeHandle } from "../preview/RightPanelResizeHandle";

const CHAT_MIN_WIDTH = 360;
const BOARD_MIN_WIDTH = 320;

export function WorkspaceSidePane({ children }: { children: ReactNode }) {
  const [rowWidth, setRowWidth] = useState<number | null>(null);
  const measureRow = (panel: HTMLDivElement | null) => {
    const row = panel?.parentElement;
    if (!row) return;
    const measure = () => setRowWidth(row.clientWidth);
    measure();
    return observeResize(row, measure);
  };
  // Read the saved preference before constraining it to this window's available space.
  const maxWidth =
    rowWidth === null
      ? Number.MAX_SAFE_INTEGER
      : Math.max(CHAT_MIN_WIDTH, rowWidth - BOARD_MIN_WIDTH);
  const { width, setWidth, handlers } = useResizableWidth({
    storageKey: "helm.workspace.panel-width",
    defaultWidth: rowWidth === null ? 480 : Math.round(rowWidth * 0.45),
    minWidth: CHAT_MIN_WIDTH,
    maxWidth,
    edge: "left",
  });

  return (
    <div
      ref={measureRow}
      className="relative grid min-h-0 min-w-0 w-full shrink-0 grid-cols-1 grid-rows-1 @3xl/workspace:w-(--resizable-width)"
      style={{ [RESIZABLE_WIDTH_PROPERTY]: `${width}px` } as CSSProperties}
    >
      <RightPanelResizeHandle
        handlers={handlers}
        className="hidden touch-none after:absolute after:top-1/2 after:left-1/2 after:h-8 after:w-1 after:-translate-x-1/2 after:-translate-y-1/2 after:rounded-full after:bg-border hover:after:bg-muted-foreground focus-visible:after:bg-primary @3xl/workspace:block"
        label="Resize workspace chat"
        tabIndex={0}
        aria-valuemin={CHAT_MIN_WIDTH}
        aria-valuemax={maxWidth}
        aria-valuenow={width}
        onKeyDown={(event) => {
          if (event.altKey || event.ctrlKey || event.metaKey) return;
          switch (event.key) {
            case "ArrowLeft":
              setWidth(width + 16);
              break;
            case "ArrowRight":
              setWidth(width - 16);
              break;
            case "Home":
              setWidth(CHAT_MIN_WIDTH);
              break;
            case "End":
              setWidth(maxWidth);
              break;
            default:
              return;
          }
          event.preventDefault();
          event.stopPropagation();
        }}
      />
      {children}
    </div>
  );
}
