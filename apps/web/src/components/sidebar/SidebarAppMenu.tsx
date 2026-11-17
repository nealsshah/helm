import { WorkspaceModelDefaults } from "./WorkspaceModelDefaults";
import { Link } from "@tanstack/react-router";
import { ChartNoAxesColumnIcon, SettingsIcon, SlidersHorizontalIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { useSidebar } from "../ui/sidebar";

export function SidebarAppMenu({ variant = "ghost" }: { variant?: "ghost" | "glass" }) {
  const [open, setOpen] = useState(false);
  const [defaultsOpen, setDefaultsOpen] = useState(false);
  const { isMobile, setOpenMobile } = useSidebar();
  function close() {
    setOpen(false);
    if (isMobile) setOpenMobile(false);
  }
  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          openOnHover
          delay={100}
          closeDelay={150}
          render={<Button variant={variant} size="icon-sm" aria-label="App menu" />}
        >
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
          >
            <path
              d="M5 6h14"
              className="motion-safe:transition-transform motion-safe:duration-180 motion-safe:ease-out"
              style={{
                transformOrigin: "12px 6px",
                transform: open ? "translateY(6px) rotate(45deg)" : "none",
              }}
            />
            <path
              d="M5 12h14"
              className="motion-safe:transition-opacity motion-safe:duration-180"
              opacity={open ? 0 : 1}
            />
            <path
              d="M5 18h14"
              className="motion-safe:transition-transform motion-safe:duration-180 motion-safe:ease-out"
              style={{
                transformOrigin: "12px 18px",
                transform: open ? "translateY(-6px) rotate(-45deg)" : "none",
              }}
            />
          </svg>
        </PopoverTrigger>
        <PopoverPopup side="top" align="start" padding="none" aria-label="App menu">
          <nav aria-label="App options" className="grid w-44 gap-0.5 p-1">
            <Link
              to="/settings/general"
              onClick={close}
              className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
            >
              <SettingsIcon aria-hidden="true" className="size-4 text-muted-foreground" />
              Settings
            </Link>
            <Link
              to="/usage"
              onClick={close}
              className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
            >
              <ChartNoAxesColumnIcon aria-hidden="true" className="size-4 text-muted-foreground" />
              Usage
            </Link>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                setDefaultsOpen(true);
              }}
              className="flex items-center gap-2 whitespace-nowrap rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
            >
              <SlidersHorizontalIcon aria-hidden="true" className="size-4 text-muted-foreground" />
              Default models
            </button>
          </nav>
        </PopoverPopup>
      </Popover>
      {defaultsOpen && (
        <WorkspaceModelDefaults open={defaultsOpen} onOpenChange={setDefaultsOpen} />
      )}
    </>
  );
}
