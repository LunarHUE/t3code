// @effect-diagnostics globalDate:off globalTimers:off -- Promise-based browser/native OAuth adapter; tests inject timers and fetch.
export interface AccountUser {
  readonly id: string;
  readonly email?: string;
  readonly name?: string;
}
export interface AccountCredential {
  readonly relayUrl: string;
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresAt: number;
  readonly user: AccountUser;
}
export interface AccountCredentialStore {
  read: () => Promise<string | null>;
  write: (value: string | null) => Promise<void>;
}
export interface DeviceAuthorization {
  readonly device_code: string;
  readonly user_code: string;
  readonly verification_uri: string;
  readonly verification_uri_complete?: string;
  readonly expires_in: number;
  readonly interval?: number;
}
class AccountAuthError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(`Account authorization failed: ${code}.`);
    this.code = code;
  }
}
export function createAccountAuth(input: {
  relayUrl: string;
  clientId: string;
  store: AccountCredentialStore;
  fetch?: typeof globalThis.fetch;
}) {
  let credential: AccountCredential | null = null;
  let refresh: Promise<string | null> | null = null;
  let generation = 0;
  let logoutPending: Promise<void> | null = null;
  let writes = Promise.resolve();
  const write = (value: string | null, expected?: number) => {
    const operation = writes
      .catch(() => {})
      .then(() => {
        if (expected !== undefined && generation !== expected) return;
        return input.store.write(value);
      });
    writes = operation;
    return operation;
  };
  const request = async (path: string, fields: Record<string, string>, signal?: AbortSignal) => {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) controller.abort();
    const timeout = setTimeout(cancel, 20_000);
    try {
      const response = await (input.fetch ?? globalThis.fetch)(`${input.relayUrl}${path}`, {
        method: "POST",
        signal: controller.signal,
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ ...fields, client_id: input.clientId }).toString(),
      });
      if (response.status === 429 || response.status >= 500)
        throw new AccountAuthError("temporarily_unavailable");
      if (response.status === 204) return null;
      const body = await response.json();
      if (!response.ok)
        throw new AccountAuthError(typeof body.error === "string" ? body.error : "request_failed");
      return body;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", cancel);
    }
  };
  const accept = async (body: unknown, expected: number) => {
    if (typeof body !== "object" || body === null) throw new AccountAuthError("invalid_response");
    const value = body as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      user?: AccountUser;
    };
    if (
      typeof value.access_token !== "string" ||
      !value.access_token ||
      typeof value.refresh_token !== "string" ||
      !value.refresh_token ||
      typeof value.expires_in !== "number" ||
      !Number.isFinite(value.expires_in) ||
      value.expires_in <= 0 ||
      typeof value.user?.id !== "string" ||
      !value.user.id
    )
      throw new AccountAuthError("invalid_response");
    if (generation !== expected) throw new AccountAuthError("cancelled");
    if (credential && credential.user.id !== value.user.id)
      throw new AccountAuthError("invalid_response");
    const next = {
      relayUrl: input.relayUrl,
      accessToken: value.access_token,
      refreshToken: value.refresh_token,
      expiresAt: Date.now() + value.expires_in * 1000,
      user: {
        id: value.user.id,
        ...(typeof value.user.email === "string" ? { email: value.user.email } : {}),
        ...(typeof value.user.name === "string" ? { name: value.user.name } : {}),
      },
    };
    credential = next;
    try {
      await write(JSON.stringify(next), expected);
    } catch {
      if (generation === expected) {
        credential = null;
        await write(null, expected).catch(() => {});
      }
      throw new AccountAuthError("credential_storage_failed");
    }
    if (generation !== expected) throw new AccountAuthError("cancelled");
    return next;
  };
  const getToken = async (): Promise<string | null> => {
    if (logoutPending || !credential) return null;
    if (credential.expiresAt > Date.now() + 30_000) return credential.accessToken;
    if (refresh) return refresh;
    const current = credential;
    const expected = generation;
    refresh = request("/auth/token", {
      grant_type: "refresh_token",
      refresh_token: current.refreshToken,
    })
      .then((body) => accept(body, expected))
      .then((next) => next.accessToken)
      .catch(async (error: unknown) => {
        if (
          error instanceof AccountAuthError &&
          error.code === "invalid_grant" &&
          generation === expected
        ) {
          credential = null;
          await write(null);
        }
        throw error;
      })
      .finally(() => {
        refresh = null;
      });
    return refresh;
  };
  return {
    get user() {
      return credential?.user ?? null;
    },
    getToken,
    async restore() {
      if (generation !== 0) return;
      const expected = generation;
      const raw = await input.store.read();
      if (!raw || generation !== expected) return;
      try {
        const stored = JSON.parse(raw) as AccountCredential;
        if (
          stored.relayUrl !== input.relayUrl ||
          typeof stored.user?.id !== "string" ||
          !stored.user.id ||
          typeof stored.refreshToken !== "string" ||
          !stored.refreshToken ||
          typeof stored.accessToken !== "string" ||
          !stored.accessToken ||
          !Number.isFinite(stored.expiresAt)
        ) {
          await write(null, expected);
          return;
        }
        credential = stored;
        await getToken();
      } catch {
        if (!credential && generation === expected) await write(null, expected);
      }
    },
    async login(onDevice: (device: DeviceAuthorization) => void, signal: AbortSignal) {
      if (logoutPending) await logoutPending.catch(() => {});
      if (credential) throw new AccountAuthError("already_signed_in");
      const expected = ++generation;
      const invalidate = () => {
        if (generation !== expected) return;
        ++generation;
        credential = null;
        void write(null).catch(() => {});
      };
      signal.addEventListener("abort", invalidate, { once: true });
      try {
        const device = (await request("/auth/device", {}, signal)) as DeviceAuthorization;
        if (
          typeof device.device_code !== "string" ||
          !device.device_code ||
          typeof device.user_code !== "string" ||
          !device.user_code ||
          typeof device.verification_uri !== "string" ||
          !Number.isFinite(device.expires_in) ||
          device.expires_in <= 0
        )
          throw new AccountAuthError("invalid_response");
        for (const value of [device.verification_uri, device.verification_uri_complete]) {
          if (value === undefined) continue;
          const url = new URL(value);
          if (url.origin !== input.relayUrl || url.username || url.password)
            throw new AccountAuthError("invalid_approval_origin");
        }
        if (signal.aborted || generation !== expected) throw new AccountAuthError("cancelled");
        onDevice(device);
        let interval = Math.max(Number.isFinite(device.interval) ? device.interval! : 5, 1) * 1000;
        const deadline = Date.now() + device.expires_in * 1000;
        while (!signal.aborted && Date.now() < deadline) {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(done, Math.min(interval, Math.max(deadline - Date.now(), 0)));
            function done() {
              clearTimeout(timer);
              signal.removeEventListener("abort", done);
              resolve();
            }
            signal.addEventListener("abort", done, { once: true });
          });
          if (signal.aborted || generation !== expected) throw new AccountAuthError("cancelled");
          if (Date.now() >= deadline) throw new AccountAuthError("expired_token");
          try {
            return await accept(
              await request(
                "/auth/token",
                {
                  grant_type: "urn:ietf:params:oauth:grant-type:device_code",
                  device_code: device.device_code,
                },
                signal,
              ),
              expected,
            );
          } catch (error) {
            if (error instanceof AccountAuthError && error.code === "authorization_pending")
              continue;
            if (error instanceof AccountAuthError && error.code === "slow_down") {
              interval += 5000;
              continue;
            }
            if (
              !signal.aborted &&
              (!(error instanceof AccountAuthError) || error.code === "temporarily_unavailable")
            )
              continue;
            throw error;
          }
        }
        throw new AccountAuthError(signal.aborted ? "cancelled" : "expired_token");
      } finally {
        signal.removeEventListener("abort", invalidate);
      }
    },
    logout() {
      if (logoutPending) return logoutPending;
      ++generation;
      const token = credential?.refreshToken;
      logoutPending = (async () => {
        try {
          if (token) await request("/auth/revoke", { token });
        } finally {
          credential = null;
          await write(null);
        }
      })().finally(() => {
        logoutPending = null;
      });
      return logoutPending;
    },
  };
}
