import type { EnvironmentId } from "@t3tools/contracts";

export function firstMateDraftKey(environmentId: EnvironmentId) {
  return `helm:first-mate:${environmentId}`;
}
