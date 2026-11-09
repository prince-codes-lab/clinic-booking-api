// All SQL lives here. Each statement returns a single JSON column `r`.

// Turns a bookings row (alias b) into the Booking JSON shape from the spec.
const BOOKING_JSON = `json_build_object(
  'id', b.id,
  'slot_id', b.slot_id,
  'name', b.name,
  'email', b.email,
  'status', b.status,
  'created_at', to_char(b.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
)`;

// POST /reset: delete every booking and replace all slots with $1 (a JSON array).
// Also clears idempotency keys and rate-limit counters so a reset gives a clean start.
const RESET = `
WITH new_slots AS (
  SELECT * FROM json_to_recordset($1::json) AS x(id text, provider text, start text, "end" text)
),
del_bookings AS (DELETE FROM bookings),
del_keys     AS (DELETE FROM idempotency_keys),
del_limits   AS (DELETE FROM rate_limits),
del_slots    AS (DELETE FROM slots WHERE id NOT IN (SELECT id FROM new_slots)),
upserted AS (
  INSERT INTO slots (id, provider, start_text, end_text, start_at)
  SELECT id, provider, start, "end", start::timestamptz FROM new_slots
  ON CONFLICT (id) DO UPDATE
    SET provider = EXCLUDED.provider, start_text = EXCLUDED.start_text,
        end_text = EXCLUDED.end_text, start_at = EXCLUDED.start_at
  RETURNING 1
)
SELECT json_build_object('slots', (SELECT count(*) FROM upserted)) AS r`;

// GET /slots: every slot (optionally one provider), earliest start first.
const LIST_SLOTS = `
SELECT coalesce(json_agg(json_build_object(
  'id', s.id,
  'provider', s.provider,
  'start', s.start_text,
  'end', s.end_text,
  'available', NOT EXISTS (
    SELECT 1 FROM bookings b WHERE b.slot_id = s.id AND b.status = 'confirmed')
) ORDER BY s.start_at, s.id), '[]'::json) AS r
FROM slots s
WHERE $1::text IS NULL OR s.provider = $1`;

// POST /bookings (levels 1-3) in ONE atomic statement.
// The insert only happens if the slot exists and hasn't started. If another
// confirmed booking already holds the slot, the unique index makes
// ON CONFLICT DO NOTHING skip the insert, even when requests arrive together.
// $1 id, $2 slot_id, $3 name, $4 email
const CREATE_BOOKING = `
WITH s AS (SELECT id, start_at FROM slots WHERE id = $2),
inserted AS (
  INSERT INTO bookings (id, slot_id, name, email, status)
  SELECT $1, s.id, $3, $4, 'confirmed' FROM s WHERE s.start_at > now()
  ON CONFLICT (slot_id) WHERE status = 'confirmed' DO NOTHING
  RETURNING *
)
SELECT json_build_object(
  'slot_found', EXISTS (SELECT 1 FROM s),
  'started',    coalesce((SELECT start_at <= now() FROM s), false),
  'booking',    (SELECT ${BOOKING_JSON} FROM inserted b)
) AS r`;

// GET /bookings/{id}
const GET_BOOKING = `SELECT ${BOOKING_JSON} AS r FROM bookings b WHERE b.id = $1`;

// DELETE /bookings/{id}: only a confirmed booking can be cancelled. Two
// simultaneous cancels are safe: the second one finds it already cancelled.
const CANCEL_BOOKING = `
WITH found AS (SELECT id FROM bookings WHERE id = $1),
updated AS (
  UPDATE bookings SET status = 'cancelled', cancelled_at = now()
  WHERE id = $1 AND status = 'confirmed'
  RETURNING *
)
SELECT json_build_object(
  'found',   EXISTS (SELECT 1 FROM found),
  'booking', (SELECT ${BOOKING_JSON} FROM updated b)
) AS r`;

// GET /bookings?email=: one page of a person's bookings, oldest first.
// We fetch limit + 1 rows to know whether there is another page.
// $1 email, $2 after seq, $3 limit + 1
const LIST_BOOKINGS = `
SELECT coalesce(json_agg(json_build_object('seq', b.seq, 'booking', ${BOOKING_JSON}) ORDER BY b.seq), '[]'::json) AS r
FROM (
  SELECT * FROM bookings WHERE email = $1 AND seq > $2 ORDER BY seq LIMIT $3
) b`;

// Level 4: claim an Idempotency-Key. Returns the stored row, and whether this
// request is the one that created it ("claimed").
// $1 key, $2 body hash
const CLAIM_IDEMPOTENCY_KEY = `
WITH ins AS (
  INSERT INTO idempotency_keys (key, body_hash) VALUES ($1, $2)
  ON CONFLICT (key) DO NOTHING
  RETURNING key
)
SELECT CASE WHEN EXISTS (SELECT 1 FROM ins)
  THEN json_build_object('claimed', true)
  ELSE (SELECT json_build_object('claimed', false, 'body_hash', body_hash,
                                 'status_code', status_code, 'response', response)
        FROM idempotency_keys WHERE key = $1)
END AS r`;

const READ_IDEMPOTENCY_KEY = `
SELECT json_build_object('body_hash', body_hash, 'status_code', status_code, 'response', response) AS r
FROM idempotency_keys WHERE key = $1`;

const SAVE_IDEMPOTENCY_RESPONSE = `
UPDATE idempotency_keys SET status_code = $2, response = $3::jsonb WHERE key = $1
RETURNING json_build_object('ok', true) AS r`;

const RELEASE_IDEMPOTENCY_KEY = `
DELETE FROM idempotency_keys WHERE key = $1 AND response IS NULL
RETURNING json_build_object('ok', true) AS r`;

// Level 5: sliding-window rate limit, 5 attempts per email per 60 seconds.
// One row per email holds the timestamps of recent attempts. The upsert locks
// that row, so simultaneous requests for one email are counted one at a time.
// A blocked attempt is not recorded, so Retry-After is exact.
// $1 email
const RATE_LIMIT = `
INSERT INTO rate_limits AS rl (email, hits) VALUES ($1, ARRAY[now()])
ON CONFLICT (email) DO UPDATE SET hits = (
  WITH recent AS (
    SELECT coalesce(array_agg(h ORDER BY h), '{}') AS hs
    FROM unnest(rl.hits) AS h WHERE h > now() - interval '60 seconds'
  )
  SELECT CASE WHEN cardinality(hs) < 5 THEN hs || now() ELSE hs END FROM recent
)
RETURNING json_build_object(
  'allowed', hits[cardinality(hits)] = now(),
  'retry_after', greatest(1, ceil(extract(epoch FROM (hits[1] + interval '60 seconds' - now())))::int)
) AS r`;

module.exports = {
  RESET, LIST_SLOTS, CREATE_BOOKING, GET_BOOKING, CANCEL_BOOKING, LIST_BOOKINGS,
  CLAIM_IDEMPOTENCY_KEY, READ_IDEMPOTENCY_KEY, SAVE_IDEMPOTENCY_RESPONSE,
  RELEASE_IDEMPOTENCY_KEY, RATE_LIMIT,
};
