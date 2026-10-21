import { atom, read, update } from "claude-code";
import type { EngineInterface, Register } from "claude-code";

import type { AdSlot, KoahAd } from "../types";
import { BAND_ADS } from "./features";

const MAX_TEXT = 4000;
const MAX_SLOTS = 50;
const SITE = "https://getsidequest.dev";
const POLL_MS = 1000;
const NEVER_ENTER = "Only enter a code that Claude showed you.";
const connectUrl = (base: string, userCode: string) => `${base}/connect?code=${userCode}`;
const codeNotice = (base: string, userCode: string) =>
  `sidequest: copy ${connectUrl(base, userCode)} into your browser. ${NEVER_ENTER}`;

const slots = atom({ plugin: "sidequest", key: "slots" } as const, [] as AdSlot[]);
const band = atom({ plugin: "sidequest", key: "band" } as const, null as KoahAd | null);

type Settings = { inline: boolean; band: boolean };

const USAGE = BAND_ADS
  ? "Usage: /sidequest on | off | inline on | inline off | band on | band off"
  : "Usage: /sidequest on | off";

const COMMANDS = new Map<string, Partial<Settings>>([
  ["on", { inline: true, band: BAND_ADS }],
  ["off", { inline: false, band: false }],
  ...(BAND_ADS
    ? ([
        ["inline on", { inline: true }],
        ["inline off", { inline: false }],
        ["band on", { band: true }],
        ["band off", { band: false }],
      ] as const)
    : []),
]);

type Pending = { key: string; expiresAt: number; userCode: string };

let siteOnce: Promise<string> | undefined;
let osOnce: Promise<Os | undefined> | undefined;
let clientOnce: Promise<Client> | undefined;
let settingsOnce: Promise<Settings> | undefined;
let question = "";
let bandTurnId: string | undefined;
let bandColumns: number | undefined;

const BAND_HOVER_SCOPE = "sidequest-band";
const BAND_FIRST_TEXT_LENGTH = 60;
const BAND_MIN_TEXT_LENGTH = 40;
const BAND_MAX_TEXT_LENGTH = 300;
// Logo 2, "Ad" 2, four gaps, and about 25 for the brand and the call to action, which are unknown until the ad arrives.
const BAND_LINE_OVERHEAD = 2 + 2 + 4 + 25;

// Impression ids already reported this load; Koah dedupes impressions per served ad.
const reported = new Set<string>();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function storedDeviceKey($: EngineInterface): Promise<string | undefined> {
  const saved = await $.store.get("deviceKey");
  return typeof saved === "string" ? saved : undefined;
}

async function storedPending($: EngineInterface): Promise<Pending | undefined> {
  const saved = (await $.store.get("pending")) as Partial<Pending> | undefined;
  return typeof saved?.key === "string" &&
    typeof saved.expiresAt === "number" &&
    typeof saved.userCode === "string"
    ? (saved as Pending)
    : undefined;
}

function readSettings($: EngineInterface): Promise<Settings> {
  return (settingsOnce ??= $.store.get("settings").then((saved) => {
    const stored = (saved ?? {}) as Partial<Settings>;
    return { inline: stored.inline !== false, band: BAND_ADS && stored.band !== false };
  }));
}

const settingsText = (s: Settings) =>
  BAND_ADS
    ? `Inline ads: ${s.inline ? "on" : "off"}. Band ads: ${s.band ? "on" : "off"}.`
    : `Ads: ${s.inline ? "on" : "off"}.`;

function site($: EngineInterface): Promise<string> {
  return (siteOnce ??= resolveSite($));
}

// The person launching Claude Code sets user settings and --settings; a repo cannot. Only a loopback URL is accepted, and --settings wins.
async function resolveSite($: EngineInterface): Promise<string> {
  for (const source of ["flag", "user"] as const) {
    try {
      const { env } = await $.settings.read({ source });
      const url = new URL((env as Record<string, string> | undefined)?.SIDEQUEST_URL ?? "");
      if (url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))
        return url.origin;
    } catch {}
  }
  return SITE;
}

const OPENERS = {
  macos: ["open"],
  linux: ["xdg-open"],
  windows: ["rundll32", "url.dll,FileProtocolHandler"],
};
type Os = keyof typeof OPENERS;

