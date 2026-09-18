-- Up Migration
-- ChatPop uses its own backend authentication, never Supabase's public Data API.
-- The PostgreSQL owner remains able to access these tables through the backend.
DO $$
DECLARE
 table_name text;
 api_role text;
BEGIN
 FOREACH table_name IN ARRAY ARRAY['users','user_settings','sessions','refresh_tokens','chats','messages','media','storage_deletions','rate_limits','pgmigrations'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
  EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC', table_name);
  FOREACH api_role IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
   IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=api_role) THEN
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM %I', table_name, api_role);
   END IF;
  END LOOP;
 END LOOP;
END $$;

-- Down Migration
-- Intentionally do not restore unsafe public grants when rolling back.
SELECT 1;
