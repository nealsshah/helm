import type { ScopedThreadRef } from "@t3tools/contracts";
import { type ComponentProps, useLayoutEffect, useMemo } from "react";
import { useIncrementalTimelineEntries } from "../../hooks/useIncrementalTimelineEntries";
import type { TimelineEntriesInput, TimelineEntry } from "../../session-logic";
import { useTimelineVisibleTurnItems } from "../../state/entities";
import {
  peekRememberedThreadTimeline,
  rememberReadyThreadTimeline,
  resolveThreadSwitchTimeline,
  timelineHasEphemeralPreviewUrls,
} from "../ChatView.logic";
import type { SecondMateTranscript } from "../workspace/secondMateTranscript";
import { MessagesTimeline } from "./MessagesTimeline";

/**
 * The timeline with the streamed text. ChatView reads the thread through its quiet
 * atoms, which hold through text deltas; this reads the live turn items, so a
 * reasoning delta re-renders the timeline without re-rendering ChatView. Streamed
 * assistant text reaches only its own row, through useAssistantMessageText.
 */
export function ThreadTimeline({
  threadDetailRef,
  conversation,
  entriesInput,
  draftEntries,
  activeThreadKey,
  syncing,
  detailLoading,
  ...timelineProps
}: Omit<ComponentProps<typeof MessagesTimeline>, "timelineEntries"> & {
  /** Null until the thread's detail may load; see resolveThreadDetailRef. */
  threadDetailRef: ScopedThreadRef | null;
  conversation: SecondMateTranscript | null;
  entriesInput: Omit<TimelineEntriesInput, "visibleTurnItems">;
  /** A local draft's optimistic rows; null for a server thread. */
  draftEntries: ReadonlyArray<TimelineEntry> | null;
  activeThreadKey: string | null;
  syncing: boolean;
  detailLoading: boolean;
}) {
  const visibleTurnItems = useTimelineVisibleTurnItems(threadDetailRef);
  // oxlint-disable-next-line t3code/no-manual-memo -- The incremental timeline resets its render state when this input changes identity.
  const conversationItems = useMemo(
    () =>
      conversation
        ? visibleTurnItems.filter(({ item }) => conversation.shows(item))
        : visibleTurnItems,
    [conversation, visibleTurnItems],
  );
  const serverEntries = useIncrementalTimelineEntries(activeThreadKey, {
    ...entriesInput,
    visibleTurnItems: conversationItems,
  });
  const entries = draftEntries ?? serverEntries;
  const cacheKey =
    conversation && activeThreadKey ? `${activeThreadKey}:conversation` : activeThreadKey;
  const displayedEntries = resolveThreadSwitchTimeline({
    loading: entries.length === 0 && syncing,
    activeThreadKey: cacheKey,
    nextEntries: entries,
    rememberedForActive: peekRememberedThreadTimeline<typeof entries>(cacheKey),
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- stores the committed ready timeline in the module-level cache used during thread switches
  useLayoutEffect(() => {
    if (detailLoading || entries.length === 0 || timelineHasEphemeralPreviewUrls(entries)) {
      return;
    }
    rememberReadyThreadTimeline({ threadKey: cacheKey, entries });
  }, [cacheKey, detailLoading, entries]);
  return <MessagesTimeline {...timelineProps} timelineEntries={displayedEntries} />;
}
