import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ExternalLauncher from "../process/externalLauncher.ts";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import * as CliTokenManager from "./CliTokenManager.ts";

const TEST_ENV = {
  T3CODE_RELAY_URL: "https://relay.example.test",
};

interface RecordedTokenRequest {
  readonly url: string;
  readonly params: URLSearchParams;
}

// A JWT whose payload claims { email: "theo@example.test" } (signature is not
// verified — the CLI only reads the claim to display the connected account).
const TestIdTokenHeaderJson = Schema.fromJsonString(Schema.Struct({ alg: Schema.Literal("none") }));
const TestIdTokenPayloadJson = Schema.fromJsonString(Schema.Struct({ email: Schema.String }));
const encodeTestIdTokenHeader = Schema.encodeSync(TestIdTokenHeaderJson);
const encodeTestIdTokenPayload = Schema.encodeSync(TestIdTokenPayloadJson);
const idTokenWithEmail = (() => {
  const header = Base64Url.encode(encodeTestIdTokenHeader({ alg: "none" }));
  const payload = Base64Url.encode(encodeTestIdTokenPayload({ email: "theo@example.test" }));
  return `${header}.${payload}.`;
})();

const TestTokenResponseJson = Schema.fromJsonString(
  Schema.Struct({
    access_token: Schema.String,
    refresh_token: Schema.String,
    id_token: Schema.String,
    expires_in: Schema.Number,
    token_type: Schema.String,
  }),
);
const encodeTestTokenResponse = Schema.encodeSync(TestTokenResponseJson);
const decodeSavedCredential = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Struct({ refreshToken: Schema.String, relayUrl: Schema.String })),
);

const provideTestEnv = Effect.provide(
  ConfigProvider.layer(ConfigProvider.fromEnv({ env: TEST_ENV })),
);

const isAuthorizationError = Schema.is(CliTokenManager.CloudCliAuthorizationError);

interface DeviceFlowServer {
  readonly requests: Array<RecordedTokenRequest>;
  /** Token endpoint replies, consumed in order; the last one repeats. */
  readonly tokenReplies: Array<{ readonly status: number; readonly body: string }>;
}

const DEVICE_AUTHORIZATION_BODY = JSON.stringify({
  device_code: "device-code-1",
  user_code: "BCDF-GHJK",
  verification_uri: "https://relay.example.test/auth/device",
  verification_uri_complete: "https://relay.example.test/auth/device?user_code=BCDF-GHJK",
  expires_in: 600,
  interval: 5,
});

const oauthError = (error: string) => ({ status: 400, body: JSON.stringify({ error }) });
const tokenGranted = {
  status: 200,
  body: encodeTestTokenResponse({
    access_token: "access-token-1",
    refresh_token: "refresh-token-1",
    id_token: idTokenWithEmail,
    expires_in: 3600,
    token_type: "bearer",
  }),
};

const layerDeviceFlow = (server: DeviceFlowServer) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => {
        const body =
          request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "";
        server.requests.push({ url: request.url, params: new URLSearchParams(body) });
        const reply = request.url.endsWith("/auth/device")
          ? { status: 200, body: DEVICE_AUTHORIZATION_BODY }
          : ((server.tokenReplies.length > 1
              ? server.tokenReplies.shift()
              : server.tokenReplies[0]) ?? oauthError("invalid_grant"));
        return HttpClientResponse.fromWeb(
          request,
          new Response(reply.body, {
            status: reply.status,
            headers: { "content-type": "application/json" },
          }),
        );
      }),
    ),
  );

const tokenRequests = (requests: ReadonlyArray<RecordedTokenRequest>) =>
  requests.filter((request) => request.url.endsWith("/auth/token"));

