import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import { ThreadId, TrimmedNonEmptyString as Text, IsoDateTime } from "./baseSchemas.ts";

export const WorkspaceStage = Schema.Literals(["planning", "building", "qa", "complete"]);
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
  sessions: Schema.Array(Session),
  artifacts: Schema.Array(Artifact),
  dependencies: Schema.Array(Dependency),
  latestReport: Schema.NullOr(Report),
  decisions: Schema.Array(Decision),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type WorkItem = typeof WorkItem.Type;
const RequestKind = Schema.Literals(["question", "review", "error"]);
export const WorkspaceRequest = Schema.Struct({
  id: Text,
  itemId: Text,
  threadId: ThreadId,
  kind: RequestKind,
  prompt: Text,
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
        sessionAttention,
        requests,
        items,
      }) => ({
        orchestratorThreadIds:
          orchestratorThreadIds ?? (orchestratorThreadId ? [orchestratorThreadId] : []),
        requests: sessionAttention?.length ? [...requests, ...sessionAttention] : requests,
        items,
      }),
      encode: (snapshot) => ({
        ...snapshot,
        orchestratorThreadId: snapshot.orchestratorThreadIds.at(-1) ?? null,
        requests: snapshot.requests.filter((request) => legacyRequestKinds.has(request.kind)),
        sessionAttention: snapshot.requests.filter(
          (request) => !legacyRequestKinds.has(request.kind),
        ),
      }),
    }),
  ),
);
export const WorkspaceAgentCommand = Schema.Union([
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
    type: Schema.Literal("request"),
    itemId: Text,
    requestId: Text,
    threadId: ThreadId,
    kind: RequestKind,
    prompt: Text,
    context: Schema.optional(Schema.String),
    choices: Schema.optional(Schema.Array(Text)),
  }),
  Schema.Struct({
    type: Schema.Literal("report"),
    itemId: Text,
    threadId: ThreadId,
    text: Text,
    stage: Schema.optional(wireStage),
    reportedAt: Schema.optional(IsoDateTime),
    format: Schema.optional(Schema.Literals(["progress", "legacy"])),
  }),
]);
export const WorkspaceCommand = Schema.Union([
  WorkspaceAgentCommand,
  Schema.Struct({ type: Schema.Literal("orchestrator"), threadId: ThreadId }),
  Schema.Struct({ type: Schema.Literal("closeOrchestrator"), threadId: ThreadId }),
  Schema.Struct({ type: Schema.Literal("respond"), requestId: Text, response: Text }),
  Schema.Struct({ type: Schema.Literal("obsolete"), requestId: Text, reason: Text }),
]);
export type WorkspaceCommand = typeof WorkspaceCommand.Type;
export class WorkspaceError extends Schema.TaggedError<WorkspaceError>()("WorkspaceError", {
  message: Schema.String,
}) {}
