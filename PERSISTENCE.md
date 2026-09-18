# Account persistence

PostgreSQL is authoritative. `users.id` is the immutable UUID owner key; `email`
is already normalized and constrained unique, so a duplicate normalized-email
column is not needed. Account creation and default settings are transactional.
Passwords use Argon2id; only token hashes are stored. Sign out revokes a session,
not the account. Multiple sessions can belong to one account.

## API additions

- `PATCH /me`: strict `display_name` update for the authenticated user only.
- `POST /chats` and `POST /chats/:id/messages`: optional UUID `id` makes retries
  idempotent. IDs never establish ownership. Conflicting message content is rejected.
- The first message supplies a stored, whitespace-normalized, 80-character title.
  Explicit user titles are never overwritten. No title-generation AI is claimed.
- `GET /media`: paginated owner-only metadata, optional `type` filter.
- `DELETE /media/:id`: owner-only deletion; existing trigger queues binary cleanup.

Existing chat/message routes use bounded limit/offset pagination, deterministic
timestamp/UUID ordering, and composite ownership foreign keys. Offset pagination
is not a snapshot across simultaneous device edits; clients deduplicate IDs.
Chat deletion cascades its messages/media and queues private binary cleanup.
The current model has one chat/message association per media item, not shared media.

## Not yet connected

`STORAGE_DRIVER=disabled` remains intentional in production. No cloud object
storage credential or private bucket is configured. Local filesystem storage is
not durable on Render and must not be enabled as a substitute. Image/video/file
upload, retrieval across reinstall, and a working cloud cleanup worker still need
a backend-only private object storage provider. Metadata tests alone are not proof
of binary persistence.

AI generation is not connected. Client APIs cannot forge assistant/system messages.
A future server generation service must persist partial/final responses and their
stopped/failed state; no fake client assistant write route is added here.

## Backups

Supabase PostgreSQL persists across Render restarts, but this is not a backup.
The account's backup retention/PITR entitlement has not been verified. Before
production launch, verify backup schedules and retention in Supabase, enable PITR
if required, and run a restore drill into an isolated project. Private object
storage needs its own backup/versioning and retention policy.

Never run `npm test` against cloud: it requires a loopback `*_test` database and an
explicit matching reset guard. Production checks use disposable API-created users.
