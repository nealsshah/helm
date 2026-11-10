import { type OrchestrationV2TurnItem, ThreadId, TurnItemId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import { makeStreamingTimelineFixture } from "~/test-fixtures";
import { secondMateTranscript } from "./secondMateTranscript";

it("shows the human steer and the answer when a person joins a private worker turn", () => {
  const { visibleTurnItems } = makeStreamingTimelineFixture();
  const user = visibleTurnItems[0]?.item;
  const assistant = visibleTurnItems[2]?.item;
  if (user?.type !== "user_message" || assistant?.type !== "assistant_message") {
    throw new Error("Expected conversation fixture");
  }
  const items: OrchestrationV2TurnItem[] = [
    { ...user, createdBy: "agent", senderThreadId: ThreadId.make("worker") },
    { ...assistant, id: TurnItemId.make("acknowledgement"), ordinal: 1 },
    { ...user, id: TurnItemId.make("steer"), inputIntent: "steer", ordinal: 2 },
    assistant,
  ];
  const transcript = secondMateTranscript(
    {
      runs: [],
      messages: [],
      visibleTurnItems: items.map((item, position) => ({
        item,
        position,
        visibility: "local",
        sourceThreadId: item.threadId,
        sourceItemId: item.id,
      })),
    },
    [],
  );
  expect(items.filter(transcript.shows).map((item) => item.id)).toEqual(["steer", assistant.id]);
  expect(transcript.isPrivateRun(assistant.runId)).toBe(false);
});
