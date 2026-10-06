# T3 Connect Relay

> [!NOTE]
> Sign in to T3 Connect from the app under Settings > Connections.

The relay is the hosted control plane for T3 Connect. It helps clients discover and connect to
remote environments, manages the cloud-side records needed for those connections, and delivers
optional mobile notifications and Live Activities.

The relay is intentionally not in the hot path for normal T3 Code traffic. After a client connects,
regular API and WebSocket traffic goes directly between that client and the selected environment.
See the [T3 Connect architecture note](../../docs/internals/t3-connect.md) for the larger system
design.

## Responsibilities

The relay currently owns:

- Linking T3 Code environments to a cloud account.
- Provisioning and tracking managed environment endpoints.
- Issuing short-lived credentials used to connect clients to linked environments.
- Listing linked environments and registered mobile devices for an account.
- Registering mobile notification preferences and APNs or FCM tokens.
- Receiving published agent activity and delivering notifications or Live Activity updates.
- Persisting relay state and exposing relay-specific traces for diagnostics.

The environment server and relay have separate credentials and trust boundaries. Read
[Environment Authentication Profile](../../docs/internals/environment-auth.md) before changing token,
credential, or authorization behavior.

## Code Map

- [`alchemy.run.ts`](./alchemy.run.ts) defines the deployed Alchemy stack.
- [`src/worker.ts`](./src/worker.ts) wires Cloudflare bindings, runtime layers, queues, and HTTP APIs.
- [`src/http/Api.ts`](./src/http/Api.ts) contains the relay HTTP handlers and authentication
  boundaries.
- [`src/environments`](./src/environments) contains environment linking, credentials, endpoint
  provisioning, and connection flows.
- [`src/agentActivity`](./src/agentActivity) contains mobile device registration, activity state,
  APNs and FCM delivery, and queue processing.
- [`src/auth`](./src/auth) contains relay token and DPoP proof handling.
- [`src/persistence/schema.ts`](./src/persistence/schema.ts) defines persisted relay state. Keep
  schema and migration changes together.

Shared request and response schemas live in
[`packages/contracts/src/relay.ts`](../../packages/contracts/src/relay.ts). Shared client-side relay
calls live in
[`packages/client-runtime/src/relay/managedRelay.ts`](../../packages/client-runtime/src/relay/managedRelay.ts).

## Working Locally

Install dependencies from the repository root, then run relay-focused checks from this directory:

```sh
vp install
cd infra/relay
vp test run
vp run typecheck
```

To run a smaller test set while iterating:

```sh
vp test run src/environments/EnvironmentLinker.test.ts
```

Before considering a change complete, run the repository-wide checks from the root:

```sh
vp check
vp run typecheck
```

Backend changes should include tests. Prefer testing the real business logic with external
dependencies represented at their boundary rather than mocking internal behavior.

## Cluster deployment

