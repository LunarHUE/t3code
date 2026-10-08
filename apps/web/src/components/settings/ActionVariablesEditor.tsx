import { useState } from "react";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";

/** Edit named action variables without silently accepting malformed values. */
export function ActionVariablesEditor({
  values,
  onSave,
}: {
  values: Readonly<Record<string, string>>;
  onSave: (values: Record<string, string>) => Promise<unknown>;
}) {
  const serialized = JSON.stringify(values, null, 2);
  const [draft, setDraft] = useState({ source: serialized, text: serialized });
  const text = draft.source === serialized ? draft.text : serialized;
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  return (
    <div className="space-y-2">
      <Textarea
        aria-label="Action variables"
        value={text}
        onChange={(event) => setDraft({ source: serialized, text: event.target.value })}
      />
      {error && <p className="text-sm text-destructive">{error}</p>}
      <Button
        size="xs"
        variant="outline"
        disabled={saving}
        onClick={async () => {
          setSaving(true);
          try {
            const parsed: unknown = JSON.parse(text);
            if (
              typeof parsed !== "object" ||
              parsed === null ||
              Array.isArray(parsed) ||
              Object.entries(parsed).some(
                ([key, value]) => !/^[a-zA-Z][a-zA-Z0-9_]*$/.test(key) || typeof value !== "string",
              )
            ) {
              throw new Error("Use a JSON object with variable names and string values.");
            }
            await onSave(parsed as Record<string, string>);
            setError(null);
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : "Unable to save variables.");
          } finally {
            setSaving(false);
          }
        }}
      >
        Save variables
      </Button>
    </div>
  );
}
