# ChatPop Backend

Real PostgreSQL API foundation. No frontend/iOS changes, AI integrations,
OAuth, payments, or subscription logic are included.

## Stack and layout

- Node.js 24+, TypeScript, Fastify 5, node-postgres (`pg`).
- PostgreSQL 18, transactional SQL migrations with `node-pg-migrate`.
- Argon2id passwords: 64 MiB memory, 3 iterations, parallelism 1, random salts.
- Zod strict request validation; native Node test runner and a real test database.
- `src/app.ts`: routes, validation, authentication middleware, ownership, security.
- `src/auth.ts`: registration, password verification, hashed sessions/rotation.
- `src/storage.ts`: private-storage contract and optional local-filesystem adapter.
- `src/cleanup.ts`: retryable, transactionally queued media deletion worker.
- `migrations/1789466400000_foundation.sql`: initial reversible schema.

## Run on this Mac

The implementation environment has a private PostgreSQL 18.6 installation under
`.local/pgsql`, a persistent cluster under `.local/pgdata`, and separate
`chatpop` and `chatpop_test` databases with different SCRAM-authenticated roles.
The server listens only on `127.0.0.1:55432`. Generated `.env`/`.env.test` files
are mode 0600 and ignored by Git. Do not share or commit them.

```sh
cd /Users/mohned/Desktop/ks/chatpop-backend
export PATH="/Users/mohned/Desktop/ks/.tools/node-v24.21.0-darwin-x64/bin:$PATH"
npm ci
node scripts/local-db.mjs start
npm run migrate
npm run build
npm start
```

API: `http://127.0.0.1:3000`. `npm run dev` starts TypeScript directly.
Stop the API with Ctrl-C; database records remain on disk.

### Real iPhone development on the same network

```sh
npm run dev:lan:start
npm run dev:lan:status
# After testing on the phone:
npm run dev:lan:stop
```

The development service keeps the API running after the terminal or assistant
session ends. `start` is idempotent, checks that its own listener is ready and
that PostgreSQL responds, and refuses an occupied port. `stop` checks a unique
process identity before sending a signal, so a stale PID cannot stop another
application. Private PID/log files live under Git-ignored `.local` (mode 0600).
These lifecycle commands use macOS `ps`/`lsof`; they are a local development
convenience, not a production service manager. `npm run dev:lan` remains
available in the foreground, but closing that terminal stops that server.

This explicit development launcher binds the existing Fastify API to `0.0.0.0`
on `PORT` (default 3000). It refuses `NODE_ENV=production` or `test`. Normal
`npm start` / `npm run dev` retain the configured `HOST` and loopback default;
production TLS, proxy and database rules are unchanged. PostgreSQL remains
bound to loopback and its credentials never go to the phone.

Find the Mac's Wi-Fi address with `ipconfig getifaddr en0` (use the active
interface if different). Set the iOS development API base URL to
`http://<MAC_LAN_IP>:3000`, not `localhost`/`127.0.0.1`; the latter refer to the
phone itself. The frontend README documents the single native API configuration
file. Keep the phone and Mac on the same trusted Wi-Fi, allow the Node development
server through the Mac firewall if asked, and allow the app's Local Network
permission. Client isolation/guest Wi-Fi/VPN policies can block the connection.
Do not open a router port or expose this HTTP development server to the internet.
HTTP does not encrypt credentials: use test accounts on a trusted LAN only, and
use verified HTTPS for staging and production. Stop the listener when finished.

Native `URLSession` requests do not require a browser CORS exception; the existing
allowlist and authentication/rate limits stay enabled. No wildcard CORS or
production ATS exception is needed.

After building, verify the same HTTP auth contract against local PostgreSQL:

```sh
npm run build
AUTH_SMOKE_BASE_URL="http://$(ipconfig getifaddr en0):3000" npm run verify:auth
```

This development-only check creates a random temporary user, verifies its
persisted password hash, tests registration/login/current-user/refresh/logout
and account deletion, then removes that fixture. It never logs passwords or
tokens. It is not a substitute for testing Keychain and navigation on an iPhone.

```sh
node scripts/local-db.mjs status
node scripts/local-db.mjs stop
node scripts/local-db.mjs start
npm test
npm run storage:cleanup
```

`.local` is deliberately not committed. The source build used the official
PostgreSQL 18.6 archive, verified SHA-256
`555610c24d53e4316da5b7d3fc25c279d96856d5e0e23ee308c328c5fa881d9f`.
It was built without TLS/ICU/readline/zlib for loopback-only development, **not
as a production PostgreSQL distribution**. For a fresh local installation,
install PostgreSQL and set `PG_BIN=/path/to/postgres/bin` before running
`node scripts/local-db.mjs init`. Init refuses to overwrite an existing cluster
or env files. It generates credentials, creates dev/test roles/databases, and
starts the database; it does not create application tables. Migrations do that.

