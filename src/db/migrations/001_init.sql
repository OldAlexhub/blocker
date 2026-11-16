-- Nexus Internet Scheduler: initial schema

CREATE TABLE devices (
  id                    serial PRIMARY KEY,
  mac_address           text NOT NULL UNIQUE CHECK (mac_address ~ '^([0-9A-F]{2}:){5}[0-9A-F]{2}$'),
  ip_address            inet,
  hostname              text,
  display_name          text CHECK (display_name IS NULL OR length(display_name) <= 60),
  connection_type       text,
  is_protected          boolean NOT NULL DEFAULT false,
  protected_reason      text,
  restrictions_enabled  boolean NOT NULL DEFAULT false,
  is_online             boolean NOT NULL DEFAULT false,
  router_status         text CHECK (router_status IN ('Allow', 'Block')),  -- last value the ROUTER reported
  router_status_at      timestamptz,
  last_seen_at          timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CHECK (NOT (is_protected AND restrictions_enabled))
);

CREATE TABLE schedules (
  id            serial PRIMARY KEY,
  name          text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  start_time    time NOT NULL,
  end_time      time NOT NULL,
  days_of_week  smallint[] NOT NULL CHECK (cardinality(days_of_week) BETWEEN 1 AND 7
                                           AND days_of_week <@ ARRAY[0,1,2,3,4,5,6]::smallint[]),
  enabled       boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (start_time <> end_time)
);

CREATE TABLE schedule_devices (
  schedule_id  integer NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
  device_id    integer NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  PRIMARY KEY (schedule_id, device_id)
);
CREATE INDEX schedule_devices_device_idx ON schedule_devices(device_id);

-- At most one manual override per device; it always expires.
CREATE TABLE device_overrides (
  id             serial PRIMARY KEY,
  device_id      integer NOT NULL UNIQUE REFERENCES devices(id) ON DELETE CASCADE,
  override_type  text NOT NULL CHECK (override_type IN ('block', 'allow')),
  expires_at     timestamptz NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX device_overrides_expires_idx ON device_overrides(expires_at);

-- What the app wants vs. what it last did / verified, per device.
CREATE TABLE restriction_state (
  device_id        integer PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
  desired          text CHECK (desired IN ('block', 'allow')),
  desired_reason   text,
  app_blocked      boolean NOT NULL DEFAULT false,   -- the app issued a block that it has not yet verifiably undone
  last_command     text,                             -- block | allow | dry:block | dry:allow
  last_command_at  timestamptz,
  last_result      text,                             -- verified | unverified | failed | dry_run
  verified_state   text CHECK (verified_state IN ('Allow', 'Block')),
  verified_at      timestamptz,
  failure_count    integer NOT NULL DEFAULT 0,
  next_attempt_at  timestamptz,
  dry_state        text CHECK (dry_state IN ('Allow', 'Block')),  -- simulated router state in dry-run
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE activity_logs (
  id            bigserial PRIMARY KEY,
  created_at    timestamptz NOT NULL DEFAULT now(),
  device_id     integer REFERENCES devices(id) ON DELETE SET NULL,
  device_label  text,
  action        text NOT NULL,
  trigger       text NOT NULL CHECK (trigger IN ('schedule', 'manual', 'override', 'reconcile', 'system', 'startup')),
  result        text NOT NULL CHECK (result IN ('verified', 'unverified', 'requested', 'failed', 'dry_run', 'skipped', 'info')),
  detail        text
);
CREATE INDEX activity_logs_created_idx ON activity_logs(created_at DESC);
CREATE INDEX activity_logs_device_idx ON activity_logs(device_id, created_at DESC);

CREATE TABLE application_settings (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  sid     text PRIMARY KEY,
  sess    jsonb NOT NULL,
  expire  timestamptz NOT NULL
);
CREATE INDEX sessions_expire_idx ON sessions(expire);
