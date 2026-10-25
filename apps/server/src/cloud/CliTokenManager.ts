import * as Clock from "effect/Clock";
import * as Console from "effect/Console";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Terminal from "effect/Terminal";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ExternalLauncher from "../process/externalLauncher.ts";
import { cloudCliOAuthConfig, relayUrlConfig, type CloudCliOAuthConfig } from "./publicConfig.ts";

const CLOUD_CLI_OAUTH_TOKEN_SECRET = "cloud-cli-oauth-token";
const CLOUD_CLI_OAUTH_REFRESH_EARLY_MS = Duration.toMillis(Duration.minutes(5));
const DEVICE_CODE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
// RFC 8628 defaults, used only when the broker omits the field.
const DEVICE_AUTHORIZATION_DEFAULT_INTERVAL = Duration.seconds(5);
// RFC 8628 §3.5: a slow_down response means "add 5 seconds to the interval".
const DEVICE_AUTHORIZATION_SLOW_DOWN_INCREMENT = Duration.seconds(5);
const PersistedToken = Schema.Struct({
  accessToken: Schema.String,
  refreshToken: Schema.String,
  expiresAtEpochMs: Schema.Number,
  identity: Schema.optional(Schema.String),
  relayUrl: Schema.optional(Schema.String),
});
export type PersistedToken = typeof PersistedToken.Type;

const PersistedTokenJson = Schema.fromJsonString(PersistedToken);
const decodePersistedToken = Schema.decodeUnknownEffect(PersistedTokenJson);
const encodePersistedToken = Schema.encodeEffect(PersistedTokenJson);

const OAuthTokenResponse = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.optional(Schema.String),
  id_token: Schema.optional(Schema.String),
  expires_in: Schema.Number,
  token_type: Schema.String,
  user: Schema.optional(
    Schema.Struct({
      id: Schema.String,
      email: Schema.optional(Schema.String),
      name: Schema.optional(Schema.String),
    }),
  ),
});

const OAuthErrorResponse = Schema.Struct({
  error: Schema.String,
  error_description: Schema.optional(Schema.String),
});

const OAUTH_REQUEST_TIMEOUT = Duration.seconds(10);
const OAuthRefreshErrorCode = Schema.Literals([
  "invalid_grant",
  "invalid_client",
  "unauthorized_client",
  "unsupported_grant_type",
  "invalid_request",
  "invalid_scope",
  "access_denied",
]);
const decodeOAuthRefreshErrorResponse = Schema.decodeUnknownOption(
  Schema.Struct({ error: OAuthRefreshErrorCode }),
);

const isPermanentRefreshStatus = (status: number): boolean =>
  status >= 400 && status < 500 && status !== 408 && status !== 429;

const DeviceAuthorizationResponse = Schema.Struct({
  device_code: Schema.String,
  user_code: Schema.String,
  verification_uri: Schema.String,
  verification_uri_complete: Schema.optional(Schema.String),
  expires_in: Schema.Number,
  interval: Schema.optional(Schema.Number),
});

const OidcIdentityClaimsJson = Schema.fromJsonString(
  Schema.Struct({
    email: Schema.optional(Schema.String),
    preferred_username: Schema.optional(Schema.String),
    sub: Schema.optional(Schema.String),
  }),
);
const decodeOidcIdentityClaimsJson = Schema.decodeUnknownOption(OidcIdentityClaimsJson);

/**
 * Best-effort read of the `email` (or fallback) claim from an OIDC id_token.
 * Only used to show the operator which account they linked, so a malformed
 * token degrades to "no identity" rather than an error.
 */
function idTokenIdentity(idToken: string | undefined): string | null {
  if (!idToken) return null;
  const payload = idToken.split(".")[1];
  if (!payload) return null;
  const decoded = Base64Url.decodeString(payload);
  if (decoded._tag !== "Success") return null;
  const claims = decodeOidcIdentityClaimsJson(decoded.success);
  if (Option.isNone(claims)) return null;
  for (const value of [claims.value.email, claims.value.preferred_username, claims.value.sub]) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

export class CloudCliCredentialRemovalError extends Schema.TaggedError<CloudCliCredentialRemovalError>()(
  "CloudCliCredentialRemovalError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not remove the stored T3 Connect CLI credential.";
  }
}

