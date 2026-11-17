import { ensureLocalApi } from "../../localApi";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import type { WorkPanelLink } from "./workPanelLinks";

export function WorkPanelServiceLinks({
  service,
  links,
}: {
  service: "Linear" | "GitHub";
  links: readonly WorkPanelLink[];
}) {
  const first = links[0];
  if (!first) return null;
  const icon = (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      {service === "GitHub" ? (
        <path d="M12 .3a12 12 0 0 0-3.79 23.39c.6.11.82-.26.82-.58v-2.23c-3.34.73-4.04-1.42-4.04-1.42-.55-1.39-1.34-1.76-1.34-1.76-1.09-.75.08-.73.08-.73 1.21.08 1.84 1.24 1.84 1.24 1.07 1.83 2.81 1.3 3.49.99.11-.77.42-1.3.76-1.6-2.67-.3-5.47-1.34-5.47-5.93 0-1.31.47-2.38 1.24-3.22-.13-.3-.54-1.52.12-3.18 0 0 1.01-.32 3.3 1.23a11.5 11.5 0 0 1 6 0c2.29-1.55 3.3-1.23 3.3-1.23.66 1.66.25 2.88.12 3.18.77.84 1.24 1.91 1.24 3.22 0 4.6-2.81 5.62-5.49 5.92.43.37.82 1.1.82 2.22v3.3c0 .32.22.69.83.57A12 12 0 0 0 12 .3Z" />
      ) : (
        <path d="M3.03 4.3a12 12 0 0 0-1.02 1.48l16.2 16.2a12 12 0 0 0 1.49-1.01L3.03 4.3Zm-1.8 3.14c-.24.62-.44 1.27-.58 1.93l13.98 13.98a12 12 0 0 0 1.93-.58L1.23 7.44ZM.38 11.7a12 12 0 0 0 11.92 11.92L.38 11.7Zm4-8.67L20.97 19.6A12 12 0 0 0 4.38 3.03Z" />
      )}
    </svg>
  );
  const open = (url: string) => void ensureLocalApi().shell.openExternal(url);
  if (links.length === 1) {
    return (
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={`Open in ${service}`}
        title={first.label}
        onClick={() => open(first.url)}
      >
        {icon}
      </Button>
    );
  }
  return (
    <Menu>
      <MenuTrigger
        render={<Button variant="ghost" size="icon-sm" />}
        aria-label={`${service} links`}
      >
        {icon}
      </MenuTrigger>
      <MenuPopup align="end">
        {links.map((link) => (
          <MenuItem key={link.url} onClick={() => open(link.url)}>
            {link.label}
          </MenuItem>
        ))}
      </MenuPopup>
    </Menu>
  );
}
