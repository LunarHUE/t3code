import { useAtomSet, useAtomValue } from "@effect/atom-react";
import * as Exit from "effect/Exit";
import type { ProjectScript } from "@t3tools/contracts";
import {
  mergeProjectActions,
  validateProjectActionUrl,
} from "@t3tools/client-runtime/project-actions";
import { resolveProjectScripts } from "@t3tools/shared/projectScripts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { AsyncResult } from "effect/reactivity";
import { useRef, useState } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text, AppTextInput } from "../../components/AppText";
import { ScreenScrollView } from "../../components/ScreenScrollView";
import { uuidv4 } from "../../lib/uuid";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsActionRow } from "./components/SettingsActionRow";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import {
  AndroidSettingsEnvironmentFilter,
  SettingsEnvironmentFilterHeader,
} from "./components/SettingsEnvironmentFilterHeader";
import { useSettingsEnvironmentFilter, type SettingsTarget } from "./settings-environment-filter";

export function SettingsActionsRouteScreen() {
  const insets = useSafeAreaInsets();
  const preferences = useAtomValue(mobilePreferencesAtom);
  const save = useAtomSet(updateMobilePreferencesAtom, { mode: "promiseExit" });
  const [saveError, setSaveError] = useState<string | null>(null);
  const saved = (result: Exit.Exit<unknown, unknown>) => {
    const ok = Exit.isSuccess(result);
    setSaveError(ok ? null : "Could not save action settings. Try again.");
    return ok;
  };
  const { selectedTargets, projectGroups, selectedProjectKey } = useSettingsEnvironmentFilter();
  const globalActions = AsyncResult.isSuccess(preferences)
    ? (preferences.value.globalActions ?? [])
    : [];
  const variables = AsyncResult.isSuccess(preferences)
    ? (preferences.value.environmentActionVariables ?? {})
    : {};
  const members = projectGroups.find((group) => group.key === selectedProjectKey)?.members ?? [];
  const ready = AsyncResult.isSuccess(preferences) && !preferences.waiting;
  return (
    <>
      <SettingsEnvironmentFilterHeader />
      <SettingsScreen title="Actions" trailing={<AndroidSettingsEnvironmentFilter />}>
        <ScreenScrollView
          className="flex-1"
          contentInsetAdjustmentBehavior="automatic"
          contentContainerClassName="gap-4 px-5 pt-4"
          contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
        >
          {saveError ? <Text className="text-sm text-danger-foreground">{saveError}</Text> : null}
          <SettingsSection title="Global actions">
            <Text className="px-4 pt-4 text-sm text-foreground-muted">
              Available in every project on this device. URL actions open on this device; commands
              run on the environment.
            </Text>
            {globalActions.map((action) => (
              <ActionEditor
                key={action.id}
                action={action}
                disabled={!ready}
                onSave={async (next) => {
                  const result = await save({
                    transform: (current) => ({
                      globalActions: (current.globalActions ?? []).map((entry) =>
                        entry.id === next.id ? next : entry,
                      ),
                    }),
                  });
                  return saved(result);
                }}
                onRemove={() => {
                  void save({
                    transform: (current) => ({
                      globalActions: (current.globalActions ?? []).filter(
                        (entry) => entry.id !== action.id,
                      ),
                    }),
                  }).then(saved);
                }}
              />
            ))}
            <ActionEditor
              key="new"
              disabled={!ready}
              onSave={async (action) => {
                const result = await save({
                  transform: (current) => ({
                    globalActions: [...(current.globalActions ?? []), action],
                  }),
                });
                return saved(result);
              }}
            />
          </SettingsSection>
          {selectedTargets.map((target) => (
            <SettingsSection key={target.environmentId} title={`${target.label} variables`}>
              <VariablesEditor
                key={JSON.stringify(variables[target.environmentId] ?? {})}
                disabled={!ready}
                prefix="env"
                values={variables[target.environmentId] ?? {}}
                defaults={target.serverConfig.environmentVariables ?? {}}
                onSave={async (next) => {
                  const result = await save({
                    transform: (current) => ({
                      environmentActionVariables: {
                        ...current.environmentActionVariables,
                        [target.environmentId]: next,
                      },
                    }),
                  });
                  return saved(result);
                }}
              />
            </SettingsSection>
          ))}
          {members.flatMap(({ project }) => {
            const target = selectedTargets.find(
              (entry) => entry.environmentId === project.environmentId,
            );
            return target
              ? [
                  <ProjectActions
                    key={`${project.environmentId}:${project.id}`}
                    project={project}
                    target={target}
                    globalActions={globalActions}
                  />,
                ]
              : [];
          })}
          {selectedProjectKey === null ? (
            <Text className="px-2 text-sm text-foreground-muted">
              Choose a project in the filter to override or hide its global actions and set project
              variables.
            </Text>
          ) : null}
        </ScreenScrollView>
      </SettingsScreen>
    </>
  );
}

