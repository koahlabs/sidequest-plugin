import { expect, mock, test } from "claude-code/testing";
import type { On } from "claude-code";

import { BAND_ADS } from "../hooks/features";

const AD = {
  adText: "Find your next pair of running shoes.",
  adCta: "Explore",
  adLink: "https://app.koah.ai/kclk/648dd783-4b6f-4efa-b8a4-f7a95ccfce47",
  advertiser: {
    name: "Example Brand",
    rootDomain: "example.com",
    iconUrl: "https://www.google.com/s2/favicons?domain=example.com&sz=64",
  },
  impressionId: "648dd783-4b6f-4efa-b8a4-f7a95ccfce47",
};

const BAND_AD = {
  ...AD,
  adText: "Run farther for less.",
  advertiser: { ...AD.advertiser, name: "Band Brand" },
  impressionId: "11111111-2222-4333-8444-555555555555",
};
const NEXT_BAND_AD = {
  ...BAND_AD,
  adText: "Trail shoes on sale.",
  advertiser: { ...AD.advertiser, name: "Next Brand" },
  impressionId: "66666666-7777-4888-8999-000000000000",
};

const SECOND_AD = {
  ...AD,
  advertiser: { ...AD.advertiser, name: "Second Brand" },
  impressionId: "99999999-8888-4777-8666-555555555555",
};

const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==";
const SITE = "https://getsidequest.dev";
const LATEST_MANIFEST_URL =
  "https://raw.githubusercontent.com/koahlabs/sidequest-plugin/main/plugin/.claude-plugin/plugin.json";
const PLUGIN_VERSION = "1.2.3";
const CLAUDE_VERSION = "2.1.300";
const TERM_PROGRAM = "ghostty";
const IMPRESSION_URL = `${SITE}/api/impression/${AD.impressionId}`;
const QUESTION = "What should I look for in running shoes?";
const ANSWER = "Look at fit first.\n\nPrioritize fit and cushioning.";
const COMPLETE = {
  answer: ANSWER,
  durationMs: 10,
  isAborted: false,
  turnId: "t1",
  reason: "answer",
} as const;

type Call = { url: string; method?: string; body?: string; auth?: string };

type WorldOptions = {
  store?: Record<string, unknown>;
  projectEnv?: Record<string, string>;
  userEnv?: Record<string, string>;
  flagEnv?: Record<string, string>;
  polls?: number[];
  adStatus?: number;
  startStatus?: number;
  ad?: typeof AD;
  inlineAds?: (typeof AD)[];
  adBody?: string;
  holdInline?: boolean;
  failFirstImpression?: boolean;
  bandAds?: (typeof AD)[];
  holdFirstBand?: boolean;
  localCheckout?: boolean;
  failingCommands?: string[];
  updateVersions?: { updateOutcome: string; oldVersion?: string; newVersion: string };
  osEnv?: Record<string, string>;
  unameOutput?: string;
  surfaces?: ("terminal" | "desktop" | "mobile" | "vscode")[];
  latestVersion?: string;
  deviceBody?: Record<string, unknown>;
};