export class CloudCliCredentialRefreshError extends Schema.TaggedError<CloudCliCredentialRefreshError>()(
  "CloudCliCredentialRefreshError",
  {
    cause: Schema.Defect(),
    status: Schema.optional(Schema.Number),
    oauthErrorCode: Schema.optional(OAuthRefreshErrorCode),
  },
) {
  get requiresLogin(): boolean {
    return this.status !== undefined && isPermanentRefreshStatus(this.status);
  }

  override get message(): string {
    return this.requiresLogin
      ? `Could not refresh the T3 Connect CLI credential${
          this.oauthErrorCode === undefined ? "" : ` (OAuth error: ${this.oauthErrorCode})`
        }. Run \`t3 connect login\` to authorize again.`
      : "Could not refresh the T3 Connect CLI credential.";
  }
}

export const isCloudCliCredentialRefreshError = Schema.is(CloudCliCredentialRefreshError);

export class CloudCliCredentialReadError extends Schema.TaggedError<CloudCliCredentialReadError>()(
  "CloudCliCredentialReadError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not read the stored T3 Connect CLI credential.";
  }
}

export class CloudCliAuthorizationError extends Schema.TaggedError<CloudCliAuthorizationError>()(
  "CloudCliAuthorizationError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not authorize the T3 Connect CLI.";
  }
}

export class CloudCliAuthorizationTimeoutError extends Schema.TaggedError<CloudCliAuthorizationTimeoutError>()(
  "CloudCliAuthorizationTimeoutError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Timed out waiting for T3 Connect authorization.";
  }
}

export class CloudCliAuthorizationDeniedError extends Schema.TaggedError<CloudCliAuthorizationDeniedError>()(
  "CloudCliAuthorizationDeniedError",
  {},
) {
  override get message(): string {
    return "T3 Connect authorization was denied in the browser.";
  }
}

export const CloudCliTokenManagerError = Schema.Union([
  CloudCliCredentialRemovalError,
  CloudCliCredentialRefreshError,
  CloudCliCredentialReadError,
  CloudCliAuthorizationError,
  CloudCliAuthorizationTimeoutError,
  CloudCliAuthorizationDeniedError,
]);
export type CloudCliTokenManagerError = typeof CloudCliTokenManagerError.Type;

export class CloudCliTokenManager extends Context.Service<
  CloudCliTokenManager,
  {
    readonly get: Effect.Effect<
      | { readonly _tag: "Authorized"; readonly token: PersistedToken }
      | { readonly _tag: "HeadlessRequested" },
      CloudCliTokenManagerError | Terminal.QuitError
    >;
    readonly getExisting: Effect.Effect<Option.Option<PersistedToken>, CloudCliTokenManagerError>;
    readonly hasCredential: Effect.Effect<boolean, CloudCliTokenManagerError>;
    readonly store: (token: PersistedToken) => Effect.Effect<void, CloudCliTokenManagerError>;
    readonly clear: Effect.Effect<void, CloudCliTokenManagerError>;
  }
>()("t3/cloud/CliTokenManager/CloudCliTokenManager") {}

function stringToBytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function bytesToString(value: Uint8Array): string {
  return new TextDecoder().decode(value);
}

const readTokenResponse = Effect.fn("cloud.cli_token.read_token_response")(function* (
  response: HttpClientResponse.HttpClientResponse,
  params: Record<string, string>,
) {
  const body = yield* HttpClientResponse.schemaBodyJson(OAuthTokenResponse)(response);
  const now = yield* Clock.currentTimeMillis;
  const identity =
    body.user?.email ?? body.user?.name ?? body.user?.id ?? idTokenIdentity(body.id_token);
  return {
    token: {
      accessToken: body.access_token,
      refreshToken: body.refresh_token ?? params.refresh_token ?? "",
      expiresAtEpochMs: now + body.expires_in * 1_000,
      ...(identity === null ? {} : { identity }),
    } satisfies PersistedToken,
    identity,
  };
});

