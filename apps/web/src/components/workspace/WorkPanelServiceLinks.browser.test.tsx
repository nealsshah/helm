import "../../index.css";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "../../../test/render";
import { WorkPanelServiceLinks } from "./WorkPanelServiceLinks";

const { openExternal } = vi.hoisted(() => ({ openExternal: vi.fn() }));
vi.mock("../../localApi", () => ({ ensureLocalApi: () => ({ shell: { openExternal } }) }));

it("opens a single associated link externally without a menu", async () => {
  openExternal.mockReset();
  await using screen = await render(
    <WorkPanelServiceLinks
      service="Linear"
      links={[{ url: "https://linear.app/acme/issue/acme-123", label: "ACME-123 · Checkout" }]}
    />,
  );
  await screen.getByRole("button", { name: "Open in Linear" }).click();
  expect(openExternal).toHaveBeenCalledExactlyOnceWith("https://linear.app/acme/issue/acme-123");
  await expect.element(page.getByRole("menu")).not.toBeInTheDocument();
});

it("opens the selected PR from a multiple-link menu and hides empty services", async () => {
  openExternal.mockReset();
  await using screen = await render(
    <>
      <WorkPanelServiceLinks service="Linear" links={[]} />
      <WorkPanelServiceLinks
        service="GitHub"
        links={[
          { url: "https://github.com/acme/app/pull/12", label: "acme/app#12 · Checkout" },
          { url: "https://github.com/acme/app/pull/13", label: "acme/app#13 · Receipts" },
        ]}
      />
    </>,
  );
  await expect.element(screen.getByRole("button", { name: /Linear/ })).not.toBeInTheDocument();
  await screen.getByRole("button", { name: "GitHub links" }).click();
  expect(openExternal).not.toHaveBeenCalled();
  await page.getByRole("menuitem", { name: "acme/app#13 · Receipts" }).click();
  expect(openExternal).toHaveBeenCalledExactlyOnceWith("https://github.com/acme/app/pull/13");
});