function Field(props: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  multiline?: boolean;
  disabled?: boolean;
}) {
  return (
    <View className="gap-1">
      <Text className="text-sm text-foreground-muted">{props.label}</Text>
      <AppTextInput
        accessibilityLabel={props.label}
        value={props.value}
        onChangeText={props.onChange}
        multiline={props.multiline}
        autoCapitalize="none"
        autoCorrect={false}
        editable={!props.disabled}
        className="min-h-11 rounded-xl bg-card px-3 py-2 text-base text-foreground"
      />
    </View>
  );
}

function ActionEditor(props: {
  action?: ProjectScript;
  disabled?: boolean;
  onSave: (action: ProjectScript) => Promise<boolean>;
  onRemove?: () => void;
}) {
  const [draft, setDraft] = useState<ProjectScript | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const begin = () =>
    setDraft(
      props.action ?? {
        id: uuidv4(),
        name: "",
        command: "",
        kind: "command",
        icon: "play",
        runOnWorktreeCreate: false,
      },
    );
  if (!draft)
    return (
      <SettingsActionRow
        icon={props.action?.kind === "url" ? "link" : "play"}
        label={props.action ? `Edit ${props.action.name}` : "Add action"}
        disabled={props.disabled}
        onPress={begin}
      />
    );
  return (
    <View className="gap-3 border-t border-border-subtle p-4">
      <Field
        label="Action name"
        value={draft.name}
        onChange={(name) => setDraft({ ...draft, name })}
        disabled={pending}
      />
      <SettingsActionRow
        icon={draft.kind === "url" ? "link" : "play"}
        label={`Kind: ${draft.kind === "url" ? "URL" : "Command"}. Tap to change`}
        disabled={pending}
        onPress={() =>
          setDraft({
            ...draft,
            kind: draft.kind === "url" ? "command" : "url",
            runOnWorktreeCreate: false,
          })
        }
      />
      <Field
        label={draft.kind === "url" ? "URL template" : "Command template"}
        value={draft.command}
        multiline
        disabled={pending}
        onChange={(command) => setDraft({ ...draft, command })}
      />
      <Text className="text-sm text-foreground-muted">
        Use {"{{project.name}}"}, {"{{project.root}}"}, {"{{env.sshName}}"}, or your own variables.
      </Text>
      {error ? <Text className="text-sm text-danger-foreground">{error}</Text> : null}
      <SettingsActionRow
        icon="checkmark"
        label="Save action"
        disabled={pending || !draft.name.trim() || !draft.command.trim()}
        loading={pending}
        onPress={() => {
          setError(null);
          try {
            // A templated scheme is validated against the allowlist when clicked.
            if (draft.kind === "url" && !/^\s*\{\{[^{}]+\}\}\s*:/.test(draft.command))
              validateProjectActionUrl(draft.command.replace(/\{\{[^{}]+\}\}/g, "value"));
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : "Invalid URL");
            return;
          }
          setPending(true);
          void props
            .onSave({ ...draft, name: draft.name.trim(), command: draft.command.trim() })
            .then((saved) => {
              if (saved) setDraft(null);
            })
            .finally(() => setPending(false));
        }}
      />
      <SettingsActionRow
        icon="xmark"
        label="Cancel"
        disabled={pending}
        onPress={() => setDraft(null)}
      />
      {props.onRemove ? (
        <SettingsActionRow
          icon="trash"
          label="Remove action"
          tone="danger"
          disabled={pending}
          onPress={props.onRemove}
        />
      ) : null}
    </View>
  );
}

function VariablesEditor(props: {
  prefix: string;
  values: Readonly<Record<string, string>>;
  defaults?: Readonly<Record<string, string>>;
  onSave: (values: Readonly<Record<string, string>>) => Promise<boolean>;
  disabled?: boolean;
}) {
  const [values, setValues] = useState({ ...props.values });
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <View className="gap-3 p-4">
      {Object.entries(props.defaults ?? {}).map(([key, entry]) => (
        <Text key={key} className="text-sm text-foreground-muted">
          Server default: {props.prefix}.{key} = {entry}
        </Text>
      ))}
      {Object.entries(values).map(([key, entry]) => (
        <View key={key} className="gap-1">
          <Field
            label={`${props.prefix}.${key}`}
            value={entry}
            disabled={pending || props.disabled}
            onChange={(next) => setValues({ ...values, [key]: next })}
          />
          <SettingsActionRow
            icon="trash"
            label={`Remove ${key}`}
            disabled={pending || props.disabled}
            onPress={() =>
              setValues(
                Object.fromEntries(Object.entries(values).filter(([entryKey]) => entryKey !== key)),
              )
            }
          />
        </View>
      ))}
      <Field
        label="Variable name"
        value={name}
        onChange={setName}
        disabled={pending || props.disabled}
      />
      <Field
        label="Variable value"
        value={value}
        onChange={setValue}
        disabled={pending || props.disabled}
      />
      {error ? <Text className="text-sm text-danger-foreground">{error}</Text> : null}
      <SettingsActionRow
        icon="checkmark"
        label="Save variables"
        loading={pending}
        disabled={pending || props.disabled}
        onPress={() => {
          if (name && !/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) {
            setError(
              "Use a variable name starting with a letter, followed by letters, numbers, or underscores.",
            );
            return;
          }
          setError(null);
          setPending(true);
          const next = name ? { ...values, [name]: value } : values;
          void props
            .onSave(next)
            .then((saved) => {
              if (saved) {
                setValues(next);
                setName("");
                setValue("");
              }
            })
            .finally(() => setPending(false));
        }}
      />
    </View>
  );
}

