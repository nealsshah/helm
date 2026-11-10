import "../../index.css";
import { createMemoryHistory } from "@tanstack/react-router";
import { ProjectId, RuntimeRequestId, NodeId, type WorkItem } from "@t3tools/contracts";
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
  const first = threadWithHistory("shape-sample", 1);
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
  const askingWorker: FakeThread = {
    ...threadWithHistory("question-worker", 1),
    runtimeRequests: [
      {
        id: RuntimeRequestId.make("worker-input"),
        nodeId: NodeId.make("question-node"),
        providerTurnId: null,
        nativeRequestRef: null,
        kind: "user_input",
        status: "pending",
        responseCapability: { type: "message" },
        createdAt: DateTime.makeUnsafe(time),
        resolvedAt: null,
      },
    ],
  };
  const history = threadWithHistory("implement-sample", 2);
  const privateRun = history.runs[1]!.id;
  const second: FakeThread = {
    ...history,
    items: history.items.map((item) => {
      if (item.runId !== privateRun) return item;
      if (item.type === "user_message") {
        return {
          ...item,
          text: "The export worker is checking the layout.",
          createdBy: "agent",
          creationSource: "mcp",
          senderThreadId: askingWorker.id,
        };
      }
      if (item.type === "assistant_message")
        return { ...item, text: "Recorded the worker update." };
      return item;
    }),
  };
  const retiredWorker = {
    ...askingWorker,
    id: threadWithHistory("retired-worker", 1).id,
    title: "Retired worker",
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
      id: "retired",
      title: "Retired task",
      primaryThreadId: retiredWorker.id,
      retiredAt: time,
      stage: "qa",
    },
    {
      ...base,
      id: "sample-a",
      title: "Shape checkout",
      primaryThreadId: first.id,
      secondMateThreadId: first.id,
      sessions: [{ threadId: archivedWorker.id, role: "Previous worker" }],
      stage: "planning",
    },
    {
      ...base,
      id: "sample-b",
      title: "Implement checkout",
      primaryThreadId: second.id,
      secondMateThreadId: second.id,
      sessions: [{ threadId: askingWorker.id, role: "Worker" }],
      stage: "building",
    },
  ];
  using env = installFakeEnvironment(
    [first, second, archivedWorker, askingWorker, retiredWorker],
    {
      items,
      requests: [
        {
          id: "lead-question",
          itemId: "sample-a",
          threadId: first.id,
          kind: "question",
          prompt: "Which release should we target?",
          context: "",
          choices: [],
          status: "open",
          response: null,
          createdAt: time,
          resolvedAt: null,
        },
      ],
      orchestratorThreadIds: [first.id, second.id],
    },
    [{ id: ProjectId.make("meow"), title: "Meow", workspaceRoot: "/workspace/meow" }],
  );
  __setClientSettingsForTests({ ...DEFAULT_CLIENT_SETTINGS, onboardingCompletedAt: time });
  const ref = { environmentId: ENVIRONMENT_ID, threadId: first.id };
  useRightPanelStore.getState().open(ref, "diff");
  useRightPanelStore.getState().setMaximized(ref, true);
  const router = getRouter(createMemoryHistory({ initialEntries: ["/workspace"] }));
  await router.load();
  await using screen = await render(<AppRoot router={router} />, { router: false });
  const expectRole = async (role: string) => {
    const editor = screen.getByRole("textbox", { name: `Message ${role}` });
    await expect.element(editor).toBeVisible();
    const surface = editor.element().closest<HTMLElement>("[data-chat-composer-form]")!;
    await expect
      .element(page.elementLocator(surface).getByText(role, { exact: true }))
      .toBeVisible();
  };
  const board = screen.getByRole("region", { name: "Workspace overview" });
  await expect
    .element(
      board
        .getByRole("button", { name: "Shape checkout", exact: true })
        .getByRole("img", { name: "render" }),
    )
    .toBeVisible();
  await expect
    .element(board.getByRole("region", { name: "QA", exact: true }).getByText("Retired task"))
    .not.toBeInTheDocument();
  await expect
    .element(
      board
        .getByRole("region", { name: "Needs me" })
        .getByRole("button", { name: retiredWorker.title }),
    )
    .not.toBeInTheDocument();
  await screen.getByRole("button", { name: "Retired tasks" }).click();
  await expect.element(page.getByRole("menuitem", { name: "Restore Retired task" })).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect
    .element(board.getByRole("region", { name: "Building" }).getByText("Awaiting Second Mate"))
    .toBeVisible();
  await expect
    .element(
      board
        .getByRole("region", { name: "Needs me" })
        .getByRole("button", { name: askingWorker.title }),
    )
    .not.toBeInTheDocument();
  await board
    .getByRole("region", { name: "Needs me" })
    .getByRole("button", { name: "Thread archived-worker", exact: true })
    .click();
  await expectRole("Worker");
  await screen.getByRole("button", { name: "Second Mate" }).click();
  await expectRole("Second Mate");
  await board
    .getByRole("region", { name: "Needs me" })
    .getByRole("button", { name: "Shape checkout", exact: true })
    .click();
  await expectRole("Second Mate");
  const editor = screen.getByTestId("composer-editor");
  await expect.element(editor).toBeVisible();
  await editor.fill("Unsent shaping direction");
  await board.getByRole("region", { name: "Building" }).getByRole("button").click();
  await expectRole("Second Mate");
  await editor.fill("Unsent implementation direction");
  await board
    .getByRole("region", { name: "Needs me" })
    .getByRole("button", { name: "Thread archived-worker", exact: true })
    .click();
  await expectRole("Worker");
  await screen.getByRole("button", { name: "Second Mate" }).click();
  await expectRole("Second Mate");
  await expect.element(editor).toHaveTextContent("Unsent shaping direction");
  await board.getByRole("region", { name: "Building" }).getByRole("button").click();
  await expect.element(editor).toHaveTextContent("Unsent implementation direction");
  const coordination = screen.getByText("Recorded the worker update.");
  const directAnswer = screen.getByText("Answer 0 for implement-sample.");
  await expect.element(directAnswer).toBeVisible();
  await expect.element(coordination).not.toBeInTheDocument();
  await screen.getByRole("button", { name: /Workers \(1\)/ }).click();
  await page.getByRole("menuitemcheckbox", { name: "Show worker activity" }).click();
  await expect.element(coordination).toBeVisible();
  await screen.getByRole("link", { name: "Open full session" }).click();
  await expect
    .element(screen.getByRole("complementary", { name: "Work panel" }))
    .not.toBeInTheDocument();
  await expect.element(directAnswer).toBeVisible();
  await expect.element(coordination).not.toBeInTheDocument();
  await screen.getByRole("link", { name: /^Workspace/ }).click();
  await expectRole("Second Mate");
  await expect.element(editor).toHaveTextContent("Unsent implementation direction");
  await expect
    .element(board.getByRole("button", { name: "Thread archived-worker", exact: true }))
    .toBeVisible();
  await screen.getByRole("button", { name: "First Mate", exact: true }).click();
  await screen.getByRole("tab", { name: first.title }).click();
  await expectRole("First Mate");
  await expect.element(editor).toHaveTextContent("Unsent shaping direction");
  await screen.getByRole("tab", { name: second.title }).click();
  await expect.element(editor).toHaveTextContent("Unsent implementation direction");
  await screen.getByLabelText("Session project: render").click();
  await page.getByRole("option", { name: /Meow/ }).click();
  await expect.element(screen.getByLabelText("Session project: Meow")).toBeVisible();
  await expect
    .element(screen.getByRole("tab", { name: second.title }))
    .toHaveAttribute("aria-selected", "true");
  await expect.element(editor).toHaveTextContent("Unsent implementation direction");
  await expect
    .element(screen.getByText("implement-sample: question 0", { exact: true }))
    .toBeVisible();
  const originalCount = env.threadCount;
  await screen.getByRole("button", { name: "New First Mate session" }).click();
  const draftProject = () =>
    page.elementLocator(document.querySelector<HTMLElement>("[data-draft-project-trigger]")!);
  await expect.element(draftProject()).toHaveTextContent("Meow");
  expect(env.threadCount).toBe(originalCount);
  await editor.fill("Coordinate the render release.");
  await draftProject().click();
  await page.getByRole("option", { name: "Add project" }).click();
  await expect.element(page.getByText("Local folder", { exact: true })).toBeVisible();
  await expect.element(page.getByText("Git URL", { exact: true })).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await draftProject().click();
  await page.getByPlaceholder("Search projects...").fill("rend");
  await page.getByRole("option", { name: /render/ }).click();
  await expect.element(editor).toHaveTextContent("Coordinate the render release.");
  expect(env.threadCount).toBe(originalCount);
  await screen.getByRole("button", { name: "Submit message" }).click();
  await expect.element(screen.getByLabelText("Session project: render")).toBeVisible();
  await vi.waitFor(() => {
    const message = document.querySelector('[data-message-role="user"]');
    expect(message?.textContent).toContain("Coordinate the render release.");
  });
  expect(env.threadCount).toBe(originalCount + 1);
  expect(env.latestThread?.modelSelection).toEqual({
    instanceId: "codex",
    model: "gpt-6.1-sol",
    options: [{ id: "reasoningEffort", value: "high" }],
  });
  await screen.getByRole("tab", { name: second.title }).click();
  await expect.element(screen.getByLabelText("Session project: Meow")).toBeVisible();
  await expect.element(editor).toHaveTextContent("Unsent implementation direction");
});
