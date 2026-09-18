-- Up Migration
CREATE TABLE users (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 email text NOT NULL UNIQUE CHECK (email = lower(btrim(email)) AND length(email) <= 254),
 password_hash text,
 display_name varchar(80),
 auth_provider text NOT NULL DEFAULT 'email' CHECK (auth_provider IN ('email','apple','google','microsoft')),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 last_login_at timestamptz,
 account_status text NOT NULL DEFAULT 'active' CHECK (account_status IN ('active','disabled')),
 CHECK (auth_provider <> 'email' OR (password_hash IS NOT NULL AND password_hash LIKE '$argon2id$%'))
);
CREATE TABLE user_settings (
 user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 theme text NOT NULL DEFAULT 'dark' CHECK (theme IN ('dark','light','system')),
 selected_voice varchar(80) NOT NULL DEFAULT 'voice-1',
 default_ai_provider text NOT NULL DEFAULT 'auto' CHECK (default_ai_provider IN ('auto','chatgpt','claude','gemini','deepseek')),
 default_ai_model varchar(100), language varchar(35) NOT NULL DEFAULT 'en',
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE sessions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 access_token_hash char(64) NOT NULL UNIQUE, access_expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
 revoked_at timestamptz, last_used_at timestamptz
);
CREATE INDEX sessions_user_idx ON sessions(user_id);
CREATE INDEX sessions_expiry_idx ON sessions(expires_at);
CREATE TABLE refresh_tokens (
 token_hash char(64) PRIMARY KEY, session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
 created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL, consumed_at timestamptz
);
CREATE INDEX refresh_session_idx ON refresh_tokens(session_id);
CREATE TABLE chats (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 title varchar(200) NOT NULL DEFAULT 'New chat' CHECK (length(btrim(title)) > 0),
 title_source text NOT NULL DEFAULT 'default' CHECK (title_source IN ('default','auto','user')),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 last_message_at timestamptz, archived_at timestamptz,
 UNIQUE(id,user_id)
);
CREATE INDEX chats_activity_idx ON chats(user_id, (coalesce(last_message_at,created_at)) DESC, id);
CREATE TABLE messages (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), chat_id uuid NOT NULL, user_id uuid NOT NULL,
 role text NOT NULL CHECK (role IN ('user','assistant','system')),
 content text NOT NULL CHECK (length(btrim(content)) > 0 AND length(content) <= 20000),
 provider varchar(80), model varchar(100),
 status text NOT NULL DEFAULT 'completed' CHECK (status IN ('pending','completed','failed')),
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(chat_id,user_id) REFERENCES chats(id,user_id) ON DELETE CASCADE,
 UNIQUE(id,chat_id,user_id)
);
CREATE INDEX messages_chat_time_idx ON messages(chat_id,created_at,id);
CREATE TABLE media (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 chat_id uuid, message_id uuid,
 media_type text NOT NULL CHECK (media_type IN ('image','video','audio','file')),
 storage_driver varchar(40) NOT NULL, storage_key text NOT NULL,
 mime_type varchar(100) NOT NULL, file_size bigint NOT NULL CHECK(file_size > 0 AND file_size <= 104857600),
 width integer CHECK(width > 0), height integer CHECK(height > 0), duration numeric CHECK(duration >= 0),
 created_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
 CHECK(message_id IS NULL OR chat_id IS NOT NULL),
 CHECK(length(storage_key) BETWEEN 1 AND 512),
 FOREIGN KEY(chat_id,user_id) REFERENCES chats(id,user_id) ON DELETE CASCADE,
 FOREIGN KEY(message_id,chat_id,user_id) REFERENCES messages(id,chat_id,user_id) ON DELETE CASCADE,
 UNIQUE(storage_driver,storage_key)
);
CREATE INDEX media_user_idx ON media(user_id,created_at DESC);
CREATE INDEX media_chat_idx ON media(chat_id);
CREATE INDEX media_message_idx ON media(message_id);
-- Intentionally independent of users: durable cleanup must survive account deletion.
CREATE TABLE storage_deletions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), storage_driver varchar(40) NOT NULL, storage_key text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), attempts integer NOT NULL DEFAULT 0,
 next_attempt_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz,
 UNIQUE(storage_driver,storage_key)
);
CREATE INDEX storage_deletions_due_idx ON storage_deletions(next_attempt_at) WHERE completed_at IS NULL;
CREATE FUNCTION enqueue_media_deletion() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO storage_deletions(storage_driver,storage_key) VALUES(OLD.storage_driver,OLD.storage_key)
 ON CONFLICT(storage_driver,storage_key) DO NOTHING;
 RETURN OLD;
END $$;
CREATE TRIGGER media_cleanup BEFORE DELETE ON media FOR EACH ROW EXECUTE FUNCTION enqueue_media_deletion();
CREATE TABLE rate_limits (
 key char(64) PRIMARY KEY, count integer NOT NULL, expires_at timestamptz NOT NULL
);
CREATE INDEX rate_limits_expiry_idx ON rate_limits(expires_at);
CREATE FUNCTION touch_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = clock_timestamp(); RETURN NEW; END $$;
CREATE TRIGGER users_touch BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER settings_touch BEFORE UPDATE ON user_settings FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER chats_touch BEFORE UPDATE ON chats FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- Down Migration
DROP TABLE rate_limits, storage_deletions, media, messages, chats, refresh_tokens, sessions, user_settings, users CASCADE;
DROP FUNCTION enqueue_media_deletion();
DROP FUNCTION touch_updated_at();
