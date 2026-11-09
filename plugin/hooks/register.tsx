import { atom, read, update } from "claude-code";
import type { EngineInterface, Register } from "claude-code";

import type { AdSlot, KoahAd } from "../types";
import { BAND_ADS } from "./features";

const MAX_TEXT = 4000;
const MAX_SLOTS = 50;
const SITE = "https://getsidequest.dev";
const POLL_MS = 1000;
const LATEST_MANIFEST_URL =
  "https://raw.githubusercontent.com/koahlabs/sidequest-plugin/main/plugin/.claude-plugin/plugin.json";
const UPDATE_TIMEOUT_MS = 120_000;
const NEVER_ENTER = "Only enter a code that Claude showed you.";
const NOT_CONNECTED = "not connected — run /sidequest-connect";
const connectUrl = (base: string, userCode: string) => `${base}/connect?code=${userCode}`;
const codeNotice = (base: string, userCode: string) =>
  `copy ${connectUrl(base, userCode)} into your browser. ${NEVER_ENTER}`;

const slots = atom({ plugin: "sidequest", key: "slots" } as const, [] as AdSlot[]);
const band = atom({ plugin: "sidequest", key: "band" } as const, null as KoahAd | null);

type Settings = { inline: boolean; band: boolean };

const USAGE = BAND_ADS
  ? "Usage: /sidequest on | off | inline on | inline off | band on | band off | update"
  : "Usage: /sidequest on | off | update";

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
let clientOnce: Promise<string | undefined> | undefined;
let pluginVersionOnce: Promise<string | undefined> | undefined;
let claudeVersionOnce: Promise<string | undefined> | undefined;
let newerVersionOnce: Promise<string | undefined> | undefined;
let terminalProgramOnce: Promise<string | undefined> | undefined;
let fullscreen: boolean | undefined;
// Whether this terminal draws an Image's pixels; unknown until a blit answers.
let imagesDraw: boolean | undefined;
let imagesProbe: Promise<void> | undefined;
let settingsOnce: Promise<Settings> | undefined;
// Ads follow prompts typed in the terminal or Claude Desktop (both "composer"), not turns that
// background tasks, schedules, peers, Remote Control, `claude -p`, slash commands or `!` shell
// commands start. A `!` command raises no prompt.submit, so a turn counts only when one marked it.
const questions = new Map<string, string>();
let nextTurnFromPerson = false;
// Every AssistantMessage id drawn this load, and the newest first-seen id per surface this turn.
const renderedIds = new Set<string>();
const newestRenderedId = new Map<RenderSurface, string>();
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

const joined = (...parts: (string | false | undefined)[]) => parts.filter(Boolean).join(" · ");

const versionParts = (version: string) => version.split(".").map(Number);

// The version on GitHub's main branch when it is strictly newer than the installed one; any failure
// is no notice. A local checkout gets none, as on the site: an update does not change it.
function newerVersion($: EngineInterface): Promise<string | undefined> {
  return (newerVersionOnce ??= Promise.all([pluginVersion($), $.http.fetch(LATEST_MANIFEST_URL)])
    .then(([installed, res]) => {
      const { version } = JSON.parse(res.text) as { version: string };
      if (!installed || installed.includes("+") || !/^\d+\.\d+\.\d+$/.test(version))
        return undefined;
      const [latest, current] = [versionParts(version), versionParts(installed)];
      const index = latest.findIndex((part, i) => part !== current[i]);
      return index >= 0 && latest[index]! > current[index]! ? version : undefined;
    })
    .catch(() => undefined));
}

const updateNotice = (version: string) => `Sidequest ${version} is ready. Run /sidequest update.`;

const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;

type Payout = { balanceCents: number; thresholdCents: number; payable: boolean };
type DeviceStatus =
  | { kind: "connected"; email: string; payout?: Payout }
  | { kind: "pending" | "suspended" | "not_found" | "unavailable" };

const DEVICE_STATES = { 202: "pending", 403: "suspended", 404: "not_found" } as const;

const isPayout = (payout: Partial<Payout> | null | undefined): payout is Payout =>
  typeof payout?.balanceCents === "number" &&
  typeof payout.thresholdCents === "number" &&
  typeof payout.payable === "boolean";

