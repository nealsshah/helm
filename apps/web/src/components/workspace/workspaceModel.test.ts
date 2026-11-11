import { RuntimeRequestId, RunId, type WorkItem } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { makeThreadFixture } from "../../test-fixtures";
import {
  nativeQueueEntries,
  runtimeLabel,
  safeArtifactUrl,
  shellNeedsAttention,
  workspaceCardStatus,
} from "./workspaceModel";

describe("workspace runtime", () => {
  const shell = makeThreadFixture({ hasPendingApprovals: true, hasPendingUserInput: true });
  const now = "2026-11-06T18:30:00Z";
  it("preserves reasons from simultaneous provider requests on one session", () => {
    const approval = RuntimeRequestId.make("approval");
    const question = RuntimeRequestId.make("question");
    const requests = nativeQueueEntries(
      shell,
      {
        approvals: [
          {
            requestId: approval,
            requestKind: "command",
            detail: "Run the formatter?",
            createdAt: now,
            responseCapability: "live",
          },
        ],
        userInputs: [
          {
            requestId: question,
            createdAt: now,
            responseCapability: "live",
            dismissible: false,
            questions: [
              {
                id: "target",
                header: "Destination",
                question: "Which repository?",
                options: [],
                multiSelect: false,
              },
            ],
          },
        ],
      },
      "qa",
    );
    expect(requests.map((r) => [r.threadId, r.itemId, r.prompt])).toEqual([
      [shell.id, "qa", "Run the formatter?"],
      [shell.id, "qa", "Which repository?"],
    ]);
    expect(new Set(requests.map((r) => r.key)).size).toBe(2);
    const worker = {
      ...shell,
      hasPendingApprovals: false,
      hasActionableProposedPlan: true,
      runtime: {
        status: "failed",
        activeRunId: null,
        providerInstanceId: shell.providerInstanceId,
        providerName: null,
        lastErrorClass: "usage_limit",
        lastError: "Provider rate limit reached",
        updatedAt: now,
      },
    } as const;
    expect(shellNeedsAttention(worker, true)).toBe(false);
    expect(nativeQueueEntries(worker, null, "qa", true)).toEqual([]);
    expect(nativeQueueEntries(worker, null, null)).toContainEqual(
      expect.objectContaining({
        threadId: worker.id,
        kind: "Error",
        prompt: worker.runtime.lastError,
      }),
    );
    expect(runtimeLabel(worker, true, true)).toBe("Awaiting Second Mate");
    expect(shellNeedsAttention(shell, true)).toBe(true);
    expect(nativeQueueEntries(shell, null, "qa", true).map((entry) => entry.kind)).toEqual([
      "Approval",
    ]);
    expect(runtimeLabel(shell, false)).toBe("Disconnected");
    expect(runtimeLabel(shell, true)).toBe("Awaiting input");
  });
  it.each([null, { approvals: [], userInputs: [] }])(
    "preserves unlinked pending session actions before the native detail arrives",
    (pending) => {
      expect(nativeQueueEntries(shell, pending, null)).toMatchObject([
        { threadId: shell.id, itemId: null, kind: "Approval" },
        { threadId: shell.id, itemId: null, kind: "Input" },
      ]);
    },
  );
  it("renders executable artifact URLs as plain text", () => {
    expect(safeArtifactUrl("javascript:alert(1)")).toBeNull();
    expect(safeArtifactUrl("https://example.com/pull/1")).toBe("https://example.com/pull/1");
  });
  it("derives a single live card status instead of trusting saved attention flags", () => {
    const idle = makeThreadFixture();
    const item: WorkItem = {
      id: "build",
      title: "Build",
      scope: "",
      stage: "building",
      attention: "active",
      priority: 0,
      primaryThreadId: idle.id,
      sessions: [],
      artifacts: [],
      dependencies: [],
      decisions: [],
      createdAt: now,
      updatedAt: now,
      latestReport: null,
    };
    const runtime = (status: "running" | "waiting" | "queued" | "failed") => ({
      status,
      activeRunId: RunId.make("active"),
      providerInstanceId: idle.providerInstanceId,
      providerName: null,
      lastError: null,
      updatedAt: now,
    });
    const status = (sessions: Parameters<typeof workspaceCardStatus>[0]["sessions"], work = item) =>
      workspaceCardStatus({ item: work, sessions, connected: true, workerTriage: false });
    expect(status([idle]).kind).toBe("idle");
    expect(status([idle], { ...item, attention: "paused" }).kind).toBe("idle");
    expect(status([{ ...idle, runtime: runtime("running") }]).kind).toBe("working");
    expect(status([{ ...idle, runtime: runtime("running"), blockedOnThreadWait: true }]).kind).toBe(
      "waiting",
    );
    expect(status([{ ...idle, runtime: runtime("queued") }]).kind).toBe("waiting");
    expect(status([{ ...idle, hasPendingApprovals: true, runtime: runtime("running") }]).kind).toBe(
      "needsYou",
    );
    expect(
      status([{ ...idle, pendingBackgroundTasks: [{ taskId: "logs", kind: "monitor" }] }]).kind,
    ).toBe("idle");
    expect(
      status([
        { ...idle, pendingBackgroundTasks: [{ taskId: "build", kind: "command", awaited: true }] },
      ]).kind,
    ).toBe("waiting");
    expect(
      status([{ ...idle, pendingBackgroundTasks: [{ taskId: "review", kind: "subagent" }] }]).label,
    ).toBe("Waiting for workers");
    expect(
      status([
        {
          ...idle,
          latestRun: {
            runId: RunId.make("stopped"),
            status: "interrupted",
            requestedAt: now,
            startedAt: now,
            completedAt: now,
            assistantMessageId: null,
          },
        },
      ]).kind,
    ).toBe("paused");
    const limited = {
      ...idle,
      runtime: runtime("failed"),
      limitRecovery: { runId: RunId.make("limited"), resetAt: now, autoResume: true },
    };
    expect(status([limited]).label).toBe("Waiting for provider");
    expect(
      status([{ ...limited, limitRecovery: { ...limited.limitRecovery, autoResume: false } }]).kind,
    ).toBe("needsYou");
    expect(status([idle], { ...item, stage: "complete" }).kind).toBe("done");
    expect(
      workspaceCardStatus({ item, sessions: [idle], connected: false, workerTriage: false }).label,
    ).toBe("Disconnected");
  });
});
