import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import { ThreadId, TrimmedNonEmptyString as Text, IsoDateTime } from "./baseSchemas.ts";

import { ProviderInstanceId } from "./providerInstance.ts";
import type { ModelSelection } from "./modelSelection.ts";

export const WORKSPACE_MATE_MODEL = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-6.1-sol",
  options: [{ id: "reasoningEffort", value: "high" }],
} satisfies ModelSelection;

export const WORKSPACE_WORKER_MODEL = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-opus-5-5",
} satisfies ModelSelection;

export const WorkspaceRole = Schema.Literals(["firstMate", "secondMate", "worker", "directWorker"]);
export type WorkspaceRole = typeof WorkspaceRole.Type;

export const WorkspaceStage = Schema.Literals([
  "planning",
  "building",
  "reviewing",
  "qa",
  "complete",
]);
export function isWorkspaceCheckpointToolName(name: string | null | undefined): boolean {
  return !!name && /(?:^|[.:/_-])t3_workspace_checkpoint$/.test(name);
}

export const WorkspaceCheckpoint = Schema.Struct({
  stage: WorkspaceStage,
  needsAttention: Schema.Boolean,
  summary: Text,
  publishReply: Schema.optional(
    Schema.Boolean.annotate({
      description:
        "Second Mate: show the final reply to the person when a worker brings a requested result before the task is complete.",
    }),
  ),
});
export type WorkspaceCheckpoint = typeof WorkspaceCheckpoint.Type;
const previousStages = Schema.Literals(["backlog", "shaping", "review"]);
const wireStage = Schema.String.pipe(
  Schema.refine(Schema.is(Schema.Union([WorkspaceStage, previousStages])), {
    expected: "a workspace stage",
    toJsonSchema: () => [{ enum: [...WorkspaceStage.literals] }, true],
  }),
  Schema.decodeTo(
    WorkspaceStage,
    SchemaTransformation.transform({
      decode: (stage) => {
        if (stage === "backlog" || stage === "shaping") return "planning";
        return stage === "review" ? "qa" : stage;
      },
      encode: (stage) => stage,
    }),
  ),
);
export const WorkspaceAttention = Schema.Literals(["active", "waiting", "paused", "none"]);
const Session = Schema.Struct({ threadId: ThreadId, role: Text });
const Artifact = Schema.Struct({ label: Text, url: Text });
const Dependency = Schema.Struct({ itemId: Text, owner: Text });
const Report = Schema.Struct({
  threadId: ThreadId,
  text: Text,
  reportedAt: IsoDateTime,
  receivedAt: Schema.optional(IsoDateTime),
  format: Schema.Literals(["progress", "legacy"]),
});
const Decision = Schema.Struct({ text: Text, author: Text, createdAt: IsoDateTime });
export const WorkItem = Schema.Struct({
  id: Text,
  title: Text,
  scope: Schema.String,
  stage: wireStage,
  attention: WorkspaceAttention,
  priority: Schema.Int,
  primaryThreadId: ThreadId,
  secondMateThreadId: Schema.optional(ThreadId),
  directWorker: Schema.optionalKey(Schema.Literal(true)),
  retiredAt: Schema.optional(IsoDateTime),
  canReassignPrimary: Schema.optional(Schema.Boolean),
  sessions: Schema.Array(Session),
  artifacts: Schema.Array(Artifact),
  dependencies: Schema.Array(Dependency),
  latestReport: Schema.NullOr(Report),
  decisions: Schema.Array(Decision),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type WorkItem = typeof WorkItem.Type;
export function workspaceOwnerThreadId(item: WorkItem) {
  return item.directWorker ? item.primaryThreadId : item.secondMateThreadId;
}

const RequestKind = Schema.Literals(["question", "review", "error"]);
export const WorkspaceRequest = Schema.Struct({
  id: Text,
  itemId: Text,
  threadId: ThreadId,
  kind: Schema.Union([Schema.Literal("attention"), RequestKind]),
  prompt: Text,
  replyId: Schema.optional(Text),
  context: Schema.String,
  choices: Schema.Array(Text),
  createdAt: IsoDateTime,
  status: Schema.Literals(["open", "delivering", "accepted", "obsolete"]),
  response: Schema.NullOr(Text),
  deliveryError: Schema.optional(Schema.String),
  resolvedAt: Schema.NullOr(IsoDateTime),
});
export type WorkspaceRequest = typeof WorkspaceRequest.Type;
export const WorkspaceSnapshot = Schema.Struct({
  orchestratorThreadIds: Schema.Array(ThreadId),
  items: Schema.Array(WorkItem),
  requests: Schema.Array(WorkspaceRequest),
});
export type WorkspaceSnapshot = typeof WorkspaceSnapshot.Type;
const workspaceSnapshotWire = Schema.Struct({
  ...WorkspaceSnapshot.fields,
  orchestratorThreadId: Schema.optional(Schema.NullOr(ThreadId)),
  orchestratorThreadIds: Schema.optional(Schema.Array(ThreadId)),
  reviewingItemIds: Schema.optional(Schema.Array(Text)),
  retiredItems: Schema.optional(Schema.Array(WorkItem)),
  readyReplies: Schema.optional(Schema.Array(WorkspaceRequest)),
  sessionAttention: Schema.optional(Schema.Array(WorkspaceRequest)),
});
const legacyRequestKinds: ReadonlySet<string> = new Set(["question", "review", "error"]);

// Older clients require a single orchestrator and reject unfamiliar request kinds.
export const WorkspaceSnapshotRpc = workspaceSnapshotWire.pipe(
  Schema.decodeTo(
    Schema.toType(WorkspaceSnapshot),
    SchemaTransformation.transform<WorkspaceSnapshot, typeof workspaceSnapshotWire.Type>({
      decode: ({
        orchestratorThreadIds,
        orchestratorThreadId,
        sessionAttention = [],
        readyReplies = [],
        reviewingItemIds,
        retiredItems = [],
        requests,
        items,
      }) => ({
        orchestratorThreadIds:
          orchestratorThreadIds ?? (orchestratorThreadId ? [orchestratorThreadId] : []),
        requests: [...requests, ...sessionAttention, ...readyReplies],
        items: [
          ...items.map((item) =>
            reviewingItemIds?.includes(item.id) ? { ...item, stage: "reviewing" as const } : item,
          ),
          ...retiredItems,
        ],
      }),
      encode: (snapshot) => ({
        ...snapshot,
        retiredItems: snapshot.items.filter((item) => item.retiredAt !== undefined),
        items: snapshot.items
          .filter((item) => item.retiredAt === undefined)
          .map((item) => (item.stage === "reviewing" ? { ...item, stage: "qa" as const } : item)),
        reviewingItemIds: snapshot.items
          .filter((item) => item.stage === "reviewing")
          .map((item) => item.id),
        orchestratorThreadId: snapshot.orchestratorThreadIds.at(-1) ?? null,
        requests: snapshot.requests.filter((request) => legacyRequestKinds.has(request.kind)),
        readyReplies: snapshot.requests.filter((request) => request.replyId !== undefined),
        sessionAttention: snapshot.requests.filter(
          (request) => !legacyRequestKinds.has(request.kind) && request.replyId === undefined,
        ),
      }),
    }),
  ),
);
const WorkspaceAgentManagementCommand = Schema.Union([
  Schema.Struct({ type: Schema.Literal("ensureSecondMate"), itemId: Text }),
  Schema.Struct({
    type: Schema.Literal("create"),
    itemId: Text,
    title: Text,
    primaryThreadId: ThreadId,
    scope: Schema.optional(Schema.String),
    stage: Schema.optional(wireStage),
  }),
  Schema.Struct({
    type: Schema.Literal("update"),
    itemId: Text,
    title: Schema.optional(Text),
    scope: Schema.optional(Schema.String),
    stage: Schema.optional(wireStage),
    attention: Schema.optional(WorkspaceAttention),
    priority: Schema.optional(Schema.Int),
    dependencies: Schema.optional(Schema.Array(Dependency)),
  }),
  Schema.Struct({
    type: Schema.Literal("associate"),
    itemId: Text,
    threadId: ThreadId,
    role: Text,
  }),
  Schema.Struct({ type: Schema.Literal("disassociate"), itemId: Text, threadId: ThreadId }),
  Schema.Struct({ type: Schema.Literal("artifact"), itemId: Text, label: Text, url: Text }),
  Schema.Struct({ type: Schema.Literal("decide"), itemId: Text, text: Text, author: Text }),
  Schema.Struct({
    type: Schema.Literal("report"),
    itemId: Text,
    threadId: ThreadId,
    text: Text,
    stage: Schema.optional(wireStage),
    needsAttention: Schema.optional(Schema.Boolean),
    reportedAt: Schema.optional(IsoDateTime),
    format: Schema.optional(Schema.Literals(["progress", "legacy"])),
  }),
]);
const respondFields = { type: Schema.Literal("respond"), requestId: Text, response: Text };
export const WorkspaceAgentCommand = Schema.Union([
  WorkspaceAgentManagementCommand,
  Schema.Struct({ ...respondFields, itemId: Text }),
]);
export const WorkspaceCommand = Schema.Union([
  WorkspaceAgentManagementCommand,
  Schema.Struct({
    type: Schema.Literal("retire"),
    itemId: Text,
    onlyIfDone: Schema.optional(Schema.Literal(true)),
  }),
  Schema.Struct({ type: Schema.Literal("restore"), itemId: Text }),
  Schema.Struct({ type: Schema.Literal("readReply"), itemId: Text, replyId: Text }),
  Schema.Struct({
    type: Schema.Literal("request"),
    itemId: Text,
    requestId: Text,
    threadId: ThreadId,
    kind: RequestKind,
    prompt: Text,
    context: Schema.optional(Schema.String),
    choices: Schema.optional(Schema.Array(Text)),
  }),
  Schema.Struct({ type: Schema.Literal("orchestrator"), threadId: ThreadId }),
  Schema.Struct({ type: Schema.Literal("closeOrchestrator"), threadId: ThreadId }),
  Schema.Struct({ ...respondFields, itemId: Schema.optional(Text) }),
  Schema.Struct({ type: Schema.Literal("obsolete"), requestId: Text, reason: Text }),
]);
export type WorkspaceCommand = typeof WorkspaceCommand.Type;
export class WorkspaceError extends Schema.TaggedError<WorkspaceError>()("WorkspaceError", {
  message: Schema.String,
}) {}
