import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";
import { useClientSettings, persistClientSettingsUpdate } from "../../hooks/useSettings";
import { buildProjectScript, nextProjectScriptId } from "../../projectScripts";
import { useEnvironments } from "../../state/environments";
import {
  EMPTY_PROJECT_SCRIPT_INPUT,
  editorRequestForScript,
  ProjectScriptEditorDialog,
  type ProjectScriptEditorRequest,
} from "../projectScriptEditor";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { ActionVariablesEditor } from "./ActionVariablesEditor";
import { ProjectActionsList } from "./ProjectActionsList";
import { SettingsRow, SettingsSection } from "./settingsLayout";

export function GlobalActionsSettings() {
  const { globalActions, environmentActionVariables } = useClientSettings();
  const { environments } = useEnvironments();
  const [request, setRequest] = useState<ProjectScriptEditorRequest | null>(null);
  return (
    <SettingsSection id="global-actions" title="Global actions">
      <SettingsRow
        title="Actions in every project"
        description="Stored on this device and available across all connected environments. Projects can override or hide each action."
        control={
          <Button
            size="xs"
            variant="outline"
            onClick={() => setRequest({ scriptId: null, initial: EMPTY_PROJECT_SCRIPT_INPUT })}
          >
            Add global action
          </Button>
        }
      />
      <ProjectActionsList
        scripts={globalActions}
        keybindings={DEFAULT_RESOLVED_KEYBINDINGS}
        disabled={false}
        onEdit={(script) =>
          setRequest(editorRequestForScript(script, DEFAULT_RESOLVED_KEYBINDINGS))
        }
      />
      {environments.map((environment) => (
        <SettingsRow
          key={environment.environmentId}
          title={`Action variables · ${environment.label}`}
          description={
            <>
              Override defaults for this environment on this device using {"{{env.sshName}}"} and
              other named variables. Server defaults:{" "}
              {JSON.stringify(environment.serverConfig?.environmentVariables ?? {})}
            </>
          }
          control={
            <ActionVariablesEditor
              values={environmentActionVariables[environment.environmentId] ?? {}}
              onSave={(values) =>
                persistClientSettingsUpdate((current) => ({
                  ...current,
                  environmentActionVariables: {
                    ...current.environmentActionVariables,
                    [environment.environmentId]: values,
                  },
                }))
              }
            />
          }
        />
      ))}
      <ProjectScriptEditorDialog
        showKeybinding={false}
        showSetup={false}
        request={request}
        scripts={globalActions}
        onClose={() => setRequest(null)}
        onDelete={(id) => {
          void persistClientSettingsUpdate((current) => ({
            ...current,
            globalActions: current.globalActions.filter((action) => action.id !== id),
          })).catch((error: unknown) =>
            toastManager.add({
              type: "error",
              title: "Action not deleted",
              description: error instanceof Error ? error.message : "Unable to save settings.",
            }),
          );
        }}
        onSubmit={async (id, input) => {
          await persistClientSettingsUpdate((current) => {
            const next = buildProjectScript(
              id ??
                nextProjectScriptId(
                  input.name,
                  current.globalActions.map((action) => action.id),
                ),
              input,
            );
            return {
              ...current,
              globalActions:
                id === null
                  ? [...current.globalActions, next]
                  : current.globalActions.map((action) => (action.id === id ? next : action)),
            };
          });
          return AsyncResult.success(undefined);
        }}
      />
    </SettingsSection>
  );
}
