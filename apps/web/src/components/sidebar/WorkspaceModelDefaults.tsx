import { useState } from "react";
import {
  AuthSettingsWriteScope,
  DEFAULT_SERVER_SETTINGS,
  type EnvironmentId,
  type ModelSelection,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { useMergedSettings } from "../../hooks/useSettings";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import { providerInstanceEntriesFor } from "../../providerInstances";
import {
  useEnvironmentProviders,
  useEnvironments,
  usePrimaryEnvironmentId,
} from "../../state/environments";
import { useEnvironmentsWithScope } from "../../state/session";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { TraitsPicker } from "../chat/TraitsPicker";
import { Dialog, DialogDescription, DialogHeader, DialogPopup, DialogTitle } from "../ui/dialog";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Spinner } from "../ui/spinner";

const roles = [
  { key: "workspaceFirstMateModelSelection", label: "First Mate" },
  { key: "workspaceSecondMateModelSelection", label: "Second Mate" },
  { key: "workspaceWorkerModelSelection", label: "Workers" },
] as const;
type RoleKey = (typeof roles)[number]["key"];

export function WorkspaceModelDefaults({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { environments } = useEnvironments();
  const primaryId = usePrimaryEnvironmentId();
  const [selectedId, setSelectedId] = useState<EnvironmentId | null>(null);
  const connected = environments.filter(
    (environment) => environment.connection.phase === "connected" && environment.serverConfig,
  );
  const environment =
    connected.find((entry) => entry.environmentId === selectedId) ??
    connected.find((entry) => entry.environmentId === primaryId) ??
    connected[0];
  const settings = useMergedSettings(
    environment?.serverConfig?.settings ?? DEFAULT_SERVER_SETTINGS,
  );
  const providersByEnvironment = useEnvironmentProviders();
  const providers =
    (environment ? providersByEnvironment.get(environment.environmentId) : undefined) ??
    EMPTY_SERVER_PROVIDERS;
  const entries = providerInstanceEntriesFor(providers, settings, null);
  const writable = useEnvironmentsWithScope(connected, AuthSettingsWriteScope);
  const persist = useAtomCommand(serverEnvironment.updateSettings);
  const [saving, setSaving] = useState<RoleKey | null>(null);
  async function save(key: RoleKey, selection: ModelSelection) {
    if (!environment || saving || !writable.has(environment.environmentId)) return;
    setSaving(key);
    await persist({
      environmentId: environment.environmentId,
      input: { patch: { [key]: selection } },
    }).finally(() => setSaving(null));
  }
  const disabled = !environment || !writable.has(environment.environmentId) || saving !== null;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Default models</DialogTitle>
          <DialogDescription>
            Used when this environment starts new chats. Existing chats keep their models. An
            explicit model request overrides these defaults.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-5 px-6 pb-6">
          {connected.length > 1 && (
            <Select
              value={environment?.environmentId ?? ""}
              onValueChange={(value) =>
                setSelectedId(
                  connected.find((entry) => entry.environmentId === value)?.environmentId ?? null,
                )
              }
            >
              <SelectTrigger aria-label="Environment" disabled={saving !== null}>
                <SelectValue>{environment?.label}</SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {connected.map((entry) => (
                  <SelectItem key={entry.environmentId} value={entry.environmentId}>
                    {entry.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          )}
          {!environment ? (
            <p className="text-sm text-muted-foreground">
              Connect an environment to choose its default models.
            </p>
          ) : (
            roles.map(({ key, label }) => {
              const selection = settings[key];
              const active = entries.find((entry) => entry.instanceId === selection.instanceId);
              const models = getCustomModelOptionsByInstance(
                settings,
                providers,
                selection.instanceId,
                selection.model,
              );
              return (
                <div
                  key={key}
                  className="flex min-w-0 flex-wrap items-center justify-between gap-2"
                >
                  <span className="text-sm font-medium">{label}</span>
                  <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                    {saving === key && <Spinner size="sm" />}
                    <ProviderModelPicker
                      environmentId={environment.environmentId}
                      activeInstanceId={selection.instanceId}
                      model={selection.model}
                      lockedProvider={null}
                      instanceEntries={entries}
                      modelOptionsByInstance={models}
                      disabled={disabled}
                      triggerAriaLabel={`${label} default model`}
                      onInstanceModelChange={(instanceId, model) => {
                        void save(key, createModelSelection(instanceId, model));
                      }}
                    />
                    {active && (
                      <TraitsPicker
                        provider={active.driverKind}
                        models={active.models}
                        model={selection.model}
                        modelOptions={selection.options ?? []}
                        allowPromptInjectedEffort={false}
                        planModeEnabled={settings.planModeEnabled}
                        disabled={disabled}
                        onModelOptionsChange={(options) => {
                          void save(
                            key,
                            createModelSelection(selection.instanceId, selection.model, options),
                          );
                        }}
                      />
                    )}
                  </div>
                </div>
              );
            })
          )}
          {environment && !writable.has(environment.environmentId) && (
            <p className="text-sm text-muted-foreground">
              This connection does not allow changing settings.
            </p>
          )}
        </div>
      </DialogPopup>
    </Dialog>
  );
}
