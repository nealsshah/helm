import { EnvironmentId, ThreadId, type WorkspaceRequest } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { render } from "../../../test/render";
import { RequestResponse } from "./WorkspaceForms";

const { run } = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("./workspaceState", () => ({ useWorkspaceCommand: () => run }));
vi.mock("../../state/server", () => ({
  serverEnvironment: { workspaceCommand: { permissionAtom: () => Atom.make(true) } },
}));

const environmentId = EnvironmentId.make("sample-environment");
const sample: WorkspaceRequest = {
  id: "request-qa",
  kind: "question",
  itemId: "qa",
  threadId: ThreadId.make("qa-worker"),
  prompt: "Which account should QA use?",
  context: "Both staging fixtures are available.",
  choices: ["Sandbox", "Demo"],
  status: "open",
  response: null,
  resolvedAt: null,
  createdAt: "2026-11-06T18:00:00Z",
};
function form(request: WorkspaceRequest) {
  return (
    <RequestResponse
      key={request.id}
      source={request.threadId}
      connected
      environmentId={environmentId}
      request={request}
    />
  );
}

it("keeps drafts on their requests and retains a failed answer until accepted", async () => {
  run
    .mockReset()
    .mockRejectedValueOnce(new Error("Host disconnected"))
    .mockResolvedValueOnce(undefined);
  await using screen = await render(form(sample));
  await screen.getByRole("button", { name: "Sandbox" }).click();
  const review: WorkspaceRequest = {
    ...sample,
    id: "request-review",
    kind: "review",
    threadId: ThreadId.make("review-worker"),
    prompt: "Accept the proposed result?",
  };
  await screen.rerender(form(review));
  await screen
    .getByRole("textbox", { name: "Reply to review-worker" })
    .fill("Please verify permissions first.");
  await screen.rerender(form(sample));
  await expect
    .element(screen.getByRole("textbox", { name: "Reply to qa-worker" }))
    .toHaveValue("Sandbox");
  await screen.getByRole("button", { name: "Send answer" }).click();
  await expect.element(screen.getByRole("alert")).toHaveTextContent("Host disconnected");
  await expect.element(screen.getByRole("textbox")).toHaveValue("Sandbox");
  await screen.rerender(
    form({
      ...sample,
      status: "delivering",
      response: "Sandbox",
      deliveryError: "Host disconnected",
    }),
  );
  await expect.element(screen.getByRole("textbox")).toBeDisabled();
  await screen.getByRole("button", { name: "Retry delivery" }).click();
  expect(run).toHaveBeenLastCalledWith(environmentId, {
    type: "respond",
    requestId: "request-qa",
    response: "Sandbox",
  });
  await screen.rerender(
    form({ ...sample, status: "accepted", response: "Sandbox", resolvedAt: sample.createdAt }),
  );
  await expect.element(screen.getByText("Answer delivered")).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Send answer" })).not.toBeInTheDocument();
  await screen.rerender(form(review));
  await expect.element(screen.getByRole("textbox")).toHaveValue("Please verify permissions first.");
  await screen.getByRole("textbox").fill("");
});

it("shows the reason an obsolete request stopped accepting answers", async () => {
  await using screen = await render(
    form({
      ...sample,
      status: "obsolete",
      response: "Worker replaced",
      resolvedAt: sample.createdAt,
    }),
  );
  await expect.element(screen.getByText(/Worker replaced/)).toBeVisible();
  await expect.element(screen.getByRole("textbox")).not.toBeInTheDocument();
});

it("requires a reason before closing a request even after delivery has started", async () => {
  run.mockReset().mockResolvedValue(undefined);
  await using screen = await render(form({ ...sample, status: "delivering", response: "Sandbox" }));
  await screen.getByRole("button", { name: "Close request…" }).click();
  await expect.element(screen.getByRole("button", { name: "Mark obsolete" })).toBeDisabled();
  await screen
    .getByRole("textbox", { name: "Why is this request obsolete?" })
    .fill("Worker archived");
  await screen.getByRole("button", { name: "Mark obsolete" }).click();
  expect(run).toHaveBeenCalledWith(environmentId, {
    type: "obsolete",
    requestId: sample.id,
    reason: "Worker archived",
  });
});
