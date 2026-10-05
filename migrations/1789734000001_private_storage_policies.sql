-- Up Migration
-- Restrictive policies keep this bucket backend-only even when broader permissive policies exist.
-- Supabase service_role retains its platform-defined BYPASSRLS; no grants are added.
DO $$ BEGIN
 IF to_regclass('storage.objects') IS NOT NULL
    AND EXISTS(SELECT FROM pg_roles WHERE rolname='anon')
    AND EXISTS(SELECT FROM pg_roles WHERE rolname='authenticated') THEN
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid='storage.objects'::regclass)
     OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid='storage.buckets'::regclass) THEN
   RAISE EXCEPTION 'Storage RLS must be enabled before configuring ChatPop private storage';
  END IF;
  IF NOT EXISTS(SELECT FROM pg_policies WHERE schemaname='storage' AND tablename='objects' AND policyname='chatpop_backend_only_objects') THEN
   EXECUTE 'CREATE POLICY chatpop_backend_only_objects ON storage.objects AS RESTRICTIVE FOR ALL TO anon, authenticated USING (bucket_id <> ''chatpop-media'') WITH CHECK (bucket_id <> ''chatpop-media'')';
  END IF;
  IF NOT EXISTS(SELECT FROM pg_policies WHERE schemaname='storage' AND tablename='buckets' AND policyname='chatpop_backend_only_bucket') THEN
   EXECUTE 'CREATE POLICY chatpop_backend_only_bucket ON storage.buckets AS RESTRICTIVE FOR ALL TO anon, authenticated USING (id <> ''chatpop-media'') WITH CHECK (id <> ''chatpop-media'')';
  END IF;
 END IF;
END $$;

-- Down Migration
-- Intentionally retain access restrictions on rollback; removing them can expose existing private media.
SELECT 1;
