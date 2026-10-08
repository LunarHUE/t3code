import { useId, useState } from "react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { useActionVariablesDrafts } from "./ActionVariablesDraftContext";
import {
  actionVariableMapsEqual,
  actionVariableRows,
  effectiveActionVariableMap,
  validateActionVariableRows,
} from "./ActionVariablesEditor.logic";

const EMPTY_VARIABLES: Readonly<Record<string, string>> = {};

/** Named variables with explicit overrides and scope-local unsaved edits. */
export function ActionVariablesEditor({
  scopeKey,
  namespace,
  values,
  inherited = EMPTY_VARIABLES,
  inheritedSource = "Server default",
  overrideSource = "Device override",
  inheritAsMap = false,
  disabled = false,
  preview,
  onSave,
}: {
  scopeKey: string;
  namespace: "env" | "project";
  values: Readonly<Record<string, string>> | undefined;
  inherited?: Readonly<Record<string, string>> | undefined;
  inheritedSource?: string;
  overrideSource?: string;
  inheritAsMap?: boolean;
  disabled?: boolean;
  preview?: (values: Readonly<Record<string, string>>, name: string) => string;
  onSave: (values: Record<string, string> | undefined) => Promise<unknown>;
}) {
  const { drafts, setDraft, savingScopes, saveDraft } = useActionVariablesDrafts();
  const draft = drafts[scopeKey];
  const override = draft?.override ?? values !== undefined;
  const rows = draft?.rows ?? actionVariableRows(values ?? {});
  const { values: editedValues, errors } = validateActionVariableRows(rows);
  const effectiveValues = effectiveActionVariableMap(
    override ? editedValues : undefined,
    inherited,
    inheritAsMap,
  );
  const inheritedRows = Object.entries(inherited).filter(
    ([name]) => !Object.hasOwn(editedValues, name) && !(inheritAsMap && override),
  );
  const dirty =
    draft !== undefined &&
    (errors.size > 0 ||
      override !== (values !== undefined) ||
      !actionVariableMapsEqual(editedValues, values ?? {}));
  const [error, setError] = useState<string | null>(null);
  const saving = savingScopes.has(scopeKey);
  const errorId = useId();
  const locked = disabled || saving;
  const previewErrors = new Map<string, string>();
  const previews = new Map<string, string>();
  if (preview && errors.size === 0) {
    for (const name of Object.keys(effectiveValues)) {
      try {
        previews.set(name, preview(effectiveValues, name));
      } catch (cause) {
        previewErrors.set(
          name,
          cause instanceof Error ? cause.message : "Unable to resolve value.",
        );
      }
    }
  }
  function updateRows(next: typeof rows) {
    setError(null);
    setDraft(scopeKey, { rows: next, override: true });
  }
  function overrideInherited(name: string, value: string) {
    const next = inheritAsMap && !override ? actionVariableRows(inherited) : rows;
    updateRows(
      inheritAsMap && !override
        ? next
        : [...next, { id: Math.max(-1, ...next.map((row) => row.id)) + 1, name, value }],
    );
  }
  function valueDetails(name: string, value: string, rowError?: string, rowId?: number) {
    const message = rowError ?? previewErrors.get(name);
    const resolved = previews.get(name);
    return (
      <>
        {message && (
          <p
            id={`${errorId}-${rowId ?? name}`}
            role="alert"
            className="mt-1 text-xs text-destructive"
          >
            {message}
          </p>
        )}
        {!message && resolved !== undefined && resolved !== value && (
          <p className="mt-1 break-all text-xs text-muted-foreground">
            Resolves to <span className="font-mono">{resolved}</span>
          </p>
        )}
      </>
    );
  }
  return (
    <div className="space-y-3 px-3 sm:px-4">
      <div
        className="hidden grid-cols-[minmax(0,1fr)_minmax(0,2fr)_9rem] gap-3 border-b border-border/60 pb-2 text-xs text-muted-foreground sm:grid"
        aria-hidden
      >
        <span>Name</span>
        <span>Value</span>
        <span>Source</span>
      </div>
      <div className="divide-y divide-border/60">
        {rows.map((row) => (
          <div
            key={row.id}
            className="grid min-w-0 gap-2 py-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_9rem] sm:gap-3"
          >
            <div>
              <Input
                size="compact"
                font="mono"
                aria-label={`Name for ${namespace}.${row.name || "new variable"}`}
                aria-invalid={errors.has(row.id)}
                aria-describedby={errors.has(row.id) ? `${errorId}-${row.id}` : undefined}
                disabled={locked}
                value={row.name}
                onChange={(event) =>
                  updateRows(
                    rows.map((item) =>
                      item.id === row.id ? { ...item, name: event.target.value } : item,
                    ),
                  )
                }
              />
              <p className="mt-1 text-xs text-muted-foreground">
                {namespace}.{row.name || "name"}
              </p>
            </div>
            <div className="min-w-0">
              <Input
                size="compact"
                font="mono"
                aria-label={`Value for ${namespace}.${row.name || "new variable"}`}
                aria-invalid={previewErrors.has(row.name)}
                aria-describedby={previewErrors.has(row.name) ? `${errorId}-${row.id}` : undefined}
                disabled={locked}
                value={row.value}
                onChange={(event) =>
                  updateRows(
                    rows.map((item) =>
                      item.id === row.id ? { ...item, value: event.target.value } : item,
                    ),
                  )
                }
              />
              {valueDetails(row.name, row.value, errors.get(row.id), row.id)}
            </div>
            <div className="flex flex-wrap items-start gap-1 sm:flex-col">
              <span className="text-xs text-muted-foreground">{overrideSource}</span>
              <Button
                size="xs"
                variant="ghost"
                aria-label={`${Object.hasOwn(inherited, row.name) ? "Reset" : "Delete"} ${namespace}.${row.name}`}
                disabled={locked}
                onClick={() => {
                  if (inheritAsMap && Object.hasOwn(inherited, row.name)) {
                    updateRows(
                      rows.map((item) =>
                        item.id === row.id ? { ...item, value: inherited[row.name]! } : item,
                      ),
                    );
                  } else updateRows(rows.filter((item) => item.id !== row.id));
                }}
              >
                {Object.hasOwn(inherited, row.name) ? "Reset" : "Delete"}
              </Button>
              {inheritAsMap && Object.hasOwn(inherited, row.name) && (
                <Button
                  size="xs"
                  variant="ghost"
                  aria-label={`Delete ${namespace}.${row.name}`}
                  disabled={locked}
                  onClick={() => updateRows(rows.filter((item) => item.id !== row.id))}
                >
                  Delete
                </Button>
              )}
            </div>
          </div>
        ))}
        {inheritedRows.map(([name, value]) => (
          <div
            key={name}
            className="grid min-w-0 gap-2 py-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_9rem] sm:gap-3"
          >
            <div className="break-all font-mono text-xs">
              {namespace}.{name}
            </div>
            <div className="min-w-0">
              <p className="break-all font-mono text-xs">{value || "(empty)"}</p>
              {valueDetails(name, value)}
            </div>
            <div className="flex flex-wrap items-start gap-1 sm:flex-col">
              <span className="text-xs text-muted-foreground">{inheritedSource}</span>
              <Button
                size="xs"
                variant="ghost"
                aria-label={`Override ${namespace}.${name}`}
                disabled={locked}
                onClick={() => overrideInherited(name, value)}
              >
                Override
              </Button>
            </div>
          </div>
        ))}
      </div>
      {rows.length === 0 && inheritedRows.length === 0 && (
        <p className="text-xs text-muted-foreground">
          No {namespace === "env" ? "environment" : "project"} variables yet.
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="xs"
          variant="ghost"
          aria-label={`Add ${namespace === "env" ? "environment" : "project"} variable`}
          disabled={locked}
          onClick={() => {
            const next = inheritAsMap && !override ? actionVariableRows(inherited) : rows;
            updateRows([
              ...next,
              { id: Math.max(-1, ...next.map((row) => row.id)) + 1, name: "", value: "" },
            ]);
          }}
        >
          Add variable
        </Button>
        {inheritAsMap && override && (
          <Button
            size="xs"
            variant="ghost"
            disabled={locked}
            onClick={() => setDraft(scopeKey, { rows: [], override: false })}
          >
            Use inherited map
          </Button>
        )}
        {dirty && (
          <>
            <Button
              size="xs"
              variant="outline"
              disabled={locked || errors.size > 0 || previewErrors.size > 0}
              onClick={async () => {
                if (!draft) return;
                try {
                  await saveDraft(scopeKey, draft, () =>
                    onSave(override ? editedValues : undefined),
                  );
                  setError(null);
                } catch (cause) {
                  setError(cause instanceof Error ? cause.message : "Unable to save variables.");
                }
              }}
            >
              Save variables
            </Button>
            <Button
              size="xs"
              variant="ghost"
              disabled={saving}
              onClick={() => {
                setDraft(scopeKey, null);
                setError(null);
              }}
            >
              Discard changes
            </Button>
            <span role="status" className="text-xs text-muted-foreground">
              Unsaved changes. Kept when switching scope.
            </span>
          </>
        )}
      </div>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