// With an unknown OS it tries every opener in turn. The reply always shows the URL, so every failure is ignored.
async function openBrowser($: EngineInterface, url: string, os: Os | undefined) {
  for (const opener of os ? [OPENERS[os]] : Object.values(OPENERS)) {
    try {
      if ((await $.process.run([...opener, url])).exitCode === 0) return;
    } catch {}
  }
}

function newDeviceKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const b64 = btoa(String.fromCharCode(...bytes));
  return `sq_${b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
}

// Only the OS name goes to the site, never a hostname. Windows sets OS and has no uname.
async function detectOs($: EngineInterface): Promise<Os | undefined> {
  if ((await $.env.get("OS")) === "Windows_NT") return "windows";
  try {
    const { exitCode, stdout } = await $.process.run(["uname", "-s"]);
    const names: Record<string, Os | undefined> = { Darwin: "macos", Linux: "linux" };
    return exitCode === 0 ? names[stdout.trim()] : undefined;
  } catch {
    return undefined;
  }
}

function currentOs($: EngineInterface): Promise<Os | undefined> {
  return (osOnce ??= detectOs($));
}

// Claude Code sets the entrypoint; the site turns the client into the Koah slot it reports by.
type Client = "desktop" | "terminal";
function currentClient($: EngineInterface): Promise<Client> {
  return (clientOnce ??= $.env
    .get("CLAUDE_CODE_ENTRYPOINT")
    .then((entrypoint) => (entrypoint === "claude-desktop" ? "desktop" : "terminal")));
}

// Polls until the site confirms the pending key, refuses it, or it expires.
// A newer /sidequest-connect replaces the stored key, which ends this poll.
// The code stays on the status line until the poll ends, also after a restart.
async function pollConnection($: EngineInterface, { key, expiresAt, userCode }: Pending) {
  const base = await site($);
  $.ui.status(codeNotice(base, userCode));
  const finish = async (toast: string) => {
    await $.store.delete("pending");
    $.ui.status(undefined);
    $.ui.toast(toast);
  };

  const stillPending = async () => {
    const current = await storedPending($);
    if (current?.key === key) return true;
    if (!current) $.ui.status(undefined);
    return false;
  };

  while ((await $.clock.now()) < expiresAt) {
    await $.clock.sleep(POLL_MS);
    const res = await $.http
      .fetch(`${base}/api/device`, { headers: { Authorization: `Bearer ${key}` } })
      .catch(() => undefined);
    if (!(await stillPending())) return;
    if (res?.status === 200) {
      const { email } = JSON.parse(res.text) as { email: string };
      await $.store.set("deviceKey", key);
      return finish(`Sidequest connected as ${email}.`);
    }
    if (res?.status === 403) return finish("Sidequest: this account is suspended.");
    if (res?.status === 404) break;
  }
  if (await stillPending()) {
    await finish("Sidequest: the code expired. Run /sidequest-connect again.");
  }
}

// $.http.fetch returns text only, so curl fetches the icon and base64 encodes
// it. Many advertisers serve an ICO (Baseten does), so sips converts any
// non-PNG to a 64px PNG first.
const FETCH_ICON = `
t=$(mktemp -d) || exit 1
trap 'rm -rf "$t"' EXIT
curl -sfL --max-time 5 "$1" -o "$t/icon" || exit 1
if ! head -c 8 "$t/icon" | grep -q PNG; then
  sips -s format png -Z 64 "$t/icon" --out "$t/icon.png" >/dev/null 2>&1 || exit 1
  mv "$t/icon.png" "$t/icon"
fi
base64 < "$t/icon"
`;

const icons = new Map<string, string | undefined>();
async function favicon(
  $: EngineInterface,
  advertiser: KoahAd["advertiser"],
): Promise<string | undefined> {
  const url =
    advertiser.iconUrl ||
    (advertiser.rootDomain ? `https://${advertiser.rootDomain}/favicon.ico` : null);
  if (!url) return undefined;
  if (icons.has(url)) return icons.get(url);
  const { exitCode, stdout } = await $.process.run(["/bin/sh", "-c", FETCH_ICON, "sh", url]);
  const png = stdout.replace(/\s/g, "");
  // Keep PNGs only: a bad image makes the engine refuse the whole tree.
  const icon = exitCode === 0 && png.startsWith("iVBORw0KGgo") ? png : undefined;
  icons.set(url, icon);
  return icon;
}

