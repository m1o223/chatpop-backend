# Private cloud media: rollout status

The implementation is staged locally. It is NOT enabled on Render and has NOT
been verified against real Supabase Storage. Do not treat the local storage-double
tests as a cloud persistence result. Do not deploy before applying the migrations.

## Provider and secrets

Use the existing Supabase project and one PRIVATE bucket, `chatpop-media`.
Privileged credentials belong only in the existing Render service environment.
Do not put credential values in source, `.env.example`, iOS, or logs.

Environment variable names:

- `STORAGE_DRIVER`: keep disabled until verification; adapter supports supabase.
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY` (secret)
- `STORAGE_BUCKET`
- `STORAGE_SIGNED_URL_SECONDS`
- `STORAGE_USER_MAX_BYTES`, `STORAGE_USER_MAX_FILES`
- `STORAGE_MAX_IMAGE_BYTES`, `STORAGE_MAX_VIDEO_BYTES`
- `STORAGE_MAX_AUDIO_BYTES`, `STORAGE_MAX_DOCUMENT_BYTES`
- `STORAGE_UPLOAD_CONCURRENCY`, existing `MAX_MEDIA_BYTES`

Operational defaults are safety ceilings, not confirmed Free/Plus/Pro allowances:
256 MiB / 100 files per user; 20 MiB images/PDFs, 50 MiB videos, 25 MiB audio;
two simultaneous buffered-to-disk uploads per backend instance. Failed/pending
reservations and queued deletions count toward quota until actual cleanup succeeds.
Future plan entitlements must be server-derived.

## Protocol

1. `POST /media/uploads`: authenticated JSON reservation with a retry UUID
   `upload_key`, MIME, byte size, SHA-256, original filename, source type, and
   optional owned chat/message IDs. Server generates media UUID and object key.
2. `PUT /media/:id/content`: authenticated `application/octet-stream` with an
   exact Content-Length. Stream to a mode-0600 temporary file, bound bytes, verify
   SHA-256 and file signature, then stream to cloud. No binary enters PostgreSQL.
3. Pending/failed uploads are excluded from `GET /media`; details expose status.
4. `GET /media`: bounded limit/offset, newest-first timestamp + UUID ordering,
   type/chat/source filters, `has_more`. Concurrent changes are not a snapshot.
5. `POST /media/:id/signed-url`: owner-only ready object, short-lived signed download
   (60 seconds by default, max 300). Never persist this URL. Request another after expiry.
6. `GET /media/:id/content`: owner-authorized redirect for cloud objects; legacy
   local download behavior stays available only outside production.
7. `PATCH /media/:id`: associate an owned ready media item with an owned message/chat.
8. `DELETE /media/:id`: delete metadata and durably queue the binary. Repeats return
   404 without additional side effects. Chat/account cascades use the same queue.

Each item has one chat/message association. Deleting that chat deletes associated
media; unattached library items survive. Shared multi-chat media is not supported.
Message history includes safe ready attachment metadata, never storage credentials.

## Security and failure consistency

Keys are `users/<user UUID>/<image|video|audio|file>/<server media UUID>`.
Filenames are display metadata only. Client user IDs/storage keys are rejected.
Accepted new uploads: JPEG, PNG, WebP, MP4, QuickTime, PDF, MP3, M4A and WAV.
HEIC, executables, SVG, arbitrary text/Office documents and unknown formats are
not accepted. Signature checks do not constitute antivirus or full codec parsing.
Dimensions, duration, thumbnail generation and transcoding are not implemented.
Original bytes are preserved. Signed downloads use attachment disposition and
objects use zero cache TTL. A signed URL is a bearer capability until it expires.

The cloud write holds a media row lock so chat/account/media deletion cannot race
finalization. A crash leaves pending metadata; a failed write cannot mark it ready.
Retries reuse the reserved key/checksum, remove ambiguous prior uploads under the
row lock, and never overwrite a ready object. Failed/pending reservations expire
after an hour and enter the existing deletion queue. Temporary staging files are
removed on success/error; an abrupt process crash relies on ephemeral temp-disk
reclamation. They are never the permanent source of a media record.

When enabled, the backend drains the durable deletion queue every minute while
running, with exponential failure backoff. Render Free sleep pauses processing;
strict deletion SLAs require an always-on worker/cron, not this opportunistic timer.
Queue jobs survive restarts. Previously issued URLs may work until TTL/deletion.

## Required controlled rollout

1. Save the two Supabase credentials directly in Render, not in chat.
2. Create/verify the PRIVATE `chatpop-media` bucket using Supabase dashboard/API.
   Set allowed MIME types and a bucket maximum consistent with application limits.
3. Apply existing migration runner: `1789734000000_private_cloud_media` adds fields
   and indexes; `1789734000001_private_storage_policies` restricts anon/authenticated
   access to this bucket and its objects even if broader permissive policies exist.
   `1789734000002_cleanup_quota` retains queued-deletion bytes in quota accounting.
   The policy migration intentionally does not remove restrictions on rollback.
   PostgreSQL migration user must have permission to manage these Storage policies.
4. Verify RLS enabled on storage.objects/storage.buckets and inspect effective
   anon/authenticated grants/policies. The service role bypasses RLS; the API must
   enforce ownership. `public=false` alone does not verify custom policy safety.
5. Enable the provider and deploy only after configuration/migrations are verified.
6. Exercise real image/video/PDF/audio, signed expiry, anonymous object denial,
   two-user isolation, interrupted upload, deletion/queue retry, account/chat
   deletion, logout/login and redeploy persistence using disposable assets/users.
7. Connect and test native pickers, upload progress/cancel, private previews and
   media library on the real iPhone. These UI integrations are still pending.

No AI providers or generated-media ingestion are connected. `generated` metadata
is reserved for future trusted server-side generation, not accepted from clients.
