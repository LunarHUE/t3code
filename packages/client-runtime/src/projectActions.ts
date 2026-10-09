import type { ProjectScript } from "@t3tools/contracts";

export interface ProjectActionContext {
  project: { id: string; name: string; root: string };
  environment: { id: string; label: string; os?: string | undefined };
  shell?: string | undefined;
  projectVariables?: Readonly<Record<string, string>> | undefined;
  environmentOverrides?: Readonly<Record<string, string>> | undefined;
  environmentDefaults?: Readonly<Record<string, string>> | undefined;
}

export function mergeProjectActions(
  globalActions: readonly ProjectScript[],
  projectScripts: readonly ProjectScript[],
  hiddenGlobalActionIds: readonly string[] = [],
): { action: ProjectScript; source: "global" | "project" | "override"; hidden: boolean }[] {
  const overrides = new Map(projectScripts.map((action) => [action.id, action]));
  const globalIds = new Set(globalActions.map((action) => action.id));
  const hiddenIds = new Set(hiddenGlobalActionIds);
  return [
    ...globalActions.map((action) => ({
      action: overrides.get(action.id) ?? action,
      source: overrides.has(action.id) ? ("override" as const) : ("global" as const),
      hidden: hiddenIds.has(action.id),
    })),
    ...projectScripts
      .filter((action) => !globalIds.has(action.id))
      .map((action) => ({ action, source: "project" as const, hidden: false })),
  ];
}

const allowedProtocols = new Set(["vscode:", "vscode-insiders:", "cursor:", "http:", "https:"]);

/** Validate every client-opened action, including actions imported from a repository. */
export function validateProjectActionUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Action URL is invalid.");
  }
  if (!allowedProtocols.has(url.protocol)) {
    throw new Error(`URL actions cannot open the ${url.protocol} scheme.`);
  }
  return value;
}

const maxExpandedLength = 262_144;
const maxExpansionWork = 4_194_304;
const maxVariableDepth = 64;

function createVariableResolver(context: ProjectActionContext) {
  const builtIns: Readonly<Record<string, string>> = {
    "project.name": context.project.name,
    "project.root": context.project.root,
    "project.id": context.project.id,
    "environment.label": context.environment.label,
    "environment.id": context.environment.id,
  };
  const cache = new Map<string, string>();
  const chain: string[] = [];
  let work = 0;
  function spend(length: number) {
    work += length;
    if (work > maxExpansionWork) {
      throw new Error("Action variable expansion exceeds the work limit.");
    }
  }

  function expand(template: string, scope: "project" | "environment"): string {
    spend(template.length);
    return replaceActionVariables(template, (_match, variable) => {
      const name = variable.trim();
      // Unqualified braces in saved values are literal; dotted references must resolve.
      if (/^[A-Za-z][A-Za-z0-9_]*$/.test(name) && !/^(project|environment|env)$/.test(name)) {
        return _match;
      }
      const value = resolve(name, scope);
      spend(value.length);
      return value;
    });
  }

  function resolve(name: string, scope: "project" | "environment" = "project"): string {
    if (!/^(project|environment|env)\.[A-Za-z][A-Za-z0-9_]*$/.test(name)) {
      throw new Error(`Unknown action variable: {{${name}}}`);
    }
    const [namespace, key] = name.split(".");
    if (scope === "environment" && namespace !== "env") {
      throw new Error(`Environment action variables can only reference env.*: {{${name}}}`);
    }
    if (chain.includes(name)) {
      throw new Error(`Action variable cycle: ${[...chain, name].join(" -> ")}`);
    }
    if (chain.length >= maxVariableDepth) {
      throw new Error(`Action variable expansion exceeds ${maxVariableDepth} levels: ${name}`);
    }
    const cached = cache.get(name);
    if (cached !== undefined) return cached;
    let template: string | undefined;
    if (namespace === "project" && key && Object.hasOwn(context.projectVariables ?? {}, key)) {
      template = context.projectVariables![key]!;
    } else if (namespace === "env" && key) {
      for (const variables of [context.environmentOverrides, context.environmentDefaults]) {
        if (variables && Object.hasOwn(variables, key)) {
          template = variables[key]!;
          break;
        }
      }
    }
    if (template === undefined) {
      // Metadata is data, even when a project name or path contains template delimiters.
      if (Object.hasOwn(builtIns, name)) return builtIns[name]!;
      throw new Error(`Unknown action variable: {{${name}}}`);
    }
    chain.push(name);
    try {
      const value = expand(template, namespace === "env" ? "environment" : "project");
      cache.set(name, value);
      return value;
    } finally {
      chain.pop();
    }
  }
  return { resolve, expand };
}

