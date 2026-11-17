import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  EnvironmentId,
  ThreadId,
  type ScopedThreadRef,
  type WorkspaceSnapshot,
} from "@t3tools/contracts";
import { AtomRegistry } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";
import { makeThreadFixture } from "../../test-fixtures";
import { workspaceNeedsAttentionAtom } from "./workspaceState";

const sources = await vi.hoisted(async () => {
  const { Atom } = await import("effect/reactivity");
  const environmentIds = Atom.make<readonly EnvironmentId[]>([]);
  const shells = Atom.make<readonly EnvironmentThreadShell[]>([]);
  const snapshot = Atom.make<WorkspaceSnapshot>({
    items: [],
    requests: [],
    orchestratorThreadIds: [],
  });
  const detailReads = vi.fn<(ref: ScopedThreadRef) => void>();
  return {
    environmentIds,
    shells,
    snapshot,
    detailReads,
    hostWorkspace: Atom.family((_environmentId: EnvironmentId) =>
      Atom.make((get) => ({ snapshot: get(snapshot), error: null })),
    ),
    workspaceTriageRoles: Atom.family((_environmentId: EnvironmentId) =>
      Atom.make(new Map<ThreadId, "worker" | "lead" | "retired">()),
    ),
    environmentThreadShells: {
      quietThreadShellsAtom: shells,
      quietThreadShellAtom: (ref: ScopedThreadRef) =>
        Atom.make((get) => get(shells).find((shell) => shell.id === ref.threadId)),
    },
    environmentThreadDetails: {
      quietThreadAtom: (ref: ScopedThreadRef) =>
        Atom.make(() => {
          detailReads(ref);
          return null;
        }),
      updatedAtAtom: (_ref: ScopedThreadRef) => Atom.make(null),
    },
  };
});

vi.mock("../../state/presentation", () => ({
  environmentSummaries: {
    environmentIdsAtom: sources.environmentIds,
    connectedEnvironmentIdsAtom: sources.environmentIds,
  },
}));
vi.mock("../../state/threads", () => ({
  environmentThreadShells: sources.environmentThreadShells,
  environmentThreadDetails: sources.environmentThreadDetails,
}));
vi.mock("./workspaceHost", () => ({
  hostWorkspace: sources.hostWorkspace,
  workspaceTriageRoles: sources.workspaceTriageRoles,
}));
vi.mock("../../state/environments", () => ({}));
vi.mock("../../state/server", () => ({ serverEnvironment: {} }));
vi.mock("../ChatView.logic", () => ({ presentThreadShellFromProjection: vi.fn() }));

const environmentId = EnvironmentId.make("local");
const primaryThreadId = ThreadId.make("primary");
const secondMateThreadId = ThreadId.make("second-mate");
const orchestratorThreadId = ThreadId.make("orchestrator");

function setup() {
  sources.detailReads.mockClear();
  const registry = AtomRegistry.make();
  registry.set(sources.environmentIds, [environmentId]);
  registry.set(sources.snapshot, {
    orchestratorThreadIds: [orchestratorThreadId],
    requests: [],
    items: [
      {
        id: "item",
        title: "Work item",
        scope: "",
        stage: "building",
        attention: "none",
        priority: 0,
        primaryThreadId,
        secondMateThreadId,
        sessions: Array.from({ length: 1000 }, (_, index) => ({
          threadId: ThreadId.make(`native-child-${index}`),
          role: "worker",
        })),
        artifacts: [],
        dependencies: [],
        latestReport: null,
        decisions: [],
        createdAt: "2026-11-17T00:00:00.000Z",
        updatedAt: "2026-11-17T00:00:00.000Z",
      },
    ],
  });
  return registry;
}

describe("workspace thread subscriptions", () => {
  it("hydrates missing owners without subscribing to historical worker transcripts", () => {
    const registry = setup();
    try {
      expect(registry.get(workspaceNeedsAttentionAtom)).toBe(false);
      expect(sources.detailReads.mock.calls.map(([ref]) => ref.threadId)).toEqual([
        primaryThreadId,
        secondMateThreadId,
        orchestratorThreadId,
      ]);
    } finally {
      registry.dispose();
    }
  });

  it("keeps indexed worker approvals actionable without hydrating their transcript", () => {
    const registry = setup();
    try {
      const worker = makeThreadFixture({
        environmentId,
        id: ThreadId.make("native-child-0"),
        hasPendingApprovals: true,
      });
      registry.set(sources.shells, [worker]);
      registry.set(sources.workspaceTriageRoles(environmentId), new Map([[worker.id, "worker"]]));
      expect(registry.get(workspaceNeedsAttentionAtom)).toBe(true);
      expect(sources.detailReads.mock.calls.map(([ref]) => ref.threadId)).toEqual([
        primaryThreadId,
        secondMateThreadId,
        orchestratorThreadId,
      ]);
      registry.set(sources.shells, [{ ...worker, hasPendingApprovals: false }]);
      expect(registry.get(workspaceNeedsAttentionAtom)).toBe(false);
    } finally {
      registry.dispose();
    }
  });
});
