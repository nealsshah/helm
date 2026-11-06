import { createMemoryHistory } from "@tanstack/react-router";
import { RuntimeRequestId, NodeId, type WorkItem } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { AppRoot } from "~/AppRoot";
import "../ChatView";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { getRouter } from "~/router";
import { useRightPanelStore } from "~/rightPanelStore";
import {
  ENVIRONMENT_ID,
  installFakeEnvironment,
  threadWithHistory,
  type FakeDriver,
  type FakeThread,
} from "../../../test/fakeEnvironment";
import { render } from "../../../test/render";

vi.mock(
  "../../../../../packages/client-runtime/src/connection/driver.ts",
  async (importOriginal) => {
    const [actual, { fakeDriver }, Layer] = await Promise.all([
      importOriginal<{ readonly ConnectionDriver: Context.Key<unknown, FakeDriver> }>(),
      import("../../../test/fakeEnvironment"),
      import("effect/Layer"),
    ]);
    return { ...actual, layer: Layer.succeed(actual.ConnectionDriver, fakeDriver) };
  },
);

it("keeps a work conversation editable with a maximized full-session panel and restores distinct drafts", async () => {
  const previous = { width: window.innerWidth, height: window.innerHeight };
  await page.viewport(1440, 900);
  await using _viewport = {
    [Symbol.asyncDispose]: () => page.viewport(previous.width, previous.height),
  };
  const first = threadWithHistory("shape-sample", 1),
    second = threadWithHistory("implement-sample", 1);
  const time = "2026-11-06T20:00:00Z";
  const archivedWorker: FakeThread = {
    ...threadWithHistory("archived-worker", 1),
    archived: true,
    runtimeRequests: [
      {
        id: RuntimeRequestId.make("archived-approval"),
        nodeId: NodeId.make("archived-node"),
        providerTurnId: null,
        nativeRequestRef: null,
        kind: "command",
        status: "pending",
        responseCapability: { type: "not_resumable", reason: "Process ended" },
        createdAt: DateTime.makeUnsafe(time),
        resolvedAt: null,
      },
    ],
  };
  const base = {
    scope: "",
    attention: "none",
    priority: 0,
    decisions: [],
    artifacts: [],
    sessions: [],
    dependencies: [],
    latestReport: null,
    createdAt: time,
    updatedAt: time,
  } as const;
  const items: WorkItem[] = [
    {
      ...base,
      id: "sample-a",
      title: "Shape checkout",
      primaryThreadId: first.id,
      sessions: [{ threadId: archivedWorker.id, role: "Previous worker" }],
      stage: "planning",
    },
    {
      ...base,
      id: "sample-b",
      title: "Implement checkout",
      primaryThreadId: second.id,
      stage: "building",
    },
  ];
  using _env = installFakeEnvironment([first, second, archivedWorker], {
    items,
    requests: [],
    orchestratorThreadIds: [first.id, second.id],
  });
  __setClientSettingsForTests({ ...DEFAULT_CLIENT_SETTINGS, onboardingCompletedAt: time });
  const ref = { environmentId: ENVIRONMENT_ID, threadId: first.id };
  useRightPanelStore.getState().open(ref, "diff");
  useRightPanelStore.getState().setMaximized(ref, true);
  const router = getRouter(createMemoryHistory({ initialEntries: ["/workspace"] }));
  await router.load();
  await using screen = await render(<AppRoot router={router} />, { router: false });
  const board = screen.getByRole("region", { name: "Workspace overview" });
  await board
    .getByRole("region", { name: "Needs me" })
    .getByRole("button", { name: "Thread archived-worker", exact: true })
    .click();
  const conversation = screen.getByRole("tab", { name: archivedWorker.title, exact: true });
  await expect.element(conversation).toHaveAttribute("aria-selected", "true");
  await conversation.click();
  await userEvent.keyboard("{Home}");
  await expect
    .element(screen.getByRole("tab", { name: first.title }))
    .toHaveAttribute("aria-selected", "true");
  const editor = screen.getByTestId("composer-editor");
  await expect.element(editor).toBeVisible();
  await editor.fill("Unsent shaping direction");
  await board.getByRole("region", { name: "Building" }).getByRole("button").click();
  await expect
    .element(screen.getByText("To Work conversation · Thread implement-sample"))
    .toBeVisible();
  await editor.fill("Unsent implementation direction");
  await board
    .getByRole("region", { name: "Needs me" })
    .getByRole("button", { name: "Thread archived-worker", exact: true })
    .click();
  await expect.element(conversation).toHaveAttribute("aria-selected", "true");
  await screen.getByRole("tab", { name: first.title }).click();
  await expect.element(editor).toHaveTextContent("Unsent shaping direction");
  await board.getByRole("region", { name: "Building" }).getByRole("button").click();
  await expect.element(editor).toHaveTextContent("Unsent implementation direction");
  await screen.getByRole("link", { name: "Open full session" }).click();
  await expect
    .element(screen.getByRole("complementary", { name: "Work panel" }))
    .not.toBeInTheDocument();
  await screen.getByRole("link", { name: /^Workspace/ }).click();
  await expect
    .element(screen.getByText("To Work conversation · Thread implement-sample"))
    .toBeVisible();
  await expect.element(editor).toHaveTextContent("Unsent implementation direction");
  await expect
    .element(board.getByRole("button", { name: "Thread archived-worker", exact: true }))
    .toBeVisible();
  await screen.getByRole("button", { name: "Orchestrator", exact: true }).click();
  await screen.getByRole("tab", { name: first.title }).click();
  await expect.element(editor).toHaveTextContent("Unsent shaping direction");
  await screen.getByRole("tab", { name: second.title }).click();
  await expect.element(editor).toHaveTextContent("Unsent implementation direction");
});