LunarHUE's private deployment uses `src/cluster/main.ts` and `Dockerfile`. It runs
Node with direct PostgreSQL connections, keeping the Cloudflare entrypoint intact.
The deployment root and operational instructions live in
[Infrastructure-Tofu/t3connect](https://github.com/LunarHUE/Infrastructure-Tofu/tree/master/t3connect).

The entrypoint accepts `serve`, `deliver`, `cleanup`, and `migrate-cluster`.
The image workflow runs the cluster adapter tests against disposable PostgreSQL.
For local integration tests, set `RELAY_CLUSTER_TEST_DATABASE_URL` to a disposable
database named `t3_relay_test`, then run `vp test run infra/relay/src/cluster`.
These tests delete fixture rows. Never use a production database.

Set `T3CODE_RELAY_PRIVATE_NETWORK=true` on environment hosts when using the fork's
CLI, so `t3 connect` skips installing cloudflared. The normal link flow is retained;
the relay advertises only administrator-configured private HTTPS endpoints.

## Deployment

The following instructions describe the optional Cloudflare deployment.

This fork defaults to an existing PostgreSQL database through Cloudflare Hyperdrive,
Clerk authentication, and disabled telemetry/mobile push. Upstream Axiom, APNs/FCM,
queue, and PlanetScale implementations remain available behind deployment settings.
Ordinary Worker logs remain available when telemetry is disabled.

### 1. Prepare Supabase

Use the Postgres database in your hosted Supabase project. You do not need Neon,
Supabase Auth, or a Supabase API key. Prefer a project dedicated to relay data.

In Supabase's **Connect** panel, copy two PostgreSQL URLs:

- **Direct connection**, port 5432: `RELAY_DATABASE_URL`. Hyperdrive connects here
  and manages pooling itself. Use a runtime database role with access to the relay tables.
- **Session pooler**, port 5432: `RELAY_MIGRATION_DATABASE_URL`. GitHub-hosted runners
  can reach this IPv4 endpoint. Use a migration role that can create and alter tables.
  Use the exact hostname and username supplied by Supabase; the pooler username
  includes the project reference. Add `sslmode=require` for the migration connection.

Percent-encode special characters in URL credentials. Do not use the transaction
pooler on port 6543. Hyperdrive origin configuration takes the host, port, database,
user and password from its URL; URL query options are not passed to Hyperdrive.
Hyperdrive requires TLS, and query caching stays disabled for relay state.

The deployment workflow applies the checked-in Drizzle migrations before deploying
Worker code. It never creates or deletes your Supabase database. All external
stages use the database you supply: use separate database credentials/projects for
separate stages, since this path does not create PlanetScale branches.

For a manual migration, supply `RELAY_MIGRATION_DATABASE_URL` in the process environment:

```sh
vp run --filter t3code-relay db:migrate
```

Runtime credentials need SELECT, INSERT, UPDATE and DELETE on the relay tables,
USAGE on their schema, and any required sequence privileges. Grant those after the
first migration, including future tables when upgrading. Migration credentials
stay in CI; they are not bound into the Worker.

[Cloudflare's Supabase guide](https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/postgres-database-providers/supabase/)
explains the direct connection. [Supabase's connection guide](https://supabase.com/docs/guides/database/connecting-to-postgres)
explains the session pooler and IPv4 access.

### 2. Choose Cloudflare domains and create a token

The API domain defaults to `relay.<RELAY_API_ZONE_NAME>`. `RELAY_DOMAIN` overrides it.
Managed environments get `<stage>-<digest>.<RELAY_TUNNEL_ZONE_NAME>` hostnames.
Both zone settings must identify existing Cloudflare DNS zones. They can be the
same zone; an arbitrary subdomain is not automatically a separate Cloudflare zone.
Alchemy adopts the zones and creates the Worker, Hyperdrive configuration, managed
endpoint resources, hook Durable Objects, and deployment state.

Scope the deployment token to the intended account and zones:

| Scope   | Permission         | Access |
| ------- | ------------------ | ------ |
| Account | Workers Scripts    | Edit   |
| Account | Hyperdrive         | Edit   |
| Account | Cloudflare Tunnel  | Edit   |
| Account | Account API Tokens | Edit   |
| Account | Secrets Store      | Edit   |
| Account | Account Settings   | Read   |
| Zone    | Zone               | Read   |
| Zone    | DNS                | Edit   |
| Zone    | Workers Routes     | Edit   |

Alchemy creates scoped runtime tokens for tunnel/DNS operations. Its state store
uses a Worker, Durable Object, and Secrets Store. Queues permissions are only
needed if mobile push is enabled later. Some permission menus label Edit as Write.

### 3. Configure Clerk

Follow [T3 Connect setup](../../docs/operations/connect-setup.md) for:

- A Clerk application, preferably restricted to your team.
- A `t3-relay` JWT template with audience `t3-code-relay`.
- The public CLI OAuth application, PKCE callback and device grant for headless hosts.
- Native API and Electron redirect allowlists.

The Clerk secret key is relay-only. The publishable key, JWT template name and
CLI OAuth client ID belong in client builds. Device-grant availability must be
confirmed in your Clerk account before relying on headless container sign-in.

### 4. Configure GitHub Actions

Create the `production` environment in this fork. Add these **secrets**:

- `CLOUDFLARE_API_TOKEN`
- `CLERK_SECRET_KEY`
- `RELAY_DATABASE_URL`
- `RELAY_MIGRATION_DATABASE_URL`

Add these environment **variables**:

- `CLOUDFLARE_ACCOUNT_ID`
- `RELAY_API_ZONE_NAME`
- `RELAY_TUNNEL_ZONE_NAME`
- `CLERK_PUBLISHABLE_KEY`
- `CLERK_JWT_AUDIENCE=t3-code-relay`
- Optional `RELAY_DOMAIN`

Defaults need no additional configuration:

```dotenv
RELAY_DATABASE_PROVIDER=external
RELAY_TELEMETRY_ENABLED=false
RELAY_MOBILE_PUSH_ENABLED=false
```

Set the **repository** variable `RELAY_DEPLOY_ENABLED=true` once configured.
The workflow must be on main. Run **Deploy T3 Connect relay** from main, leaving
`force` unchecked. It applies migrations, then deploys the `prod` stack. Later
relevant main pushes deploy automatically; variable/secret changes require a manual run.

For local deployment, Alchemy loads `infra/relay/.env`; copy `.env.example` and
supply the deployment values. Run migrations separately before deploying:

```sh
vp run --filter t3code-relay deploy --stage prod --yes --no-input
```

The deployment's `PublishClientConfig` action writes its URL and tracing settings
to the root `.env`, or `T3CODE_RELAY_CLIENT_CONFIG_ENV` if set. Disabled telemetry
writes empty tracing values so stale tokens from an earlier deployment are cleared.
CI redirects that file into its temporary directory.

### 5. Build clients for this relay

Set these **repository variables**, which the Release workflow reads:

```dotenv
T3CODE_RELAY_URL=https://relay.example.com
CLERK_PUBLISHABLE_KEY=pk_...
CLERK_JWT_TEMPLATE=t3-relay
CLERK_CLI_OAUTH_CLIENT_ID=...
```

Build a preview Electron release and verify sign-in, host registration and a
remote connection before publishing an updater-enabled stable/nightly release.
The relay deployment alone does not repoint existing desktop installations.

### Optional upstream integrations

- `RELAY_TELEMETRY_ENABLED=true` enables the existing Axiom resources and exporters.
  Supply `AXIOM_ORG_ID` and `AXIOM_TOKEN`. Disabled mode provisions none and keeps
  the existing trace annotations and exporter implementation in source.
- `RELAY_MOBILE_PUSH_ENABLED=true` provisions the upstream push queues and consumers.
  Supply APNs credentials and set `APNS_ENABLED=true` for Apple delivery, and/or
  `FCM_SERVICE_ACCOUNT` for Android delivery. Disabled mode reads neither set of
  credentials, creates no queues, and supplies no-op queue transports.
- `RELAY_DATABASE_PROVIDER=planetscale` selects the original database/branch/role
  provisioning and migrations. It requires the original PlanetScale credentials.

Both tunnel-cleanup switches remain off unless explicitly configured. Follow the
[cleanup rollout runbook](../../docs/operations/release.md#legacy-tunnel-cleanup)
before enabling them. Tunnel quotas still follow `ManagedTunnelLimits`; selecting
an external database does not change the quota policy.