/** Preview a saved variable value without shell quoting or URL encoding. Throws on invalid references. */
export function resolveProjectActionValue(
  template: string,
  context: ProjectActionContext,
  scope: "project" | "environment" = "project",
): string {
  return createVariableResolver(context).expand(template, scope);
}

/** Scan each template character once, including malformed or whitespace-heavy input. */
function replaceActionVariables(
  template: string,
  replace: (match: string, variable: string, offset: number) => string,
): string {
  const parts: string[] = [];
  let length = 0;
  function append(part: string) {
    length += part.length;
    if (length > maxExpandedLength) {
      throw new Error("Action variable expansion exceeds the output limit.");
    }
    parts.push(part);
  }
  let cursor = 0;
  for (let index = 0; index < template.length; index++) {
    if (template.startsWith("}}", index)) {
      throw new Error("Action contains an invalid template variable.");
    }
    if (!template.startsWith("{{", index)) continue;
    const start = index;
    index += 2;
    const variableStart = index;
    while (index < template.length && template[index] !== "{" && template[index] !== "}") {
      index++;
    }
    if (index === variableStart || !template.startsWith("}}", index)) {
      throw new Error("Action contains an invalid template variable.");
    }
    const end = index + 2;
    append(template.slice(cursor, start));
    append(replace(template.slice(start, end), template.slice(variableStart, index), start));
    cursor = end;
    index = end - 1;
  }
  append(template.slice(cursor));
  return parts.join("");
}

/** Resolve at click time so renames, environment selection, and overrides remain current. */
export function resolveProjectAction(action: ProjectScript, context: ProjectActionContext): string {
  const isUrl = action.kind === "url";
  const hasTemplates = /\{\{/.test(action.command);
  const shellName = context.shell?.split(/[\\/]/).at(-1)?.toLowerCase();
  const powershell = shellName !== undefined && /^(pwsh|powershell)(\.exe)?$/.test(shellName);
  if (
    !isUrl &&
    hasTemplates &&
    ((context.environment.os === "windows" && shellName === undefined) ||
      (shellName !== undefined &&
        !powershell &&
        !/^(bash|sh|zsh|dash|ksh)(\.exe)?$/.test(shellName)))
  ) {
    throw new Error("Cannot safely resolve action variables for this terminal shell.");
  }
  if (
    !isUrl &&
    hasTemplates &&
    (/\$\(|\$\{|\$['"]|`|<<|#|\\\{\{/.test(action.command) ||
      (powershell && /@['"]|['"]@/.test(action.command)))
  ) {
    throw new Error(
      "Command templates cannot use shell substitutions, special quoting, comments, heredocs, or escaped placeholders.",
    );
  }
  let quote: "'" | '"' | null = null;
  let cursor = 0;
  const variables = createVariableResolver(context);
  const resolved = replaceActionVariables(
    action.command,
    (match, variable: string, offset: number) => {
      if (!isUrl) {
        for (let index = cursor; index < offset; index++) {
          const character = action.command[index];
          if (!powershell && character === "\\" && quote !== "'") {
            index++;
            continue;
          }
          if (character === quote) quote = null;
          else if (quote === null && (character === "'" || character === '"')) quote = character;
        }
      }
      cursor = offset + match.length;
      const value = variables.resolve(variable.trim());
      if (isUrl) {
        // RFC 3986 encoding also escapes punctuation encodeURIComponent leaves alone.
        return encodeURIComponent(value).replace(
          /[!'()*]/g,
          (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
        );
      }
      // The terminal receives interactive input, so readline controls bypass shell quoting.
      // oxlint-disable-next-line no-control-regex -- rejecting terminal control bytes is intentional.
      if (/[\x00-\x1F\x7F]/.test(value)) {
        throw new Error("Command action variables cannot contain terminal control characters.");
      }
      if (powershell) {
        if (quote === '"') return value.replace(/[`"$]/g, "`$&");
        const escaped = value.replace(/'/g, "''");
        return quote === "'" ? escaped : `'${escaped}'`;
      }
      if (quote === '"') return value.replace(/[\\"$`]/g, "\\$&");
      const escaped = value.replace(/'/g, "'\\''");
      return quote === "'" ? escaped : `'${escaped}'`;
    },
  );
  return isUrl ? validateProjectActionUrl(resolved) : resolved;
}
