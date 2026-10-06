# Serves this devcontainer through T3 Connect. Start it from the devcontainer's
# postStartCommand. The first time, it waits until someone runs
# `t3 connect link --headless` in the container; the login then persists in
# T3CODE_HOME/T3CODE_INSTANCE across rebuilds.
: "${T3CODE_HOME:?Set T3CODE_HOME to the persistent T3 Code root.}"
: "${T3CODE_INSTANCE:?Set T3CODE_INSTANCE to a name that stays the same across rebuilds of this devcontainer.}"
: "${T3CODE_RELAY_PRIVATE_URL:?Set T3CODE_RELAY_PRIVATE_URL to the HTTPS URL of this devcontainer on the VPN.}"

linked() {
  t3 connect status --json | jq -e '.authenticated and .desired' >/dev/null
}

if ! linked; then
  echo "T3 Connect is not set up for '$T3CODE_INSTANCE'. In a terminal in this devcontainer, run:" >&2
  echo "  t3 connect link --headless" >&2
  until linked; do sleep 10; done
fi

# The ingress behind T3CODE_RELAY_PRIVATE_URL needs a fixed, reachable port.
export T3CODE_HOST="${T3CODE_HOST:-0.0.0.0}"
export T3CODE_PORT="${T3CODE_PORT:-3773}"
exec t3 serve "$@"
