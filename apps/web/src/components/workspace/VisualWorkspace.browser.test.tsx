import "~/index.css";
import { EnvironmentId, ThreadId, type WorkItem, type WorkspaceRequest } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "../../../test/render";
import { makeThreadFixture } from "../../test-fixtures";
import { SidebarProvider } from "../ui/sidebar";
import type { WorkspaceState } from "./workspaceState";
import { VisualWorkspace } from "./VisualWorkspace";

let snapshot: WorkspaceState;
const { runWorkspace } = vi.hoisted(() => ({ runWorkspace: vi.fn(async () => {}) }));
vi.mock("./workspaceState", () => ({
  useWorkspaceState: () => snapshot,
  useWorkspaceCommand: () => runWorkspace,
}));
vi.mock("../../hooks/useSettings", async () => {
  const { DEFAULT_CLIENT_SETTINGS } = await import("@t3tools/contracts/settings");
  return {
    useClientSettings: (select: (settings: typeof DEFAULT_CLIENT_SETTINGS) => unknown) =>
      select(DEFAULT_CLIENT_SETTINGS),
  };
});
vi.mock("../../state/entities", () => ({ useProject: () => null, useThreadShell: () => null }));
vi.mock("../ProjectFavicon", () => ({ ProjectFavicon: () => null }));
vi.mock("../../state/server", () => ({
  serverEnvironment: { workspaceCommand: { permissionAtom: () => Atom.make(true) } },
}));
vi.mock("./SessionProjectPicker", () => ({ SessionProjectPicker: () => null }));
vi.mock("./OrchestratorPanel", () => ({ OrchestratorPanel: () => null }));
vi.mock("../ChatView", () => ({
  default: ({ threadId }: { threadId: string }) => <p>Session {threadId}</p>,
}));

const env = EnvironmentId.make("test-server");
const timestamp = "2026-11-06T18:00:00Z";
function work(title: string, stage: WorkItem["stage"]): WorkItem {
  return {
    id: title,
    title,
    scope: "",
    stage,
    attention: "none",
    priority: 0,
    primaryThreadId: ThreadId.make(title.toLowerCase()),
    sessions: [],
    artifacts: [],
    dependencies: [],
    decisions: [],
    createdAt: timestamp,
    updatedAt: timestamp,
    latestReport: null,
  };
}

