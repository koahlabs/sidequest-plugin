import { appendFileSync } from "node:fs";

const port = Number(process.env.PORT ?? 4517);
const impressionId = process.env.GOLDEN_IMPRESSION_ID;
if (!impressionId) throw new Error("GOLDEN_IMPRESSION_ID is not set");
const log = process.env.GOLDEN_LOG ?? "/tmp/sidequest-golden-impressions.log";

const icon = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR4nGO4YyNCEmIY1TCqYfhqAABGBCwQMTs5GgAAAABJRU5ErkJggg==",
  "base64",
);

const ad = {
  adText: "Golden render check ad text",
  adCta: "Golden button",
  adLink: "https://example.com/golden",
  advertiser: {
    name: "Golden Test Co",
    rootDomain: "example.com",
    iconUrl: `http://127.0.0.1:${port}/icon.png`,
  },
  impressionId,
};

Bun.serve({
  hostname: "127.0.0.1",
  port,
  fetch(req) {
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
    if (req.method === "POST" && pathname.startsWith("/api/impression/")) {
      appendFileSync(log, `${pathname.split("/").pop()}\n`);
      return new Response(null, { status: 200 });
    }
    return new Response(null, { status: 404 });
  },
});
