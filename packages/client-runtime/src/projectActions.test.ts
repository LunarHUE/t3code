import { describe, expect, it } from "vite-plus/test";
import type { ProjectScript } from "@t3tools/contracts";
import {
  mergeProjectActions,
  resolveProjectAction,
  resolveProjectActionValue,
  validateProjectActionUrl,
  type ProjectActionContext,
} from "./projectActions.ts";

const action = (
  command: string,
  kind: "url" | "command" = "command",
  id = "editor",
): ProjectScript => ({
  id,
  name: "Open editor",
  command,
  kind,
  icon: "play",
  runOnWorktreeCreate: false,
});
const context: ProjectActionContext = {
  project: { id: "project-1", name: "abstract", root: "/repos/abstract" },
  environment: { id: "dev-1", label: "Development" },
  environmentDefaults: { sshName: "dev1" },
};

describe("project actions", () => {
  it("resolves the SSH example with current project and environment values", () => {
    expect(
      resolveProjectAction(
        action(
          "vscode://vscode-remote/ssh-remote+{{project.name}}.{{env.sshName}}.repos/workspace?windowId=_blank",
          "url",
        ),
        context,
      ),
    ).toBe("vscode://vscode-remote/ssh-remote+abstract.dev1.repos/workspace?windowId=_blank");
  });
  it("prefers project variables over built-ins and client overrides over server defaults", () => {
    const resolved = resolveProjectAction(
      action(
        "https://example.test/{{project.name}}/{{env.sshName}}/{{project.id}}/{{environment.id}}/{{environment.label}}/{{project.root}}",
        "url",
      ),
      {
        ...context,
        projectVariables: { name: "alias" },
        environmentOverrides: { sshName: "override" },
      },
    );
    expect(resolved).toBe(
      "https://example.test/alias/override/project-1/dev-1/Development/%2Frepos%2Fabstract",
    );
    expect(
      resolveProjectAction(action("https://example.test/{{env.sshName}}", "url"), {
        ...context,
        environmentOverrides: { sshName: "" },
      }),
    ).toBe("https://example.test/");
  });
  it("encodes substituted delimiters in host and path without changing template delimiters", () => {
    const resolved = resolveProjectAction(
      action("vscode://vscode-remote/ssh-remote+{{project.name}}.{{env.sshName}}/workspace", "url"),
      {
        ...context,
        project: { ...context.project, name: "a b/c?x" },
      },
    );
    expect(resolved).toBe("vscode://vscode-remote/ssh-remote+a%20b%2Fc%3Fx.dev1/workspace");
    expect(new URL(resolved).search).toBe("");
  });
  it.each(["vscode", "vscode-insiders", "cursor", "http", "https"])("allows %s URLs", (scheme) => {
    expect(validateProjectActionUrl(`${scheme}://example.test/workspace`)).toBe(
      `${scheme}://example.test/workspace`,
    );
  });
  it.each(["file", "javascript", "data", "custom", "mailto"])(
    "refuses %s URLs from project actions too",
    (scheme) => {
      expect(() =>
        resolveProjectAction(action(`${scheme}://example.test/workspace`, "url"), context),
      ).toThrow("scheme");
    },
  );
  it.each([
    "project.missing",
    "env.missing",
    "environment.missing",
    "project.name.extra",
    "unknown.name",
  ])("reports unknown %s", (name) => {
    expect(() => resolveProjectAction(action(`echo {{${name}}}`), context)).toThrow(
      "Unknown action variable",
    );
  });
  it("rejects malformed template syntax but allows braces inside values", () => {
    expect(() => resolveProjectAction(action("echo {{project.name"), context)).toThrow(
      "invalid template",
    );
    expect(
      resolveProjectAction(action("echo {{project.name}}"), {
        ...context,
        projectVariables: { name: "{{literal}}" },
      }),
    ).toBe("echo '{{literal}}'");
  });
  it("expands inherited environment values through overrides and project dependencies", () => {
    const nestedContext = {
      ...context,
      environmentDefaults: { host: "server", sshName: "{{env.host}}.repos" },
      environmentOverrides: { host: "device" },
      projectVariables: {
        host: "project",
        alias: "{{project.name}}.{{env.sshName}}",
        target: "{{project.alias}}/{{project.root}}/{{environment.label}}",
      },
    };
    expect(resolveProjectActionValue("{{project.target}}", nestedContext)).toBe(
      "abstract.device.repos//repos/abstract/Development",
    );
    expect(resolveProjectActionValue("{{env.host}}/{{project.host}}", nestedContext)).toBe(
      "device/project",
    );
    expect(
      resolveProjectActionValue("{{env.sshName}}", {
        ...nestedContext,
        environmentOverrides: { host: "" },
      }),
    ).toBe(".repos");
  });
  it("uses project overrides during nested expansion", () => {
    expect(
      resolveProjectActionValue("{{project.target}}", {
        ...context,
        projectVariables: { name: "alias", target: "{{project.name}}" },
      }),
    ).toBe("alias");
  });
  it("keeps built-in metadata literal through nested expansion", () => {
    const literalContext = {
      ...context,
      project: { ...context.project, name: "{{env.missing}}", root: "{{broken" },
      environment: { ...context.environment, label: "{{project.name}}" },
      projectVariables: { target: "{{project.name}}/{{project.root}}/{{environment.label}}" },
    };
    expect(resolveProjectActionValue("{{project.target}}", literalContext)).toBe(
      "{{env.missing}}/{{broken/{{project.name}}",
    );
    expect(resolveProjectAction(action("echo {{project.target}}"), literalContext)).toBe(
      "echo '{{env.missing}}/{{broken/{{project.name}}'",
    );
  });
  it.each(["project.name", "environment.label"])(
    "refuses environment dependencies on %s even when cached by a project reference",
    (reference) => {
      expect(() =>
        resolveProjectActionValue(`{{${reference}}}{{env.target}}`, {
          ...context,
          environmentDefaults: { target: `{{${reference}}}` },
        }),
      ).toThrow("can only reference env.*");
      expect(() => resolveProjectActionValue(`{{${reference}}}`, context, "environment")).toThrow(
        "can only reference env.*",
      );
    },
  );
  it.each([
    [{ a: "{{project.a}}" }, {}, "project.a -> project.a"],
    [{ a: "{{project.b}}", b: "{{project.a}}" }, {}, "project.a -> project.b -> project.a"],
    [
      { a: "{{env.b}}" },
      { b: "{{env.c}}", c: "{{env.b}}" },
      "project.a -> env.b -> env.c -> env.b",
    ],
  ])("reports readable dependency cycles", (projectVariables, environmentDefaults, chain) => {
    expect(() =>
      resolveProjectActionValue("{{project.a}}", {
        ...context,
        projectVariables,
        environmentDefaults,
      }),
    ).toThrow(chain);
  });
  it.each([
    "{{env.missing}}",
    "{{project.missing}}",
    "{{env.typo.extra}}",
    "{{unknown.name}}",
    "{{env}}",
    "{{project}}",
    "{{environment}}",
  ])("reports unknown nested references in %s", (value) => {
    expect(() =>
      resolveProjectActionValue("{{project.target}}", {
        ...context,
        projectVariables: { target: value },
      }),
    ).toThrow("Unknown action variable");
  });
  it.each(["{{env.host", "{{env.host}", "{{env.}}", "{{env.host{{env.host}}", "}}"])(
    "rejects malformed nested references in %s",
    (value) => {
      expect(() =>
        resolveProjectActionValue("{{project.target}}", {
          ...context,
          projectVariables: { target: value },
        }),
      ).toThrow();
    },
  );
  it("escapes complete nested values once for URL, POSIX and PowerShell", () => {
    const nestedContext = {
      ...context,
      environmentDefaults: { value: "a'b /$`!" },
      projectVariables: { target: "prefix:{{env.value}}" },
    };
    expect(
      resolveProjectAction(action("https://example.test/{{project.target}}", "url"), nestedContext),
    ).toBe("https://example.test/prefix%3Aa%27b%20%2F%24%60%21");
    expect(resolveProjectAction(action("echo {{project.target}}"), nestedContext)).toBe(
      "echo 'prefix:a'\\''b /$`!'",
    );
    expect(resolveProjectAction(action('echo "{{project.target}}"'), nestedContext)).toBe(
      'echo "prefix:a\'b /\\$\\`!"',
    );
    expect(
      resolveProjectAction(action("Write-Output {{project.target}}"), {
        ...nestedContext,
        shell: "pwsh",
      }),
    ).toBe("Write-Output 'prefix:a''b /$`!'");
    expect(
      resolveProjectAction(action('Write-Output "{{project.target}}"'), {
        ...nestedContext,
        shell: "pwsh",
      }),
    ).toBe('Write-Output "prefix:a\'b /`$``!"');
  });
  it("rejects controls reached through nested values", () => {
    expect(() =>
      resolveProjectAction(action("echo {{project.target}}"), {
        ...context,
        projectVariables: { target: "{{env.value}}" },
        environmentDefaults: { value: "a\nb" },
      }),
    ).toThrow("terminal control characters");
  });
  it("bounds recursive depth", () => {
    const projectVariables = Object.fromEntries(
      Array.from({ length: 65 }, (_, index) => [
        `v${index}`,
        index === 64 ? "end" : `{{project.v${index + 1}}}`,
      ]),
    );
    expect(() =>
      resolveProjectActionValue("{{project.v0}}", { ...context, projectVariables }),
    ).toThrow("64 levels");
  });
  it("bounds exponentially growing values and final encoded output", () => {
    const projectVariables = Object.fromEntries(
      Array.from({ length: 20 }, (_, index) => [
        `v${index}`,
        index === 19 ? "x" : `{{project.v${index + 1}}}{{project.v${index + 1}}}`,
      ]),
    );
    expect(() =>
      resolveProjectActionValue("{{project.v0}}", { ...context, projectVariables }),
    ).toThrow("output limit");
    expect(() =>
      resolveProjectAction(action("https://example.test/{{project.value}}", "url"), {
        ...context,
        projectVariables: { value: "/".repeat(100_000) },
      }),
    ).toThrow("output limit");
  });
  it("bounds total expansion work across distinct dependencies", () => {
    const projectVariables = Object.fromEntries(
      Array.from({ length: 43 }, (_, index) => [
        `v${index}`,
        `{{${" ".repeat(100_000)}env.empty}}`,
      ]),
    );
    projectVariables.target = Array.from(
      { length: 43 },
      (_, index) => `{{project.v${index}}}`,
    ).join("");
    expect(() =>
      resolveProjectActionValue("{{project.target}}", {
        ...context,
        projectVariables,
        environmentDefaults: { empty: "" },
      }),
    ).toThrow("work limit");
  });
  it.each(["{{{{", "{{{{z", "{{", "{{z"])(
    "rejects whitespace-heavy unterminated templates starting with %s",
    (prefix) => {
      expect(() =>
        resolveProjectAction(
          action(`https://example.test/${prefix}${"\t".repeat(100_000)}`, "url"),
          context,
        ),
      ).toThrow("invalid template");
    },
  );
  it("resolves padded adjacent variables and rejects stray closing delimiters", () => {
    expect(
      resolveProjectAction(action("echo {{ \tproject.name\t }}{{ env.sshName }}"), context),
    ).toBe("echo 'abstract''dev1'");
    expect(() => resolveProjectAction(action("echo }}"), context)).toThrow("invalid template");
  });
  it("quotes spaces, URL delimiters, and apostrophes in POSIX command values", () => {
    expect(
      resolveProjectAction(action("echo {{project.name}}"), {
        ...context,
        projectVariables: { name: "a b/c?x" },
      }),
    ).toBe("echo 'a b/c?x'");
    expect(
      resolveProjectAction(action("echo {{project.name}}"), {
        ...context,
        projectVariables: { name: "a'b" },
      }),
    ).toBe("echo 'a'\\''b'");
  });
  it("refuses shell contexts whose quote rules differ", () => {
    expect(() =>
      resolveProjectAction(action('echo "$(printf "{{project.name}}")"'), context),
    ).toThrow("shell substitutions");
  });
  it.each([
    "echo $'{{project.name}}'",
    'echo $"{{project.name}}"',
    "echo ${prefix:-{{project.name}}}",
    "cat <<EOF\n{{project.name}}\nEOF",
    "echo ready # unmatched quote '\necho {{project.name}}",
  ])("refuses nested shell grammar in %s", (template) => {
    expect(() => resolveProjectAction(action(template), context)).toThrow("shell substitutions");
  });
  it.each(["\x03; printf INJECTED", "\x15; printf INJECTED", "a\nb", "a\tb", "\x7F"])(
    "refuses terminal controls in command substitutions",
    (name) => {
      expect(() =>
        resolveProjectAction(action("echo {{project.name}}"), {
          ...context,
          projectVariables: { name },
        }),
      ).toThrow("terminal control characters");
    },
  );
  it("refuses unknown shells and unknown Windows shells when substituting command values", () => {
    expect(() =>
      resolveProjectAction(action("echo {{project.name}}"), {
        ...context,
        shell: "cmd.exe",
      }),
    ).toThrow("terminal shell");
    expect(() =>
      resolveProjectAction(action("echo {{project.name}}"), {
        ...context,
        environment: { ...context.environment, os: "windows" },
      }),
    ).toThrow("terminal shell");
    expect(resolveProjectAction(action("echo hello"), { ...context, shell: "cmd.exe" })).toBe(
      "echo hello",
    );
  });
  it("uses PowerShell quoting for values containing apostrophes", () => {
    expect(
      resolveProjectAction(action("Write-Output {{project.name}}"), {
        ...context,
        shell: "powershell.exe",
        environment: { ...context.environment, os: "windows" },
        projectVariables: { name: "a'b" },
      }),
    ).toBe("Write-Output 'a''b'");
  });
  it("replaces global actions by id, hides them, and resets by removing overrides and hidden ids", () => {
    const global = action("https://global.test", "url");
    const override = action("https://project.test", "url");
    const local = action("pnpm test", "command", "test");
    expect(mergeProjectActions([global], [override, local], [global.id])).toEqual([
      { action: override, source: "override", hidden: true },
      { action: local, source: "project", hidden: false },
    ]);
    expect(mergeProjectActions([global], [local])).toEqual([
      { action: global, source: "global", hidden: false },
      { action: local, source: "project", hidden: false },
    ]);
  });
});
