// Each run gets its own ad text and impression id, so parallel runs cannot pass on each other's ad.
const { GOLDEN_AD_TEXT: adText, GOLDEN_IMPRESSION_ID: impressionId } = process.env;
if (!adText || !impressionId)
  throw new Error("GOLDEN_AD_TEXT and GOLDEN_IMPRESSION_ID are required");

const icon = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR4nGO4YyNCEmIY1TCqYfhqAABGBCwQMTs5GgAAAABJRU5ErkJggg==",
  "base64",
);

// Port 0: the OS picks a free port, printed first so the caller can read it.
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch,
});
console.log(`PORT ${server.port}`);

const ad = {
  adText,
  adCta: "Golden button",
  adLink: "https://example.com/golden",
  advertiser: {
    name: "Golden Test Co",
    iconUrl: `http://127.0.0.1:${server.port}/icon.png`,
  },
  impressionId,
};

function fetch(req: Request) {
  const { pathname } = new URL(req.url);
  const route = `${req.method} ${pathname}`;
  console.log(route);
  if (route === "POST /api/device") {
    const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
    return Response.json({ userCode: "GOLD-TEST", expiresAt }, { status: 201 });
  }
  if (route === "GET /api/device") return Response.json({ email: "golden@sidequest.test" });
  if (route === "POST /api/ad") return Response.json(ad);
  if (route === "GET /icon.png")
    return new Response(icon, { headers: { "Content-Type": "image/png" } });
  // The run log above is the record the scripts check for this run's impression.
  if (route.startsWith("POST /api/impression/")) return new Response(null);
  return new Response(null, { status: 404 });
}
