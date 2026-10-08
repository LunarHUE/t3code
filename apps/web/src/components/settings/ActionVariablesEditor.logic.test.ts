import { describe, expect, it } from "vite-plus/test";
import {
  clearSavedActionVariablesDraft,
  actionVariableMapsEqual,
  actionVariableRows,
  effectiveActionVariableMap,
  projectActionVariablesScopeKey,
  validateActionVariableRows,
} from "./ActionVariablesEditor.logic";

describe("action variable row validation", () => {
  it("keeps string values and nested templates intact, including empty values", () => {
    const values = { host: "{{env.user}}@example.com", user: "", constructor: "custom" };
    const result = validateActionVariableRows(actionVariableRows(values));
    expect(result.errors.size).toBe(0);
    expect(result.values).toEqual(values);
    expect(Object.getPrototypeOf(result.values)).toBeNull();
  });

  it("reports duplicate names on both rows and rejects invalid names", () => {
    const result = validateActionVariableRows([
      { id: 4, name: "host", value: "first" },
      { id: 5, name: "host", value: "second" },
      { id: 6, name: "env.host", value: "namespaced" },
      { id: 7, name: "", value: "new" },
      { id: 8, name: "9host", value: "invalid" },
    ]);
    expect([...result.errors.keys()].sort()).toEqual([4, 5, 6, 7, 8]);
  });

  it("compares map contents regardless of row order and detects deleted empty values", () => {
    expect(
      actionVariableMapsEqual({ host: "server", user: "" }, { user: "", host: "server" }),
    ).toBe(true);
    expect(actionVariableMapsEqual({ user: "" }, {})).toBe(false);
    expect(actionVariableMapsEqual({ user: "" }, { user: "changed" })).toBe(false);
  });
});

describe("action variable inheritance", () => {
  const defaults = { host: "default", user: "inherited" };

  it("merges environment overrides per name, preserving explicit empty values", () => {
    expect(effectiveActionVariableMap({ host: "" }, defaults, false)).toEqual({
      host: "",
      user: "inherited",
    });
    expect(effectiveActionVariableMap({}, defaults, false)).toEqual(defaults);
  });

  it("replaces a project map and only inherits when the override is absent", () => {
    expect(effectiveActionVariableMap({ host: "project" }, defaults, true)).toEqual({
      host: "project",
    });
    expect(effectiveActionVariableMap({}, defaults, true)).toEqual({});
    expect(effectiveActionVariableMap(undefined, defaults, true)).toEqual(defaults);
  });
});

describe("variable draft scope identity", () => {
  it("retains a grouped selection regardless of member order", () => {
    expect(projectActionVariablesScopeKey("environment", ["a", "b"])).toBe(
      projectActionVariablesScopeKey("environment", ["b", "a"]),
    );
  });

  it("separates environments, default maps, projects, and checkout selections", () => {
    const scopes = [
      projectActionVariablesScopeKey("one", [null]),
      projectActionVariablesScopeKey("one", ["defaults"]),
      projectActionVariablesScopeKey("two", [null]),
      projectActionVariablesScopeKey("one", ["a", "b"]),
      projectActionVariablesScopeKey("one", ["a,b"]),
      projectActionVariablesScopeKey("one", ["a"]),
    ];
    expect(new Set(scopes).size).toBe(scopes.length);
  });
});

describe("pending variable save completion", () => {
  const saved = { rows: actionVariableRows({ host: "old" }), override: true };
  const otherScope = { rows: actionVariableRows({ host: "other" }), override: true };

  it("clears the saved draft while preserving other scopes", () => {
    expect(clearSavedActionVariablesDraft({ A: saved, B: otherScope }, "A", saved)).toEqual({
      B: otherScope,
    });
  });

  it("preserves edits created after a save started, even when values match", () => {
    const newer = { rows: actionVariableRows({ host: "old" }), override: true };
    const current = { A: newer, B: otherScope };
    expect(clearSavedActionVariablesDraft(current, "A", saved)).toBe(current);
    const edited = { A: { rows: actionVariableRows({ host: "new" }), override: true } };
    expect(clearSavedActionVariablesDraft(edited, "A", saved)).toBe(edited);
  });

  it("leaves discarded drafts alone when their save finishes", () => {
    const current = { B: otherScope };
    expect(clearSavedActionVariablesDraft(current, "A", saved)).toBe(current);
  });
});
