import { expect, it } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "../../../test/render";
import { SidebarProvider } from "../ui/sidebar";
import { SidebarAppMenu } from "./SidebarAppMenu";

it("opens on hover, closes on Escape, and navigates from its labeled options", async () => {
  await using screen = await render(
    <SidebarProvider>
      <SidebarAppMenu />
    </SidebarProvider>,
    { router: "/workspace" },
  );
  const trigger = screen.getByRole("button", { name: "App menu", exact: true });
  await userEvent.hover(trigger);
  await expect.element(page.getByRole("link", { name: "Settings", exact: true })).toBeVisible();
  await expect.element(trigger).toHaveAttribute("aria-expanded", "true");
  await userEvent.keyboard("{Escape}");
  await expect.element(trigger).toHaveAttribute("aria-expanded", "false");
  await trigger.click();
  await page.getByRole("link", { name: "Usage", exact: true }).click();
  await expect.element(trigger).toHaveAttribute("aria-expanded", "false");
  await trigger.click();
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await expect.element(trigger).toHaveAttribute("aria-expanded", "false");
  await trigger.click();
  await page.getByRole("button", { name: "Default models", exact: true }).click();
  await expect
    .element(page.getByRole("dialog", { name: "Default models", exact: true }))
    .toBeVisible();
});