const exchangeToken = Effect.fn("cloud.cli_token.exchange")(function* (
  metadata: Pick<CloudCliOAuthConfig, "tokenEndpoint">,
  params: Record<string, string>,
) {
  const httpClient = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
  const startedAt = yield* Clock.monotonicTimeNanos;
  return yield* HttpClientRequest.post(metadata.tokenEndpoint).pipe(
    HttpClientRequest.bodyUrlParams(params),
    httpClient.execute,
    Effect.flatMap((response) => readTokenResponse(response, params)),
    Effect.timeout(OAUTH_REQUEST_TIMEOUT),
    Effect.catchTags({
      HttpClientError: (cause) =>
        Effect.gen(function* () {
          const reason = cause.reason;
          if (
            params.grant_type !== "refresh_token" ||
            reason._tag !== "StatusCodeError" ||
            !isPermanentRefreshStatus(reason.response.status)
          ) {
            return yield* cause;
          }
          // Reading a rejection body shares the exchange budget without losing
          // the known status when the body stalls or cannot be decoded.
          const elapsed = Duration.toMillis(
            Duration.nanos((yield* Clock.monotonicTimeNanos) - startedAt),
          );
          const body = yield* reason.response.json.pipe(
            Effect.timeout(Math.max(0, Duration.toMillis(OAUTH_REQUEST_TIMEOUT) - elapsed)),
            Effect.mapError(
              (cause) =>
                new CloudCliCredentialRefreshError({
                  status: reason.response.status,
                  cause: new HttpClientError.HttpClientError({
                    reason: new HttpClientError.StatusCodeError({
                      request: reason.request,
                      response: reason.response,
                      cause,
                    }),
                  }),
                }),
            ),
          );
          const diagnostic = decodeOAuthRefreshErrorResponse(body);
          return yield* new CloudCliCredentialRefreshError({
            cause,
            status: reason.response.status,
            ...(Option.isSome(diagnostic) ? { oauthErrorCode: diagnostic.value.error } : {}),
          });
        }),
    }),
  );
});

export interface DeviceAuthorizationPrompt {
  readonly verificationUri: string;
  readonly verificationUriComplete: string | undefined;
  readonly userCode: string;
  readonly expiresIn: Duration.Duration;
}

const isTransportError = (error: unknown) =>
  HttpClientError.isHttpClientError(error) && error.reason._tag === "TransportError";

// Poll until approval, backing off on slow_down and transient errors within the device lifetime.
const pollDeviceToken = Effect.fn("cloud.cli_token.poll_device_token")(function* (
  metadata: Pick<CloudCliOAuthConfig, "tokenEndpoint" | "clientId">,
  deviceCode: string,
  initialInterval: Duration.Duration,
) {
  const httpClient = yield* HttpClient.HttpClient;
  const params = {
    grant_type: DEVICE_CODE_GRANT_TYPE,
    device_code: deviceCode,
    client_id: metadata.clientId,
  };
  let interval = initialInterval;
  while (true) {
    yield* Effect.sleep(interval);
    const response = yield* HttpClientRequest.post(metadata.tokenEndpoint).pipe(
      HttpClientRequest.bodyUrlParams(params),
      httpClient.execute,
      Effect.asSome,
      Effect.catchIf(isTransportError, () => Effect.succeedNone),
    );
    // Transport failures and upstream 5xx are transient while the device code
    // is still valid. RFC 8628 §3.5 asks clients to back off before retrying,
    // so widen the interval like slow_down; drain the body so the connection
    // returns to the pool for the next poll.
    if (Option.isNone(response) || response.value.status >= 500) {
      if (Option.isSome(response)) yield* Effect.ignore(response.value.text);
      interval = Duration.sum(interval, DEVICE_AUTHORIZATION_SLOW_DOWN_INCREMENT);
      continue;
    }
    if (response.value.status >= 200 && response.value.status < 300) {
      return yield* readTokenResponse(response.value, params);
    }
    const failure = yield* HttpClientResponse.schemaBodyJson(OAuthErrorResponse)(response.value);
    switch (failure.error) {
      case "authorization_pending":
        continue;
      case "slow_down":
        interval = Duration.sum(interval, DEVICE_AUTHORIZATION_SLOW_DOWN_INCREMENT);
        continue;
      case "expired_token":
        return yield* new CloudCliAuthorizationTimeoutError({ cause: failure });
      case "access_denied":
        return yield* new CloudCliAuthorizationDeniedError();
      default:
        return yield* new CloudCliAuthorizationError({
          cause: failure.error_description ?? failure.error,
        });
    }
  }
});