it.layer(NodeServices.layer)("CliTokenManager.deviceAuthorizationLogin", (it) => {
  it.effect("requests a device code, shows it, and polls until the relay grants the token", () =>
    Effect.gen(function* () {
      const server: DeviceFlowServer = {
        requests: [],
        tokenReplies: [oauthError("authorization_pending"), tokenGranted],
      };
      const prompts: Array<CliTokenManager.DeviceAuthorizationPrompt> = [];

      const fiber = yield* CliTokenManager.deviceAuthorizationLogin((prompt) =>
        Effect.sync(() => {
          prompts.push(prompt);
        }),
      ).pipe(Effect.provide(layerDeviceFlow(server)), provideTestEnv, Effect.forkChild);

      yield* TestClock.adjust(Duration.seconds(10));
      const { token, identity } = yield* Fiber.join(fiber);

      assert.deepEqual(prompts, [
        {
          verificationUri: "https://relay.example.test/auth/device",
          verificationUriComplete: "https://relay.example.test/auth/device?user_code=BCDF-GHJK",
          userCode: "BCDF-GHJK",
          expiresIn: Duration.seconds(600),
        },
      ]);
      assert.equal(token.accessToken, "access-token-1");
      assert.equal(token.refreshToken, "refresh-token-1");
      assert.equal(token.identity, "theo@example.test");
      assert.equal(identity, "theo@example.test");

      const authorization = server.requests[0]!;
      assert.equal(authorization.url, "https://relay.example.test/auth/device");
      assert.equal(authorization.params.get("client_id"), "t3-cli");
      assert.equal(authorization.params.get("scope"), "account");

      const polls = tokenRequests(server.requests);
      assert.lengthOf(polls, 2);
      for (const poll of polls) {
        assert.equal(poll.url, "https://relay.example.test/auth/token");
        assert.equal(poll.params.get("grant_type"), "urn:ietf:params:oauth:grant-type:device_code");
        assert.equal(poll.params.get("device_code"), "device-code-1");
        assert.equal(poll.params.get("client_id"), "t3-cli");
      }
    }),
  );

  it.effect("waits the advertised interval between polls and backs off on slow_down", () =>
    Effect.gen(function* () {
      const server: DeviceFlowServer = {
        requests: [],
        tokenReplies: [oauthError("slow_down"), oauthError("authorization_pending")],
      };

      const fiber = yield* CliTokenManager.deviceAuthorizationLogin(() => Effect.void).pipe(
        Effect.provide(layerDeviceFlow(server)),
        provideTestEnv,
        Effect.forkChild,
      );

      yield* TestClock.adjust(Duration.seconds(4));
      assert.lengthOf(tokenRequests(server.requests), 0);
      yield* TestClock.adjust(Duration.seconds(1));
      assert.lengthOf(tokenRequests(server.requests), 1);
      // slow_down widens the 5s interval to 10s.
      yield* TestClock.adjust(Duration.seconds(9));
      assert.lengthOf(tokenRequests(server.requests), 1);
      yield* TestClock.adjust(Duration.seconds(1));
      assert.lengthOf(tokenRequests(server.requests), 2);
      yield* Fiber.interrupt(fiber);
    }),
  );

  it.effect("backs off after a transient upstream failure and keeps polling", () =>
    Effect.gen(function* () {
      const server: DeviceFlowServer = {
        requests: [],
        tokenReplies: [{ status: 503, body: "upstream unavailable" }, tokenGranted],
      };

      const fiber = yield* CliTokenManager.deviceAuthorizationLogin(() => Effect.void).pipe(
        Effect.provide(layerDeviceFlow(server)),
        provideTestEnv,
        Effect.forkChild,
      );

      yield* TestClock.adjust(Duration.seconds(5));
      assert.lengthOf(tokenRequests(server.requests), 1);
      // The 5xx widens the 5s interval to 10s before the retry.
      yield* TestClock.adjust(Duration.seconds(9));
      assert.lengthOf(tokenRequests(server.requests), 1);
      yield* TestClock.adjust(Duration.seconds(1));
      const { token } = yield* Fiber.join(fiber);
      assert.lengthOf(tokenRequests(server.requests), 2);
      assert.equal(token.accessToken, "access-token-1");
    }),
  );

  it.effect("fails with a denied error when the user rejects the request", () =>
    Effect.gen(function* () {
      const server: DeviceFlowServer = {
        requests: [],
        tokenReplies: [oauthError("access_denied")],
      };

      const fiber = yield* CliTokenManager.deviceAuthorizationLogin(() => Effect.void).pipe(
        Effect.provide(layerDeviceFlow(server)),
        provideTestEnv,
        Effect.flip,
        Effect.forkChild,
      );
      yield* TestClock.adjust(Duration.seconds(5));
      const result = yield* Fiber.join(fiber);

      assert.instanceOf(result, CliTokenManager.CloudCliAuthorizationDeniedError);
      assert.lengthOf(tokenRequests(server.requests), 1);
    }),
  );

  it.effect("times out once the device code lifetime elapses", () =>
    Effect.gen(function* () {
      const server: DeviceFlowServer = {
        requests: [],
        tokenReplies: [oauthError("authorization_pending")],
      };

      const fiber = yield* CliTokenManager.deviceAuthorizationLogin(() => Effect.void).pipe(
        Effect.provide(layerDeviceFlow(server)),
        provideTestEnv,
        Effect.flip,
        Effect.forkChild,
      );
      yield* TestClock.adjust(Duration.seconds(600));
      const result = yield* Fiber.join(fiber);

      assert.instanceOf(result, CliTokenManager.CloudCliAuthorizationTimeoutError);
    }),
  );

  it.effect("surfaces other OAuth errors as authorization failures", () =>
    Effect.gen(function* () {
      const server: DeviceFlowServer = {
        requests: [],
        tokenReplies: [oauthError("invalid_client")],
      };

      const fiber = yield* CliTokenManager.deviceAuthorizationLogin(() => Effect.void).pipe(
        Effect.provide(layerDeviceFlow(server)),
        provideTestEnv,
        Effect.flip,
        Effect.forkChild,
      );
      yield* TestClock.adjust(Duration.seconds(5));
      const result = yield* Fiber.join(fiber);

      assert.isTrue(isAuthorizationError(result));
    }),
  );
});

