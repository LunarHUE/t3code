export interface ActionVariableRow {
  id: number;
  name: string;
  value: string;
}

export interface ActionVariablesDraft {
  rows: ActionVariableRow[];
  override: boolean;
}

/** A completed save owns only the draft it captured, never edits made afterward. */
export function clearSavedActionVariablesDraft(
  drafts: Record<string, ActionVariablesDraft>,
  key: string,
  saved: ActionVariablesDraft,
) {
  if (drafts[key] !== saved) return drafts;
  const next = { ...drafts };
  delete next[key];
  return next;
}

export function actionVariableRows(values: Readonly<Record<string, string>>) {
  return Object.entries(values).map(([name, value], id) => ({ id, name, value }));
}

/** Project maps replace defaults; environment maps override individual names. */
export function effectiveActionVariableMap(
  values: Readonly<Record<string, string>> | undefined,
  inherited: Readonly<Record<string, string>>,
  inheritAsMap: boolean,
) {
  return inheritAsMap ? (values ?? inherited) : { ...inherited, ...values };
}

export function validateActionVariableRows(rows: readonly ActionVariableRow[]) {
  const names = new Map<string, number>();
  const errors = new Map<number, string>();
  const values: Record<string, string> = Object.create(null);
  for (const row of rows) {
    if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(row.name)) {
      errors.set(row.id, "Start with a letter. Use letters, numbers, and underscores.");
    } else if (names.has(row.name)) {
      errors.set(row.id, "This name is already used.");
      errors.set(names.get(row.name)!, "This name is already used.");
    } else {
      names.set(row.name, row.id);
      values[row.name] = row.value;
    }
  }
  return { values, errors };
}

export function actionVariableMapsEqual(
  left: Readonly<Record<string, string>>,
  right: Readonly<Record<string, string>>,
) {
  return (
    Object.keys(left).length === Object.keys(right).length &&
    Object.entries(left).every(([key, value]) => Object.hasOwn(right, key) && right[key] === value)
  );
}

export function projectActionVariablesScopeKey(
  environmentId: string,
  projectIds: readonly (string | null)[],
) {
  return JSON.stringify(["project", environmentId, [...projectIds].sort()]);
}
