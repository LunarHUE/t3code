#!@shell@
# Runs the release's t3. With T3CODE_INSTANCE set, T3CODE_HOME is a shared
# root (e.g. a persistent volume) and each instance keeps its own home under
# it, so instances never share an environment identity, database, or login.
if [ -n "${T3CODE_INSTANCE:-}" ] && [ -z "${T3CODE_INSTANCE_HOME:-}" ]; then
  case "$T3CODE_INSTANCE" in
    */* | . | ..)
      echo "T3CODE_INSTANCE must be a plain directory name, got '$T3CODE_INSTANCE'." >&2
      exit 1
      ;;
  esac
  if [ -z "${T3CODE_HOME:-}" ]; then
    echo "T3CODE_HOME must be set when T3CODE_INSTANCE is." >&2
    exit 1
  fi
  # Marks the home as resolved so nested t3 calls do not append the name again.
  export T3CODE_INSTANCE_HOME="$T3CODE_HOME/$T3CODE_INSTANCE"
  export T3CODE_HOME="$T3CODE_INSTANCE_HOME"
fi
export T3CODE_RELAY_URL="${T3CODE_RELAY_URL:-@relayUrl@}"
exec @t3@ "$@"
