import { createFileRoute } from "@tanstack/react-router";
import { VisualWorkspace } from "../components/workspace/VisualWorkspace";

export const Route = createFileRoute("/_chat/workspace")({ component: VisualWorkspace });