function ProjectActions(props: {
  project: EnvironmentProject;
  target: SettingsTarget;
  globalActions: readonly ProjectScript[];
}) {
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: true });
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const overrides = props.target.serverConfig.settings.projectSettingsOverrides;
  const current = overrides[props.project.id] ?? {};
  const resolvedSettings = resolveProjectSettings(
    props.target.serverConfig.settings,
    props.project.id,
    props.project,
  ).settings;
  const hidden = resolvedSettings.hiddenGlobalActionIds;
  const supported =
    props.target.serverConfig.environment.capabilities.projectSettingsOverrides === true;
  const disabled = !supported || pending;
  const patch = async (next: {
    actionVariables?: Readonly<Record<string, string>>;
    hiddenGlobalActionIds?: readonly string[];
    defaultProjectScripts?: readonly ProjectScript[];
  }) => {
    if (pendingRef.current || !supported) return false;
    pendingRef.current = true;
    setPending(true);
    try {
      const result = await updateSettings({
        environmentId: props.project.environmentId,
        input: {
          patch: { projectSettingsOverrides: { [props.project.id]: { ...current, ...next } } },
        },
      });
      return !AsyncResult.isFailure(result);
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  };
  const scripts = resolveProjectScripts(props.target.serverConfig.settings, props.project);
  const saveScripts = (defaultProjectScripts: readonly ProjectScript[]) =>
    patch({ defaultProjectScripts });
  return (
    <SettingsSection title={`${props.project.title} · ${props.target.label}`}>
      {!supported ? (
        <Text className="p-4 text-sm text-foreground-muted">
          Update this environment to edit project action settings.
        </Text>
      ) : null}
      <VariablesEditor
        key={JSON.stringify(resolvedSettings.actionVariables)}
        prefix="project"
        values={resolvedSettings.actionVariables}
        disabled={disabled}
        onSave={(actionVariables) => patch({ actionVariables })}
      />
      {mergeProjectActions(props.globalActions, scripts, hidden).map(
        ({ action, source, hidden: isHidden }) => (
          <View key={action.id} className="border-t border-border-subtle">
            <Text className="px-4 pt-3 text-base text-foreground">
              {action.name} ·{" "}
              {isHidden
                ? "Hidden"
                : source === "override"
                  ? "Overridden"
                  : source === "global"
                    ? "Global"
                    : "Project"}
            </Text>
            <ActionEditor
              action={action}
              disabled={disabled}
              onSave={(next) =>
                saveScripts([...scripts.filter((entry) => entry.id !== next.id), next])
              }
            />
            {source !== "project" ? (
              <>
                <SettingsActionRow
                  icon="eye"
                  label={isHidden ? "Show action" : "Hide action"}
                  disabled={disabled}
                  onPress={() => {
                    void patch({
                      hiddenGlobalActionIds: isHidden
                        ? hidden.filter((id) => id !== action.id)
                        : [...hidden, action.id],
                    });
                  }}
                />
                {isHidden || source === "override" ? (
                  <SettingsActionRow
                    icon="arrow.clockwise"
                    label="Reset to global"
                    disabled={disabled}
                    onPress={() => {
                      void (async () => {
                        const hiddenGlobalActionIds = hidden.filter((id) => id !== action.id);
                        const nextScripts = scripts.filter((entry) => entry.id !== action.id);
                        if (source === "override") {
                          await patch({
                            hiddenGlobalActionIds,
                            defaultProjectScripts: nextScripts,
                          });
                        } else {
                          if (isHidden) await patch({ hiddenGlobalActionIds });
                        }
                      })();
                    }}
                  />
                ) : null}
              </>
            ) : null}
          </View>
        ),
      )}
    </SettingsSection>
  );
}
