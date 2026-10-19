<div align="center">

```
  ____ ___ ____  _____ ___  _   _ _____ ____ _____
 / ___|_ _|  _ \| ____/ _ \| | | | ____/ ___|_   _|
 \___ \| || | | |  _|| | | | | | |  _| \___ \ | |
  ___) | || |_| | |__| |_| | |_| | |___ ___) || |
 |____/___|____/|_____\__\_\\___/|_____|____/ |_|
```

**A short detour under every Claude Code answer.**

One clearly labeled sponsored card, right where the answer ends.

[![Claude Code mod](https://img.shields.io/badge/Claude%20Code-mod-D97757?logo=claude&logoColor=white)](https://claude.com/claude-code)
[![Install](https://img.shields.io/badge/install-sidequest%40sidequest-1f6feb)](#install)
[![Powered by Koah](https://img.shields.io/badge/ads%20by-Koah-111111)](https://koah.ai)
[![Website](https://img.shields.io/badge/site-getsidequest.dev-000000?logo=vercel&logoColor=white)](https://getsidequest.dev)
[![Last commit](https://img.shields.io/github/last-commit/koahlabs/sidequest-plugin?color=2ea44f)](https://github.com/koahlabs/sidequest-plugin/commits/main)

[Install](#install) · [Use](#use) · [Privacy](#what-it-sends) · [Development](#development)

</div>

---

## What it looks like

Claude answers as usual. When the turn ends, Sidequest adds a divider and one
ad under the last message of that answer:

```
⏺ Use a middleware file at the project root and match only the routes you
  need, so static assets skip it.

────────────────────────────────────────────────────────────────────────

[▣] Patagonia  Sponsored

Built to last, repaired for free. Patagonia's Ironclad Guarantee means...

╭────────────╮
│ Learn More │
╰────────────╯
```

One more line, with an **Ad** label, sits directly above the prompt:

```
[▣] Patagonia  Ad  Built to last, repaired for free.  o: Learn More
```

- Every card says **Sponsored**, and the line above the prompt says **Ad**. The ad never goes into Claude's answer or the
  conversation, so the model never reads it.
- Each answer gets its own ad. Earlier ads stay where they are.
- It works in the terminal and in the Claude desktop app, with the
  advertiser's icon next to its name when the icon loads.

## Install

Open [getsidequest.dev/account](https://getsidequest.dev/account) and sign in. The setup page shows how to install and connect Sidequest in the terminal or in Claude Desktop.

## Use

| Action                        | How                                                                                              |
| ----------------------------- | ------------------------------------------------------------------------------------------------ |
| Show the ad settings          | `/sidequest`                                                                                     |
| Turn all ads on or off        | `/sidequest on` or `/sidequest off`                                                              |
| Turn one kind of ad on or off | `/sidequest inline on\|off` or `/sidequest band on\|off`                                         |
| See the band ad               | Automatic. One ad shows above the prompt and stays until the next turn brings a new one          |
| Count an impression           | Automatic, once per ad, when the inline ad or the band ad is drawn. A hidden band counts nothing |

## What it sends

Each request goes to getsidequest.dev. It carries the last question and answer (up to 4,000 characters each), the session ID, and a random per-machine device key. The site forwards the request to Koah with your account. The mod does no IP lookup: the site sees your IP as any web request does. It never sends an email address or phone number. At the start of each turn it also sends one request for the band ad, with the question only and the text length that fits the terminal width.

## Requirements

- Claude Code 2.1.292 or later in the terminal. `claude plugin install --marketplace` first shipped in 2.1.292.
- Claude Desktop with bundled Claude Code 2.1.287 or later. Mods first shipped in 2.1.287. Run `/status` in a local Code session to see that version. It can differ from `claude --version`.
- Advertiser icons need `curl`. Icons that are not PNG also need `sips`, which macOS includes. Ads show without an icon when it fails to load.

## Troubleshooting

- **No ad appears.** Some requests return no ad. Ask another question.
- **Claude asks you to run `/sidequest-connect`, or the status line shows `sidequest: not connected`.** Run `/sidequest-connect`.
- **The plugin does not load.** Start a new session, or run `/reload-plugins`.
- **`claude: command not found`.** Install the CLI with the [official setup guide](https://code.claude.com/docs/en/setup).

## Update and uninstall

Run these commands in a terminal. After an update, start a new session.

```
claude plugin update sidequest@sidequest
claude plugin uninstall sidequest@sidequest
claude plugin marketplace remove sidequest
```

The last command is optional. It removes the marketplace.

## Development

1. Install Bun and Claude Code, then run `bun install`. It also installs the git hooks that lint, format and typecheck staged files.
2. Run Claude Code with the plugin from this checkout:

   ```
   claude --plugin-dir plugin
   ```

   To use a local Sidequest site, add `--settings '{"env":{"SIDEQUEST_URL":"http://localhost:3001"}}'`. The plugin accepts this override only for `http://localhost` or `http://127.0.0.1`, and only from your own user settings or the `--settings` flag.

3. Claude Code writes the plugin types to `plugin/.claude-plugin/types`. `bun run typecheck` needs them.

`bun run uninstall-plugin` runs the uninstall and the marketplace remove.

## Checks

```
claude plugin validate plugin
bun run test
bun run typecheck
bun run lint
```
