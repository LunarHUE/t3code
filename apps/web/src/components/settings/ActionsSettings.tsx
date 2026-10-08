import {
  resolveProjectActionValue,
  type ProjectActionContext,
} from "@t3tools/client-runtime/project-actions";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { clearProjectSettingsOverrides } from "@t3tools/shared/projectSettings";
import { useClientSettings, persistClientSettingsUpdate } from "../../hooks/useSettings";
import { useEnvironments } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { useActionVariablesDrafts } from "./ActionVariablesDraftContext";
import {
  projectActionVariablesScopeKey,
  validateActionVariableRows,
} from "./ActionVariablesEditor.logic";
import { ActionVariablesEditor } from "./ActionVariablesEditor";
import { GlobalActionsSettings } from "./GlobalActionsSettings";
import { ProjectActionsSettings } from "./ProjectActionsSettings";
import { useSettingsScope } from "./SettingsScopeContext";
import {
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
  SettingsSearchTarget,
} from "./settingsLayout";

export function ActionsSettings() {
  const { scope, target, targets } = useSettingsScope();
  const { environments } = useEnvironments();
  const settings = useClientSettings();
  const { drafts } = useActionVariablesDrafts();
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const environment = environments.find((entry) => entry.environmentId === target?.environmentId);
  const config = environment?.serverConfig;
  const projectScope = scope.kind === "project" || scope.kind === "checkout";
  const canSaveProject =
    !projectScope || config?.environment.capabilities.projectSettingsOverrides === true;
  const projectValues = target?.projectId
    ? config?.settings.projectSettingsOverrides[target.projectId]?.actionVariables
    : config?.settings.actionVariables;

  const environmentDraft = target ? drafts[`env:${target.environmentId}`] : undefined;
  const environmentValues = environmentDraft
    ? validateActionVariableRows(environmentDraft.rows).values
    : target
      ? (settings.environmentActionVariables[target.environmentId] ?? {})
      : {};
  const member = projectScope
    ? scope.members.find((entry) => entry.id === target?.projectId)
    : undefined;
  const context: ProjectActionContext = {
    project: {
      id: target?.projectId ?? "{{project.id}}",
      name: member?.title ?? "{{project.name}}",
      root: member?.workspaceRoot ?? "{{project.root}}",
    },
    environment: { id: target?.environmentId ?? "", label: environment?.label ?? "" },
    projectVariables: target?.settings.actionVariables,
    environmentDefaults: config?.environmentVariables,
    environmentOverrides: environmentValues,
  };

  async function saveProjectVariables(values: Record<string, string> | undefined) {
    if (!config || !target)
      throw new Error("Connect to the selected environment to save variables.");
    if (!canSaveProject) throw new Error("Update this environment to save project variables.");
    for (const candidate of targets) {
      const input = candidate.projectId
        ? {
            patch: {
              projectSettingsOverrides: {
                [candidate.projectId]:
                  values === undefined
                    ? clearProjectSettingsOverrides(config.settings, candidate.projectId, [
                        "actionVariables",
                      ])
                    : {
                        ...config.settings.projectSettingsOverrides[candidate.projectId],
                        actionVariables: values,
                      },
              },
            },
          }
        : { patch: { actionVariables: values ?? {} } };
      const result = await updateSettings({ environmentId: candidate.environmentId, input });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
    }
  }

  return (
    <SettingsPageContainer>
      <GlobalActionsSettings />
      {target && config ? (
        <>
          <ProjectActionsSettings />
          <SettingsSection id="action-variables" title="Variables">
            <SettingsRow
              title="Environment variables"
              description={
                <>
                  Available as <code>{"{{env.name}}"}</code>. Server defaults are read-only until
                  overridden on this device. Values can reference other env.* variables.
                </>
              }
            />
            <ActionVariablesEditor
              scopeKey={`env:${target.environmentId}`}
              namespace="env"
              values={settings.environmentActionVariables[target.environmentId] ?? {}}
              inherited={config.environmentVariables}
              preview={(values, name) =>
                resolveProjectActionValue(
                  `{{env.${name}}}`,
                  { ...context, environmentOverrides: values },
                  "environment",
                )
              }
              onSave={(values) =>
                persistClientSettingsUpdate((current) => ({
                  ...current,
                  environmentActionVariables: {
                    ...current.environmentActionVariables,
                    [target.environmentId]: values ?? {},
                  },
                }))
              }
            />
            {environmentDraft && (
              <p className="px-3 text-xs text-muted-foreground sm:px-4">
                Previews include unsaved environment values. Save those changes before using them in
                actions.
              </p>
            )}
            <SettingsRow
              mixed={targets.some(
                (entry) =>
                  JSON.stringify(entry.settings.actionVariables) !==
                  JSON.stringify(target.settings.actionVariables),
              )}
              serverScoped
              settingKeys={["actionVariables"]}
              title={projectScope ? "Project variables" : "Project variable defaults"}
              description={
                <>
                  Available as <code>{"{{project.name}}"}</code>.{" "}
                  {projectScope
                    ? "An override replaces the inherited map for the selected checkouts. Use inherited map to reset the whole override."
                    : "Inherited by projects on this environment until they override the map."}
                </>
              }
            />
            {!canSaveProject && (
              <p className="text-xs text-muted-foreground">
                Update this environment to edit project variables.
              </p>
            )}
            <ActionVariablesEditor
              scopeKey={projectActionVariablesScopeKey(
                target.environmentId,
                targets.map((entry) => entry.projectId),
              )}
              namespace="project"
              values={projectValues}
              inherited={projectScope ? config.settings.actionVariables : {}}
              inheritAsMap={projectScope}
              preview={(values, name) =>
                resolveProjectActionValue(`{{project.${name}}}`, {
                  ...context,
                  projectVariables: values,
                })
              }
              inheritedSource="Environment default"
              overrideSource={projectScope ? "Project override" : "Environment default"}
              disabled={!canSaveProject}
              onSave={saveProjectVariables}
            />
            <p className="text-xs text-muted-foreground">
              Values can reference other variables, such as <code>{"{{env.host}}"}</code> or{" "}
              <code>{"{{project.root}}"}</code>. Project and environment names are separate.
            </p>
          </SettingsSection>
        </>
      ) : (
        <SettingsSection id="project-actions" title="Environment actions and variables">
          <SettingsSearchTarget id="action-variables">
            <p className="px-3 text-sm text-muted-foreground sm:px-4">
              {scope.kind === "unavailable"
                ? scope.message
                : environments.length === 0
                  ? "Connect an environment to configure its actions and variables."
                  : "Connect to the selected environment to configure its actions and variables."}
            </p>
          </SettingsSearchTarget>
        </SettingsSection>
      )}
    </SettingsPageContainer>
  );
}
