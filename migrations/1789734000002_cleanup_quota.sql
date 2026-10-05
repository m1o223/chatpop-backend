-- Up Migration
ALTER TABLE storage_deletions ADD COLUMN owner_id uuid;
ALTER TABLE storage_deletions ADD COLUMN file_size bigint NOT NULL DEFAULT 0 CHECK(file_size>=0);
CREATE INDEX storage_deletions_owner_idx ON storage_deletions(owner_id);
CREATE OR REPLACE FUNCTION enqueue_media_deletion() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO storage_deletions(storage_driver,storage_key,storage_bucket,owner_id,file_size)
 VALUES(OLD.storage_driver,OLD.storage_key,OLD.storage_bucket,OLD.user_id,OLD.file_size)
 ON CONFLICT(storage_driver,storage_key) DO NOTHING;
 RETURN OLD;
END $$;

-- Down Migration
CREATE OR REPLACE FUNCTION enqueue_media_deletion() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO storage_deletions(storage_driver,storage_key,storage_bucket)
 VALUES(OLD.storage_driver,OLD.storage_key,OLD.storage_bucket)
 ON CONFLICT(storage_driver,storage_key) DO NOTHING;
 RETURN OLD;
END $$;
ALTER TABLE storage_deletions DROP COLUMN owner_id, DROP COLUMN file_size;
