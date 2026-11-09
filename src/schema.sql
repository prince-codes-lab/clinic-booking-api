-- Runs as one transaction. The lock stops two cold-starting instances from
-- creating the tables at the same moment; it is released automatically.
SELECT pg_advisory_xact_lock(727001);

CREATE TABLE IF NOT EXISTS slots (
  id         text PRIMARY KEY,
  provider   text NOT NULL,
  start_text text NOT NULL,          -- returned exactly as it was sent
  end_text   text NOT NULL,
  start_at   timestamptz NOT NULL    -- used for sorting and "already started"
);

CREATE TABLE IF NOT EXISTS bookings (
  seq          bigserial UNIQUE,     -- insertion order, used for cursor pagination
  id           text PRIMARY KEY,
  slot_id      text NOT NULL,
  name         text NOT NULL,
  email        text NOT NULL,        -- stored trimmed and lower-cased
  status       text NOT NULL CHECK (status IN ('confirmed', 'cancelled')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  cancelled_at timestamptz
);

-- Level 3: at most ONE confirmed booking per slot, enforced by Postgres.
-- Concurrent inserts for the same slot are serialised by this index, so two
-- people can never both get a confirmed booking. Cancelled bookings don't count,
-- which is what frees the slot after a cancellation.
CREATE UNIQUE INDEX IF NOT EXISTS one_confirmed_booking_per_slot
  ON bookings (slot_id) WHERE status = 'confirmed';

CREATE INDEX IF NOT EXISTS bookings_email_seq ON bookings (email, seq);

-- Level 4: one row per Idempotency-Key. `response` is NULL while the first
-- request with that key is still being processed.
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key         text PRIMARY KEY,
  body_hash   text NOT NULL,
  status_code int,
  response    jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Level 5: one row per email with the timestamps of recent booking attempts.
CREATE TABLE IF NOT EXISTS rate_limits (
  email text PRIMARY KEY,
  hits  timestamptz[] NOT NULL
);
