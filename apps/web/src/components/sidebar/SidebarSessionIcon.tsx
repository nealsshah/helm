import type { ComponentProps, ReactNode } from "react";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export function SidebarSessionIcon({
  label,
  working,
  children,
  ...props
}: ComponentProps<"button"> & { label: string; working?: boolean; children: ReactNode }) {
  return (
    <li className="relative">
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label={label}
              aria-description={working ? "Working" : undefined}
              className="grid size-9 cursor-pointer place-items-center rounded-lg text-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring aria-[current=page]:bg-sidebar-row-hover aria-[current=page]:text-sidebar-foreground aria-[current=page]:ring-1 aria-[current=page]:ring-inset aria-[current=page]:ring-sidebar-border"
              {...props}
            />
          }
        >
          {children}
          {working && (
            <span
              aria-hidden="true"
              className="absolute right-1 bottom-1 size-1.5 rounded-full bg-info"
            />
          )}
        </TooltipTrigger>
        <TooltipPopup side="right">{label}</TooltipPopup>
      </Tooltip>
    </li>
  );
}