## Any new environment / Docker alternative

1. Install Node 24+ and run `npm ci`.
2. Provision PostgreSQL. Docker users can use the included `compose.yaml` with
   a persistent named volume. Set `POSTGRES_USER`, `POSTGRES_PASSWORD`, and
   `POSTGRES_DB` in an ignored `.env`, then run `docker compose up -d postgres`.
   Compose is development-only: its initial role is the container administrator.
   Do not expose port 5432 publicly or use that role for a production API.
3. Create `.env` using the variable names in `.env.example`, replacing all
   placeholders. Set `DATABASE_URL` to the real database connection string.
4. Generate `RATE_LIMIT_SECRET` using
   `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
5. Run `npm run migrate`, `npm run build`, and `npm start`.

Production can inject environment variables without any `.env` file. Use
`NODE_ENV=production`, `DATABASE_SSL=true`, and, if needed, `DATABASE_CA_FILE`.
Certificate verification is never disabled. Use a TLS-enabled managed or
properly installed PostgreSQL server; the bundled local build is not for this.
Run migrations once per release with a schema-owner role, then run the API with
a separate least-privilege role granted DML on application tables. Do not give
the runtime role superuser, role-management, database-creation, or schema-owner
privileges. Back up the database and private storage, test restores, and keep
PostgreSQL/Node/dependencies patched.

Terminate HTTPS at a trusted reverse proxy; keep the API/network private behind
it. `TRUST_PROXY=false` is the safe default. Only set it to true if the API cannot
be reached except through your controlled proxy, which replaces forwarded
headers. CORS is an exact origin allowlist, not an authentication mechanism.

## Environment

Required: `DATABASE_URL`, `RATE_LIMIT_SECRET` (32+ random characters).

Other variables: `NODE_ENV`, `HOST`, `PORT`, `DATABASE_SSL`, `DATABASE_CA_FILE`,
`DB_POOL_MAX`, `ACCESS_TOKEN_SECONDS` (60-900, default 900), `SESSION_DAYS`
(1-90, default 30), `CORS_ORIGINS`, `TRUST_PROXY`, `STORAGE_DRIVER`,
`STORAGE_LOCAL_ROOT`, `MAX_MEDIA_BYTES` (at most 100 MiB).

No JWT signing secret, AI API key, payment secret, or OAuth credential is needed.
Database URLs must percent-encode reserved characters in credentials.

## Data model

- `users`: UUID, normalized unique email, Argon2id hash, display name, provider,
  account status, timestamps. Provider values reserve email/Apple/Google/Microsoft;
  only email/password authentication is implemented. Social account linking and
  provider subject identifiers will need a later identities migration.
- `user_settings`: one-to-one theme, voice, default provider/model and language.
- `sessions`: hashed access credentials, expiry, revocation and last-used time.
- `refresh_tokens`: hashed one-time tokens and consumption history per session.
- `chats`: owner, title, default/auto/user title source, activity, archive timestamp.
- `messages`: chat/owner, role, content, provider/model, status and creation time.
- `media`: private object metadata only, optional chat/message association.
- `storage_deletions`: durable cleanup outbox independent of deleted users.
- `rate_limits`: expiring HMAC-keyed counters shared by API instances.
- `pgmigrations`: migration ledger managed by node-pg-migrate.

Composite foreign keys prevent cross-owner chat/message/media associations.
Ownership comes from the session, never a client-supplied user ID. All API queries
also scope by authenticated owner; other users' resources return 404. No RLS is
claimed: the API and database integrity constraints are the enforcement layers.

## Authentication contract

Registration accepts `{email,password,display_name?}`, atomically creates user
and settings, and returns a safe user profile. It does not automatically log in.
Email is trimmed/lowercased; registration passwords are 12-128 characters and
are never trimmed. Login accepts the original password (1-128 characters).

Login returns `{user,access_token,refresh_token,token_type,expires_in}`. Tokens are
opaque 256-bit random values, not JWTs. Only SHA-256 hashes are stored. The access
token lasts at most 15 minutes; a session has a fixed maximum lifetime of 30 days
by default. Send `Authorization: Bearer <access_token>` to protected endpoints.
No cookies or token-in-URL authentication is accepted.

Refresh submits `{refresh_token}`. Every successful refresh consumes its old
token and replaces both credentials in a locked transaction. Old access tokens
stop working immediately. Reusing a consumed refresh token revokes the entire
session, including newly issued credentials. **The future mobile client must
serialize refresh requests and atomically replace its stored credentials.** A
lost refresh response may require signing in again; automatic duplicate refresh
retries intentionally fail closed. Store long-lived credentials in iOS Keychain,
not browser storage. The native client uses these existing routes; registration
must be followed by login and `/me` before treating the user as signed in.

Logout revokes the current session immediately. Disabled users cannot log in or
refresh. Wrong password and unknown account login errors are identical. Duplicate
registration returns 409 as requested (this reveals that an email is registered).
Email verification, recovery email delivery, MFA, and external OAuth are not yet
implemented. Do not treat unverified email as an ownership proof for future
OAuth linking or privileged account operations.

## Routes

All bodies are JSON. Responses use `{user}`, `{settings}`, `{chat}`, `{message}`,
`{media}` or plural collections. Errors use `{error:{code,message,request_id}}`.
No stack traces, database details, token values in logs, or password hashes are
returned. Request logs include method, route template, status and request ID,
not request bodies, query strings, raw URLs, headers or credentials.

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/health` | Liveness, no database dependency |
| GET | `/ready` | Database/schema readiness |
| POST | `/auth/register` | Real user + default settings |
| POST | `/auth/login` | Password verification + session |
| POST | `/auth/refresh` | One-time refresh rotation |
| POST | `/auth/logout` | Revoke authenticated session (204) |
| GET | `/me` | Safe authenticated profile |
| DELETE | `/me` | Reauthenticated deletion (204) |
| GET/PATCH | `/me/settings` | Own settings |
| POST/GET | `/chats` | Create/list/search own chats |
| GET/PATCH/DELETE | `/chats/:id` | Read/rename/delete own chat |
| POST/GET | `/chats/:id/messages` | Save user message/list own chat messages |
| GET | `/media/:id` | Private metadata, excludes storage key |
| GET | `/media/:id/content` | Authenticated private file download |