// The world beneath the mod: the site proxy, the icon fetch, and an engine
// drawing of its own for any message the mod leaves alone. `polls` are the
// statuses GET /api/device answers in turn (202 once they run out).
function world(
  on: On,
  {
    store,
    projectEnv = {},
    userEnv = {},
    flagEnv = {},
    polls = [],
    adStatus = 200,
    startStatus = 201,
    ad = AD,
    inlineAds = [],
    adBody,
    holdInline = false,
    failFirstImpression = false,
    bandAds = [],
    holdFirstBand = false,
    localCheckout = false,
    failingCommands = [],
    updateVersions = { updateOutcome: "updated", oldVersion: "0.2.6", newVersion: "0.2.7" },
    osEnv = {},
    unameOutput = "Darwin\n",
    surfaces = ["terminal"],
    latestVersion,
    deviceBody = { email: "ada@example.com" },
  }: WorldOptions = {},
) {
  const calls: Call[] = [];
  let releaseFirstBand = () => {};
  const firstBandGate = new Promise<void>((resolve) => (releaseFirstBand = resolve));
  let releaseInline = () => {};
  const inlineGate = new Promise<void>((resolve) => (releaseInline = resolve));
  let impressionCalls = 0;
  let bandCalls = 0;
  const toasts: string[] = [];
  const statuses: (string | undefined)[] = [];
  const opened: (readonly string[])[] = [];
  const answers: Record<number, string> = {
    200: JSON.stringify(deviceBody),
    202: "{}",
    403: "{}",
    404: "{}",
  };

  on("http.fetch", async (_$, e) => {
    const reply = (status: number, text = "") => ({
      value: { status, ok: status < 300, headers: {}, text },
    });
    if (e.url === LATEST_MANIFEST_URL) {
      return latestVersion ? reply(200, JSON.stringify({ version: latestVersion })) : reply(404);
    }
    const method = e.init?.method ?? "GET";
    calls.push({ url: e.url, method, body: e.init?.body, auth: e.init?.headers?.Authorization });
    if (e.url.endsWith("/api/device")) {
      if (method === "POST") {
        if (startStatus !== 201) return reply(startStatus, "{}");
        return reply(
          201,
          JSON.stringify({ userCode: "BCDF-GHJK", expiresAt: new Date(600000).toISOString() }),
        );
      }
      const status = polls.shift() ?? 202;
      return reply(status, answers[status]);
    }
    if (e.url === `${SITE}/api/ad`) {
      if (JSON.parse(e.init?.body ?? "{}").placement === "band") {
        const served = bandAds.shift();
        if (holdFirstBand && bandCalls++ === 0) await firstBandGate;
        return served ? reply(200, JSON.stringify(served)) : reply(204);
      }
      if (holdInline) await inlineGate;
      return reply(
        adStatus,
        adStatus === 200 ? (adBody ?? JSON.stringify(inlineAds.shift() ?? ad)) : "",
      );
    }
    if (e.url.includes("/api/impression/") && failFirstImpression && impressionCalls++ === 0) {
      throw new Error("network down");
    }
    return reply(204);
  });
  on("process.run", async (_$, e) => {
    opened.push(e.argv);
    return {
      value: {
        exitCode: failingCommands.includes(e.argv[0] ?? "") ? 1 : 0,
        stdout:
          e.argv[0] === "uname"
            ? unameOutput
            : e.argv[2]?.startsWith("ps -o comm=")
              ? "/Applications/Claude.app/claude\n"
              : e.argv.includes("--json")
                ? JSON.stringify(updateVersions)
                : `${PNG}\n`,
        stderr: "",
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    };
  });
  on("ui.toast", async (_$, e) => {
    toasts.push(e.text);
    return { value: undefined };
  });
  on("ui.status", async (_$, e) => {
    statuses.push(e.text);
    return { value: undefined };
  });
  on("fs.read", async (_$, e) => {
    if (!e.path.endsWith("/.claude-plugin/plugin.json")) throw new Error(`ENOENT: ${e.path}`);
    return { value: JSON.stringify({ version: PLUGIN_VERSION }) };
  });
  on("fs.exists", async (_$, e) => ({ value: localCheckout && e.path.endsWith("/.local") }));
  on("session.start", async (_$, e) => ({ cwd: e.cwd }));
  on("command.register", async (_$, e) => ({ value: { command: e.name } }));
  mock.store(on, store);
  on("session.version", async () => ({ value: { version: CLAUDE_VERSION } }));
  mock.env(on, { TERM_PROGRAM, CLAUDE_CODE_ENTRYPOINT: "cli", ...osEnv });
  on("settings.read", async (_$, e) => {
    const envs: Record<string, Record<string, string>> = {
      project: projectEnv,
      user: userEnv,
      flag: flagEnv,
    };
    const env = e.source && envs[e.source];
    return { value: env ? { env } : {} };
  });
  const clock = mock.clock(on);
  on("session.id", async () => ({ value: "session_abc" }));
  on("session.surfaces", async () => ({ value: surfaces }));
  on("prompt.submit", async (_$, e) => ({ text: e.text }));
  on("turn.start", async (_$, e) => ({ turnId: e.turnId }));
  on("turn.complete", async (_$, e) => ({ text: e.answer }));
  on("command.run", async () => ({ text: "" }));
  on("ui.render", ($, e) => {
    const { Text } = $.ui.resolve(e);
    return <Text>engine row</Text>;
  });
  return { calls, toasts, statuses, opened, clock, releaseFirstBand, releaseInline };
}

const KEY = "sq_connected_key";
const CONNECTED = { store: { deviceKey: KEY } };
const requestsFor = (calls: Call[], placement: string) =>
  calls.filter(
    (c) => c.url === `${SITE}/api/ad` && JSON.parse(c.body ?? "{}").placement === placement,
  );
const inlineRequests = (calls: Call[]) => requestsFor(calls, "inline");
const bandRequests = (calls: Call[]) => requestsFor(calls, "band");
const keyOf = (call?: Call) => call?.auth?.replace("Bearer ", "");

type Engine = Parameters<Parameters<typeof test>[2] & Function>[0];

async function connect($: Engine) {
  const { text } = await $.command.run({
    command: "sidequest-connect",
    args: "",
    origin: { kind: "composer" },
    presentation: { isFullscreen: false, columns: 120 },
  });
  return text ?? "";
}

async function sidequest($: Engine, args: string) {
  const { text } = await $.command.run({
    command: "sidequest",
    args,
    origin: { kind: "composer" },
    presentation: { isFullscreen: false, columns: 120 },
  });
  return text ?? "";
}

const message = (text: string) => ({
  plugin: "sidequest",
  component: "AssistantMessage" as const,
  props: { text, isFirstOfReply: false },
  requestId: "msg_1",
});

async function drawReply($: Engine, requestId = "msg_1") {
  const ui = await $.ui.mount({ ...message(ANSWER), requestId, surface: "terminal" });
  await ui.unmount();
}

test("requests no ad before the account is connected", async ($, on) => {
  const { calls, clock } = world(on);
  await connect($);
  await $.prompt.submit({ text: QUESTION, wait: false, origin: { kind: "composer" } });
  await $.turn.start({ text: QUESTION, turnId: "t1" });
  await drawReply($);
  await $.turn.complete(COMPLETE);
  await clock.settle();
  expect(inlineRequests(calls)).toHaveLength(0);
});

test("requests no ad when no surface can draw it", async ($, on) => {
  const { calls, clock } = world(on, { ...CONNECTED, surfaces: [] });
  await $.prompt.submit({ text: QUESTION, wait: false, origin: { kind: "composer" } });
  await $.turn.start({ text: QUESTION, turnId: "t1" });
  await drawReply($);
  await $.turn.complete(COMPLETE);
  await clock.settle();
  expect(inlineRequests(calls)).toHaveLength(0);
});

test("/sidequest-connect outside the US says it is US only", async ($, on) => {
  world(on, { startStatus: 403 });

  expect(await connect($)).toBe("only available in the US for now.");
});

const URL_WITH_CODE = `${SITE}/connect?code=BCDF-GHJK`;

test("/sidequest-connect shows the link and the code as text to copy, not as links", async ($, on) => {
  world(on);
  const text = await connect($);

  expect(text).toContain(`\`\`\`\n${URL_WITH_CODE}\n\`\`\``);
  expect(text).toContain("```\nBCDF-GHJK\n```");
});

test("keeps the code on the status line while the connection is pending", async ($, on) => {
  const { statuses } = world(on);
  await connect($);

  expect(statuses.at(-1)).toContain(URL_WITH_CODE);
});

const CONNECT_ROWS = [
  { os: "macos", options: { unameOutput: "Darwin\n" }, opener: ["open", URL_WITH_CODE] },
  { os: "linux", options: { unameOutput: "Linux\n" }, opener: ["xdg-open", URL_WITH_CODE] },
  {
    os: "windows",
    options: { osEnv: { OS: "Windows_NT" } },
    opener: ["rundll32", "url.dll,FileProtocolHandler", URL_WITH_CODE],
  },
];

for (const { os, options, opener } of CONNECT_ROWS) {
  test(`/sidequest-connect on ${os} reports the os and opens the link with ${opener[0]}`, async ($, on) => {
    const { calls, opened } = world(on, options);
    await connect($);

    const start = calls.find((c) => c.method === "POST");
    expect(JSON.parse(start?.body ?? "").os).toBe(os);
    expect(opened).toContainEqual(opener);
  });
}

test("/sidequest-connect sends the plugin version and client with the os", async ($, on) => {
  const { calls } = world(on);
  await connect($);

  const start = calls.find((c) => c.method === "POST");
  expect(JSON.parse(start?.body ?? "{}")).toMatchObject({
    pluginVersion: PLUGIN_VERSION,
    client: "terminal",
  });
});

test("/sidequest-connect tries every opener when the os is unknown", async ($, on) => {
  const { calls, opened } = world(on, {
    unameOutput: "FreeBSD\n",
    failingCommands: ["open", "xdg-open"],
  });
  await connect($);

  const start = calls.find((c) => c.method === "POST");
  expect(JSON.parse(start?.body ?? "{}").os).toBeUndefined();
  const openers = opened.filter((argv) => argv.at(-1)?.includes("/connect?code="));
  expect(openers.map((argv) => argv[0])).toEqual(["open", "xdg-open", "rundll32"]);
});

test("once the site confirms the code, the mod names the account and requests ads with that key", async ($, on) => {
  const { calls, toasts, clock } = world(on, { polls: [202, 200] });
  await connect($);
  await clock.advance(1000);
  expect(toasts).toEqual([]);
  await clock.advance(1000);
  await $.prompt.submit({ text: QUESTION, wait: false, origin: { kind: "composer" } });
  await $.turn.start({ text: QUESTION, turnId: "t1" });
  await drawReply($);
  await $.turn.complete(COMPLETE);
  await clock.settle();

  const created = calls.find((c) => c.method === "POST" && c.url === `${SITE}/api/device`);
  expect(toasts).toEqual(["Sidequest connected as ada@example.com."]);
  expect(keyOf(inlineRequests(calls)[0])).toBe(keyOf(created));
});

test("an expired code ends the poll without connecting", async ($, on) => {
  const { calls, toasts, clock } = world(on, { polls: [404] });
  await connect($);
  await clock.advance(1000);
  await $.prompt.submit({ text: QUESTION, wait: false, origin: { kind: "composer" } });
  await $.turn.start({ text: QUESTION, turnId: "t1" });
  await drawReply($);
  await $.turn.complete(COMPLETE);
  await clock.settle();

  expect(toasts).toEqual(["Sidequest: the code expired. Run /sidequest-connect again."]);
  expect(inlineRequests(calls)).toHaveLength(0);
});

test("a second /sidequest-connect replaces the first, so only its key is connected", async ($, on) => {
  const { calls, toasts, clock } = world(on, { polls: [200, 200] });
  await connect($);
  await connect($);
  await clock.advance(1000);
  await $.prompt.submit({ text: QUESTION, wait: false, origin: { kind: "composer" } });
  await $.turn.start({ text: QUESTION, turnId: "t1" });
  await drawReply($);
  await $.turn.complete(COMPLETE);
  await clock.settle();

  const created = calls.filter((c) => c.method === "POST" && c.url === `${SITE}/api/device`);
  expect(toasts).toHaveLength(1);
  expect(keyOf(inlineRequests(calls)[0])).toBe(keyOf(created[1]));
});

test("resumes a connection left pending by a restart", async ($, on) => {
  const { toasts, clock } = world(on, {
    store: { pending: { key: "sq_pending", expiresAt: 600000, userCode: "BCDF-GHJK" } },
    polls: [200],
  });
  await $.session.start({ cwd: "/tmp", surface: "terminal", isInteractive: true });
  await clock.advance(1000);
  expect(toasts).toEqual(["Sidequest connected as ada@example.com."]);
});

test("a poll whose code another session already confirmed clears its status line", async ($, on) => {
  const { statuses, toasts, clock } = world(on, {
    store: { pending: { key: "sq_pending", expiresAt: 600000, userCode: "BCDF-GHJK" } },
    polls: [200, 202],
  });
  await $.session.start({ cwd: "/tmp", surface: "terminal", isInteractive: true });
  await $.session.start({ cwd: "/tmp", surface: "terminal", isInteractive: true });
  await clock.advance(1000);

  expect(toasts).toHaveLength(1);
  expect(statuses.slice(-2)).toEqual([undefined, undefined]);
});

test("a session with no key reminds the user to run /sidequest-connect", async ($, on) => {
  const { calls, toasts, clock } = world(on);
  await $.session.start({ cwd: "/tmp", surface: "terminal", isInteractive: true });
  await clock.settle();

  expect(calls).toHaveLength(0);
  expect(toasts).toEqual(["sidequest: run /sidequest-connect to link your account"]);
});

test("/sidequest with no surface to draw ads says why no ads show", async ($, on) => {
  world(on, { ...CONNECTED, surfaces: [] });

  const text = await sidequest($, "");
  expect(text.split("\n")[0]).toBe(
    "Ads do not show in Claude Code on the web. To see ads and earn, run Claude Code on your computer: in the terminal, Claude Desktop, or VS Code.",
  );
});

const ACCOUNT_LINES: [number[], string][] = [
  [[200], "Account: connected"],
  [[202], "Account: waiting for you to finish connecting"],
  [[403], "Account: suspended"],
  [[404], "Account: not connected — run /sidequest-connect"],
  [[500], "Account: could not reach Sidequest"],
];

for (const [polls, line] of ACCOUNT_LINES) {
  test(`/sidequest shows "${line}" when the site answers ${polls[0]}`, async ($, on) => {
    world(on, { ...CONNECTED, polls });

    expect(await sidequest($, "")).toContain(line);
  });
}

test("/sidequest shows no account when there is no key", async ($, on) => {
  world(on);

  expect(await sidequest($, "")).toContain("Account: not connected — run /sidequest-connect");
});

test("/sidequest shows the balance and when the payout comes once it is payable", async ($, on) => {
  world(on, {
    ...CONNECTED,
    polls: [200],
    deviceBody: {
      email: "ada@example.com",
      payout: { balanceCents: 1240, thresholdCents: 1000, payable: true },
    },
  });

  expect(await sidequest($, "")).toContain(
    "Balance: $12.40. You get paid after the month ends, once Stripe is connected.\n",
  );
});

test("/sidequest shows the payout threshold while the balance is not payable", async ($, on) => {
  world(on, {
    ...CONNECTED,
    polls: [200],
    deviceBody: {
      email: "ada@example.com",
      payout: { balanceCents: 410, thresholdCents: 1000, payable: false },
    },
  });

  expect(await sidequest($, "")).toContain(
    "Balance: $4.10. You get paid when your balance is more than $10.00.",
  );
});

test("/sidequest shows no balance when the site sends no payout", async ($, on) => {
  world(on, { ...CONNECTED, polls: [200] });

  expect(await sidequest($, "")).not.toContain("Balance:");
});

test("/sidequest shows no balance when the payout is malformed", async ($, on) => {
  world(on, {
    ...CONNECTED,
    polls: [200],
    deviceBody: { email: "ada@example.com", payout: { balanceCents: "1240", payable: true } },
  });

  expect(await sidequest($, "")).not.toContain("Balance:");
});

test("/sidequest links to the earnings page once the device is connected", async ($, on) => {
  world(on, { ...CONNECTED, polls: [200] });

  expect(await sidequest($, "")).toContain(`See your earnings: ${SITE}/account`);
});

test("/sidequest does not link to the earnings page before the account is connected", async ($, on) => {
  world(on);

  expect(await sidequest($, "")).not.toContain("See your earnings");
});

test("a newer version on GitHub is announced at session start", async ($, on) => {
  const { toasts, clock } = world(on, { ...CONNECTED, latestVersion: "1.10.0" });
  await $.session.start({ cwd: "/tmp", surface: "terminal", isInteractive: true });
  await clock.settle();

  expect(toasts).toEqual(["Sidequest 1.10.0 is ready. Run /sidequest update."]);
});

test("/sidequest names a newer version", async ($, on) => {
  world(on, { ...CONNECTED, latestVersion: "1.10.0" });

  expect(await sidequest($, "")).toContain("Sidequest 1.10.0 is ready. Run /sidequest update.");
});

test("a local checkout is not told to update", async ($, on) => {
  const { toasts, clock } = world(on, {
    ...CONNECTED,
    latestVersion: "1.10.0",
    localCheckout: true,
  });
  await $.session.start({ cwd: "/tmp", surface: "terminal", isInteractive: true });
  await clock.settle();

  expect(toasts).toEqual([]);
});

test("/sidequest update runs the Claude Code it is running in, with no CLI needed", async ($, on) => {
  const { opened } = world(on, CONNECTED);
  await sidequest($, "update");

  expect(opened.filter((argv) => argv[0] === "/Applications/Claude.app/claude")).toEqual([
    ["/Applications/Claude.app/claude", "plugin", "marketplace", "update", "sidequest"],
    ["/Applications/Claude.app/claude", "plugin", "update", "sidequest@sidequest", "--json"],
  ]);
});

test("/sidequest update names the old and new versions", async ($, on) => {
  world(on, CONNECTED);

  expect(await sidequest($, "update")).toBe(
    "Sidequest updated from 0.2.6 to 0.2.7. Run /reload-plugins to start using it.",
  );
});

test("/sidequest update without an old version names only the new one", async ($, on) => {
  world(on, {
    ...CONNECTED,
    updateVersions: { updateOutcome: "updated", newVersion: "0.2.7" },
  });

  expect(await sidequest($, "update")).toBe(
    "Sidequest updated to 0.2.7. Run /reload-plugins to start using it.",
  );
});

test("/sidequest update on the latest version says so", async ($, on) => {
  world(on, {
    ...CONNECTED,
    updateVersions: { updateOutcome: "up_to_date", oldVersion: "0.2.7", newVersion: "0.2.7" },
  });

  expect(await sidequest($, "update")).toBe("Sidequest is already on the latest version (0.2.7).");
});

test("/sidequest update that fails shows the command to run in a terminal", async ($, on) => {
  world(on, { ...CONNECTED, failingCommands: ["/Applications/Claude.app/claude"] });

  expect(await sidequest($, "update")).toBe(
    "Sidequest could not update. Check your internet connection and run /sidequest update again. If it still fails, run /plugin and update Sidequest there.",
  );
});

test("ignores a SIDEQUEST_URL set only in project settings", async ($, on) => {
  const { calls } = world(on, { projectEnv: { SIDEQUEST_URL: "http://localhost:3001" } });
  await connect($);
  expect(calls[0]?.url.startsWith(SITE)).toBe(true);
});

test("uses a loopback SIDEQUEST_URL from user settings", async ($, on) => {
  const { calls } = world(on, { userEnv: { SIDEQUEST_URL: "http://localhost:3001" } });
  await connect($);
  expect(calls[0]?.url.startsWith("http://localhost:3001")).toBe(true);
});

test("uses a loopback SIDEQUEST_URL from the --settings flag over user settings", async ($, on) => {
  const { calls } = world(on, {
    userEnv: { SIDEQUEST_URL: "http://localhost:3001" },
    flagEnv: { SIDEQUEST_URL: "http://127.0.0.1:3002" },
  });
  await connect($);
  expect(calls[0]?.url.startsWith("http://127.0.0.1:3002")).toBe(true);
});

test("ignores a non-loopback SIDEQUEST_URL from user settings", async ($, on) => {
  const { calls } = world(on, { userEnv: { SIDEQUEST_URL: "http://localhost.evil.example" } });
  await connect($);
  expect(calls[0]?.url.startsWith(SITE)).toBe(true);
});

test("shows the suspended status when the site refuses a banned account", async ($, on) => {
  const { statuses, clock } = world(on, { ...CONNECTED, adStatus: 403 });
  await $.prompt.submit({ text: QUESTION, wait: false, origin: { kind: "composer" } });
  await $.turn.start({ text: QUESTION, turnId: "t1" });
  await drawReply($);
  await $.turn.complete(COMPLETE);
  await clock.settle();
  expect(statuses).toContain("account suspended");
});

test("shows a plain status when the site cannot serve ads", async ($, on) => {
  const { statuses, clock } = world(on, { ...CONNECTED, adStatus: 502 });
  await $.prompt.submit({ text: QUESTION, wait: false, origin: { kind: "composer" } });
  await $.turn.start({ text: QUESTION, turnId: "t1" });
  await drawReply($);
  await $.turn.complete(COMPLETE);
  await clock.settle();
  expect(statuses).toContain("ads unavailable — trying again next prompt");
});

test("clears the status line when an ad is served", async ($, on) => {
  const { statuses, clock } = world(on, { ...CONNECTED, adStatus: 200 });
  await $.prompt.submit({ text: QUESTION, wait: false, origin: { kind: "composer" } });
  await $.turn.start({ text: QUESTION, turnId: "t1" });
  await drawReply($);
  await $.turn.complete(COMPLETE);
  await clock.settle();
  expect(statuses).toContain(undefined);
});

test("sends the question, answer and session id with the device key", async ($, on) => {
  const { calls, clock } = world(on, CONNECTED);
  await $.prompt.submit({ text: QUESTION, wait: false, origin: { kind: "composer" } });
  await $.turn.start({ text: QUESTION, turnId: "t1" });
  await drawReply($);
  await $.turn.complete(COMPLETE);
  await clock.settle();

  const request = inlineRequests(calls)[0];
  expect(keyOf(request)).toBe(KEY);
  expect(JSON.parse(request?.body ?? "{}")).toEqual({
    placement: "inline",
    client: "terminal",
    pluginVersion: PLUGIN_VERSION,
    claudeVersion: CLAUDE_VERSION,
    terminalProgram: TERM_PROGRAM,
    question: QUESTION,
    answer: ANSWER,
    conversationId: "session_abc",
  });
});

test("marks the plugin version as local when it runs from a local checkout", async ($, on) => {
  const { calls, clock } = world(on, { ...CONNECTED, localCheckout: true });
  await $.prompt.submit({ text: QUESTION, wait: false, origin: { kind: "composer" } });
  await $.turn.start({ text: QUESTION, turnId: "t1" });
  await drawReply($);
  await $.turn.complete(COMPLETE);
  await clock.settle();

  expect(JSON.parse(inlineRequests(calls)[0]?.body ?? "{}").pluginVersion).toBe(
    `${PLUGIN_VERSION}+local`,
  );
});

test("tells the site the ad request comes from Claude Desktop", async ($, on) => {
  const { calls, clock } = world(on, {
    ...CONNECTED,
    osEnv: { CLAUDE_CODE_ENTRYPOINT: "claude-desktop" },
  });
  await $.prompt.submit({ text: QUESTION, wait: false, origin: { kind: "composer" } });
  await $.turn.start({ text: QUESTION, turnId: "t1" });
  await drawReply($);
  await $.turn.complete(COMPLETE);
  await clock.settle();

  expect(JSON.parse(inlineRequests(calls)[0]?.body ?? "{}").client).toBe("desktop");
});

test("an IDE extension request sends its entrypoint as the client and no terminal program", async ($, on) => {
  const { calls, clock } = world(on, {
    ...CONNECTED,
    osEnv: { CLAUDE_CODE_ENTRYPOINT: "claude-vscode" },
  });
  await $.prompt.submit({ text: QUESTION, wait: false, origin: { kind: "composer" } });
  await $.turn.start({ text: QUESTION, turnId: "t1" });
  await drawReply($);
  await $.turn.complete(COMPLETE);
  await clock.settle();

  const body = JSON.parse(inlineRequests(calls)[0]?.body ?? "{}");
  expect([body.client, body.terminalProgram]).toEqual(["claude-vscode", undefined]);
});

test("a terminal opened from another terminal sends its own app, not the inherited TERM_PROGRAM", async ($, on) => {
  const { calls, clock } = world(on, {
    ...CONNECTED,
    osEnv: { __CFBundleIdentifier: "net.kovidgoyal.kitty" },
  });
  await $.prompt.submit({ text: QUESTION, wait: false, origin: { kind: "composer" } });
  await $.turn.start({ text: QUESTION, turnId: "t1" });
  await drawReply($);
  await $.turn.complete(COMPLETE);
  await clock.settle();

  expect(JSON.parse(inlineRequests(calls)[0]?.body ?? "{}").terminalProgram).toBe(
    "net.kovidgoyal.kitty",
  );
});

test("a Claude Desktop viewport does not set fullscreen", async ($, on) => {
  const { calls, clock } = world(on, {
    ...CONNECTED,
    osEnv: { CLAUDE_CODE_ENTRYPOINT: "claude-desktop" },
  });
  const viewport = { columns: 120, rows: 40, isFullscreen: true };
  const ui = await $.ui.mount({
    ...message(ANSWER),
    requestId: "msg_0",
    surface: "desktop",
    viewport,
  });
  await ui.unmount();
  await $.prompt.submit({ text: QUESTION, wait: false, origin: { kind: "composer" } });
  await $.turn.start({ text: QUESTION, turnId: "t1" });
  await drawReply($);
  await $.turn.complete(COMPLETE);
  await clock.settle();

  const body = JSON.parse(inlineRequests(calls)[0]?.body ?? "{}");
  expect(body.fullscreen).toBeUndefined();
});

test("sends whether the terminal renders fullscreen, as the viewport says", async ($, on) => {
  const { calls, clock } = world(on, CONNECTED);
  const viewport = { columns: 120, rows: 40, isFullscreen: true };
  const ui = await $.ui.mount({
    ...message(ANSWER),
    requestId: "msg_0",
    surface: "terminal",
    viewport,
  });
  await ui.unmount();
  await $.prompt.submit({ text: QUESTION, wait: false, origin: { kind: "composer" } });
  await $.turn.start({ text: QUESTION, turnId: "t1" });
  await drawReply($);
  await $.turn.complete(COMPLETE);
  await clock.settle();

  expect(JSON.parse(inlineRequests(calls)[0]?.body ?? "{}").fullscreen).toBe(true);
});

for (const surface of ["terminal", "desktop"] as const) {
  test(`shows a labeled ad under the last message of the answer (${surface})`, async ($, on) => {
    const { clock } = world(on, CONNECTED);
    await $.prompt.submit({ text: QUESTION, wait: false, origin: { kind: "composer" } });
    await $.turn.start({ text: QUESTION, turnId: "t1" });
    await drawReply($);
    await $.turn.complete(COMPLETE);
    await clock.settle();

    const ui = await $.ui.mount({ ...message("Prioritize fit and cushioning."), surface });
    expect(await ui.find({ text: /Example Brand/ })).toBeDefined();
    expect(await ui.find({ text: /Sponsored/ })).toBeDefined();
    expect(await ui.find({ type: surface === "terminal" ? "Image" : "Svg" })).toBeDefined();
    if (surface === "desktop") {
      const svg = await ui.find({ type: "Svg" });
      expect(svg?.props.source).toContain(`data:image/png;base64,${PNG}`);
      expect(svg?.props.alt).toBe("Example Brand logo");
    }
    expect(await ui.find({ type: "Link", text: /Explore/ })).toBeDefined();
    await ui.unmount();
  });
}

test("shows the ad under a Claude Desktop message id that is not the transcript uuid", async ($, on) => {
  const { clock } = world(on, {
    ...CONNECTED,
    surfaces: ["desktop"],
    osEnv: { CLAUDE_CODE_ENTRYPOINT: "claude-desktop" },
  });
  const requestId = "msg_abc-t0";
  await $.prompt.submit({ text: QUESTION, wait: false, origin: { kind: "composer" } });
  await $.turn.start({ text: QUESTION, turnId: "t1" });
  const thinking = await $.ui.mount({ ...message("Thinking"), requestId, surface: "desktop" });
  await thinking.unmount();
  const text = await $.ui.mount({ ...message(ANSWER), requestId, surface: "desktop" });
  await text.unmount();
  await $.turn.complete(COMPLETE);
  await clock.settle();

  const ui = await $.ui.mount({ ...message(ANSWER), requestId, surface: "desktop" });
  expect(await ui.find({ text: /Example Brand/ })).toBeDefined();
  await ui.unmount();
});

test("clicking the call to action in the fullscreen terminal opens the ad link", async ($, on) => {
  const { clock, opened } = world(on, CONNECTED);
  await $.prompt.submit({ text: QUESTION, wait: false, origin: { kind: "composer" } });
  await $.turn.start({ text: QUESTION, turnId: "t1" });
  await drawReply($);
  await $.turn.complete(COMPLETE);
  await clock.settle();

  const ui = await $.ui.mount({
    ...message("Prioritize fit and cushioning."),
    surface: "terminal",
    viewport: { columns: 120, rows: 40, isFullscreen: true },
  });
  await ui.press({ key: "cta" });
  await clock.settle();

  expect(opened).toContainEqual(["open", AD.adLink]);
  await ui.unmount();
});

test("pressing the button in the IDE panel opens the ad link", async ($, on) => {
  const { clock, opened } = world(on, CONNECTED);
  await $.prompt.submit({ text: QUESTION, wait: false, origin: { kind: "composer" } });
  await $.turn.start({ text: QUESTION, turnId: "t1" });
  await drawReply($);
  await $.turn.complete(COMPLETE);
  await clock.settle();

  const ui = await $.ui.mount({ ...message("Prioritize fit and cushioning."), surface: "vscode" });
  await ui.press({ key: "cta" });
  await clock.settle();

  expect(opened).toContainEqual(["open", AD.adLink]);
  await ui.unmount();
});

test("draws the engine's own reply above the ad", async ($, on) => {
  const { clock } = world(on, CONNECTED);
  await $.prompt.submit({ text: QUESTION, wait: false, origin: { kind: "composer" } });
  await $.turn.start({ text: QUESTION, turnId: "t1" });
  await drawReply($);
  await $.turn.complete(COMPLETE);
  await clock.settle();

  const ui = await $.ui.mount({ ...message("Prioritize fit and cushioning."), surface: "desktop" });
  expect(await ui.find({ text: /engine row/ })).toBeDefined();
  await ui.unmount();
});

test("reports an impression once even when the ad renders twice", async ($, on) => {
  const { calls, clock } = world(on, CONNECTED);
  await $.prompt.submit({ text: QUESTION, wait: false, origin: { kind: "composer" } });
  await $.turn.start({ text: QUESTION, turnId: "t1" });
  await drawReply($);
  await $.turn.complete(COMPLETE);
  await clock.settle();

  const first = await $.ui.mount({
    ...message("Prioritize fit and cushioning."),
    surface: "terminal",
  });
  await clock.settle();
  await first.unmount();
  const second = await $.ui.mount({
    ...message("Prioritize fit and cushioning."),
    surface: "terminal",
  });
  await clock.settle();
  await second.unmount();

  const impressions = calls.filter((c) => c.url === IMPRESSION_URL);
  expect(impressions).toHaveLength(1);
  expect(impressions[0]?.auth).toBe(`Bearer ${KEY}`);
});

test("renders no ad and reports no impression for an ad without a valid impressionId", async ($, on) => {
  const { calls, clock } = world(on, { ...CONNECTED, ad: { ...AD, impressionId: "../../evil" } });
  await $.prompt.submit({ text: QUESTION, wait: false, origin: { kind: "composer" } });
  await $.turn.start({ text: QUESTION, turnId: "t1" });
  await drawReply($);
  await $.turn.complete(COMPLETE);
  await clock.settle();

  const ui = await $.ui.mount({
    ...message("Prioritize fit and cushioning."),
    surface: "terminal",
  });
  expect(await ui.find({ text: /Sponsored/ })).toBeUndefined();

  await clock.settle();
  expect(calls.filter((c) => c.url.includes("/api/impression/"))).toHaveLength(0);
});

test("draws the ad under the newest message of the answer only", async ($, on) => {
  const { clock } = world(on, CONNECTED);
  await $.prompt.submit({ text: QUESTION, wait: false, origin: { kind: "composer" } });
  await $.turn.start({ text: QUESTION, turnId: "t1" });
  await drawReply($, "msg_0");
  await drawReply($, "msg_1");
  await $.turn.complete(COMPLETE);
  await clock.settle();

  const earlier = await $.ui.mount({
    ...message("Look at fit first."),
    requestId: "msg_0",
    surface: "terminal",
  });
  const newest = await $.ui.mount({ ...message(ANSWER), requestId: "msg_1", surface: "terminal" });
  expect(await earlier.find({ text: /Sponsored/ })).toBeUndefined();
  expect(await newest.find({ text: /Sponsored/ })).toBeDefined();
});

test("/sidequest off hides the ad that is showing", async ($, on) => {
  const { clock } = world(on, CONNECTED);
  await $.prompt.submit({ text: QUESTION, wait: false, origin: { kind: "composer" } });
  await $.turn.start({ text: QUESTION, turnId: "t1" });
  await drawReply($);
  await $.turn.complete(COMPLETE);
  await clock.settle();
  await sidequest($, "off");

  const ui = await $.ui.mount({ ...message(ANSWER), surface: "terminal" });
  expect(await ui.find({ text: /Sponsored/ })).toBeUndefined();
  await ui.unmount();
});

test("requests nothing when the question is blank", async ($, on) => {
  const { calls, clock } = world(on, CONNECTED);
  await $.prompt.submit({ text: "  ", wait: false, origin: { kind: "composer" } });
  await $.turn.start({ text: "  ", turnId: "t1" });
  await drawReply($);
  await $.turn.complete(COMPLETE);
  await clock.settle();
  expect(inlineRequests(calls)).toHaveLength(0);
});

for (const reason of ["aborted", "error"] as const) {
  test(`a turn that ends ${reason} sends no ad request`, async ($, on) => {
    const { calls, clock } = world(on, CONNECTED);
    await $.prompt.submit({ text: QUESTION, wait: false, origin: { kind: "composer" } });
    await $.turn.start({ text: QUESTION, turnId: "t1" });
    await drawReply($);
    await $.turn.complete({ ...COMPLETE, reason });
    await clock.settle();

    expect(inlineRequests(calls)).toHaveLength(0);
  });
}

test("the ad request carries the question of its own turn when a prompt starts the next turn first", async ($, on) => {
  const { calls, clock } = world(on, CONNECTED);
  await $.prompt.submit({ text: QUESTION, wait: false, origin: { kind: "composer" } });
  await $.turn.start({ text: QUESTION, turnId: "t1" });
  await $.prompt.submit({ text: "A second question", wait: false, origin: { kind: "composer" } });
  await $.turn.start({ text: "A second question", turnId: "t2" });
  await drawReply($);
  await $.turn.complete(COMPLETE);
  await clock.settle();

  expect(JSON.parse(inlineRequests(calls)[0]?.body ?? "{}").question).toBe(QUESTION);
});

test("a bad ad response leaves no ad and no unhandled error", async ($, on) => {
  const { clock } = world(on, { ...CONNECTED, adBody: "<html>not json</html>" });
  await $.prompt.submit({ text: QUESTION, wait: false, origin: { kind: "composer" } });
  await $.turn.start({ text: QUESTION, turnId: "t1" });
  await drawReply($);
  await $.turn.complete(COMPLETE);
  await clock.settle();

  const ui = await $.ui.mount({ ...message(ANSWER), surface: "desktop" });
  expect(await ui.find({ text: /Sponsored/ })).toBeUndefined();
  await ui.unmount();
});

test("an ad request that is still open does not hold up the end of the turn", async ($, on) => {
  const { releaseInline } = world(on, { ...CONNECTED, holdInline: true });
  await $.prompt.submit({ text: QUESTION, wait: false, origin: { kind: "composer" } });
  await $.turn.start({ text: QUESTION, turnId: "t1" });
  await drawReply($);

  await expect($.turn.complete(COMPLETE)).resolves.toBeDefined();
  releaseInline();
});

test("two answers with the same text each show their own ad", async ($, on) => {
  const { clock } = world(on, { ...CONNECTED, inlineAds: [AD, SECOND_AD] });
  await $.prompt.submit({ text: QUESTION, wait: false, origin: { kind: "composer" } });
  await $.turn.start({ text: QUESTION, turnId: "t1" });
  await drawReply($);
  await $.turn.complete(COMPLETE);
  await clock.settle();
  await $.prompt.submit({ text: QUESTION, wait: false, origin: { kind: "composer" } });
  await $.turn.start({ text: QUESTION, turnId: "t2" });
  await drawReply($, "msg_2");
  await $.turn.complete({ ...COMPLETE, turnId: "t2" });
  await clock.settle();

  const ui = await $.ui.mount({ ...message(ANSWER), requestId: "msg_2", surface: "desktop" });
  expect(await ui.find({ text: /Second Brand/ })).toBeDefined();
  await ui.unmount();
});

const band = (isWorking: boolean, hasSurvey = false, bodyColumns = 80) => ({
  plugin: "sidequest",
  component: "AbovePrompt" as const,
  props: {
    hasSurvey,
    isWorking,
    maxRows: 10,
    bodyColumns,
    scroll: { offset: 0, bodyRows: 9 },
    view: {},
  },
});

// Band ad tests run only while band ads are on; the tests after them cover the off state.
const bandTest: typeof test = BAND_ADS ? test : () => {};
const bandOffTest: typeof test = BAND_ADS ? () => {} : test;

test("a network error on the impression request is retried", async ($, on) => {
  const { calls, clock } = world(on, { ...CONNECTED, failFirstImpression: true });
  await $.prompt.submit({ text: QUESTION, wait: false, origin: { kind: "composer" } });
  await $.turn.start({ text: QUESTION, turnId: "t1" });
  await drawReply($);
  await $.turn.complete(COMPLETE);
  await clock.settle();
  const ui = await $.ui.mount({ ...message(ANSWER), surface: "desktop" });
  await clock.advance(1000);
  await ui.unmount();

  expect(calls.filter((c) => c.url === IMPRESSION_URL)).toHaveLength(2);
});

bandTest("the band labels the ad with a dim Ad and not the word Sponsored", async ($, on) => {
  const { clock } = world(on, { ...CONNECTED, bandAds: [BAND_AD] });
  await $.prompt.submit({ text: QUESTION, wait: false, origin: { kind: "composer" } });
  await $.turn.start({ text: QUESTION, turnId: "t1" });
  await clock.settle();

  const ui = await $.ui.mount({ ...band(true), surface: "terminal" });
  expect(await ui.find({ type: "Text", text: /^Ad$/ })).toMatchObject({
    props: { dimColor: true },
  });
  expect(await ui.find({ text: /Sponsored/ })).toBeUndefined();
  await ui.unmount();
});

bandTest("the band shows the brand and the ad text as links", async ($, on) => {
  const { clock } = world(on, { ...CONNECTED, bandAds: [BAND_AD] });
  await $.prompt.submit({ text: QUESTION, wait: false, origin: { kind: "composer" } });
  await $.turn.start({ text: QUESTION, turnId: "t1" });
  await clock.settle();

  const ui = await $.ui.mount({ ...band(true), surface: "terminal" });
  expect(await ui.find({ type: "Link", text: /Band Brand/ })).toBeDefined();
  expect(await ui.find({ type: "Link", text: /Run farther for less\./ })).toBeDefined();
  await ui.unmount();
});

bandTest("pressing the band button opens the ad link in the browser", async ($, on) => {
  const { clock, opened } = world(on, { ...CONNECTED, bandAds: [BAND_AD] });
  await $.prompt.submit({ text: QUESTION, wait: false, origin: { kind: "composer" } });
  await $.turn.start({ text: QUESTION, turnId: "t1" });
  await clock.settle();

  const ui = await $.ui.mount({ ...band(true), surface: "terminal" });
  await ui.press({ key: "open" });
  await clock.settle();

  expect(opened).toContainEqual(["open", BAND_AD.adLink]);
  await ui.unmount();
});

bandTest(
  "the band has one button, labeled with the call to action and bound to the o key",
  async ($, on) => {
    const { clock } = world(on, { ...CONNECTED, bandAds: [BAND_AD] });
    await $.prompt.submit({ text: QUESTION, wait: false, origin: { kind: "composer" } });
    await $.turn.start({ text: QUESTION, turnId: "t1" });
    await clock.settle();

    const ui = await $.ui.mount({ ...band(true), surface: "terminal" });
    const buttons = await ui.findAll({ type: "Button" });
    expect(buttons.map((b) => [b.text, b.props.hotkey])).toEqual([["Explore", "o"]]);
    await ui.unmount();
  },
);

for (const surface of ["terminal", "desktop"] as const) {
  bandTest(`the band shows the advertiser icon (${surface})`, async ($, on) => {
    const { clock } = world(on, { ...CONNECTED, bandAds: [BAND_AD] });
    await $.prompt.submit({ text: QUESTION, wait: false, origin: { kind: "composer" } });
    await $.turn.start({ text: QUESTION, turnId: "t1" });
    await clock.settle();

    const ui = await $.ui.mount({ ...band(true), surface });
    expect(await ui.find({ type: surface === "terminal" ? "Image" : "Svg" })).toBeDefined();
    await ui.unmount();
  });
}

bandTest("a turn sends one band request and never rotates", async ($, on) => {
  const { calls, clock } = world(on, { ...CONNECTED, bandAds: [BAND_AD, NEXT_BAND_AD] });
  await $.prompt.submit({ text: QUESTION, wait: false, origin: { kind: "composer" } });
  await $.turn.start({ text: QUESTION, turnId: "t1" });
  await clock.advance(120_000);
  await clock.settle();

  expect(bandRequests(calls)).toHaveLength(1);
});

bandTest("a band ad that arrives after the next turn started is not shown", async ($, on) => {
  const { clock, releaseFirstBand } = world(on, {
    ...CONNECTED,
    bandAds: [BAND_AD, NEXT_BAND_AD],
    holdFirstBand: true,
  });
  await $.prompt.submit({ text: QUESTION, wait: false, origin: { kind: "composer" } });
  await $.turn.start({ text: QUESTION, turnId: "t1" });
  await $.prompt.submit({ text: QUESTION, wait: false, origin: { kind: "composer" } });
  await $.turn.start({ text: QUESTION, turnId: "t2" });
  await clock.settle();
  releaseFirstBand();
  await clock.settle();

  const ui = await $.ui.mount({ ...band(true), surface: "terminal" });
  expect(await ui.find({ text: /Next Brand/ })).toBeDefined();
  await ui.unmount();
});

bandTest("a band ad that arrives after /sidequest band off is not shown", async ($, on) => {
  const { clock, releaseFirstBand } = world(on, {
    ...CONNECTED,
    bandAds: [BAND_AD],
    holdFirstBand: true,
  });
  await $.prompt.submit({ text: QUESTION, wait: false, origin: { kind: "composer" } });
  await $.turn.start({ text: QUESTION, turnId: "t1" });
  await sidequest($, "band off");
  releaseFirstBand();
  await clock.settle();
  await sidequest($, "band on");

  const ui = await $.ui.mount({ ...band(true), surface: "terminal" });
  expect(await ui.find({ text: /Band Brand/ })).toBeUndefined();
  await ui.unmount();
});

bandTest("the band ad stays after the turn completes", async ($, on) => {
  const { clock } = world(on, { ...CONNECTED, bandAds: [BAND_AD] });
  await $.prompt.submit({ text: QUESTION, wait: false, origin: { kind: "composer" } });
  await $.turn.start({ text: QUESTION, turnId: "t1" });
  await drawReply($);
  await $.turn.complete(COMPLETE);
  await clock.settle();

  const ui = await $.ui.mount({ ...band(false), surface: "terminal" });
  expect(await ui.find({ text: /Band Brand/ })).toBeDefined();
  await ui.unmount();
});

bandTest("a new turn's ad replaces the previous band ad", async ($, on) => {
  const { clock } = world(on, { ...CONNECTED, bandAds: [BAND_AD, NEXT_BAND_AD] });
  await $.prompt.submit({ text: QUESTION, wait: false, origin: { kind: "composer" } });
  await $.turn.start({ text: QUESTION, turnId: "t1" });
  await clock.settle();
  await $.prompt.submit({ text: QUESTION, wait: false, origin: { kind: "composer" } });
  await $.turn.start({ text: QUESTION, turnId: "t2" });
  await clock.settle();

  const ui = await $.ui.mount({ ...band(false), surface: "terminal" });
  expect(await ui.find({ text: /Next Brand/ })).toBeDefined();
  await ui.unmount();
});

bandTest("a turn without a fill keeps the previous band ad", async ($, on) => {
  const { clock } = world(on, { ...CONNECTED, bandAds: [BAND_AD] });
  await $.prompt.submit({ text: QUESTION, wait: false, origin: { kind: "composer" } });
  await $.turn.start({ text: QUESTION, turnId: "t1" });
  await clock.settle();
  await $.prompt.submit({ text: QUESTION, wait: false, origin: { kind: "composer" } });
  await $.turn.start({ text: QUESTION, turnId: "t2" });
  await clock.settle();

  const ui = await $.ui.mount({ ...band(false), surface: "terminal" });
  expect(await ui.find({ text: /Band Brand/ })).toBeDefined();
  await ui.unmount();
});

bandTest("the band draws nothing while a survey holds the band", async ($, on) => {
  const { clock } = world(on, { ...CONNECTED, bandAds: [BAND_AD] });
  await $.prompt.submit({ text: QUESTION, wait: false, origin: { kind: "composer" } });
  await $.turn.start({ text: QUESTION, turnId: "t1" });
  await clock.settle();

  const ui = await $.ui.mount({ ...band(true, true), surface: "terminal" });
  expect(await ui.find({ text: /Band Brand/ })).toBeUndefined();
  await ui.unmount();
});

const BAND_IMPRESSION_URL = `${SITE}/api/impression/${BAND_AD.impressionId}`;

for (const surface of ["terminal", "desktop"] as const) {
  bandTest(`reports the band impression when the band is drawn (${surface})`, async ($, on) => {
    const { calls, clock } = world(on, { ...CONNECTED, bandAds: [BAND_AD] });
    await $.prompt.submit({ text: QUESTION, wait: false, origin: { kind: "composer" } });
    await $.turn.start({ text: QUESTION, turnId: "t1" });
    await clock.settle();

    const ui = await $.ui.mount({ ...band(true), surface });
    await clock.settle();

    expect(calls.filter((c) => c.url === BAND_IMPRESSION_URL)).toHaveLength(1);
    await ui.unmount();
  });
}

bandTest("reports no band impression when the band renders but is not drawn", async ($, on) => {
  const { calls, clock } = world(on, { ...CONNECTED, bandAds: [BAND_AD] });
  await $.prompt.submit({ text: QUESTION, wait: false, origin: { kind: "composer" } });
  await $.turn.start({ text: QUESTION, turnId: "t1" });
  await clock.settle();
  await $.ui.render({ ...band(true), surface: "terminal", requestId: "r1" });
  await clock.settle();

  expect(calls.filter((c) => c.url === BAND_IMPRESSION_URL)).toHaveLength(0);
});

bandTest("reports one band impression when the band is drawn again", async ($, on) => {
  const { calls, clock } = world(on, { ...CONNECTED, bandAds: [BAND_AD] });
  await $.prompt.submit({ text: QUESTION, wait: false, origin: { kind: "composer" } });
  await $.turn.start({ text: QUESTION, turnId: "t1" });
  await clock.settle();

  const first = await $.ui.mount({ ...band(true), surface: "terminal" });
  await clock.settle();
  await first.unmount();
  const second = await $.ui.mount({ ...band(true), surface: "terminal" });
  await clock.settle();
  await second.unmount();

  expect(calls.filter((c) => c.url === BAND_IMPRESSION_URL)).toHaveLength(1);
});

bandTest("a turn started by an agent sends no band request", async ($, on) => {
  const { calls, clock } = world(on, { ...CONNECTED, bandAds: [BAND_AD] });
  await $.prompt.submit({ text: QUESTION, wait: false, origin: { kind: "composer" } });
  await $.turn.start({ text: QUESTION, turnId: "t1", agentId: "a1" });
  await clock.settle();

  expect(bandRequests(calls)).toHaveLength(0);
});

test("a turn a subagent runs sends no ad request", async ($, on) => {
  const { calls, clock } = world(on, CONNECTED);
  await $.prompt.submit({ text: QUESTION, wait: false, origin: { kind: "composer" } });
  await $.turn.start({ text: QUESTION, turnId: "t2", agentId: "a1" });
  await drawReply($);
  await $.turn.complete({ ...COMPLETE, turnId: "t2", agentId: "a1" });
  await clock.settle();

  expect(inlineRequests(calls)).toHaveLength(0);
});

const NOTIFICATION = "<task-notification><task-id>b1</task-id></task-notification>";

test("a turn a background task starts sends no ad request", async ($, on) => {
  const { calls, clock } = world(on, { ...CONNECTED, bandAds: [BAND_AD] });
  await $.prompt.submit({ text: NOTIFICATION, wait: false, origin: { kind: "task-notification" } });
  await $.turn.start({ text: NOTIFICATION, turnId: "t1" });
  await drawReply($);
  await $.turn.complete(COMPLETE);
  await clock.settle();

  expect(calls.filter((c) => c.url === `${SITE}/api/ad`)).toHaveLength(0);
});

test("after a background task's turn, the next typed prompt gets an inline ad for its own question", async ($, on) => {
  const { calls, clock } = world(on, { ...CONNECTED, bandAds: [BAND_AD] });
  await $.prompt.submit({ text: NOTIFICATION, wait: false, origin: { kind: "task-notification" } });
  await $.turn.start({ text: NOTIFICATION, turnId: "t1" });
  await drawReply($);
  await $.turn.complete(COMPLETE);
  await $.prompt.submit({ text: QUESTION, wait: false, origin: { kind: "composer" } });
  await $.turn.start({ text: QUESTION, turnId: "t2" });
  await drawReply($, "msg_2");
  await $.turn.complete({ ...COMPLETE, turnId: "t2" });
  await clock.settle();

  expect(JSON.parse(inlineRequests(calls)[0]?.body ?? "{}").question).toBe(QUESTION);
});

test("a claude -p run sends no ad request", async ($, on) => {
  const { calls, clock } = world(on, { ...CONNECTED, bandAds: [BAND_AD] });
  await $.prompt.submit({ text: QUESTION, wait: false, origin: { kind: "sdk" } });
  await $.turn.start({ text: QUESTION, turnId: "t1" });
  await drawReply($);
  await $.turn.complete(COMPLETE);
  await clock.settle();

  expect(calls.filter((c) => c.url === `${SITE}/api/ad`)).toHaveLength(0);
});

// A `!` command raises no prompt.submit; its turn starts with the shell output.
test("a ! shell command's turn sends no ad request", async ($, on) => {
  const { calls, clock } = world(on, CONNECTED);
  await $.turn.start({
    text: "<bash-stdout>hi</bash-stdout><bash-stderr></bash-stderr>",
    turnId: "t1",
  });
  await drawReply($);
  await $.turn.complete(COMPLETE);
  await clock.settle();

  expect(inlineRequests(calls)).toHaveLength(0);
});

test("a ! shell command's turn after a typed turn sends no ad request of its own", async ($, on) => {
  const { calls, clock } = world(on, CONNECTED);
  await $.prompt.submit({ text: QUESTION, wait: false, origin: { kind: "composer" } });
  await $.turn.start({ text: QUESTION, turnId: "t1" });
  await drawReply($);
  await $.turn.complete(COMPLETE);
  await $.turn.start({
    text: "<bash-stdout>hi</bash-stdout><bash-stderr></bash-stderr>",
    turnId: "t2",
  });
  await drawReply($, "msg_2");
  await $.turn.complete({ ...COMPLETE, turnId: "t2" });
  await clock.settle();

  expect(inlineRequests(calls).map((c) => JSON.parse(c.body ?? "{}").question)).toEqual([QUESTION]);
});

test("a slash command's turn sends no ad request", async ($, on) => {
  const { calls, clock } = world(on, CONNECTED);
  await $.prompt.submit({
    text: "/humanizer ok",
    command: { name: "humanizer", args: "ok" },
    wait: false,
    origin: { kind: "composer" },
  });
  await $.turn.start({ text: "<command-message>humanizer</command-message>", turnId: "t1" });
  await drawReply($);
  await $.turn.complete(COMPLETE);
  await clock.settle();

  expect(inlineRequests(calls)).toHaveLength(0);
});

test("a prompt sent through Remote Control sends no ad request", async ($, on) => {
  const { calls, clock } = world(on, { ...CONNECTED, bandAds: [BAND_AD] });
  await $.prompt.submit({ text: QUESTION, wait: false, origin: { kind: "bridge" } });
  await $.turn.start({ text: QUESTION, turnId: "t1" });
  await drawReply($);
  await $.turn.complete(COMPLETE);
  await clock.settle();

  expect(calls.filter((c) => c.url === `${SITE}/api/ad`)).toHaveLength(0);
});

bandTest("a turn with no text sends no band request", async ($, on) => {
  const { calls, clock } = world(on, { ...CONNECTED, bandAds: [BAND_AD, NEXT_BAND_AD] });
  await $.prompt.submit({ text: "", wait: false, origin: { kind: "composer" } });
  await $.turn.start({ text: "", turnId: "t1" });
  await clock.settle();

  expect(bandRequests(calls)).toHaveLength(0);
});

bandTest("a band request carries the question and no answer", async ($, on) => {
  const { calls, clock } = world(on, { ...CONNECTED, bandAds: [BAND_AD] });
  await $.prompt.submit({ text: QUESTION, wait: false, origin: { kind: "composer" } });
  await $.turn.start({ text: QUESTION, turnId: "t1" });
  await clock.settle();

  expect(JSON.parse(bandRequests(calls)[0]?.body ?? "{}")).toEqual({
    placement: "band",
    client: "terminal",
    pluginVersion: PLUGIN_VERSION,
    claudeVersion: CLAUDE_VERSION,
    terminalProgram: TERM_PROGRAM,
    question: QUESTION,
    conversationId: "session_abc",
    textLength: 60,
  });
});

const BAND_WIDTHS = [
  { columns: 50, textLength: 40 },
  { columns: 400, textLength: 300 },
];

for (const { columns, textLength } of BAND_WIDTHS) {
  bandTest(
    `a band request after a ${columns} column band asks for ${textLength} characters`,
    async ($, on) => {
      const { calls, clock } = world(on, { ...CONNECTED, bandAds: [BAND_AD] });
      const ui = await $.ui.mount({ ...band(true, false, columns), surface: "terminal" });
      await ui.unmount();
      await $.prompt.submit({ text: QUESTION, wait: false, origin: { kind: "composer" } });
      await $.turn.start({ text: QUESTION, turnId: "t1" });
      await clock.settle();

      expect(JSON.parse(bandRequests(calls)[0]?.body ?? "{}").textLength).toBe(textLength);
    },
  );
}

const USAGE = "Usage: /sidequest on | off | inline on | inline off | band on | band off | update";

bandTest("both ad placements are on by default", async ($, on) => {
  const { calls, clock } = world(on, { ...CONNECTED, bandAds: [BAND_AD] });
  await $.prompt.submit({ text: QUESTION, wait: false, origin: { kind: "composer" } });
  await $.turn.start({ text: QUESTION, turnId: "t1" });
  await drawReply($);
  await $.turn.complete(COMPLETE);
  await clock.settle();

  expect([inlineRequests(calls).length, bandRequests(calls).length]).toEqual([1, 1]);
});

bandTest("/sidequest band off sends no band request on the next turn", async ($, on) => {
  const { calls, clock } = world(on, { ...CONNECTED, bandAds: [BAND_AD] });
  await sidequest($, "band off");
  await $.prompt.submit({ text: QUESTION, wait: false, origin: { kind: "composer" } });
  await $.turn.start({ text: QUESTION, turnId: "t1" });
  await clock.settle();

  expect(bandRequests(calls)).toHaveLength(0);
});

bandTest("/sidequest band off still requests inline ads", async ($, on) => {
  const { calls, clock } = world(on, CONNECTED);
  await sidequest($, "band off");
  await $.prompt.submit({ text: QUESTION, wait: false, origin: { kind: "composer" } });
  await $.turn.start({ text: QUESTION, turnId: "t1" });
  await drawReply($);
  await $.turn.complete(COMPLETE);
  await clock.settle();

  expect(inlineRequests(calls)).toHaveLength(1);
});

bandTest("/sidequest band off hides the band that is showing", async ($, on) => {
  const { clock } = world(on, { ...CONNECTED, bandAds: [BAND_AD] });
  await $.prompt.submit({ text: QUESTION, wait: false, origin: { kind: "composer" } });
  await $.turn.start({ text: QUESTION, turnId: "t1" });
  await clock.settle();
  await sidequest($, "band off");

  const ui = await $.ui.mount({ ...band(true), surface: "terminal" });
  expect(await ui.find({ text: /Band Brand/ })).toBeUndefined();
  await ui.unmount();
});

bandTest("/sidequest inline off sends no inline request", async ($, on) => {
  const { calls, clock } = world(on, CONNECTED);
  await sidequest($, "inline off");
  await $.prompt.submit({ text: QUESTION, wait: false, origin: { kind: "composer" } });
  await $.turn.start({ text: QUESTION, turnId: "t1" });
  await drawReply($);
  await $.turn.complete(COMPLETE);
  await clock.settle();

  expect(inlineRequests(calls)).toHaveLength(0);
});

bandTest("/sidequest inline off still requests band ads", async ($, on) => {
  const { calls, clock } = world(on, { ...CONNECTED, bandAds: [BAND_AD] });
  await sidequest($, "inline off");
  await $.prompt.submit({ text: QUESTION, wait: false, origin: { kind: "composer" } });
  await $.turn.start({ text: QUESTION, turnId: "t1" });
  await clock.settle();

  expect(bandRequests(calls)).toHaveLength(1);
});

bandTest("/sidequest off sends no ad request of either kind", async ($, on) => {
  const { calls, clock } = world(on, { ...CONNECTED, bandAds: [BAND_AD] });
  await sidequest($, "off");
  await $.prompt.submit({ text: QUESTION, wait: false, origin: { kind: "composer" } });
  await $.turn.start({ text: QUESTION, turnId: "t1" });
  await drawReply($);
  await $.turn.complete(COMPLETE);
  await clock.settle();

  expect(calls.filter((c) => c.url === `${SITE}/api/ad`)).toHaveLength(0);
});

bandTest("/sidequest on turns both placements back on", async ($, on) => {
  const { calls, clock } = world(on, { ...CONNECTED, bandAds: [BAND_AD] });
  await sidequest($, "off");
  await sidequest($, "on");
  await $.prompt.submit({ text: QUESTION, wait: false, origin: { kind: "composer" } });
  await $.turn.start({ text: QUESTION, turnId: "t1" });
  await drawReply($);
  await $.turn.complete(COMPLETE);
  await clock.settle();

  expect([inlineRequests(calls).length, bandRequests(calls).length]).toEqual([1, 1]);
});

bandTest("saved settings apply in a new session", async ($, on) => {
  const { calls, clock } = world(on, {
    store: { deviceKey: KEY, settings: { inline: true, band: false } },
    bandAds: [BAND_AD],
  });
  await $.session.start({ cwd: "/tmp", surface: "terminal", isInteractive: true });
  await $.prompt.submit({ text: QUESTION, wait: false, origin: { kind: "composer" } });
  await $.turn.start({ text: QUESTION, turnId: "t1" });
  await clock.settle();

  expect(bandRequests(calls)).toHaveLength(0);
});

bandTest("/sidequest alone prints the current settings and the usage", async ($, on) => {
  world(on, CONNECTED);
  await sidequest($, "inline off");

  const text = await sidequest($, "");
  expect(text.startsWith("Inline ads: off. Band ads: on.\n")).toBe(true);
  expect(text.endsWith(`\n${USAGE}`)).toBe(true);
});

test("/sidequest alone lists the plugin version and the Claude Code version", async ($, on) => {
  world(on, CONNECTED);

  const text = await sidequest($, "");
  expect(text).toContain(`Sidequest v${PLUGIN_VERSION} · Claude Code ${CLAUDE_VERSION}`);
});

for (const args of ["maybe", "band", "band maybe", "sidebar on", "on off", "band on now"]) {
  bandTest(`/sidequest ${args} prints the usage and changes nothing`, async ($, on) => {
    world(on, CONNECTED);

    expect(await sidequest($, args)).toBe(USAGE);
  });
}

bandOffTest("with band ads off, a turn sends only the inline request", async ($, on) => {
  const { calls, clock } = world(on, { ...CONNECTED, bandAds: [BAND_AD] });
  await $.prompt.submit({ text: QUESTION, wait: false, origin: { kind: "composer" } });
  await $.turn.start({ text: QUESTION, turnId: "t1" });
  await drawReply($);
  await $.turn.complete(COMPLETE);
  await clock.settle();

  expect([inlineRequests(calls).length, bandRequests(calls).length]).toEqual([1, 0]);
});

bandOffTest("with band ads off, /sidequest off sends no ad request", async ($, on) => {
  const { calls, clock } = world(on, CONNECTED);
  await sidequest($, "off");
  await $.prompt.submit({ text: QUESTION, wait: false, origin: { kind: "composer" } });
  await $.turn.start({ text: QUESTION, turnId: "t1" });
  await drawReply($);
  await $.turn.complete(COMPLETE);
  await clock.settle();

  expect(inlineRequests(calls)).toHaveLength(0);
});

bandOffTest(
  "with band ads off, a saved inline off still applies in a new session",
  async ($, on) => {
    const { calls, clock } = world(on, {
      store: { deviceKey: KEY, settings: { inline: false, band: true } },
    });
    await $.session.start({ cwd: "/tmp", surface: "terminal", isInteractive: true });
    await $.prompt.submit({ text: QUESTION, wait: false, origin: { kind: "composer" } });
    await $.turn.start({ text: QUESTION, turnId: "t1" });
    await drawReply($);
    await $.turn.complete(COMPLETE);
    await clock.settle();

    expect(inlineRequests(calls)).toHaveLength(0);
  },
);

bandOffTest("with band ads off, /sidequest shows only on and off", async ($, on) => {
  world(on, CONNECTED);

  const text = await sidequest($, "");
  expect(text.startsWith("Ads: on.\n")).toBe(true);
  expect(text.endsWith("\nUsage: /sidequest on | off | update")).toBe(true);
});

for (const args of ["band on", "band off", "inline off"]) {
  bandOffTest(`with band ads off, /sidequest ${args} prints the usage`, async ($, on) => {
    world(on, CONNECTED);

    expect(await sidequest($, args)).toBe("Usage: /sidequest on | off | update");
  });
}
