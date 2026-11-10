import { DEFAULT_CLIENT_SETTINGS, EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../test/render";
import { openCommandPalette } from "../commandPaletteBus";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { __setClientSettingsForTests, getClientSettings } from "../hooks/useSettings";
import { useProjects, useQuietThreadShells } from "../state/entities";
import type { Project } from "../types";
import { makeThreadFixture } from "../test-fixtures";
import { AppSidebarLayout } from "./AppSidebarLayout";
import { THREAD_SIDEBAR_WIDTH_STORAGE_KEY } from "./threadSidebarWidth";
import Sidebar from "./Sidebar";
import { SidebarProvider } from "./ui/sidebar";

vi.mock("../state/entities", { spy: true });
vi.mock("../hooks/useHandleNewThread", { spy: true });
vi.mock("../commandPaletteBus", () => ({
  openCommandPalette: vi.fn(),
  isCommandPaletteOpen: () => false,
}));
vi.mock("./sidebar/SidebarChrome", () => ({
  SidebarBrandWidthProbe: () => null,
  SidebarChromeHeader: () => null,
  SidebarChromeFooter: () => null,
}));

function project(id: string): Project {
  return {
    id: ProjectId.make(id),
    environmentId: EnvironmentId.make("local"),
    title: id,
    workspaceRoot: `/projects/${id}`,
    repositoryIdentity: null,
    defaultModelSelection: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    scripts: [],
  };
}

describe("sidebar header new thread", () => {
  it.each([
    { mode: "normal", count: 2, shift: false, picker: true },
    { mode: "boring", count: 2, shift: false, picker: true },
    { mode: "boring", count: 2, shift: true, picker: false },
    { mode: "boring", count: 1, shift: false, picker: false },
    { mode: "legacy", count: 2, shift: false, picker: false },
  ] as const)("$mode sidebar, $count projects, shift=$shift: picker=$picker", async (scenario) => {
    using stack = new DisposableStack();
    const previousSettings = getClientSettings();
    stack.defer(() => __setClientSettingsForTests(previousSettings));
    __setClientSettingsForTests({
      ...DEFAULT_CLIENT_SETTINGS,
      boringSidebarEnabled: scenario.mode === "boring",
      legacySidebarEnabled: scenario.mode === "legacy",
    });
    const projects = [project("active"), project("idle")].slice(0, scenario.count);
    const currentProjectRef = {
      environmentId: projects[0]!.environmentId,
      projectId: projects[0]!.id,
    };
    const startThread = vi.fn().mockResolvedValue(null);
    vi.mocked(useProjects).mockReturnValue(projects);
    vi.mocked(useHandleNewThread).mockReturnValue({
      activeDraftThread: null,
      activeThread: null,
      defaultProjectRef: currentProjectRef,
      handleNewThread: startThread,
      routeDraftId: null,
      routeThreadRef: null,
    });
    vi.mocked(openCommandPalette).mockClear();
    await using screen = await render(
      <SidebarProvider>
        <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
      </SidebarProvider>,
    );

    await userEvent.click(screen.getByRole("button", { name: "New thread", exact: true }), {
      modifiers: scenario.shift ? ["Shift"] : [],
    });

    if (scenario.picker) {
      expect(openCommandPalette).toHaveBeenCalledExactlyOnceWith({ open: "new-thread-in" });
      expect(startThread).not.toHaveBeenCalled();
    } else {
      expect(openCommandPalette).not.toHaveBeenCalled();
      expect(startThread).toHaveBeenCalledExactlyOnceWith(currentProjectRef);
    }
  });
});

it("remembers an icon rail after dragging and keeps its sessions individually navigable", async () => {
  const previousViewport = { width: window.innerWidth, height: window.innerHeight };
  await page.viewport(1280, 800);
  await using _viewport = {
    [Symbol.asyncDispose]: () => page.viewport(previousViewport.width, previousViewport.height),
  };
  const key = THREAD_SIDEBAR_WIDTH_STORAGE_KEY;
  const saved = localStorage.getItem(key);
  using _restore = {
    [Symbol.dispose]: () =>
      saved === null ? localStorage.removeItem(key) : localStorage.setItem(key, saved),
  };
  localStorage.removeItem(key);
  const scope = project("active");
  vi.mocked(useProjects).mockReturnValue([scope]);
  vi.mocked(useHandleNewThread).mockReturnValue({
    activeDraftThread: null,
    activeThread: null,
    defaultProjectRef: { environmentId: scope.environmentId, projectId: scope.id },
    handleNewThread: vi.fn(),
    routeDraftId: null,
    routeThreadRef: null,
  });
  const thread = makeThreadFixture({
    id: ThreadId.make("review"),
    title: "Review checkout",
    projectId: scope.id,
    environmentId: scope.environmentId,
  });
  vi.mocked(useQuietThreadShells).mockReturnValue([thread]);
  using _threads = { [Symbol.dispose]: () => vi.mocked(useQuietThreadShells).mockRestore() };
  const layout = () => (
    <AppSidebarLayout>
      <main />
    </AppSidebarLayout>
  );
  await using screen = await render(layout());
  const divider = screen.getByRole("separator", { name: "Resize Sidebar" });
  const handle = divider.element();
  const pointer = { bubbles: true, cancelable: true, pointerId: 1, button: 0 };
  const bounds = handle.closest("[data-slot=sidebar-container]")!.getBoundingClientRect();
  handle.dispatchEvent(new PointerEvent("pointerdown", { ...pointer, clientX: bounds.right }));
  handle.dispatchEvent(new PointerEvent("pointerup", { ...pointer, clientX: bounds.left }));
  await expect.element(divider).toHaveAttribute("aria-valuetext", "Icons only");
  await screen.unmount();
  await using restored = await render(layout());
  const restoredDivider = restored.getByRole("separator", { name: "Resize Sidebar" });
  await expect.element(restoredDivider).toHaveAttribute("aria-valuetext", "Icons only");
  const icon = restored.getByRole("button", { name: "Review checkout", exact: true });
  await expect.element(icon).toBeVisible();
  await expect.element(icon).not.toHaveTextContent("Review checkout");
  const toggle = restored.getByRole("button", { name: "Toggle main sidebar" });
  await toggle.click();
  await expect.element(toggle).toHaveAttribute("aria-pressed", "false");
  expect(icon.element().closest("[inert]")).toBeTruthy();
  await toggle.click();
  await expect.element(icon).toBeVisible();
  const element = restoredDivider.element() as HTMLElement;
  element.focus();
  await userEvent.keyboard("{ArrowRight}");
  await expect.element(restored.getByRole("combobox", { name: "Search threads" })).toBeVisible();
  await userEvent.keyboard("{Home}");
  await icon.click();
  await vi.waitFor(() => expect(restored.router?.state.location.pathname).toBe("/local/review"));
});