it.effect(
  "CLI refresh rotates once across concurrent readers and logout clears after failed revoke",
  () => {
    let stored: Uint8Array | null = new TextEncoder().encode(
      JSON.stringify({
        accessToken: "old",
        refreshToken: "old-refresh",
        expiresAtEpochMs: 0,
        relayUrl: TEST_ENV.T3CODE_RELAY_URL,
      }),
    );
    const server: DeviceFlowServer = { requests: [], tokenReplies: [tokenGranted] };
    const secrets = {
      get: () => Effect.sync(() => Option.fromNullishOr(stored)),
      set: (_name: string, value: Uint8Array) =>
        Effect.sync(() => {
          stored = value;
        }),
      remove: () =>
        Effect.sync(() => {
          stored = null;
        }),
    } as unknown as ServerSecretStore.ServerSecretStore["Service"];
    const launcher = {
      launchBrowser: () => Effect.void,
    } as unknown as ExternalLauncher.ExternalLauncher["Service"];
    return Effect.gen(function* () {
      const manager = yield* CliTokenManager.CloudCliTokenManager;
      const tokens = yield* Effect.all([manager.getExisting, manager.getExisting], {
        concurrency: "unbounded",
      });
      assert.isTrue(tokens.every(Option.isSome));
      assert.lengthOf(tokenRequests(server.requests), 1);
      const saved = yield* decodeSavedCredential(new TextDecoder().decode(stored!));
      assert.equal(saved.refreshToken, "refresh-token-1");
      assert.equal(saved.relayUrl, TEST_ENV.T3CODE_RELAY_URL);
      server.tokenReplies.splice(0, server.tokenReplies.length, oauthError("invalid_grant"));
      yield* manager.clear;
      assert.isNull(stored);
      const revoked = server.requests.find((request) => request.url.endsWith("/auth/revoke"));
      assert.equal(revoked?.params.get("token"), "refresh-token-1");
    }).pipe(
      Effect.provide(CliTokenManager.layer.pipe(Layer.provide(layerDeviceFlow(server)))),
      Effect.provideService(ServerSecretStore.ServerSecretStore, secrets),
      Effect.provideService(ExternalLauncher.ExternalLauncher, launcher),
      provideTestEnv,
    );
  },
);

it.effect("CLI does not send a stored credential to a different relay", () => {
  const raw = new TextEncoder().encode(
    JSON.stringify({
      accessToken: "old",
      refreshToken: "old-refresh",
      expiresAtEpochMs: 0,
      relayUrl: "https://other.example.test",
    }),
  );
  const server: DeviceFlowServer = { requests: [], tokenReplies: [tokenGranted] };
  const secrets = {
    get: () => Effect.succeed(Option.some(raw)),
  } as unknown as ServerSecretStore.ServerSecretStore["Service"];
  const launcher = {
    launchBrowser: () => Effect.void,
  } as unknown as ExternalLauncher.ExternalLauncher["Service"];
  return Effect.gen(function* () {
    const manager = yield* CliTokenManager.CloudCliTokenManager;
    assert.isTrue(Option.isNone(yield* manager.getExisting));
    assert.lengthOf(server.requests, 0);
  }).pipe(
    Effect.provide(CliTokenManager.layer.pipe(Layer.provide(layerDeviceFlow(server)))),
    Effect.provideService(ServerSecretStore.ServerSecretStore, secrets),
    Effect.provideService(ExternalLauncher.ExternalLauncher, launcher),
    provideTestEnv,
  );
});
