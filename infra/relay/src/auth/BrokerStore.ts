import * as NodeCrypto from "node:crypto";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { RelayDb } from "../db.ts";
import { AccountUserSchema, type AccountUser } from "./AccountTokens.ts";

const encodeUser = Schema.encodeSync(Schema.fromJsonString(AccountUserSchema));
export const hashCredential = (value: string) =>
  NodeCrypto.createHash("sha256").update(value).digest("hex");
const randomCredential = () => NodeCrypto.randomBytes(32).toString("base64url");
export const normalizeUserCode = (value: string) => value.toUpperCase().replace(/[\s-]/gu, "");
export class BrokerStoreError extends Schema.TaggedError<BrokerStoreError>()("BrokerStoreError", {
  operation: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message() {
    return "Authentication storage failed.";
  }
}
export type GrantResult =
  | { readonly user: AccountUser; readonly refreshToken: string }
  | { readonly error: string };
interface Login {
  readonly state: string;
  readonly nonce: string;
  readonly verifier: string;
  readonly browser: string;
  readonly userCode: string;
}
interface Device {
  readonly device_code: string;
  readonly user_code: string;
  readonly expires_in: number;
  readonly interval: number;
}
interface DeviceView {
  readonly client_id: string;
  readonly user_code: string;
  readonly status: string;
}
interface Session {
  readonly user: AccountUser;
  readonly csrf: string;
}
export class BrokerStore extends Context.Service<
  BrokerStore,
  {
    readonly createDevice: (clientId: string) => Effect.Effect<Device, BrokerStoreError>;
    readonly deviceView: (code: string) => Effect.Effect<DeviceView | undefined, BrokerStoreError>;
    readonly approve: (
      code: string,
      user: AccountUser,
      approved: boolean,
    ) => Effect.Effect<boolean, BrokerStoreError>;
    readonly poll: (
      code: string,
      clientId: string,
      lifetime: number,
    ) => Effect.Effect<GrantResult, BrokerStoreError>;
    readonly refresh: (
      token: string,
      clientId: string,
    ) => Effect.Effect<GrantResult, BrokerStoreError>;
    readonly revoke: (token: string, clientId: string) => Effect.Effect<void, BrokerStoreError>;
    readonly createLogin: (userCode: string) => Effect.Effect<Login, BrokerStoreError>;
    readonly consumeLogin: (
      state: string,
      browser: string,
    ) => Effect.Effect<Login | undefined, BrokerStoreError>;
    readonly createSession: (
      user: AccountUser,
      lifetime: number,
    ) => Effect.Effect<string, BrokerStoreError>;
    readonly session: (token: string) => Effect.Effect<Session | undefined, BrokerStoreError>;
    readonly deleteSession: (token: string) => Effect.Effect<void, BrokerStoreError>;
    readonly allow: (
      key: string,
      limit: number,
      seconds: number,
    ) => Effect.Effect<boolean, BrokerStoreError>;
    readonly prune: Effect.Effect<void, BrokerStoreError>;
  }
>()("t3code-relay/auth/BrokerStore") {}

// Cluster-owned tables avoid changing the upstream Cloudflare migration history.
export const migrate = Effect.gen(function* () {
  const { $client: sql } = yield* RelayDb;
  yield* sql`CREATE TABLE IF NOT EXISTS relay_auth_login (
    state_hash text PRIMARY KEY, browser_hash text NOT NULL, nonce text NOT NULL, verifier text NOT NULL,
    user_code text NOT NULL, expires_at timestamptz NOT NULL)`;
  yield* sql`CREATE TABLE IF NOT EXISTS relay_auth_sessions (
    token_hash text PRIMARY KEY, account jsonb NOT NULL, csrf text NOT NULL, expires_at timestamptz NOT NULL)`;
  yield* sql`CREATE TABLE IF NOT EXISTS relay_auth_devices (
    code_hash text PRIMARY KEY, user_code text UNIQUE NOT NULL, client_id text NOT NULL,
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','denied','consumed')),
    account jsonb, expires_at timestamptz NOT NULL, next_poll_at timestamptz NOT NULL DEFAULT now(),
    poll_interval integer NOT NULL DEFAULT 5)`;
  yield* sql`CREATE TABLE IF NOT EXISTS relay_auth_families (
    id text PRIMARY KEY, client_id text NOT NULL, account jsonb NOT NULL,
    expires_at timestamptz NOT NULL, revoked_at timestamptz)`;
  yield* sql`CREATE TABLE IF NOT EXISTS relay_auth_refresh (
    token_hash text PRIMARY KEY, family_id text NOT NULL REFERENCES relay_auth_families(id) ON DELETE CASCADE,
    consumed_at timestamptz)`;
  yield* sql`CREATE INDEX IF NOT EXISTS relay_auth_refresh_family ON relay_auth_refresh(family_id)`;
  yield* sql`CREATE TABLE IF NOT EXISTS relay_auth_rates (
    key text PRIMARY KEY, hits integer NOT NULL, reset_at timestamptz NOT NULL)`;
});

const make = Effect.gen(function* () {
  const { $client: sql } = yield* RelayDb;
  const persistence = <A, E>(operation: string, effect: Effect.Effect<A, E>) =>
    effect.pipe(Effect.mapError((cause) => new BrokerStoreError({ operation, cause })));
  const createDevice = (clientId: string) =>
    persistence(
      "create-device",
      Effect.gen(function* () {
        const code = randomCredential();
        const userCode = NodeCrypto.randomBytes(6).toString("hex").toUpperCase();
        yield* sql`INSERT INTO relay_auth_devices(code_hash, user_code, client_id, expires_at)
      VALUES (${hashCredential(code)}, ${userCode}, ${clientId}, now() + interval '10 minutes')`;
        return {
          device_code: code,
          user_code: `${userCode.slice(0, 6)}-${userCode.slice(6)}`,
          expires_in: 600,
          interval: 5,
        };
      }),
    );
  const deviceView = (code: string) =>
    persistence(
      "device-view",
      sql<DeviceView>`
    SELECT client_id, user_code, status FROM relay_auth_devices
    WHERE user_code = ${normalizeUserCode(code)} AND expires_at > now() AND status IN ('pending','approved','denied')`.pipe(
        Effect.map((rows) => rows[0]),
      ),
    );
  const approve = (code: string, user: AccountUser, approved: boolean) =>
    persistence(
      "approve",
      sql`
    UPDATE relay_auth_devices SET status = ${approved ? "approved" : "denied"}, account = ${encodeUser(user)}::jsonb
    WHERE user_code = ${normalizeUserCode(code)} AND expires_at > now() AND status = 'pending' RETURNING code_hash`.pipe(
        Effect.map((rows) => rows.length === 1),
      ),
    );
  const poll = (code: string, clientId: string, lifetime: number) =>
    persistence(
      "poll",
      sql.withTransaction(
        Effect.gen(function* () {
          const [device] = yield* sql<{
            status: string;
            account: AccountUser | null;
            expired: boolean;
            early: boolean;
            poll_interval: number;
          }>`
      SELECT status, account, expires_at <= now() AS expired, next_poll_at > now() AS early, poll_interval
      FROM relay_auth_devices WHERE code_hash = ${hashCredential(code)} AND client_id = ${clientId} FOR UPDATE`;
          if (!device) return { error: "invalid_grant" };
          if (device.expired) return { error: "expired_token" };
          if (device.status === "denied") return { error: "access_denied" };
          if (device.status === "consumed") return { error: "invalid_grant" };
          if (device.early) {
            yield* sql`UPDATE relay_auth_devices SET poll_interval = LEAST(poll_interval + 5, 60),
        next_poll_at = now() + LEAST(poll_interval + 5, 60) * interval '1 second' WHERE code_hash = ${hashCredential(code)}`;
            return { error: "slow_down" };
          }
          if (device.status === "pending") {
            yield* sql`UPDATE relay_auth_devices SET next_poll_at = now() + poll_interval * interval '1 second'
        WHERE code_hash = ${hashCredential(code)}`;
            return { error: "authorization_pending" };
          }
          if (!device.account) return { error: "invalid_grant" };
          const family = NodeCrypto.randomUUID();
          const refreshToken = randomCredential();
          yield* sql`UPDATE relay_auth_devices SET status = 'consumed' WHERE code_hash = ${hashCredential(code)}`;
          yield* sql`INSERT INTO relay_auth_families(id,client_id,account,expires_at)
      VALUES (${family},${clientId},${encodeUser(device.account)}::jsonb,now() + ${lifetime} * interval '1 second')`;
          yield* sql`INSERT INTO relay_auth_refresh(token_hash,family_id) VALUES (${hashCredential(refreshToken)},${family})`;
          return { user: device.account, refreshToken };
        }),
      ),
    );
  const refresh = (token: string, clientId: string) =>
    persistence(
      "refresh",
      sql.withTransaction(
        Effect.gen(function* () {
          // Lock the family first. Concurrent refresh/revoke requests use this same lock order.
          const [family] = yield* sql<{
            id: string;
            account: AccountUser;
            expired: boolean;
            revoked: boolean;
          }>`
      SELECT f.id, f.account, f.expires_at <= now() AS expired, f.revoked_at IS NOT NULL AS revoked
      FROM relay_auth_families f JOIN relay_auth_refresh r ON r.family_id=f.id
      WHERE r.token_hash=${hashCredential(token)} AND f.client_id=${clientId} FOR UPDATE OF f`;
          if (!family || family.expired || family.revoked) return { error: "invalid_grant" };
          const [current] = yield* sql<{
            consumed: boolean;
          }>`SELECT consumed_at IS NOT NULL AS consumed
      FROM relay_auth_refresh WHERE token_hash=${hashCredential(token)}`;
          if (!current || current.consumed) {
            yield* sql`UPDATE relay_auth_families SET revoked_at=now() WHERE id=${family.id}`;
            // Return an error value so family revocation commits instead of rolling back.
            return { error: "invalid_grant" };
          }
          const refreshToken = randomCredential();
          yield* sql`UPDATE relay_auth_refresh SET consumed_at=now() WHERE token_hash=${hashCredential(token)}`;
          yield* sql`INSERT INTO relay_auth_refresh(token_hash,family_id) VALUES (${hashCredential(refreshToken)},${family.id})`;
          return { user: family.account, refreshToken };
        }),
      ),
    );
  const revoke = (token: string, clientId: string) =>
    persistence(
      "revoke",
      sql`
    UPDATE relay_auth_families SET revoked_at=now() WHERE client_id=${clientId}
    AND id IN (SELECT family_id FROM relay_auth_refresh WHERE token_hash=${hashCredential(token)})`.pipe(
        Effect.asVoid,
      ),
    );
  const createLogin = (userCode: string) =>
    persistence(
      "create-login",
      Effect.gen(function* () {
        const login = {
          state: randomCredential(),
          nonce: randomCredential(),
          verifier: randomCredential(),
          browser: randomCredential(),
          userCode: normalizeUserCode(userCode),
        };
        yield* sql`INSERT INTO relay_auth_login(state_hash,browser_hash,nonce,verifier,user_code,expires_at)
      VALUES (${hashCredential(login.state)},${hashCredential(login.browser)},${login.nonce},${login.verifier},
        ${login.userCode},now() + interval '10 minutes')`;
        return login;
      }),
    );
  const consumeLogin = (state: string, browser: string) =>
    persistence(
      "consume-login",
      sql<{ nonce: string; verifier: string; user_code: string }>`
    DELETE FROM relay_auth_login WHERE state_hash=${hashCredential(state)} AND browser_hash=${hashCredential(browser)}
      AND expires_at > now() RETURNING nonce,verifier,user_code`.pipe(
        Effect.map((rows) => {
          const row = rows[0];
          return row
            ? { state, browser, nonce: row.nonce, verifier: row.verifier, userCode: row.user_code }
            : undefined;
        }),
      ),
    );
  const createSession = (user: AccountUser, lifetime: number) =>
    persistence(
      "create-session",
      Effect.gen(function* () {
        const token = randomCredential();
        yield* sql`INSERT INTO relay_auth_sessions(token_hash,account,csrf,expires_at)
      VALUES (${hashCredential(token)},${encodeUser(user)}::jsonb,${randomCredential()},now() + ${lifetime} * interval '1 second')`;
        return token;
      }),
    );
  const session = (token: string) =>
    persistence(
      "session",
      sql<{ account: AccountUser; csrf: string }>`
    SELECT account,csrf FROM relay_auth_sessions WHERE token_hash=${hashCredential(token)} AND expires_at > now()`.pipe(
        Effect.map((rows) => (rows[0] ? { user: rows[0].account, csrf: rows[0].csrf } : undefined)),
      ),
    );
  const deleteSession = (token: string) =>
    persistence(
      "delete-session",
      sql`DELETE FROM relay_auth_sessions WHERE token_hash=${hashCredential(token)}`.pipe(
        Effect.asVoid,
      ),
    );
  const allow = (key: string, limit: number, seconds: number) =>
    persistence(
      "rate-limit",
      sql<{ hits: number }>`
    INSERT INTO relay_auth_rates(key,hits,reset_at) VALUES(${key},1,now() + ${seconds} * interval '1 second')
    ON CONFLICT(key) DO UPDATE SET hits=CASE WHEN relay_auth_rates.reset_at <= now() THEN 1 ELSE relay_auth_rates.hits+1 END,
      reset_at=CASE WHEN relay_auth_rates.reset_at <= now() THEN excluded.reset_at ELSE relay_auth_rates.reset_at END RETURNING hits`.pipe(
        Effect.map((rows) => (rows[0]?.hits ?? limit + 1) <= limit),
      ),
    );
  const prune = persistence(
    "prune",
    Effect.gen(function* () {
      yield* sql`DELETE FROM relay_auth_login WHERE expires_at <= now()`;
      yield* sql`DELETE FROM relay_auth_sessions WHERE expires_at <= now()`;
      yield* sql`DELETE FROM relay_auth_devices WHERE expires_at <= now()`;
      yield* sql`DELETE FROM relay_auth_families WHERE expires_at <= now()`;
      yield* sql`DELETE FROM relay_auth_rates WHERE reset_at <= now()`;
    }),
  );
  return BrokerStore.of({
    createDevice,
    deviceView,
    approve,
    poll,
    refresh,
    revoke,
    createLogin,
    consumeLogin,
    createSession,
    session,
    deleteSession,
    allow,
    prune,
  });
});
export const layer = Layer.effect(BrokerStore, make);
