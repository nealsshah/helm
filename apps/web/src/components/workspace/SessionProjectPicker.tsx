import { useAtomValue } from "@effect/atom-react";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { threadRuntimeIsActive } from "@t3tools/client-runtime/state/models";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { useState } from "react";
import { useProjects, useThreadShell } from "../../state/entities";
import { environmentServerConfigsAtom } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import { threadEnvironment } from "../../state/threads";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { ProjectPicker } from "../chat/ProjectPicker";

export function SessionProjectPicker({
  environmentId,
  projectId,
  threadId,
  onNewThread,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  threadId: ThreadId;
  onNewThread?: () => void;
}) {
  const projects = useProjects().filter((p) => p.environmentId === environmentId);
  const current = projects.find((p) => p.id === projectId);
  const shell = useThreadShell(scopeThreadRef(environmentId, threadId));
  const supported =
    useAtomValue(environmentServerConfigsAtom).get(environmentId)?.environment.capabilities
      .threadProjectSwitch === true;
  const allowed = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const update = useOrchestrationCommand(
    threadEnvironment.updateMetadata,
    "Change session project",
  );
  const [saving, setSaving] = useState(false);
  const busy =
    threadRuntimeIsActive(shell?.runtime) ||
    shell?.hasPendingApprovals ||
    shell?.hasPendingUserInput;
  if (!current) return null;
  const title = current.isScratch ? "No project" : current.title;
  async function change(project: EnvironmentProject) {
    if (project.id === projectId || saving) return;
    setSaving(true);
    await update({ environmentId, input: { threadId, projectId: project.id } }).finally(() =>
      setSaving(false),
    );
  }
  return (
    <ProjectPicker
      compact
      activeProjectRef={scopeProjectRef(environmentId, projectId)}
      activeProjectTitle={title}
      environmentId={environmentId}
      disabled={!supported || !allowed || saving || Boolean(busy)}
      onNewThread={onNewThread}
      onSelect={change}
    />
  );
}
