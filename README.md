# Clinic Booking API

An API that lets patients book clinic appointment slots, plus a web page that uses it. Built for Task 1 of the Koya Cohort 4 assessment, following the [technical spec](https://koyaacademy.com/assessment-api).

**Stack:** Node.js (no web framework), PostgreSQL ([Neon](https://neon.tech)), deployed on [Vercel](https://vercel.com).

## Endpoints

Every request needs an `X-API-Key` header. Errors are always `{"error": "<message>"}`.

| Method | Path | Level | What it does |
|---|---|---|---|
| POST | `/reset` | 1 | Delete all bookings and replace all slots |
| GET | `/slots?provider=` | 1 | List slots, earliest first, with `available` |
| POST | `/bookings` | 1–5 | Book a slot |
| GET | `/bookings/{id}` | 1 | Get one booking |
| DELETE | `/bookings/{id}` | 3 | Cancel a booking (frees the slot) |
| GET | `/bookings?email=&limit=&cursor=` | 4 | A person's bookings, oldest first, cursor-paginated |

The web page is served at `/`.

## How each level is handled

The key rules are enforced **by Postgres**, not by JavaScript checks. A check in code ("is this slot free?") followed by a write can race when two requests arrive at the same time. A database constraint can't.

- **Level 1: persistence.** Everything is stored in Postgres, so data survives between serverless invocations.
- **Level 2: auth and validation.** The API key is compared in constant time. `slot_id`, `name` and `email` are validated. Name and email are trimmed, and email is lower-cased. Unknown slot → 404, slot already started → 400.
- **Level 3: no double-booking.** A **partial unique index** allows only one `confirmed` booking per slot:
  ```sql
  CREATE UNIQUE INDEX one_confirmed_booking_per_slot ON bookings (slot_id) WHERE status = 'confirmed';
  ```
  The booking is a single `INSERT … ON CONFLICT DO NOTHING` statement. When 20 requests hit one slot at once, Postgres lets exactly one through and the rest get 409. Cancelling sets `status = 'cancelled'`, which takes the booking out of the index and frees the slot.
- **Level 4: idempotency.** The first request with an `Idempotency-Key` claims it with an atomic insert, along with a SHA-256 hash of the body. When the booking finishes, its status code and response are saved. A retry with the same key and body gets the saved response, including when it arrives while the first request is still running. The same key with a different body gets 422.
- **Level 4: pagination.** Each booking has an increasing `seq`. The cursor is an opaque encoding of the last `seq` on the page, so pages stay stable while new bookings are added.
- **Level 5: rate limiting.** It's a sliding window of 5 attempts per email per 60 seconds, stored in Postgres so it works across serverless instances. An upsert locks that email's row, so simultaneous requests are counted one at a time. Failed attempts count. The 6th returns 429 with `Retry-After` in whole seconds, the time until the oldest attempt leaves the window.

## Project layout

```
api/index.js      Vercel entry point
server.js         Run as a normal Node server
src/app.js        Routing, validation, idempotency and rate-limit flow
src/queries.js    All SQL (each query is one atomic statement)
src/schema.sql    Tables and indexes (created automatically on first request)
src/db.js         Postgres connection
public/index.html The web page
test/spec.test.js 55 end-to-end checks against the spec, including concurrency
scripts/seed.js   Load demo slots
```

## Run locally

```bash
npm install
cp .env.example .env   # set DATABASE_URL and API_KEY
export $(cat .env | xargs) && npm start
# in another terminal
BASE_URL=http://localhost:3000 API_KEY=your-key npm test
```

## Deploy (Vercel + Neon)

1. Create a free Neon project and copy its **pooled** connection string.
2. Import this repo in Vercel and add the environment variables `DATABASE_URL` and `API_KEY`.
3. Deploy, then load demo slots: `BASE_URL=https://<app>.vercel.app API_KEY=<key> npm run seed`.
