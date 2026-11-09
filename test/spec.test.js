// End-to-end checks against a running API, following the Koya spec.
//   BASE_URL=http://localhost:3000 API_KEY=your-key node test/spec.test.js
// It calls POST /reset, so it wipes all bookings. Don't run it against your
// deployed API after you've submitted.

const BASE = (process.env.BASE_URL || "http://localhost:3000").replace(/\/$/, "");
const KEY = process.env.API_KEY || "test-key";

let passed = 0;
let failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}`, extra !== undefined ? JSON.stringify(extra) : ""); }
}

async function call(method, path, { body, key = KEY, headers = {}, rawBody } = {}) {
  const h = { ...headers };
  if (key !== null) h["X-API-Key"] = key;
  if (body !== undefined || rawBody !== undefined) h["Content-Type"] = "application/json";
  const res = await fetch(BASE + path, {
    method, headers: h,
    body: rawBody !== undefined ? rawBody : body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json, headers: res.headers };
}

const future = (h) => new Date(Date.now() + h * 3600e3).toISOString().replace(/\.\d{3}Z$/, "Z");
const past = (h) => new Date(Date.now() - h * 3600e3).toISOString().replace(/\.\d{3}Z$/, "Z");
let emailN = 0;
const freshEmail = () => `user${Date.now()}_${emailN++}@example.com`;

function slots() {
  return [
    { id: "s2", provider: "Dr Ade", start: future(26), end: future(26.5) },
    { id: "s1", provider: "Dr Ade", start: future(25), end: future(25.5) },
    { id: "s3", provider: "Dr Bello", start: future(27), end: future(27.5) },
    { id: "old", provider: "Dr Bello", start: past(2), end: past(1.5) },
    ...Array.from({ length: 30 }, (_, i) => ({
      id: `p${i}`, provider: "Dr Page", start: future(100 + i), end: future(100.5 + i),
    })),
  ];
}

(async () => {
  console.log(`Testing ${BASE}\n`);

  console.log("Level 2 - auth");
  check("no key -> 401", (await call("GET", "/slots", { key: null })).status === 401);
  const wrong = await call("GET", "/slots", { key: "wrong" });
  check("wrong key -> 401 with {error}", wrong.status === 401 && typeof wrong.body.error === "string", wrong);

  console.log("Level 1 - reset, slots, book, look up");
  const reset = await call("POST", "/reset", { body: { slots: slots() } });
  check("reset -> 200", reset.status === 200, reset);
  const list = await call("GET", "/slots");
  const ids = list.body.slots.map((s) => s.id);
  check("slots sorted by start", ids[0] === "old" && ids[1] === "s1" && ids[2] === "s2", ids.slice(0, 4));
  check("slot keeps exact start string", list.body.slots.find((s) => s.id === "s1").start === slots()[1].start);
  check("slots have available=true", list.body.slots.every((s) => s.available === true));
  const ade = await call("GET", "/slots?provider=Dr%20Ade");
  check("provider filter", ade.body.slots.length === 2 && ade.body.slots.every((s) => s.provider === "Dr Ade"), ade.body);
  const none = await call("GET", "/slots?provider=dr%20ade");
  check("provider filter is exact", none.body.slots.length === 0);

  const e1 = freshEmail();
  const b1 = await call("POST", "/bookings", { body: { slot_id: "s1", name: "  Ada Obi ", email: `  ${e1.toUpperCase()} ` } });
  check("book -> 201 confirmed", b1.status === 201 && b1.body.status === "confirmed", b1);
  check("name trimmed, email trimmed+lowercased", b1.body.name === "Ada Obi" && b1.body.email === e1, b1.body);
  check("booking has id and created_at", typeof b1.body.id === "string" && !isNaN(Date.parse(b1.body.created_at)));
  const got = await call("GET", `/bookings/${b1.body.id}`);
  check("get booking -> 200 same", got.status === 200 && got.body.id === b1.body.id, got);
  check("unknown booking -> 404", (await call("GET", "/bookings/nope")).status === 404);
  const after = await call("GET", "/slots");
  check("booked slot unavailable", after.body.slots.find((s) => s.id === "s1").available === false);

  console.log("Level 2 - validation");
  const v = async (body) => (await call("POST", "/bookings", { body })).status;
  check("missing slot_id -> 400", (await v({ name: "A", email: freshEmail() })) === 400);
  check("empty name -> 400", (await v({ slot_id: "s2", name: "  ", email: freshEmail() })) === 400);
  check("missing email -> 400", (await v({ slot_id: "s2", name: "A" })) === 400);
  check("invalid email -> 400", (await v({ slot_id: "s2", name: "A", email: "not-an-email" })) === 400);
  check("non-string name -> 400", (await v({ slot_id: "s2", name: 5, email: freshEmail() })) === 400);
  check("unknown slot -> 404", (await v({ slot_id: "zzz", name: "A", email: freshEmail() })) === 404);
  check("started slot -> 400", (await v({ slot_id: "old", name: "A", email: freshEmail() })) === 400);
  const badJson = await call("POST", "/bookings", { rawBody: "{oops" });
  check("bad JSON -> 400 {error}", badJson.status === 400 && badJson.body.error, badJson);

  console.log("Level 3 - double booking, concurrency, cancel");
  check("already booked -> 409", (await v({ slot_id: "s1", name: "B", email: freshEmail() })) === 409);
  const race = await Promise.all(Array.from({ length: 20 }, () =>
    call("POST", "/bookings", { body: { slot_id: "s2", name: "Racer", email: freshEmail() } })));
  const codes = race.map((r) => r.status);
  check("20 simultaneous bookings -> exactly one 201", codes.filter((c) => c === 201).length === 1 &&
    codes.filter((c) => c === 409).length === 19, codes);
  const cancel = await call("DELETE", `/bookings/${b1.body.id}`);
  check("cancel -> 200 cancelled", cancel.status === 200 && cancel.body.status === "cancelled", cancel);
  check("cancel again -> 409", (await call("DELETE", `/bookings/${b1.body.id}`)).status === 409);
  check("cancel unknown -> 404", (await call("DELETE", "/bookings/nope")).status === 404);
  const freed = await call("GET", "/slots");
  check("cancelled slot available again", freed.body.slots.find((s) => s.id === "s1").available === true);
  check("freed slot can be rebooked", (await v({ slot_id: "s1", name: "C", email: freshEmail() })) === 201);

  console.log("Level 4 - idempotency");
  const key = `k-${Date.now()}`;
  const ie = freshEmail();
  const ib = { slot_id: "s3", name: "Idem", email: ie };
  const i1 = await call("POST", "/bookings", { body: ib, headers: { "Idempotency-Key": key } });
  const i2 = await call("POST", "/bookings", { body: ib, headers: { "Idempotency-Key": key } });
  check("retry -> same status and id", i1.status === 201 && i2.status === 201 && i1.body.id === i2.body.id, [i1, i2]);
  const i3 = await call("POST", "/bookings", { body: { ...ib, name: "Other" }, headers: { "Idempotency-Key": key } });
  check("same key, different body -> 422", i3.status === 422, i3);
  const mine = await call("GET", `/bookings?email=${encodeURIComponent(ie)}`);
  check("retry created only one booking", mine.body.bookings.length === 1, mine.body);
  const k2 = `k2-${Date.now()}`;
  const ib2 = { slot_id: "p0", name: "Idem2", email: freshEmail() };
  const par = await Promise.all(Array.from({ length: 5 }, () =>
    call("POST", "/bookings", { body: ib2, headers: { "Idempotency-Key": k2 } })));
  check("5 simultaneous retries -> all 201, one id", par.every((r) => r.status === 201) &&
    new Set(par.map((r) => r.body.id)).size === 1, par.map((r) => [r.status, r.body.id]));
  const k3 = `k3-${Date.now()}`;
  const fail1 = await call("POST", "/bookings", { body: { slot_id: "s1", name: "X", email: freshEmail() }, headers: { "Idempotency-Key": k3 } });
  const fail2 = await call("POST", "/bookings", { body: { slot_id: "s1", name: "X", email: fail1.body && "" } , headers: { "Idempotency-Key": k3 } });
  check("failed response replays too (409 then same key+body 409)", fail1.status === 409, fail1);
  check("same key + different body after failure -> 422", fail2.status === 422, fail2);

  console.log("Level 4 - pagination");
  const pe = freshEmail();
  for (let i = 1; i <= 5; i++) {
    await call("POST", "/bookings", { body: { slot_id: `p${i}`, name: "Pager", email: pe } });
  }
  const pages = [];
  let cursor = null;
  for (let guard = 0; guard < 10; guard++) {
    const q = `/bookings?email=${encodeURIComponent(pe.toUpperCase())}&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const p = await call("GET", q);
    if (p.status !== 200) { check("page -> 200", false, p); break; }
    pages.push(p.body);
    cursor = p.body.next_cursor;
    if (!cursor) break;
  }
  const allIds = pages.flatMap((p) => p.bookings.map((b) => b.slot_id));
  check("pages: 2,2,1 with case-insensitive email", pages.map((p) => p.bookings.length).join() === "2,2,1", pages);
  check("oldest first, no duplicates", allIds.join() === "p1,p2,p3,p4,p5", allIds);
  check("last page next_cursor null", pages[pages.length - 1].next_cursor === null);
  check("default limit 10", (await call("GET", `/bookings?email=${pe}`)).body.bookings.length === 5);
  for (const bad of ["0", "51", "abc", "1.5", "-1", ""]) {
    check(`limit=${JSON.stringify(bad)} -> 400`, (await call("GET", `/bookings?email=${pe}&limit=${bad}`)).status === 400);
  }
  check("limit=50 ok", (await call("GET", `/bookings?email=${pe}&limit=50`)).status === 200);
  check("bad cursor -> 400", (await call("GET", `/bookings?email=${pe}&cursor=garbage`)).status === 400);

  console.log("Level 5 - rate limit");
  const re = freshEmail();
  const results = [];
  for (let i = 0; i < 6; i++) {
    // mix of failures (404) and a success: failures count too
    results.push(await call("POST", "/bookings", { body: { slot_id: i === 0 ? "p10" : "nope", name: "Spam", email: re } }));
  }
  check("first 5 not rate limited", results.slice(0, 5).every((r) => r.status !== 429), results.map((r) => r.status));
  const sixth = results[5];
  const ra = sixth.headers.get("retry-after");
  check("6th -> 429 with integer Retry-After", sixth.status === 429 && /^\d+$/.test(ra || "") && Number(ra) >= 1 && Number(ra) <= 60, [sixth.status, ra]);
  check("429 body has error", typeof sixth.body.error === "string");
  check("other emails unaffected", (await v({ slot_id: "p11", name: "Other", email: freshEmail() })) === 201);
  const sameCase = await call("POST", "/bookings", { body: { slot_id: "p12", name: "Spam", email: re.toUpperCase() } });
  check("rate limit ignores email case", sameCase.status === 429, sameCase.status);
  const re2 = freshEmail();
  const burst = await Promise.all(Array.from({ length: 10 }, (_, i) =>
    call("POST", "/bookings", { body: { slot_id: "nope", name: "Burst", email: re2 } })));
  check("10 simultaneous -> exactly 5 allowed", burst.filter((r) => r.status === 429).length === 5, burst.map((r) => r.status));

  console.log("Misc");
  check("unknown route -> 404 {error}", (await call("GET", "/nothing")).status === 404);
  const page = await fetch(BASE + "/");
  check("web page served at /", page.status === 200 && (page.headers.get("content-type") || "").includes("text/html"));

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
