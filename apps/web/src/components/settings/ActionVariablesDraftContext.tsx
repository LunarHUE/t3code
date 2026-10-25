import { createContext, useContext, useState, useRef, type ReactNode } from "react";
import {
  clearSavedActionVariablesDraft,
  type ActionVariablesDraft,
} from "./ActionVariablesEditor.logic";

const ActionVariablesDraftContext = createContext<{
  drafts: Readonly<Record<string, ActionVariablesDraft>>;
  setDraft: (key: string, draft: ActionVariablesDraft | null) => void;
  savingScopes: ReadonlySet<string>;
  saveDraft: (
    key: string,
    draft: ActionVariablesDraft,
    save: () => Promise<unknown>,
  ) => Promise<void>;
} | null>(null);

/** Survives the settings content's scope remount, with a separate draft for each target. */
export function ActionVariablesDraftProvider({ children }: { children: ReactNode }) {
  const [drafts, setDrafts] = useState<Record<string, ActionVariablesDraft>>({});
  const pendingSaves = useRef(new Set<string>());
  const [savingScopes, setSavingScopes] = useState<ReadonlySet<string>>(new Set());
  const setDraft = (key: string, draft: ActionVariablesDraft | null) => {
    setDrafts((current) => {
      const next = { ...current };
      if (draft) next[key] = draft;
      else delete next[key];
      return next;
    });
  };
  const saveDraft = async (
    key: string,
    draft: ActionVariablesDraft,
    save: () => Promise<unknown>,
  ) => {
    if (pendingSaves.current.has(key)) return;
    pendingSaves.current.add(key);
    setSavingScopes(new Set(pendingSaves.current));
    await Promise.resolve()
      .then(save)
      .then(() => {
        setDrafts((current) => clearSavedActionVariablesDraft(current, key, draft));
      })
      .finally(() => {
        pendingSaves.current.delete(key);
        setSavingScopes(new Set(pendingSaves.current));
      });
  };
  const value = { drafts, setDraft, savingScopes, saveDraft };
  return <ActionVariablesDraftContext value={value}>{children}</ActionVariablesDraftContext>;
}

export function useActionVariablesDrafts() {
  const context = useContext(ActionVariablesDraftContext);
  if (!context) throw new Error("Action variable editors need their draft provider.");
  return context;
}