// The site sends the payout only when it can read earnings, and decides itself whether it is payable.
async function deviceStatus($: EngineInterface, base: string, key: string): Promise<DeviceStatus> {
  const res = await $.http
    .fetch(`${base}/api/device`, { headers: { Authorization: `Bearer ${key}` } })
    .catch(() => undefined);
  const state = DEVICE_STATES[res?.status as keyof typeof DEVICE_STATES];
  if (state) return { kind: state };
  if (res?.status !== 200) return { kind: "unavailable" };
  try {
    const { email, payout } = JSON.parse(res.text) as {
      email?: unknown;
      payout?: Partial<Payout> | null;
    };
    if (typeof email !== "string") return { kind: "unavailable" };
    return { kind: "connected", email, ...(isPayout(payout) && { payout }) };
  } catch {
    return { kind: "unavailable" };
  }
}

const ACCOUNT_TEXT: Record<DeviceStatus["kind"], string> = {
  connected: "connected",
  suspended: "suspended",
  not_found: NOT_CONNECTED,
  pending: "waiting for you to finish connecting",
  unavailable: "could not reach Sidequest",
};

const payoutLine = ({ balanceCents, thresholdCents, payable }: Payout) =>
  payable
    ? `Balance: ${dollars(balanceCents)}. You get paid after the month ends, once Stripe is connected.`
    : `Balance: ${dollars(balanceCents)}. You get paid when your balance is more than ${dollars(thresholdCents)}.`;

const MARKETPLACE_UPDATE = ["plugin", "marketplace", "update", "sidequest"];
const PLUGIN_UPDATE = ["plugin", "update", "sidequest@sidequest"];

// The Claude Code binary this plugin runs in. Claude Desktop bundles its own, and many
// Desktop users have no `claude` CLI on their PATH.
async function runningClaude($: EngineInterface): Promise<string> {
  const { stdout } = await $.process
    .run(["/bin/sh", "-c", "ps -o comm= -p $PPID"])
    .catch(() => ({ stdout: "" }));
  return stdout.trim() || "claude";
}

// The outcome and versions come from `plugin update --json`; any failure points the user to /plugin.
async function updateReply($: EngineInterface): Promise<string> {
  const claude = await runningClaude($);
  const run = (args: string[]) =>
    $.process.run([claude, ...args], { timeoutMs: UPDATE_TIMEOUT_MS });
  try {
    if ((await run(MARKETPLACE_UPDATE)).exitCode === 0) {
      const { exitCode, stdout } = await run([...PLUGIN_UPDATE, "--json"]);
      const { updateOutcome, oldVersion, newVersion } = JSON.parse(stdout) as Record<
        string,
        string | undefined
      >;
      if (exitCode === 0 && updateOutcome === "up_to_date") {
        return `Sidequest is already on the latest version (${newVersion}).`;
      }
      if (exitCode === 0 && updateOutcome === "updated" && newVersion) {
        const updated = oldVersion
          ? `Sidequest updated from ${oldVersion} to ${newVersion}.`
          : `Sidequest updated to ${newVersion}.`;
        return `${updated} Run /reload-plugins to start using it.`;
      }
    }
  } catch {}
  // /plugin works in the terminal and in Desktop, with no CLI.
  return "Sidequest could not update. Check your internet connection and run /sidequest update again. If it still fails, run /plugin and update Sidequest there.";
}

