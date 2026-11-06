import { RuntimeRequestId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { makeThreadFixture } from "../../test-fixtures";
import { nativeQueueEntries, runtimeLabel, safeArtifactUrl } from "./workspaceModel";

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
});