async function reportImpression(
  $: EngineInterface,
  base: string,
  impressionId: string,
  key: string,
) {
  if (reported.has(impressionId)) return;
  reported.add(impressionId);
  const url = `${base}/api/impression/${impressionId}`;
  for (const wait of [0, 1000, 4000, 15000]) {
    if (wait) await $.clock.sleep(wait);
    const res = await $.http.fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}` },
    });
    if (res.ok) return;
    // Permanent errors stop; 429 and 5xx back off and reuse the same URL.
    if (res.status !== 429 && res.status < 500) return;
  }
}

// $.state outlives a reload, so a slot can hold an ad from an older shape.
// The mod builds the impression URL from the id, so the device key goes only to this site.
function isAd(ad: unknown): ad is KoahAd {
  const a = ad as Partial<KoahAd> | null;
  return (
    typeof a?.adText === "string" &&
    typeof a.adCta === "string" &&
    typeof a.adLink === "string" &&
    typeof a.impressionId === "string" &&
    UUID.test(a.impressionId) &&
    typeof a.advertiser?.name === "string"
  );
}

function bandTextLength() {
  if (bandColumns === undefined) return BAND_FIRST_TEXT_LENGTH;
  return Math.min(
    Math.max(bandColumns - BAND_LINE_OVERHEAD, BAND_MIN_TEXT_LENGTH),
    BAND_MAX_TEXT_LENGTH,
  );
}

async function requestAd(
  $: EngineInterface,
  key: string,
  placement: "inline" | "band",
  answer?: string,
): Promise<KoahAd | undefined> {
  const res = await $.http.fetch(`${await site($)}/api/ad`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      placement,
      client: await currentClient($),
      question: question.slice(0, MAX_TEXT),
      answer: answer?.slice(0, MAX_TEXT),
      textLength: placement === "band" ? bandTextLength() : undefined,
      conversationId: (await $.session.id()).slice(0, 64),
    }),
  });

  if (res.status === 200) {
    const served = JSON.parse(res.text) as KoahAd;
    served.iconPng = await favicon($, served.advertiser);
    return served;
  }
  if (res.status === 401) {
    $.ui.status("sidequest: not connected — run /sidequest-connect");
  } else if (res.status === 403) {
    $.ui.status("sidequest: account suspended");
  } else if (res.status !== 204) {
    $.ui.status(`sidequest: ad request ${res.status}`);
  }
  return undefined;
}

// The ad is on screen now: that is the CLI impression event.
async function reportOnScreen($: EngineInterface, ad: KoahAd) {
  if (reported.has(ad.impressionId)) return;
  const key = await storedDeviceKey($);
  if (key) void reportImpression($, await site($), ad.impressionId, key);
}

async function refreshBand($: EngineInterface, turnId: string) {
  const key = await storedDeviceKey($);
  if (!key || !question.trim() || !(await readSettings($)).band) return;
  try {
    const ad = await requestAd($, key, "band");
    if (ad && bandTurnId === turnId && (await readSettings($)).band) {
      await update($, band, () => ad);
    }
  } catch {}
}

type RenderEvent = Parameters<EngineInterface["ui"]["resolve"]>[0];

function adIcon($: EngineInterface, e: RenderEvent, ad: KoahAd) {
  if (ad.iconPng && e.surface === "terminal") {
    const { Image } = $.ui.resolve(e);
    return <Image source={{ png: ad.iconPng }} columns={2} rows={1} alt=" " />;
  }
  if (ad.iconPng && e.surface === "desktop") {
    // The PNG inside an Svg, in a box of fixed size (2 cells by 1): in a row an
    // Svg with no sized box collapses. The desktop draws nothing for an Svg
    // whose alt is blank, so it carries the advertiser's name.
    const { Box, Svg } = $.ui.resolve(e);
    const source =
      '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">' +
      `<image href="data:image/png;base64,${ad.iconPng}" width="64" height="64"/></svg>`;
    return (
      <Box width={2} height={1} flexShrink={0}>
        <Svg source={source} width={16} height={16} alt={`${ad.advertiser.name} logo`} />
      </Box>
    );
  }
  return null;
}

export const register: Register = (on) => {
  siteOnce = undefined;
  osOnce = undefined;
  clientOnce = undefined;
  settingsOnce = undefined;
  bandColumns = undefined;

  on("session.start", async ($, e, next) => {
    await $.command.register({
      name: "sidequest",
      description: BAND_ADS
        ? "Turn Sidequest ads on or off, or choose inline or band ads"
        : "Turn Sidequest ads on or off",
    });
    await $.command.register({
      name: "sidequest-connect",
      description: "Link Sidequest to your account in the browser",
    });
    const pending = await storedPending($);
    if (pending) void pollConnection($, pending).catch(() => {});
    else if (!(await storedDeviceKey($))) {
      $.ui.toast("sidequest: run /sidequest-connect to link your account");
    }
    return next(e);
  });

  on("command.run", { command: "sidequest" }, async ($, e) => {
    const args = e.args.trim().toLowerCase().split(/\s+/).join(" ");
    const change = COMMANDS.get(args);
    const current = await readSettings($);
    // The output is for the person. Without this, Claude brings it up in later answers.
    const reply = (text: string) => ({
      text,
      context: ["The user ran /sidequest. Its output is for them only. Do not mention it."],
    });
    if (!args) return reply(`${settingsText(current)}\n${USAGE}`);
    if (!change) return reply(USAGE);

    const next = { ...current, ...change };
    await $.store.set("settings", next);
    settingsOnce = Promise.resolve(next);
    if (!next.band) await update($, band, () => null);
    $.ui.invalidate("ui.render");
    return reply(settingsText(next));
  });

  on("command.run", { command: "sidequest-connect" }, async ($) => {
    const base = await site($);
    const key = newDeviceKey();
    const os = await currentOs($);
    const res = await $.http
      .fetch(`${base}/api/device`, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ os }),
      })
      .catch(() => undefined);
    if (res?.status === 403) return { text: "only available in the US for now." };
    if (res?.status === 429)
      return { text: "Too many connection attempts from this network. Try again in 10 minutes." };
    if (res?.status !== 201)
      return { text: "Sidequest could not start a connection. Try again later." };

    const { userCode, expiresAt } = JSON.parse(res.text) as { userCode: string; expiresAt: string };
    const pending = { key, expiresAt: Date.parse(expiresAt), userCode };
    const url = connectUrl(base, userCode);
    await $.store.set("pending", pending);
    await openBrowser($, url, os);
    void pollConnection($, pending).catch(() => {});
    // Code blocks, not links: Claude Desktop opens links in its own browser, where the user is signed out.
    return {
      text: [
        "**Connect Sidequest**",
        "",
        "1. Copy this link into your browser:",
        "```",
        url,
        "```",
        "2. If the page asks for a code, enter:",
        "```",
        userCode,
        "```",
        "",
        NEVER_ENTER,
      ].join("\n"),
      // The output is for the person. Without this, Claude brings the connection up in later answers.
      context: ["The user ran /sidequest-connect. Its output is for them only. Do not mention it."],
    };
  });

  on("turn.start", async ($, e, next) => {
    if (e.agentId === undefined) {
      if (e.text.trim()) question = e.text;
      bandTurnId = e.turnId;
      // The band and inline requests each use one of the site's daily ad requests.
      void refreshBand($, e.turnId);
    }
    return next(e);
  });

  on("turn.complete", async ($, e, next) => {
    const result = await next(e);
    if (e.agentId !== undefined || e.reason !== "answer" || !e.answer.trim()) return result;
    if (!(await readSettings($)).inline) return result;
    const key = await storedDeviceKey($);
    if (!key || !question.trim()) return result;

    const served = await requestAd($, key, "inline", e.answer);
    if (served) {
      const slot: AdSlot = { answer: e.answer.trim(), ad: served };
      await update($, slots, (list) => [...(list ?? []), slot].slice(-MAX_SLOTS));
    }
    return result;
  });

  // The ad sits under the last message of the reply it was served for.
  on("ui.render", { component: "AssistantMessage" }, async ($, e, next) => {
    if (!(await readSettings($)).inline) return next(e);
    const text = e.props.text.trim();
    const list = await read($, slots);
    const slot = text === "" ? undefined : list.find((s) => s.answer.endsWith(text));
    if (slot === undefined || !isAd(slot.ad)) return next(e);

    const { ad } = slot;
    const { Box, Text, Link, Markdown } = $.ui.resolve(e);

    await reportOnScreen($, ad);

    const icon = adIcon($, e, ad);

    // Box has no top-only border. The terminal gets a rule sized to fit (a cut
    // Text ends in an ellipsis); the remote surfaces draw a markdown rule.
    const divider =
      e.surface === "terminal" ? (
        <Text dimColor>{"─".repeat(Math.max((e.viewport?.columns ?? 64) - 4, 8))}</Text>
      ) : (
        <Markdown text="---" />
      );

    // The reply, a divider, then the ad: advertiser line, the ad text wrapped,
    // and the CTA as a bordered link. No side padding, one gap between rows;
    // rows stretch to the full width and only the button keeps its own.
    return (
      <Box flexDirection="column" width="100%">
        <Markdown text={e.props.text} />
        <Box flexDirection="column" width="100%" marginTop={1}>
          {divider}
        </Box>
        <Box flexDirection="column" width="100%" gap={1} marginTop={1}>
          <Box flexDirection="row" gap={1}>
            {icon}
            <Text bold>{ad.advertiser.name}</Text>
            <Text dimColor>Sponsored</Text>
          </Box>
          <Text wrap="wrap">{ad.adText}</Text>
          <Box alignSelf="flex-start" borderStyle="round" borderDimColor paddingX={1}>
            <Text>
              <Link href={ad.adLink}>{ad.adCta}</Link>
            </Text>
          </Box>
        </Box>
      </Box>
    );
  });

  on("ui.message", async ($, e, next) => {
    if (e.component === "AbovePrompt" && e.module.endsWith("seen.tsx")) {
      const seen = (e.data as { seen?: unknown } | null)?.seen;
      const ad = await read($, band);
      if (typeof seen === "string" && isAd(ad) && ad.impressionId === seen) {
        await reportOnScreen($, ad);
      }
    }
    return next(e);
  });

  on("ui.render", { component: "AbovePrompt" }, async ($, e, next) => {
    bandColumns = e.props.bodyColumns;
    if (!BAND_ADS) return next(e);
    if (e.surface !== "terminal" && e.surface !== "desktop") return next(e);
    if (e.props.hasSurvey) return next(e);
    const ad = await read($, band);
    if (!isAd(ad)) return next(e);

    const { Box, Text, Link, Button, Client } = $.ui.resolve(e);
    // The hook also runs while the band is collapsed, so the impression comes from the Client's mount.
    // Only the ad text shrinks, so a narrow terminal cuts it and never the call to action.
    // Hovering the row lights it; the colors change, the size does not.
    return (
      <Box
        key="band"
        flexDirection="row"
        gap={1}
        width="100%"
        hover={{ scope: BAND_HOVER_SCOPE, backgroundColor: "subtle" }}
      >
        {adIcon($, e, ad)}
        <Box flexShrink={0}>
          <Client key="seen" module="./seen.tsx" props={{ impressionId: ad.impressionId }} />
          <Text bold>
            <Link href={ad.adLink}>{ad.advertiser.name}</Link>
          </Text>
        </Box>
        <Box flexShrink={0}>
          <Text dimColor>Ad</Text>
        </Box>
        <Box flexGrow={1} flexShrink={1}>
          <Text wrap="truncate-end">
            <Link href={ad.adLink}>{ad.adText}</Link>
          </Text>
        </Box>
        <Box flexShrink={0}>
          <Button
            key="open"
            plain
            hotkey="o"
            hover={{ scope: BAND_HOVER_SCOPE, underline: true }}
            onPress={() => void currentOs($).then((os) => openBrowser($, ad.adLink, os))}
          >
            {ad.adCta}
          </Button>
        </Box>
      </Box>
    );
  });
};
