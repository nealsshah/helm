import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useState } from "react";

export const PanelTarget = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: ThreadId,
  itemId: Schema.NullOr(Schema.String),
  global: Schema.optionalKey(Schema.Boolean),
});
export type PanelTarget = typeof PanelTarget.Type;

export function useWorkspaceTabValue<T, E>(key: string, initial: T, schema: Schema.Codec<T, E>) {
  const storageKey = `helm.workspace.${key}`;
  const [value, setValue] = useState<T>(() => {
    try {
      const stored = sessionStorage.getItem(storageKey);
      return stored === null ? initial : Schema.decodeSync(Schema.fromJsonString(schema))(stored);
    } catch {
      return initial;
    }
  });
  function update(next: T) {
    try {
      sessionStorage.setItem(storageKey, Schema.encodeSync(Schema.fromJsonString(schema))(next));
    } catch {
      // Private browsing can disable storage while the mounted workspace remains usable.
    }
    setValue(next);
  }
  return [value, update] as const;
}