it("leaves a discussion selected when another work item requests attention and returns after inspecting it", async () => {
  runWorkspace.mockReset().mockRejectedValueOnce(new Error("Task host unavailable"));
  const previous = { width: window.innerWidth, height: window.innerHeight };
  await page.viewport(1440, 900);
  await using _viewport = {
    [Symbol.asyncDispose]: () => page.viewport(previous.width, previous.height),
  };
  const shape = work("Shape", "planning"),
    build = work("Implement", "building"),
    qa = work("Verify", "qa"),
    review: WorkItem = { ...work("Review", "qa"), directWorker: true };
  const items = [shape, build, qa, review];
  const worker = ThreadId.make("verification-worker");
  const qaWithWorker = { ...qa, sessions: [{ threadId: worker, role: "QA worker" }] };
  const shapedBuild = {
    ...build,
    secondMateThreadId: ThreadId.make("implement-lead"),
    dependencies: [{ itemId: shape.id, owner: "Design" }],
  };
  const workItems = [shape, shapedBuild, qaWithWorker, review];
  const host = {
    environmentId: env,
    label: "Local",
    connected: true,
    secondMate: true,
    workerTriage: true,
    retirement: true,
    error: null,
    snapshot: { orchestratorThreadIds: [], items: workItems, requests: [] },
  };
  snapshot = {
    hosts: [host],
    items: workItems.map((item) => ({ environmentId: env, item })),
    requests: [],
    shells: [
      ...items.map((item) =>
        makeThreadFixture({ id: item.primaryThreadId, environmentId: env, title: item.title }),
      ),
      makeThreadFixture({
        id: shapedBuild.secondMateThreadId,
        environmentId: env,
        title: "Implement lead",
      }),
      makeThreadFixture({ id: worker, environmentId: env, title: "Verification worker" }),
    ],
  };
  const ui = () => (
    <SidebarProvider defaultOpen>
      <VisualWorkspace />
    </SidebarProvider>
  );
  await using screen = await render(ui(), { router: "/workspace" });
  await expect
    .element(screen.getByRole("heading", { name: "Workspace", exact: true }))
    .not.toBeInTheDocument();
  const header = screen
    .getByRole("button", { name: "First Mate", exact: true })
    .element()
    .closest("header")!;
  expect(getComputedStyle(header).getPropertyValue("-webkit-app-region")).toBe("drag");
  const firstMateButton = screen.getByRole("button", { name: "First Mate", exact: true }).element();
  expect(getComputedStyle(firstMateButton).getPropertyValue("-webkit-app-region")).toBe("no-drag");
  const board = screen.getByRole("region", { name: "Workspace overview" });
  await expect.element(board.getByRole("button", { name: /^Needs you/ })).not.toBeInTheDocument();
  await board.getByRole("region", { name: "Planning" }).getByRole("button").click();
  await expect.element(screen.getByRole("alert")).toHaveTextContent("Task host unavailable");
  await screen.getByRole("button", { name: "Try again" }).click();
  await expect.element(screen.getByText("Opening Second Mate…")).toBeVisible();
  await expect.element(board.getByText("Waiting on Shape · Design")).toBeVisible();
  await board.getByRole("region", { name: "Building" }).getByRole("button").click();
  const building = board.getByRole("region", { name: "Building" }).getByRole("button");
  await expect.element(screen.getByText("Session implement-lead", { exact: true })).toBeVisible();
  await expect.element(page.getByRole("menuitem", { name: /Implement/ })).not.toBeInTheDocument();
  await screen.getByRole("button", { name: "Workers (1)" }).click();
  await page.getByRole("menuitem", { name: /Implement/ }).click();
  await expect.element(screen.getByText("Session implement", { exact: true })).toBeVisible();
  await building.click();
  await expect.element(screen.getByText("Session implement-lead", { exact: true })).toBeVisible();
  const request: WorkspaceRequest = {
    id: "confirm",
    kind: "question",
    itemId: qa.id,
    threadId: worker,
    prompt: "Which dataset should QA use?",
    context: "The test fixtures differ by region.",
    choices: ["US", "EU"],
    createdAt: timestamp,
    status: "open",
    response: null,
    resolvedAt: null,
  };
  snapshot = {
    ...snapshot,
    hosts: [{ ...host, snapshot: { ...host.snapshot, requests: [request] } }],
    requests: [
      {
        key: "confirm",
        environmentId: env,
        itemId: qa.id,
        threadId: worker,
        kind: "question",
        prompt: request.prompt,
        createdAt: timestamp,
      },
    ],
  };
  const doneWork = workItems.map((item) =>
    item.id === shape.id ? { ...item, stage: "complete" as const } : item,
  );
  snapshot = {
    ...snapshot,
    items: doneWork.map((item) => ({ environmentId: env, item })),
    hosts: [{ ...host, snapshot: { ...host.snapshot, items: doneWork, requests: [request] } }],
  };
  await screen.rerender(ui());
  const needsMe = board.getByRole("region", { name: "Needs me" });
  const done = board.getByRole("region", { name: "Done" });
  const qaColumn = board.getByRole("region", { name: "QA", exact: true });
  await expect.element(done.getByText("Shape", { exact: true })).toBeVisible();
  await expect.element(needsMe.getByText("Verification worker", { exact: true })).toBeVisible();
  await expect.element(qaColumn.getByText("Verify", { exact: true })).not.toBeInTheDocument();
  await expect.element(board.getByText("Waiting on Shape · Design")).not.toBeInTheDocument();
  await expect.element(screen.getByText("Session implement-lead", { exact: true })).toBeVisible();
  const workerCard = needsMe.getByRole("button", { name: "Verification worker" });
  await workerCard.click();
  await expect
    .element(screen.getByText("Session verification-worker", { exact: true }))
    .toBeVisible();
  await screen.getByRole("button", { name: "Second Mate" }).click();
  await expect.element(screen.getByText("Opening Second Mate…")).toBeVisible();
  await screen.getByRole("button", { name: "Close work panel" }).click();
  await expect.element(screen.getByText("Session implement-lead", { exact: true })).toBeVisible();

  const directCard = qaColumn.getByRole("button", { name: /^Review/ });
  await directCard.click();
  await expect.element(screen.getByText("Session review", { exact: true })).toBeVisible();
  const directReply = {
    key: "direct-reply",
    environmentId: env,
    itemId: review.id,
    threadId: review.primaryThreadId,
    kind: "attention",
    replyId: "direct-answer",
    prompt: "Worker replied",
    createdAt: timestamp,
  };
  runWorkspace.mockClear();
  snapshot = { ...snapshot, requests: [...snapshot.requests, directReply] };
  await screen.rerender(ui());
  const directAttention = needsMe.getByRole("button", { name: "Review", exact: true });
  await expect.element(directAttention).toHaveAttribute("aria-pressed", "true");
  await directAttention.click();
  await expect.element(screen.getByText("Session review", { exact: true })).toBeVisible();
  expect(runWorkspace).toHaveBeenCalledExactlyOnceWith(env, {
    type: "readReply",
    itemId: review.id,
    replyId: "direct-answer",
  });

  const original = snapshot.requests[0]!;
  const reply = {
    ...original,
    key: "reply",
    kind: "attention",
    replyId: "answer-1",
    itemId: shapedBuild.id,
    threadId: shapedBuild.secondMateThreadId,
    prompt: "Second Mate replied",
  };
  runWorkspace.mockClear();
  snapshot = { ...snapshot, requests: [original, reply] };
  await screen.rerender(ui());
  const answer = needsMe.getByRole("button", { name: "Implement", exact: true });
  await expect.element(answer).toBeVisible();
  expect(runWorkspace).not.toHaveBeenCalled();
  await answer.click();
  expect(runWorkspace).toHaveBeenCalledExactlyOnceWith(env, {
    type: "readReply",
    itemId: shapedBuild.id,
    replyId: "answer-1",
  });
  await workerCard.click();
  expect(runWorkspace).toHaveBeenCalledTimes(1);

  const primary = {
    ...original,
    key: "primary",
    threadId: qa.primaryThreadId,
    prompt: "Review the proposed plan",
  };
  snapshot = { ...snapshot, requests: [original, { ...original, key: "followup" }, primary] };
  await screen.rerender(ui());
  await expect.element(needsMe.getByRole("listitem").nth(2)).not.toBeInTheDocument();
  await expect.element(workerCard).toBeVisible();
  await needsMe.getByRole("button", { name: "Verify", exact: true }).click();
  await expect.element(screen.getByText("Session verify", { exact: true })).toBeVisible();
  snapshot = { ...snapshot, requests: [primary] };
  await screen.rerender(ui());
  await expect.element(workerCard).not.toBeInTheDocument();
  await expect.element(qaColumn.getByText("Verify", { exact: true })).not.toBeInTheDocument();
  snapshot = { ...snapshot, requests: [] };
  await screen.rerender(ui());
  await expect.element(qaColumn.getByText("Verify", { exact: true })).toBeVisible();
  await expect.element(needsMe.getByRole("button")).not.toBeInTheDocument();
  await expect.element(screen.getByText("Session verify", { exact: true })).toBeVisible();
});