/** Authorize through the broker device page, including on machines without a local browser. */
export const deviceAuthorizationLogin = Effect.fn("cloud.cli_token.device_authorization_login")(
  function* <E, R>(showPrompt: (prompt: DeviceAuthorizationPrompt) => Effect.Effect<void, E, R>) {
    const metadata = yield* cloudCliOAuthConfig;
    const httpClient = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
    const authorization = yield* HttpClientRequest.post(metadata.deviceAuthorizationEndpoint).pipe(
      HttpClientRequest.bodyUrlParams({
        client_id: metadata.clientId,
        scope: metadata.scopes.join(" "),
      }),
      httpClient.execute,
      Effect.flatMap(HttpClientResponse.schemaBodyJson(DeviceAuthorizationResponse)),
    );
    yield* Effect.try({
      try: () => {
        const origin = new URL(metadata.tokenEndpoint).origin;
        for (const value of [
          authorization.verification_uri,
          authorization.verification_uri_complete,
        ]) {
          if (value === undefined) continue;
          const uri = new URL(value);
          if (uri.origin !== origin || uri.username || uri.password)
            throw new Error("Invalid relay approval URL.");
        }
        if (!Number.isFinite(authorization.expires_in) || authorization.expires_in <= 0)
          throw new Error("Invalid device code lifetime.");
      },
      catch: (cause) => new CloudCliAuthorizationError({ cause }),
    });
    // The broker's advertised lifetime and interval are authoritative.
    const expiresIn = Duration.seconds(authorization.expires_in);
    const interval =
      authorization.interval === undefined
        ? DEVICE_AUTHORIZATION_DEFAULT_INTERVAL
        : Duration.seconds(authorization.interval);
    yield* showPrompt({
      verificationUri: authorization.verification_uri,
      verificationUriComplete: authorization.verification_uri_complete,
      userCode: authorization.user_code,
      expiresIn,
    });
    return yield* pollDeviceToken(metadata, authorization.device_code, interval).pipe(
      Effect.timeout(expiresIn),
      Effect.catchTags({
        TimeoutError: (cause) => Effect.fail(new CloudCliAuthorizationTimeoutError({ cause })),
      }),
    );
  },
);

