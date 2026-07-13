CREATE TABLE IF NOT EXISTS municipal_announcements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  control_center_id UUID NOT NULL REFERENCES control_centers(id) ON DELETE CASCADE,
  audience_type TEXT NOT NULL DEFAULT 'BROADCAST' CHECK (audience_type IN ('BROADCAST','PERSONAL')),
  target_user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  media_type TEXT NOT NULL DEFAULT 'NONE' CHECK (media_type IN ('NONE','IMAGE','VIDEO')),
  media_url TEXT,
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','PUBLISHED','ARCHIVED')),
  starts_at TIMESTAMPTZ,
  ends_at TIMESTAMPTZ,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_municipal_announcements_cc_status_dates
  ON municipal_announcements(control_center_id, status, starts_at, ends_at);

CREATE TABLE IF NOT EXISTS municipal_announcement_reads (
  announcement_id UUID NOT NULL REFERENCES municipal_announcements(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (announcement_id, user_id)
);
