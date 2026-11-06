import { EnvironmentId, ThreadId, type WorkItem, type WorkspaceRequest } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "../../../test/render";
import { makeThreadFixture } from "../../test-fixtures";
import { SidebarProvider } from "../ui/sidebar";
import type { WorkspaceState } from "./workspaceState";
import { VisualWorkspace } from "./VisualWorkspace";

let snapshot: WorkspaceState;
vi.mock("./workspaceState", () => ({
  useWorkspaceState: () => snapshot,
  useWorkspaceCommand: () => vi.fn(),
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: { workspaceCommand: { permissionAtom: () => Atom.make(true) } },
}));
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
  const previous = { width: window.innerWidth, height: window.innerHeight };
  await page.viewport(1440, 900);
  await using _viewport = {
    [Symbol.asyncDispose]: () => page.viewport(previous.width, previous.height),
  };
  const shape = work("Shape", "planning"),
    build = work("Implement", "building"),
    qa = work("Verify", "qa"),
    review = work("Review", "qa");
  const items = [shape, build, qa, review];
  const worker = ThreadId.make("verification-worker");
  const qaWithWorker = { ...qa, sessions: [{ threadId: worker, role: "QA worker" }] };
  const shapedBuild = { ...build, dependencies: [{ itemId: shape.id, owner: "Design" }] };
  const workItems = [shape, shapedBuild, qaWithWorker, review];
  const host = {
    environmentId: env,
    label: "Local",
    connected: true,
    error: null,
    snapshot: { orchestratorThreadId: null, items: workItems, requests: [] },
  };
  snapshot = {
    hosts: [host],
    items: workItems.map((item) => ({ environmentId: env, item })),
    requests: [],
    shells: [
      ...items.map((item) =>
        makeThreadFixture({ id: item.primaryThreadId, environmentId: env, title: item.title }),
      ),
      makeThreadFixture({ id: worker, environmentId: env, title: "Verification worker" }),
    ],
  };
  const ui = () => (
    <SidebarProvider defaultOpen>
      <VisualWorkspace />
    </SidebarProvider>
  );
  await using screen = await render(ui(), { router: "/workspace" });
  const board = screen.getByRole("region", { name: "Workspace overview" });
  await expect.element(board.getByRole("button", { name: /^Needs you/ })).not.toBeInTheDocument();
  await board.getByRole("region", { name: "Planning" }).getByRole("button").click();
  await expect.element(screen.getByText("Session shape", { exact: true })).toBeVisible();
  await expect.element(board.getByText("Waiting on Shape · Design")).toBeVisible();
  await board.getByRole("region", { name: "Building" }).getByRole("button").click();
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
  await expect.element(screen.getByText("Session implement", { exact: true })).toBeVisible();
  const workerCard = needsMe.getByRole("button", { name: "Verification worker" });
  await workerCard.click();
  await expect
    .element(screen.getByText("Session verification-worker", { exact: true }))
    .toBeVisible();
  await screen.getByRole("button", { name: "Close work panel" }).click();
  await expect.element(screen.getByText("Session implement", { exact: true })).toBeVisible();

  const original = snapshot.requests[0]!;
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
