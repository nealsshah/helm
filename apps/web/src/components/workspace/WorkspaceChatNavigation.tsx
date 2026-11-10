import { Link, useLocation } from "@tanstack/react-router";
import { ArrowLeftIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "../ui/button";

declare module "@tanstack/react-router" {
  interface HistoryState {
    fromWorkspace?: boolean;
  }
}

export function WorkspaceChatNavigation({ children }: { children?: ReactNode }) {
  const fromWorkspace = useLocation({ select: (location) => location.state.fromWorkspace });
  return fromWorkspace ? (
    <Button
      variant="ghost"
      size="sm"
      render={<Link to="/workspace" />}
      aria-label="Back to workspace"
    >
      <ArrowLeftIcon /> Workspace
    </Button>
  ) : (
    children
  );
}