async function statusLines($: EngineInterface, current: Settings) {
  const base = await site($);
  const key = await storedDeviceKey($);
  const [device, os, newer, surfaces, connection] = await Promise.all([
    deviceMetadata($),
    currentOs($),
    newerVersion($),
    $.session.surfaces(),
    key ? deviceStatus($, base, key) : undefined,
  ]);
  const app = joined(
    device.client,
    device.terminalProgram,
    device.fullscreen !== undefined && (device.fullscreen ? "fullscreen" : "not fullscreen"),
  );
  const account = connection ? ACCOUNT_TEXT[connection.kind] : NOT_CONNECTED;
  return [
    surfaces.length > 0
      ? settingsText(current)
      : "Ads do not show in Claude Code on the web. To see ads and earn, run Claude Code on your computer: in the terminal, Claude Desktop, or VS Code.",
    joined(
      device.pluginVersion && `Sidequest v${device.pluginVersion}`,
      device.claudeVersion && `Claude Code ${device.claudeVersion}`,
    ),
    app && `App: ${app}`,
    joined(os && `OS: ${os}`, `Account: ${account}`),
    newer && updateNotice(newer),
    connection?.kind === "connected" && connection.payout && payoutLine(connection.payout),
    key && `See your earnings: ${base}/account`,
  ].filter(Boolean);
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

// Claude Code sets the entrypoint. The site turns the two known clients into the Koah slot it
// reports by; any other entrypoint (the IDE extension, the SDK) is sent as it is.
const CLIENTS = new Map([
  ["claude-desktop", "desktop"],
  ["cli", "terminal"],
]);
function currentClient($: EngineInterface): Promise<string | undefined> {
  return (clientOnce ??= $.env
    .get("CLAUDE_CODE_ENTRYPOINT")
    .then((entrypoint) => (entrypoint ? (CLIENTS.get(entrypoint) ?? entrypoint) : undefined)));
}

// `bun install` writes the gitignored .local file, so only a copy from a local checkout has it.
function pluginVersion($: EngineInterface): Promise<string | undefined> {
  return (pluginVersionOnce ??= Promise.all([
    $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`),
    $.fs.exists(`${$.plugin.root}/.local`),
  ])
    .then(([manifest, local]) => `${JSON.parse(manifest).version}${local ? "+local" : ""}`)
    .catch(() => undefined));
}

function claudeVersion($: EngineInterface): Promise<string | undefined> {
  return (claudeVersionOnce ??= $.session
    .version()
    .then(({ version }) => version)
    .catch(() => undefined));
}

// Only Claude in a terminal has one. TERM_PROGRAM is inherited (kitty sets none, so a
// kitty opened from Ghostty says "ghostty"); the bundle id is the app's own when macOS
// launched it. Inside tmux it is the app that started the tmux server.
function terminalProgram($: EngineInterface): Promise<string | undefined> {
  return (terminalProgramOnce ??= currentClient($)
    .then(async (client) =>
      client === "terminal"
        ? ((await $.env.get("__CFBundleIdentifier")) ?? (await $.env.get("TERM_PROGRAM")))
        : undefined,
    )
    .catch(() => undefined));
}

// What the site shows for this computer; sent with the ad request and when connecting.
async function deviceMetadata($: EngineInterface) {
  return {
    client: await currentClient($),
    pluginVersion: await pluginVersion($),
    claudeVersion: await claudeVersion($),
    terminalProgram: await terminalProgram($),
    fullscreen,
  };
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
    const status = await deviceStatus($, base, key);
    if (!(await stillPending())) return;
    if (status.kind === "connected") {
      await $.store.set("deviceKey", key);
      return finish(`Sidequest connected as ${status.email}.`);
    }
    if (status.kind === "suspended") return finish("Sidequest: this account is suspended.");
    if (status.kind === "not_found") break;
  }
  if (await stillPending()) {
    await finish("Sidequest: the code expired. Run /sidequest-connect again.");
  }
}

// $.http.fetch returns text only, so curl fetches the icon and base64 encodes
// it. Advertisers serve ICOs (Baseten) and large PNGs (Koah monograms), so sips
// turns every icon into a PNG of at most 64px. It also shrinks the icon to 8x8
// and prints the BMP's 64 ARGB words on a "px" line, for brandColor to pick from.
const FETCH_ICON = `
t=$(mktemp -d) || exit 1
trap 'rm -rf "$t"' EXIT
curl -sfL --max-time 5 "$1" -o "$t/icon" || exit 1
sips -s format png -Z 64 "$t/icon" --out "$t/icon.png" >/dev/null 2>&1 || exit 1
base64 < "$t/icon.png"
sips -s format bmp -z 8 8 "$t/icon.png" --out "$t/px.bmp" >/dev/null 2>&1 || exit 0
at=$(od -An -tu4 -j10 -N4 "$t/px.bmp" | tr -d ' ')
echo px "$(od -v -An -tx4 -j"$at" -N256 "$t/px.bmp" | tr -s " \\n" "  ")"
`;

// The most saturated opaque pixel, so a logo's color wins over its background
// and its transparent corners; a grey logo gets the average of its pixels.
function brandColor(words: string[]): string | undefined {
  const pixels = words
    .map((word) => parseInt(word, 16))
    .filter((argb) => argb >>> 24 >= 0x80)
    .map((argb) => [(argb >> 16) & 0xff, (argb >> 8) & 0xff, argb & 0xff]);
  if (pixels.length === 0) return undefined;
  const saturation = (rgb: number[]) => Math.max(...rgb) - Math.min(...rgb);
  const vivid = pixels.reduce((best, rgb) => (saturation(rgb) > saturation(best) ? rgb : best));
  const rgb =
    saturation(vivid) >= 48
      ? vivid
      : [0, 1, 2].map((i) => Math.round(pixels.reduce((sum, p) => sum + p[i]!, 0) / pixels.length));
  return `#${rgb.map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

type Icon = Pick<KoahAd, "iconPng" | "iconColor">;
const icons = new Map<string, Icon>();
async function favicon($: EngineInterface, advertiser: KoahAd["advertiser"]): Promise<Icon> {
  const url =
    advertiser.iconUrl ||
    (advertiser.rootDomain ? `https://${advertiser.rootDomain}/favicon.ico` : null);
  if (!url) return {};
  const cached = icons.get(url);
  if (cached) return cached;
  const { exitCode, stdout } = await $.process.run(["/bin/sh", "-c", FETCH_ICON, "sh", url]);
  const words =
    stdout
      .match(/^px (.*)$/m)?.[1]
      ?.trim()
      .split(/\s+/) ?? [];
  const iconColor = brandColor(words);
  const png = stdout.replace(/^px .*$/m, "").replace(/\s/g, "");
  // Keep PNGs only: a bad image makes the engine refuse the whole tree.
  const icon = {
    iconPng: exitCode === 0 && png.startsWith("iVBORw0KGgo") ? png : undefined,
    iconColor,
  };
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
    const res = await $.http
      .fetch(url, { method: "POST", headers: { Authorization: `Bearer ${key}` } })
      .catch(() => undefined);
    if (res?.ok) return;
    // Permanent errors stop; a network error, 429 and 5xx back off and reuse the same URL.
    if (res && res.status !== 429 && res.status < 500) return;
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
  question: string,
  answer?: string,
): Promise<KoahAd | undefined> {
  // A cloud session seen from the web, or a -p run, has no surface to draw the ad.
  if (!(await $.session.surfaces()).length) return undefined;
  const res = await $.http.fetch(`${await site($)}/api/ad`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      placement,
      ...(await deviceMetadata($)),
      question: question.slice(0, MAX_TEXT),
      answer: answer?.slice(0, MAX_TEXT),
      textLength: placement === "band" ? bandTextLength() : undefined,
      conversationId: (await $.session.id()).slice(0, 64),
    }),
  });

  // A served or empty answer means the site works again, so an old problem leaves the status line.
  if (res.status === 200 || res.status === 204) $.ui.status(undefined);
  if (res.status === 200) {
    const served = JSON.parse(res.text) as KoahAd;
    Object.assign(served, await favicon($, served.advertiser));
    return served;
  }
  if (res.status === 401) {
    $.ui.status(NOT_CONNECTED);
  } else if (res.status === 403) {
    $.ui.status("account suspended");
  } else if (res.status !== 204) {
    $.ui.status("ads unavailable — trying again next prompt");
  }
  return undefined;
}

// The ad is on screen now: that is the CLI impression event.
async function reportOnScreen($: EngineInterface, ad: KoahAd) {
  if (reported.has(ad.impressionId)) return;
  const key = await storedDeviceKey($);
  if (key) void reportImpression($, await site($), ad.impressionId, key);
}

async function refreshBand($: EngineInterface, turnId: string, question: string) {
  const key = await storedDeviceKey($);
  if (!key || !question.trim() || !(await readSettings($)).band) return;
  try {
    const ad = await requestAd($, key, "band", question);
    if (ad && bandTurnId === turnId && (await readSettings($)).band) {
      await update($, band, () => ad);
    }
  } catch {}
}

type RenderEvent = Parameters<EngineInterface["ui"]["resolve"]>[0];
type RenderSurface = RenderEvent["surface"];

// A blit to an Image is denied where the terminal draws its alt instead of the
// pixels (Terminal.app). The first drawn ad asks once; a no switches to the badge,
// and no answer at all keeps the Image.
async function probeImages($: EngineInterface, requestId: string, png: string) {
  for (const wait of [100, 500, 2000]) {
    await $.clock.sleep(wait);
    const { deny } = await $.ui.blit({ requestId, key: "logo", source: { png } });
    if (!deny) break;
    if (deny.includes("alt")) {
      imagesDraw = false;
      return $.ui.invalidate("ui.render");
    }
  }
  imagesDraw = true;
}

function openAd($: EngineInterface, ad: KoahAd) {
  void currentOs($).then((os) => openBrowser($, ad.adLink, os));
}

function luma(rgb: number) {
  return 0.299 * (rgb >> 16) + 0.587 * ((rgb >> 8) & 0xff) + 0.114 * (rgb & 0xff);
}

// The brand color for hovered text, unless it is so dark or so light that a dark or a
// light theme would hide it (a black Nike icon); then the theme's own color.
function brandHover(ad: KoahAd) {
  if (!ad.iconColor) return undefined;
  const brightness = luma(parseInt(ad.iconColor.slice(1), 16));
  return brightness > 50 && brightness < 205 ? { color: ad.iconColor } : undefined;
}

function adIcon($: EngineInterface, e: RenderEvent, ad: KoahAd) {
  if (e.surface === "terminal") {
    const { Image, Text } = $.ui.resolve(e);
    if (ad.iconPng && imagesDraw !== false) {
      return <Image key="logo" source={{ png: ad.iconPng }} columns={2} rows={1} alt=" " />;
    }
    if (!ad.iconColor) return null;
    // The advertiser's initial on its brand color, where the terminal draws no image.
    const dark = luma(parseInt(ad.iconColor.slice(1), 16)) > 150;
    return (
      <Text color={dark ? "#000000" : "#ffffff"} backgroundColor={ad.iconColor}>
        {` ${ad.advertiser.name.trim().charAt(0).toUpperCase()} `}
      </Text>
    );
  }
  if (ad.iconPng && (e.surface === "desktop" || e.surface === "vscode")) {
    // The PNG inside an Svg, in a box of fixed size (2 cells by 1): in a row an
    // Svg with no sized box collapses. Desktop and the IDE panel draw nothing
    // for an Svg whose alt is blank, so it carries the advertiser's name.
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
  pluginVersionOnce = undefined;
  claudeVersionOnce = undefined;
  newerVersionOnce = undefined;
  terminalProgramOnce = undefined;
  fullscreen = undefined;
  imagesDraw = undefined;
  imagesProbe = undefined;
  settingsOnce = undefined;
  bandColumns = undefined;
  renderedIds.clear();
  newestRenderedId.clear();
  questions.clear();

  on("session.start", async ($, e, next) => {
    await $.command.register({
      name: "sidequest",
      description: BAND_ADS
        ? "Show your Sidequest earnings and status, turn ads on or off, choose inline or band ads, or update"
        : "Show your Sidequest earnings and status, turn ads on or off, or update",
    });
    await $.command.register({
      name: "sidequest-connect",
      description: "Link this computer to your Sidequest account in the browser",
    });
    const pending = await storedPending($);
    if (pending) void pollConnection($, pending).catch(() => {});
    else if (!(await storedDeviceKey($))) {
      $.ui.toast("sidequest: run /sidequest-connect to link your account");
    }
    if (e.isInteractive) {
      void newerVersion($).then((version) => {
        if (version) $.ui.toast(updateNotice(version));
      });
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
    if (!args) return reply(`${(await statusLines($, current)).join("\n")}\n${USAGE}`);
    if (args === "update") {
      return reply(await updateReply($));
    }
    if (!change) return reply(USAGE);

    const next = { ...current, ...change };
    await $.store.set("settings", next);
    settingsOnce = Promise.resolve(next);
    const key = await storedDeviceKey($);
    // Lets the site tell a person who turned ads off from one who stopped using Claude.
    if (key && next.inline !== current.inline)
      await $.http
        .fetch(`${await site($)}/api/device`, {
          method: "PATCH",
          headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
          body: JSON.stringify({ ads: next.inline ? "on" : "off" }),
        })
        .catch(() => undefined);
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
        body: JSON.stringify({ os, ...(await deviceMetadata($)) }),
      })
      .catch(() => undefined);
    if (res?.status === 403)
      return {
        text: "**Sidequest is in early access in the US only.** You can't earn with it outside the US yet. We're bringing Sidequest to more countries soon.",
      };
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

  on("prompt.submit", async ($, e, next) => {
    if (e.turnId === undefined) nextTurnFromPerson = e.origin.kind === "composer" && !e.command;
    return next(e);
  });

  on("turn.start", async ($, e, next) => {
    if (e.agentId !== undefined) return next(e);
    const fromPerson = nextTurnFromPerson;
    nextTurnFromPerson = false;
    if (fromPerson) {
      questions.set(e.turnId, e.text);
      newestRenderedId.clear();
      bandTurnId = e.turnId;
      // The band and inline requests each use one of the site's daily ad requests.
      void refreshBand($, e.turnId, e.text);
    }
    return next(e);
  });

  // The slot is keyed by the reply's render ids, learned from the render hook: Desktop and the terminal name messages differently.
  on("turn.complete", async ($, e, next) => {
    // Read before any await: a prompt typed during the answer starts the next turn.
    const question = questions.get(e.turnId);
    questions.delete(e.turnId);
    const result = await next(e);
    const keys = [...newestRenderedId.values()];
    if (e.agentId !== undefined || !question?.trim() || keys.length === 0) return result;
    if (e.reason !== "answer" || !e.answer.trim()) return result;
    if (!(await readSettings($)).inline) return result;
    const key = await storedDeviceKey($);
    if (!key) return result;

    // In the background: a slow or failing ad request must not hold up the end of the turn.
    void requestAd($, key, "inline", question, e.answer)
      .then(async (ad) => {
        if (!ad) return;
        const slot: AdSlot = { keys, ad };
        await update($, slots, (list) => [...(list ?? []), slot].slice(-MAX_SLOTS));
      })
      .catch(() => {});
    return result;
  });

  // The ad sits under the last message of the reply it was served for.
  on("ui.render", { component: "AssistantMessage" }, async ($, e, next) => {
    if (e.surface === "terminal") fullscreen = e.viewport?.isFullscreen ?? fullscreen;
    if (!renderedIds.has(e.requestId)) {
      renderedIds.add(e.requestId);
      newestRenderedId.set(e.surface, e.requestId);
    }
    if (!(await readSettings($)).inline) return next(e);
    const list = await read($, slots);
    const slot = list.find((s) => s.keys?.includes(e.requestId));
    if (slot === undefined || !isAd(slot.ad)) return next(e);

    const { ad } = slot;
    const { Box, Text, Link, Markdown, Button } = $.ui.resolve(e);

    await reportOnScreen($, ad);

    const icon = adIcon($, e, ad);
    if (e.surface === "terminal" && ad.iconPng) {
      imagesProbe ??= probeImages($, e.requestId, ad.iconPng).catch(() => {});
    }

    // Box has no top-only border. The terminal gets a rule sized to fit (a cut
    // Text ends in an ellipsis); Desktop draws a markdown rule. The IDE panel
    // frames the drawing itself, so it gets none.
    const divider =
      e.surface === "vscode" ? null : (
        <Box flexDirection="column" width="100%" marginTop={1}>
          {e.surface === "terminal" ? (
            <Text dimColor>{"─".repeat(Math.max((e.viewport?.columns ?? 64) - 4, 8))}</Text>
          ) : (
            <Markdown text="---" />
          )}
        </Box>
      );

    // Only the fullscreen terminal reports clicks to Claude Code, so there a
    // Button opens the ad; Terminal.app draws a Link as its text and a dim URL.
    // The IDE panel draws a Button as its own button. Elsewhere the Link is the
    // terminal's or the desktop's own.
    const hover = brandHover(ad);
    const label = `${ad.adCta} →`;
    const cta =
      e.surface === "vscode" ? (
        <Box flexDirection="row">
          <Button key="cta" onPress={() => openAd($, ad)}>
            {label}
          </Button>
        </Box>
      ) : (
        <Box key="cta-box" alignSelf="flex-start" borderStyle="round" paddingX={1}>
          {e.surface === "terminal" && e.viewport?.isFullscreen ? (
            <Button key="cta" plain onPress={() => openAd($, ad)}>
              <Text bold hover={hover}>
                {label}
              </Text>
            </Button>
          ) : (
            <Text bold hover={hover}>
              <Link href={ad.adLink}>{label}</Link>
            </Text>
          )}
        </Box>
      );

    const reply = await next(e);

    // The engine's own reply, a divider, then the ad: advertiser line, the ad
    // text wrapped, and the CTA. The Box that holds the reply takes no width:
    // Claude Desktop drops the whole tree when it has one.
    return (
      <Box flexDirection="column">
        {reply}
        {divider}
        <Box flexDirection="column" width="100%" gap={1} marginTop={divider ? 1 : 0}>
          <Box flexDirection="row" gap={1}>
            {icon}
            <Text bold>{ad.advertiser.name}</Text>
            <Text dimColor>Sponsored</Text>
          </Box>
          <Text wrap="wrap">{ad.adText}</Text>
          {cta}
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
    if (e.surface === "terminal") fullscreen = e.viewport?.isFullscreen ?? fullscreen;
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
            onPress={() => openAd($, ad)}
          >
            {ad.adCta}
          </Button>
        </Box>
      </Box>
    );
  });
};