/** @public */
export const make = Effect.gen(function* () {
  // Capture exactly the services the login/refresh flows need at build time,
  // not the whole ambient context.
  const httpClient = yield* HttpClient.HttpClient;
  const services = Context.make(HttpClient.HttpClient, httpClient);
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const externalLauncher = yield* ExternalLauncher.ExternalLauncher;
  const semaphore = yield* Semaphore.make(1);
  const persist = Effect.fn("cloud.cli_token.persist")(function* (token: PersistedToken) {
    const relayUrl = yield* relayUrlConfig;
    token = { ...token, relayUrl };
    const encoded = yield* encodePersistedToken(token);
    yield* secrets.set(CLOUD_CLI_OAUTH_TOKEN_SECRET, stringToBytes(encoded));
    return token;
  });

  const clear = Effect.gen(function* () {
    const encoded = yield* secrets.get(CLOUD_CLI_OAUTH_TOKEN_SECRET);
    if (Option.isSome(encoded)) {
      yield* Effect.gen(function* () {
        const token = yield* decodePersistedToken(bytesToString(encoded.value));
        const relayUrl = yield* relayUrlConfig;
        if (token.relayUrl !== relayUrl) return;
        yield* HttpClientRequest.post(`${relayUrl}/auth/revoke`).pipe(
          HttpClientRequest.bodyUrlParams({ token: token.refreshToken, client_id: "t3-cli" }),
          httpClient.execute,
        );
      }).pipe(Effect.timeout("20 seconds"), Effect.ignore);
    }
    yield* secrets.remove(CLOUD_CLI_OAUTH_TOKEN_SECRET);
  }).pipe(
    Effect.mapError((cause) => new CloudCliCredentialRemovalError({ cause })),
    semaphore.withPermits(1),
  );

  const read = Effect.fn("cloud.cli_token.read")(function* () {
    const encoded = yield* secrets.get(CLOUD_CLI_OAUTH_TOKEN_SECRET);
    if (Option.isNone(encoded)) return Option.none<PersistedToken>();
    const token = yield* decodePersistedToken(bytesToString(encoded.value));
    const relayUrl = yield* relayUrlConfig;
    return token.relayUrl === relayUrl ? Option.some(token) : Option.none<PersistedToken>();
  });

  const refresh = Effect.fn("cloud.cli_token.refresh")(function* (token: PersistedToken) {
    const metadata = yield* cloudCliOAuthConfig;
    const { token: refreshed } = yield* exchangeToken(metadata, {
      grant_type: "refresh_token",
      refresh_token: token.refreshToken,
      client_id: metadata.clientId,
    });
    return refreshed.identity === undefined && token.identity !== undefined
      ? { ...refreshed, identity: token.identity }
      : refreshed;
  });

  const login = Effect.fn("cloud.cli_token.login")(function* () {
    const authorization = yield* deviceAuthorizationLogin((prompt) =>
      Effect.gen(function* () {
        yield* Console.log(
          `Open ${prompt.verificationUriComplete ?? prompt.verificationUri} and approve code ${prompt.userCode}.`,
        );
        yield* externalLauncher
          .launchBrowser(prompt.verificationUriComplete ?? prompt.verificationUri)
          .pipe(Effect.ignore);
      }),
    );
    return { _tag: "Authorized", token: authorization.token } as const;
  });

  const getExistingNoLock = Effect.fn("cloud.cli_token.get_existing_no_lock")(function* () {
    const token = yield* read();
    if (Option.isNone(token)) return token;
    const now = yield* Clock.currentTimeMillis;
    if (token.value.expiresAtEpochMs - CLOUD_CLI_OAUTH_REFRESH_EARLY_MS > now) {
      return token;
    }
    return Option.some(
      yield* refresh(token.value).pipe(Effect.flatMap(persist), Effect.uninterruptible),
    );
  });

  const getExisting = semaphore.withPermits(1)(
    getExistingNoLock().pipe(
      Effect.mapError((cause) =>
        isCloudCliCredentialRefreshError(cause)
          ? cause
          : new CloudCliCredentialRefreshError({
              cause,
              ...(HttpClientError.isHttpClientError(cause) &&
              cause.reason._tag === "StatusCodeError"
                ? { status: cause.reason.response.status }
                : {}),
            }),
      ),
      Effect.provide(services),
    ),
  );
  const hasCredential = semaphore.withPermits(1)(
    read().pipe(
      Effect.map(Option.isSome),
      Effect.mapError((cause) => new CloudCliCredentialReadError({ cause })),
    ),
  );
  const get = semaphore.withPermits(1)(
    Effect.gen(function* () {
      // A stored credential that can't be read or refreshed (corrupt, revoked,
      // expired grant) must fall through to a fresh login rather than dead-end
      // the command — authorizeCli applies the same fallback to device
      // authorization.
      const token = yield* getExistingNoLock().pipe(
        Effect.orElseSucceed(() => Option.none<PersistedToken>()),
      );
      if (Option.isSome(token)) {
        return { _tag: "Authorized", token: token.value } as const;
      }
      const authorization = yield* Effect.scoped(login());
      return authorization._tag === "Authorized"
        ? ({ _tag: "Authorized", token: yield* persist(authorization.token) } as const)
        : authorization;
    }).pipe(
      Effect.mapError((cause) =>
        Terminal.isQuitError(cause) ? cause : new CloudCliAuthorizationError({ cause }),
      ),
      Effect.provide(services),
    ),
  );
  const store = Effect.fn("cloud.cli_token.store")(function* (token: PersistedToken) {
    yield* semaphore.withPermits(1)(
      persist(token).pipe(
        Effect.asVoid,
        Effect.mapError((cause) => new CloudCliAuthorizationError({ cause })),
      ),
    );
  });

  return CloudCliTokenManager.of({ get, getExisting, hasCredential, store, clear });
});

export const layer = Layer.effect(CloudCliTokenManager, make);
