import { type CSSProperties, type ReactNode, useState } from "react";
import { RESIZABLE_WIDTH_PROPERTY, useResizableWidth } from "~/hooks/useResizableWidth";
import { usePanelAnimationSettings, usePanelPresence } from "~/panelAnimations";
import { observeResize } from "~/lib/observeResize";
import { RightPanelResizeHandle } from "../preview/RightPanelResizeHandle";

const CHAT_MIN_WIDTH = 360;
const BOARD_MIN_WIDTH = 320;

export function WorkspaceSidePane({ open, children }: { open: boolean; children: ReactNode }) {
  const { active, durationMs } = usePanelAnimationSettings();
  const pane = usePanelPresence(open, children, active, null, durationMs);
  const [rowWidth, setRowWidth] = useState<number | null>(null);
  const measureRow = (panel: HTMLDivElement | null) => {
    if (!panel?.parentElement) return;
    const row = panel.parentElement;
    const measure = () =>
      setRowWidth(row.clientWidth - parseFloat(getComputedStyle(panel).columnGap));
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
      inert={!open}
      data-open={open}
      className="absolute inset-y-0 right-0 w-full gap-(--workspace-split-gap) translate-x-full data-[open=true]:translate-x-0 [[data-panel-animations=true]_&]:transition-[translate] [[data-panel-animations=true]_&]:duration-(--panel-animation-duration) [[data-panel-animations=true]_&]:ease-out @3xl/workspace:relative @3xl/workspace:w-0 @3xl/workspace:shrink-0 @3xl/workspace:translate-x-0 @3xl/workspace:data-[open=true]:w-[calc(var(--resizable-width)+var(--workspace-split-gap))] @3xl/workspace:[[data-panel-animations=true]_&]:transition-[width]"
      style={{ [RESIZABLE_WIDTH_PROPERTY]: `${width}px` } as CSSProperties}
    >
      {pane.present && (
        <>
          <RightPanelResizeHandle
            handlers={handlers}
            variant="grip"
            className="left-0 right-auto hidden touch-none @3xl/workspace:flex"
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
          <div className="relative grid h-full w-full min-w-0 grid-rows-1 rounded-2xl border border-border/70 bg-background shadow-xs @3xl/workspace:ml-(--workspace-split-gap) @3xl/workspace:w-(--resizable-width)">
            <div className="grid min-h-0 min-w-0 overflow-hidden rounded-[inherit]">
              {pane.value}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
