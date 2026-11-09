// Run locally or on any Node host (Render, Railway, a VPS):
//   DATABASE_URL=postgres://... API_KEY=your-key node server.js
const http = require("http");
const handler = require("./src/app");

const port = Number(process.env.PORT) || 3000;
http.createServer(handler).listen(port, () => {
  console.log(`Clinic booking API listening on http://localhost:${port}`);
});
