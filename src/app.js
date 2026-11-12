// The whole API as one plain Node request handler: (req, res) => void.
// It runs as a Vercel serverless function (api/index.js) and as a normal
// Node server (server.js), with no web framework needed.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { one, ensureSchema } = require("./db");
const Q = require("./queries");

const API_KEY = process.env.API_KEY;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PAGE_HTML_PATH = path.join(__dirname, "..", "public", "index.html");

// ---------- small helpers ----------

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function send(res, status, body, headers = {}) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end(body === undefined ? "" : JSON.stringify(body));
}

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-API-Key, Idempotency-Key");
  res.setHeader("Access-Control-Expose-Headers", "Retry-After");
}

// Constant-time comparison so the key can't be guessed from response timing.
function validApiKey(given) {
  if (!API_KEY || typeof given !== "string") return false;
  const a = Buffer.from(given);
  const b = Buffer.from(API_KEY);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Reads and parses a JSON body. Works with a raw Node request and with
// Vercel's request, which may have already parsed it into req.body.
async function readJson(req) {
  let raw;
  try {
    if (req.body !== undefined) {
      if (Buffer.isBuffer(req.body)) raw = req.body.toString("utf8");
      else if (typeof req.body === "string") raw = req.body;
      else return req.body; // already parsed
    }
  } catch {
    throw new HttpError(400, "request body is not valid JSON");
  }
  if (raw === undefined) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    raw = Buffer.concat(chunks).toString("utf8");
  }
  if (raw.trim() === "") throw new HttpError(400, "request body is required");
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, "request body is not valid JSON");
  }
}

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const nonEmptyString = (v) => typeof v === "string" && v.trim() !== "";