Chat creation accepts optional `{title}`. Rename accepts `{title}` and always sets
`title_source=user`. List uses `?q=title&limit=30&offset=0`; literal, case-insensitive
substring search is scoped to the owner. Max limit 100, max offset 10000. Chats
sort by last message or creation time, then ID; messages sort oldest first.
Offset pagination is intentionally simple and may shift with concurrent writes.

Saving a message accepts **only** `{content}` (1-20000 characters, not whitespace).
Role is server-assigned `user`; client-supplied owner, provider, role, status,
or model fields are rejected. Settings use a strict partial update; omitted
fields stay unchanged, and `default_ai_model` can explicitly be null.

DELETE `/me` requires `{password,confirmation:"DELETE"}`. The user and all
relational data are deleted transactionally. Before media rows disappear, a
database trigger enqueues storage keys for asynchronous deletion in the same
transaction. No credentials are copied into the outbox. Physical-file removal
is eventual; monitor and run the cleanup worker until the queue drains.

## Private media and cleanup

There is **no upload or client metadata-creation endpoint** in this phase.
Trusted future ingestion code must validate actual file signatures (not just
claimed MIME), sizes, and ownership before inserting metadata. Allowed download
types are PNG/JPEG/WebP, MP4/WebM, MPEG/MP4/WAV/Ogg audio, PDF and plain text.
HTML/SVG/executable content is not served. File size is checked against metadata
and the configured cap; downloads are attachments with `nosniff` and `no-store`.

`STORAGE_DRIVER=disabled` fails closed (503 for content); metadata remains usable.
The `local` adapter serves files from a private service-owned directory through
authenticated routes, never a static public mount. Use opaque generated keys
without names/email, never reuse keys, and do not allow untrusted processes to
write/swap directories or symlinks under the storage root. The adapter validates
paths and rejects symlink escapes. It is suitable for a persistent single-host
volume; horizontally scaled production should add an object-store adapter.

Add an S3-compatible or other adapter behind `PrivateStorage`, not inside routes.
If adding signed URLs later, issue short-lived URLs only after the same ownership
check. Account deletion cannot instantly revoke an already issued signed URL;
keep TTLs short. No permanent private-file URLs exist here.

Run `npm run storage:cleanup` at least once a minute through your scheduler.
Workers lock jobs with `SKIP LOCKED`; missing files count as successfully deleted.
Failures remain queued with exponential retry (max one hour), without storing
raw provider error messages. Alert on oldest pending job age and repeated
attempts. Do not delete disabled-driver jobs manually: configure their matching
adapter and rerun cleanup. The worker also expires sessions and rate counters.

## Tests and persistence proof

