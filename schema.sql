-- Supabase/Postgres schema for ab-resolver.
-- Run this in the Supabase SQL editor or through your migration tooling.

CREATE TABLE IF NOT EXISTS public.experiments (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    baseline_url TEXT NOT NULL,
    test_url TEXT NOT NULL,
    allocation_b DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    status TEXT NOT NULL DEFAULT 'draft',
    start_at TIMESTAMPTZ,
    stop_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT experiments_id_format CHECK (id ~ '^[a-zA-Z0-9_-]+$'),
    CONSTRAINT experiments_allocation_b_range CHECK (allocation_b >= 0 AND allocation_b <= 1),
    CONSTRAINT experiments_status_valid CHECK (status IN ('draft', 'running', 'paused', 'stopped')),
    CONSTRAINT experiments_schedule_valid CHECK (stop_at IS NULL OR start_at IS NULL OR stop_at > start_at),
    CONSTRAINT experiments_baseline_http CHECK (baseline_url ~* '^https?://'),
    CONSTRAINT experiments_test_http CHECK (test_url ~* '^https?://')
);

CREATE TABLE IF NOT EXISTS public.team_members (
    email TEXT PRIMARY KEY,
    role TEXT NOT NULL DEFAULT 'manager',
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT team_members_email_format CHECK (email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
    CONSTRAINT team_members_role_valid CHECK (role IN ('owner', 'manager', 'viewer'))
);

ALTER TABLE public.team_members
    DROP CONSTRAINT IF EXISTS team_members_role_valid;

UPDATE public.team_members
   SET role = 'manager'
 WHERE role = 'admin';

ALTER TABLE public.team_members
    ALTER COLUMN role SET DEFAULT 'manager';

ALTER TABLE public.team_members
    ADD CONSTRAINT team_members_role_valid CHECK (role IN ('owner', 'manager', 'viewer'));

CREATE TABLE IF NOT EXISTS public.access_sessions (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL REFERENCES public.team_members(email) ON DELETE CASCADE,
    user_agent TEXT,
    ip_address TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    CONSTRAINT access_sessions_id_format CHECK (id ~ '^[a-zA-Z0-9_-]{32,}$'),
    CONSTRAINT access_sessions_expiry_valid CHECK (expires_at > created_at)
);

CREATE TABLE IF NOT EXISTS public.allowed_origins (
    origin TEXT PRIMARY KEY,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT allowed_origins_http_origin CHECK (origin ~* '^https?://[^/]+$')
);

CREATE INDEX IF NOT EXISTS team_members_active_idx
    ON public.team_members (active, email);

CREATE INDEX IF NOT EXISTS access_sessions_active_lookup_idx
    ON public.access_sessions (id, expires_at, revoked_at);

CREATE INDEX IF NOT EXISTS access_sessions_email_idx
    ON public.access_sessions (email, created_at DESC);

CREATE INDEX IF NOT EXISTS allowed_origins_active_idx
    ON public.allowed_origins (active, origin);

CREATE INDEX IF NOT EXISTS experiments_active_lookup_idx
    ON public.experiments (status, start_at, stop_at);

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS set_experiments_updated_at ON public.experiments;
CREATE TRIGGER set_experiments_updated_at
    BEFORE UPDATE ON public.experiments
    FOR EACH ROW
    EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS set_team_members_updated_at ON public.team_members;
CREATE TRIGGER set_team_members_updated_at
    BEFORE UPDATE ON public.team_members
    FOR EACH ROW
    EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS set_access_sessions_updated_at ON public.access_sessions;
CREATE TRIGGER set_access_sessions_updated_at
    BEFORE UPDATE ON public.access_sessions
    FOR EACH ROW
    EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS set_allowed_origins_updated_at ON public.allowed_origins;
CREATE TRIGGER set_allowed_origins_updated_at
    BEFORE UPDATE ON public.allowed_origins
    FOR EACH ROW
    EXECUTE FUNCTION public.set_updated_at();
