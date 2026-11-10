import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, WorkItem } from "@t3tools/contracts";
import { ArchiveRestoreIcon, HistoryIcon } from "lucide-react";
import { serverEnvironment } from "../../state/server";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { toastManager } from "../ui/toast";
import { useWorkspaceCommand, type WorkspaceState } from "./workspaceState";

function RestoreItem({
  item,
  environmentId,
  connected,
  hostLabel,
}: {
  item: WorkItem;
  environmentId: EnvironmentId;
  connected: boolean;
  hostLabel?: string | undefined;
}) {
  const command = useWorkspaceCommand();
  const allowed = useAtomValue(serverEnvironment.workspaceCommand.permissionAtom(environmentId));
  return (
    <MenuItem
      disabled={!connected || !allowed}
      onClick={() => {
        void command(environmentId, { type: "restore", itemId: item.id }).catch((error: unknown) =>
          toastManager.add({
            type: "error",
            title: "Couldn’t restore task",
            description: error instanceof Error ? error.message : "Try again.",
          }),
        );
      }}
    >
      <ArchiveRestoreIcon />
      <span className="min-w-0 truncate">
        Restore {item.title}
        {hostLabel && ` · ${hostLabel}`}
      </span>
    </MenuItem>
  );
}

export function RetiredTasksMenu({ hosts }: { hosts: WorkspaceState["hosts"] }) {
  const retired = hosts.flatMap((host) =>
    (host.snapshot?.items ?? [])
      .filter((item) => item.retiredAt && host.retirement)
      .map((item) => ({ item, host })),
  );
  if (!retired.length) return null;
  return (
    <Menu>
      <MenuTrigger
        aria-label="Retired tasks"
        title="Retired tasks"
        render={<Button variant="ghost" size="icon-sm" />}
      >
        <HistoryIcon />
      </MenuTrigger>
      <MenuPopup align="end">
        {retired
          .sort((left, right) => right.item.retiredAt!.localeCompare(left.item.retiredAt!))
          .map(({ item, host }) => (
            <RestoreItem
              key={JSON.stringify([host.environmentId, item.id])}
              item={item}
              environmentId={host.environmentId}
              connected={host.connected}
              hostLabel={hosts.length > 1 ? host.label : undefined}
            />
          ))}
      </MenuPopup>
    </Menu>
  );
}
