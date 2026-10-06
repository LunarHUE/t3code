// @effect-diagnostics globalDate:off -- Promise adapter tests exercise clock expiry.
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createAccountAuth } from "./accountAuth.ts";
const user = { id: "account-one", email: "one@example.test" };
const token = { access_token: "access", refresh_token: "refresh-next", expires_in: 600, user };
function setup(raw: string | null = null) {
  let stored = raw;
  const request = vi.fn<typeof fetch>();
  const client = createAccountAuth({
    relayUrl: "https://relay.example.test",
    clientId: "t3-web",
    fetch: request,
    store: {
      read: async () => stored,
      write: async (value) => {
        stored = value;
      },
    },
  });
  return { client, request, read: () => stored };
}
function existing(relayUrl = "https://relay.example.test", expiresAt = 0) {
  return JSON.stringify({ relayUrl, expiresAt, accessToken: "old", refreshToken: "refresh", user });
}
afterEach(() => vi.useRealTimers());
describe("account session", () => {
  it("rejects credentials from another relay without sending them", async () => {
    const { client, request, read } = setup(existing("https://other.example.test"));
    await client.restore();
    expect(client.user).toBeNull();
    expect(request).not.toHaveBeenCalled();
    expect(read()).toBeNull();
  });
  it("shares a rotating refresh across concurrent token readers", async () => {
    vi.useFakeTimers();
    const { client, request, read } = setup(existing(undefined, Date.now() + 100_000));
    await client.restore();
    vi.advanceTimersByTime(100_000);
    const response = Promise.withResolvers<Response>();
    request.mockReturnValueOnce(response.promise);
    const tokens = Promise.all([client.getToken(), client.getToken()]);
    expect(request).toHaveBeenCalledTimes(1);
    response.resolve(Response.json(token));
    expect(await tokens).toEqual(["access", "access"]);
    expect(JSON.parse(read()!).refreshToken).toBe("refresh-next");
  });
  it("clears local credentials when relay revocation fails", async () => {
    const { client, request, read } = setup(existing(undefined, Date.now() + 100000));
    await client.restore();
    request.mockRejectedValue(new Error("offline"));
    await expect(client.logout()).rejects.toThrow("offline");
    expect(client.user).toBeNull();
    expect(read()).toBeNull();
  });
  it("polls pending approval then persists the approved session", async () => {
    vi.useFakeTimers();
    const { client, request } = setup();
    const device = {
      device_code: "code",
      user_code: "ABCD",
      verification_uri: "https://relay.example.test/auth/device",
      expires_in: 600,
      interval: 1,
    };
    request
      .mockResolvedValueOnce(Response.json(device))
      .mockResolvedValueOnce(Response.json({ error: "authorization_pending" }, { status: 400 }))
      .mockResolvedValueOnce(Response.json(token));
    const prompt = vi.fn();
    const login = client.login(prompt, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(2000);
    await login;
    expect(prompt).toHaveBeenCalledWith(device);
    expect(client.user).toEqual(user);
  });
  it("does not accept a pending login after logout", async () => {
    vi.useFakeTimers();
    const { client, request } = setup();
    request.mockResolvedValue(
      Response.json({
        device_code: "code",
        user_code: "ABCD",
        verification_uri: "https://relay.example.test/auth/device",
        expires_in: 600,
        interval: 1,
      }),
    );
    const login = client.login(() => {}, new AbortController().signal);
    const rejection = expect(login).rejects.toThrow("cancelled");
    await vi.advanceTimersByTimeAsync(0);
    await client.logout();
    await vi.advanceTimersByTimeAsync(1000);
    await rejection;
    expect(client.user).toBeNull();
  });
  it("rejects malformed stored credential values", async () => {
    const { client, request, read } = setup(
      JSON.stringify({
        relayUrl: "https://relay.example.test",
        expiresAt: 1,
        accessToken: {},
        refreshToken: {},
        user: { id: {} },
      }),
    );
    await client.restore();
    expect(client.user).toBeNull();
    expect(read()).toBeNull();
    expect(request).not.toHaveBeenCalled();
  });
  it("refuses approval links on another origin", async () => {
    const { client, request } = setup();
    request.mockResolvedValue(
      Response.json({
        device_code: "code",
        user_code: "ABCD",
        verification_uri: "https://evil.example.test/auth/device",
        expires_in: 600,
      }),
    );
    const prompt = vi.fn();
    await expect(client.login(prompt, new AbortController().signal)).rejects.toThrow(
      "invalid_approval_origin",
    );
    expect(prompt).not.toHaveBeenCalled();
  });
  it("retries transient failures while approval is pending", async () => {
    vi.useFakeTimers();
    const { client, request } = setup();
    request
      .mockResolvedValueOnce(
        Response.json({
          device_code: "code",
          user_code: "ABCD",
          verification_uri: "https://relay.example.test/auth/device",
          expires_in: 600,
          interval: 1,
        }),
      )
      .mockRejectedValueOnce(new TypeError("offline"))
      .mockResolvedValueOnce(Response.json({}, { status: 503 }))
      .mockResolvedValueOnce(Response.json(token));
    const login = client.login(() => {}, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(3000);
    await login;
    expect(client.user).toEqual(user);
  });
  it("serializes a pending credential write before logout clearing", async () => {
    vi.useFakeTimers();
    let stored: string | null = null;
    const writeStarted = Promise.withResolvers<void>();
    const releaseWrite = Promise.withResolvers<void>();
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          device_code: "code",
          user_code: "ABCD",
          verification_uri: "https://relay.example.test/auth/device",
          expires_in: 600,
          interval: 1,
        }),
      )
      .mockResolvedValueOnce(Response.json(token))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = createAccountAuth({
      relayUrl: "https://relay.example.test",
      clientId: "t3-web",
      fetch: request,
      store: {
        read: async () => stored,
        write: async (value) => {
          if (value !== null) {
            writeStarted.resolve();
            await releaseWrite.promise;
          }
          stored = value;
        },
      },
    });
    const login = client.login(() => {}, new AbortController().signal);
    const rejected = expect(login).rejects.toThrow("cancelled");
    await vi.advanceTimersByTimeAsync(1000);
    await writeStarted.promise;
    const logout = client.logout();
    releaseWrite.resolve();
    await logout;
    await rejected;
    expect(stored).toBeNull();
    expect(client.user).toBeNull();
  });
  it("does not restore a delayed credential after logout", async () => {
    const read = Promise.withResolvers<string | null>();
    let stored: string | null = existing(undefined, Date.now() + 100000);
    const client = createAccountAuth({
      relayUrl: "https://relay.example.test",
      clientId: "t3-web",
      store: {
        read: () => read.promise,
        write: async (value) => {
          stored = value;
        },
      },
    });
    const restored = client.restore();
    await client.logout();
    read.resolve(existing(undefined, Date.now() + 100000));
    await restored;
    expect(client.user).toBeNull();
    expect(stored).toBeNull();
  });
  it("does not retain a login cancelled during credential persistence", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    let stored: string | null = null;
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          device_code: "code",
          user_code: "ABCD",
          verification_uri: "https://relay.example.test/auth/device",
          expires_in: 600,
          interval: 1,
        }),
      )
      .mockResolvedValueOnce(Response.json(token));
    const client = createAccountAuth({
      relayUrl: "https://relay.example.test",
      clientId: "t3-web",
      fetch: request,
      store: {
        read: async () => stored,
        write: async (value) => {
          if (value !== null) controller.abort();
          stored = value;
        },
      },
    });
    const login = client.login(() => {}, controller.signal);
    const rejected = expect(login).rejects.toThrow("cancelled");
    await vi.advanceTimersByTimeAsync(1000);
    await rejected;
    expect(client.user).toBeNull();
    expect(stored).toBeNull();
  });
  it("removes a consumed refresh credential when storing its replacement fails", async () => {
    let stored: string | null = existing();
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json(token));
    const client = createAccountAuth({
      relayUrl: "https://relay.example.test",
      clientId: "t3-web",
      fetch: request,
      store: {
        read: async () => stored,
        write: async (value) => {
          if (value !== null) throw new Error("save failed");
          stored = value;
        },
      },
    });
    await client.restore();
    expect(client.user).toBeNull();
    expect(stored).toBeNull();
  });
});