`npm test` uses `.env.test`, applies migrations, then truncates only a designated
test database. It refuses to run unless NODE_ENV is test, the hostname is
loopback, the database ends in `_test`, and `ALLOW_TEST_DATABASE_RESET` exactly
matches that name. Test database credentials are separate from development.
For a fresh environment, provision that database/role first and put its URL in
`.env.test`. Never point test configuration at production.

Tests cover real registration, duplicate races, hashing, login failures,
authentication, settings/chat/message/media isolation, token rotation/replay,
logout, expiry/disabled accounts, transactional deletion/file cleanup, request
validation, rate limiting, and backend restart persistence.

On this Mac only, after building, the following non-destructive proof creates
one labeled development fixture, exercises actual HTTP, restarts the isolated
PostgreSQL cluster and API, and verifies persisted state and login/logout:

```sh
node --env-file=.env scripts/verify-persistence.mjs
```

The fixture stays in development PostgreSQL. Its generated credentials are not
saved. This command is restricted to the bundled loopback development database;
it is not a production maintenance command.

## Supabase Session Pooler verification

The backend can use the existing Supabase PostgreSQL Session Pooler on port 5432.
Keep the connection string exclusively in the ignored backend `.env`; never
copy it to frontend configuration. Set `DATABASE_SSL=true` and
`DATABASE_CA_FILE=certs/supabase-ca.crt`. The CA was downloaded from the project's
Supabase SSL Configuration page. Both the backend and migration runner retain
`rejectUnauthorized: true`; no global trust-store or TLS bypass is needed.

The `backend_only_access` migration enables RLS without public policies and
revokes PUBLIC, anon, authenticated and service_role grants on only ChatPop's
tables, including its migration ledger. The current PostgreSQL owner continues
to access data through the existing backend, which enforces per-user ownership.
This does not enable Supabase Auth or direct frontend database access. Its down
migration intentionally does not restore unsafe grants. Future tables must also
be reviewed for Supabase default privileges before storing sensitive data.

After building and applying migrations, run the explicit cloud smoke check:

```sh
CONFIRM_CLOUD_SMOKE=yes node --env-file=.env scripts/verify-cloud.mjs
```

This uses real HTTP on a temporary loopback port and verified database TLS.
It checks registration, Argon2id storage, login, safe profile responses, refresh,
logout, settings, chats, messages, bidirectional ownership and account deletion.
It closes and recreates the backend server with a new database pool to verify
persistence, without restarting the managed cloud database. It creates only
random test identities and metadata, then removes its own fixtures. Normal
database-backed rate limits remain enabled; rate-limit counters expire normally.
No object-storage files are created. Repeated runs can hit the normal auth limits.
Never point the destructive `npm test` suite at the cloud database.

## Existing Render service

Use this repository's root directory and `main` branch for the existing service.
Use Node 24 (also specified in `.nvmrc`). Install build dependencies explicitly:

- Build command: `npm ci --include=dev && npm run build`
- Start command: `npm start`
- Health check path: `/health` (process health); `/ready` also exercises PostgreSQL.
- Run `npm run migrate` as a controlled pre-deploy command where supported, or
  through a one-off administrative command before starting a new schema version.
  Never run the reset-based local test suite against the production database.

Configure environment variables privately in Render, not in Git:
`NODE_ENV=production`, `HOST=0.0.0.0`, `DATABASE_URL`, `DATABASE_SSL=true`,
`DATABASE_CA_FILE=certs/supabase-ca.crt`, and a strong `RATE_LIMIT_SECRET`.
Honor Render's supplied `PORT`; configure `CORS_ORIGINS` for the actual clients.
Do not upload the local `.env`. Keep `STORAGE_DRIVER=disabled` until durable
private storage is configured. Review trusted proxy behavior and client-IP rate
limiting against the deployment edge before public rollout; do not blindly
trust client-supplied forwarded headers. Credentials, Render configuration,
cloud connectivity, backups, monitoring and deployment smoke checks must be
verified separately; pushing source alone does not establish production readiness.

## Future integration boundaries

AI providers will be server-side services that save assistant messages with the
appropriate provider/model/status. Add token usage, latency, error metadata and
attachments through migrations when their contracts are known. Auto titles must
update only rows still using `title_source=default` so manual names always win.
No AI request or provider routing is implemented now.

Before production exposure: configure hosting/HTTPS, verified PostgreSQL TLS,
least-privilege roles, backups, monitoring, private object storage/worker scheduling,
and secrets management. This foundation is tested locally, not deployed or
independently security-audited.

References: [OWASP password storage](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html),
[PostgreSQL source installation](https://www.postgresql.org/docs/18/install-getsource.html).