it("retires done tasks with a checkmark and asks before retiring an unfinished task", async () => {
  runWorkspace.mockReset();
  sessionStorage.removeItem("helm.workspace.selected");
  const done = work("Finished ticket", "complete");
  const active = work("Active ticket", "building");
  const items = [active, done];
  snapshot = {
    hosts: [
      {
        environmentId: env,
        label: "Local",
        connected: true,
        secondMate: true,
        workerTriage: true,
        retirement: true,
        error: null,
        snapshot: { orchestratorThreadIds: [], items, requests: [] },
      },
    ],
    items: items.map((item) => ({ environmentId: env, item })),
    requests: [],
    shells: [],
  };
  await using screen = await render(
    <SidebarProvider>
      <VisualWorkspace />
    </SidebarProvider>,
    { router: "/workspace" },
  );
  await screen.getByRole("button", { name: "Retire Finished ticket" }).click();
  await expect.element(page.getByRole("alertdialog")).not.toBeInTheDocument();
  expect(runWorkspace).toHaveBeenCalledExactlyOnceWith(env, {
    type: "retire",
    itemId: done.id,
    onlyIfDone: true,
  });
  runWorkspace.mockClear();

  const card = screen.getByRole("button", { name: /Active ticket/ });
  card.element().focus();
  await userEvent.keyboard("{Shift>}{F10}{/Shift}");
  await page.getByRole("menuitem", { name: "Retire task" }).click();
  const dialog = page.getByRole("alertdialog", { name: "Retire Active ticket?" });
  await expect.element(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  expect(runWorkspace).not.toHaveBeenCalled();

  await card.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Retire task" }).click();
  await dialog.getByRole("button", { name: "Retire task" }).click();
  expect(runWorkspace).toHaveBeenCalledExactlyOnceWith(env, { type: "retire", itemId: active.id });
});
