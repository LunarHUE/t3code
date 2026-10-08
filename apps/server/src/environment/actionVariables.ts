/** Only explicitly advertised T3CODE_ENV_* values leave the server. */
export function environmentActionVariables(
  environment: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const variables: Record<string, string> = {};
  const entries = Object.entries(environment).sort(([left], [right]) => left.localeCompare(right));
  for (const [name, value] of entries) {
    if (!name.startsWith("T3CODE_ENV_") || value === undefined) continue;
    const suffix = name.slice("T3CODE_ENV_".length);
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(suffix)) continue;
    // SSHNAME is kept as the documented shorthand; SSH_NAME follows the general rule.
    const key =
      suffix.toUpperCase() === "SSHNAME"
        ? "sshName"
        : suffix.toLowerCase().replace(/_([a-z0-9])/g, (_, letter: string) => letter.toUpperCase());
    Object.defineProperty(variables, key, {
      value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return variables;
}