// Stable JSON (sorted keys) so {"a":1,"b":2} and {"b":2,"a":1} hash the same.
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isObject(value)) {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

const encodeCursor = (seq) => Buffer.from(`seq:${seq}`).toString("base64url");
function decodeCursor(cursor) {
  const text = Buffer.from(cursor, "base64url").toString("utf8");
  const m = /^seq:(\d{1,18})$/.exec(text);
  if (!m) throw new HttpError(400, "invalid cursor");
  return m[1];
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- route handlers ----------

// POST /reset (level 1)
async function reset(req, res) {
  const body = await readJson(req);
  if (!isObject(body) || !Array.isArray(body.slots)) {
    throw new HttpError(400, "body must be an object with a slots array");
  }
  const ids = new Set();
  const slots = body.slots.map((s, i) => {
    if (!isObject(s) || !nonEmptyString(s.id) || !nonEmptyString(s.provider) ||
        !nonEmptyString(s.start) || !nonEmptyString(s.end)) {
      throw new HttpError(400, `slots[${i}] needs id, provider, start and end`);
    }
    if (Number.isNaN(Date.parse(s.start)) || Number.isNaN(Date.parse(s.end))) {
      throw new HttpError(400, `slots[${i}] has an invalid start or end date-time`);
    }
    if (ids.has(s.id)) throw new HttpError(400, `duplicate slot id: ${s.id}`);
    ids.add(s.id);
    return { id: s.id, provider: s.provider, start: s.start, end: s.end };
  });
  const result = await one(Q.RESET, [JSON.stringify(slots)]);
  send(res, 200, { ok: true, slots: Number(result.slots) });
}

// GET /slots (level 1)
async function listSlots(req, res, url) {
  const provider = url.searchParams.get("provider");
  const slots = await one(Q.LIST_SLOTS, [provider]);
  send(res, 200, { slots });
}

// The core booking logic (levels 1-3). Returns { status, body }.
async function bookSlot(body) {
  if (!isObject(body)) return { status: 400, body: { error: "body must be a JSON object" } };
  const { slot_id, name, email } = body;
  if (!nonEmptyString(slot_id)) return { status: 400, body: { error: "slot_id is required" } };
  if (!nonEmptyString(name)) return { status: 400, body: { error: "name is required" } };
  if (!nonEmptyString(email)) return { status: 400, body: { error: "email is required" } };
  const cleanEmail = email.trim().toLowerCase();
  if (!EMAIL_RE.test(cleanEmail)) return { status: 400, body: { error: "email is not valid" } };

  const result = await one(Q.CREATE_BOOKING, [crypto.randomUUID(), slot_id, name.trim(), cleanEmail]);
  if (!result.slot_found) return { status: 404, body: { error: "slot not found" } };
  if (result.started) return { status: 400, body: { error: "slot has already started" } };
  if (!result.booking) return { status: 409, body: { error: "slot is already booked" } };
  return { status: 201, body: result.booking };
}

// POST /bookings (levels 1-5)
async function createBooking(req, res) {
  const body = await readJson(req);
  const idemKey = req.headers["idempotency-key"];

  // Level 4: if this Idempotency-Key was seen before, replay the saved response.
  let claimedKey = null;
  if (typeof idemKey === "string" && idemKey !== "") {
    const bodyHash = sha256(canonical(body));
    let row = await one(Q.CLAIM_IDEMPOTENCY_KEY, [idemKey, bodyHash]); if (!row) { const existing = await one(Q.READ_IDEMPOTENCY_KEY, [idemKey]); row = existing ? { claimed: false, ...existing } : await one(Q.CLAIM_IDEMPOTENCY_KEY, [idemKey, bodyHash]); } if (!row) throw new Error("could not claim or read Idempotency-Key"); // a simultaneous request inserted the key after this statement started, so re-read it
    if (!row.claimed) {
      if (row.body_hash !== bodyHash) {
        return send(res, 422, { error: "Idempotency-Key was already used with a different request body" });
      }
      // The first request with this key may still be running: wait for its result.
      for (let i = 0; row && row.status_code == null && i < 100; i++) {
        await sleep(100);
        row = await one(Q.READ_IDEMPOTENCY_KEY, [idemKey]);
      }
      if (!row || row.status_code == null) {
        return send(res, 409, { error: "a request with this Idempotency-Key is still in progress" });
      }
      return send(res, row.status_code, row.response);
    }
    claimedKey = idemKey;
  }

  try {
    // Level 5: rate limit per email. Counted before validation so failed
    // attempts count too.
    if (isObject(body) && nonEmptyString(body.email)) {
      const limit = await one(Q.RATE_LIMIT, [body.email.trim().toLowerCase()]);
      if (!limit.allowed) {
        if (claimedKey) await one(Q.RELEASE_IDEMPOTENCY_KEY, [claimedKey]);
        claimedKey = null;
        return send(res, 429, { error: "too many booking attempts for this email, try again later" },
          { "Retry-After": String(limit.retry_after) });
      }
    }

    const { status, body: responseBody } = await bookSlot(body);
    if (claimedKey) {
      await one(Q.SAVE_IDEMPOTENCY_RESPONSE, [claimedKey, status, JSON.stringify(responseBody)]);
      claimedKey = null;
    }
    send(res, status, responseBody);
  } catch (err) {
    // Something unexpected failed: free the key so a retry can try again.
    if (claimedKey) await one(Q.RELEASE_IDEMPOTENCY_KEY, [claimedKey]).catch(() => {});
    throw err;
  }
}

// GET /bookings?email=&limit=&cursor= (level 4)
async function listBookings(req, res, url) {
  const email = (url.searchParams.get("email") || "").trim().toLowerCase();
  if (!email) throw new HttpError(400, "email query parameter is required");

  let limit = 10;
  const rawLimit = url.searchParams.get("limit");
  if (rawLimit !== null) {
    if (!/^\d+$/.test(rawLimit)) throw new HttpError(400, "limit must be an integer from 1 to 50");
    limit = Number(rawLimit);
    if (limit < 1 || limit > 50) throw new HttpError(400, "limit must be an integer from 1 to 50");
  }

  const rawCursor = url.searchParams.get("cursor");
  const afterSeq = rawCursor ? decodeCursor(rawCursor) : "0";

  const rows = await one(Q.LIST_BOOKINGS, [email, afterSeq, limit + 1]);
  const page = rows.slice(0, limit);
  const hasMore = rows.length > limit;
  send(res, 200, {
    bookings: page.map((r) => r.booking),
    next_cursor: hasMore ? encodeCursor(page[page.length - 1].seq) : null,
  });
}

// GET /bookings/{id} (level 1)
async function getBooking(req, res, id) {
  const booking = await one(Q.GET_BOOKING, [id]);
  if (!booking) throw new HttpError(404, "booking not found");
  send(res, 200, booking);
}

// DELETE /bookings/{id} (level 3)
async function cancelBooking(req, res, id) {
  const result = await one(Q.CANCEL_BOOKING, [id]);
  if (!result.found) throw new HttpError(404, "booking not found");
  if (!result.booking) throw new HttpError(409, "booking is already cancelled");
  send(res, 200, result.booking);
}

// ---------- router ----------

async function handler(req, res) {
  setCors(res);
  try {
    const url = new URL(req.url, "http://localhost");
    const pathname = url.pathname.replace(/\/+$/, "") || "/";
    const method = req.method;

    // CORS preflight: browsers send it without the API key.
    if (method === "OPTIONS") {
      res.statusCode = 204;
      return res.end();
    }

    // The web page itself is public; it asks for the API key to call the API.
    if (method === "GET" && (pathname === "/" || pathname === "/index.html")) {
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.end(fs.readFileSync(PAGE_HTML_PATH));
    }

    // Level 2: every API request needs the right X-API-Key.
    if (!validApiKey(req.headers["x-api-key"])) {
      throw new HttpError(401, "missing or invalid API key");
    }

    await ensureSchema();

    if (pathname === "/reset" && method === "POST") return await reset(req, res);
    if (pathname === "/slots" && method === "GET") return await listSlots(req, res, url);
    if (pathname === "/bookings" && method === "POST") return await createBooking(req, res);
    if (pathname === "/bookings" && method === "GET") return await listBookings(req, res, url);

    const m = /^\/bookings\/([^/]+)$/.exec(pathname);
    if (m) {
      const id = decodeURIComponent(m[1]);
      if (method === "GET") return await getBooking(req, res, id);
      if (method === "DELETE") return await cancelBooking(req, res, id);
    }

    throw new HttpError(404, "not found");
  } catch (err) {
    if (err instanceof HttpError) return send(res, err.status, { error: err.message });
    console.error(err);
    send(res, 500, { error: "internal server error" });
  }
}

module.exports = handler;
