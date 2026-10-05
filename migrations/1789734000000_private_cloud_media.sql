-- Up Migration
ALTER TABLE media ADD COLUMN source_type text NOT NULL DEFAULT 'uploaded'
 CHECK(source_type IN ('uploaded','generated','camera','photo_library','audio_recording','chat_attachment'));
ALTER TABLE media ADD COLUMN storage_bucket text NOT NULL DEFAULT '';
ALTER TABLE media ADD COLUMN original_filename varchar(160);
ALTER TABLE media ADD COLUMN status text NOT NULL DEFAULT 'ready' CHECK(status IN ('pending','ready','failed'));
ALTER TABLE media ADD COLUMN sha256 char(64) CHECK(sha256 ~ '^[0-9a-f]{64}$');
ALTER TABLE media ADD COLUMN upload_key uuid;
ALTER TABLE media ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
CREATE UNIQUE INDEX media_upload_retry_idx ON media(user_id,upload_key) WHERE upload_key IS NOT NULL;
CREATE INDEX media_library_idx ON media(user_id,media_type,created_at DESC,id DESC) WHERE deleted_at IS NULL;
CREATE INDEX media_pending_idx ON media(updated_at) WHERE status IN ('pending','failed');
CREATE TRIGGER media_touch BEFORE UPDATE ON media FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
ALTER TABLE storage_deletions ADD COLUMN storage_bucket text NOT NULL DEFAULT '';
CREATE OR REPLACE FUNCTION enqueue_media_deletion() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO storage_deletions(storage_driver,storage_key,storage_bucket) VALUES(OLD.storage_driver,OLD.storage_key,OLD.storage_bucket)
 ON CONFLICT(storage_driver,storage_key) DO NOTHING;
 RETURN OLD;
END $$;

-- Down Migration
CREATE OR REPLACE FUNCTION enqueue_media_deletion() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO storage_deletions(storage_driver,storage_key) VALUES(OLD.storage_driver,OLD.storage_key)
 ON CONFLICT(storage_driver,storage_key) DO NOTHING;
 RETURN OLD;
END $$;
ALTER TABLE storage_deletions DROP COLUMN storage_bucket;
DROP TRIGGER media_touch ON media;
DROP INDEX media_pending_idx,media_library_idx,media_upload_retry_idx;
ALTER TABLE media DROP COLUMN source_type, DROP COLUMN storage_bucket, DROP COLUMN original_filename,
 DROP COLUMN status, DROP COLUMN sha256, DROP COLUMN upload_key, DROP COLUMN updated_at;
