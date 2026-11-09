// Loads demo slots through POST /reset (this DELETES all bookings).
//   BASE_URL=https://your-app.vercel.app API_KEY=your-key node scripts/seed.js
const BASE = (process.env.BASE_URL || "http://localhost:3000").replace(/\/$/, "");
const KEY = process.env.API_KEY;
if (!KEY) { console.error("Set API_KEY"); process.exit(1); }

const providers = ["Dr Ade", "Dr Bello", "Dr Chioma"];
const slots = [];
const day = new Date();
day.setUTCHours(0, 0, 0, 0);
for (let d = 1; d <= 5; d++) {
  for (let h = 9; h < 13; h++) {
    providers.forEach((provider, p) => {
      const start = new Date(day.getTime() + d * 864e5 + h * 36e5);
      const end = new Date(start.getTime() + 30 * 6e4);
      const iso = (t) => t.toISOString().replace(/\.\d{3}Z$/, "Z");
      slots.push({ id: `d${d}-${h}-${p}`, provider, start: iso(start), end: iso(end) });
    });
  }
}

fetch(`${BASE}/reset`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "X-API-Key": KEY },
  body: JSON.stringify({ slots }),
}).then(async (r) => console.log(r.status, await r.text()));
