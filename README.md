<div align="center">

```
███████╗██╗██████╗ ███████╗ ██████╗ ██╗   ██╗███████╗███████╗████████╗
██╔════╝██║██╔══██╗██╔════╝██╔═══██╗██║   ██║██╔════╝██╔════╝╚══██╔══╝
███████╗██║██║  ██║█████╗  ██║   ██║██║   ██║█████╗  ███████╗   ██║
╚════██║██║██║  ██║██╔══╝  ██║▄▄ ██║██║   ██║██╔══╝  ╚════██║   ██║
███████║██║██████╔╝███████╗╚██████╔╝╚██████╔╝███████╗███████║   ██║
╚══════╝╚═╝╚═════╝ ╚══════╝ ╚══▀▀═╝  ╚═════╝ ╚══════╝╚══════╝   ╚═╝
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

- Every card says **Sponsored**. The ad never goes into Claude's answer or the
  conversation, so the model never reads it.
- Each answer gets its own ad. Earlier ads stay where they are.
- It works in the terminal and in the Claude desktop app, with the
  advertiser's icon next to its name when the icon loads.

## Install

Open [getsidequest.dev/account](https://getsidequest.dev/account) and sign in. The setup page shows how to install and connect Sidequest in the terminal or in Claude Desktop.

## Use

| Action                  | How                                          |
| ----------------------- | -------------------------------------------- |
| Show whether ads are on | `/sidequest`                                 |
| Turn ads on or off      | `/sidequest on` or `/sidequest off`          |
| Update the plugin       | `/sidequest update`, then `/reload-plugins`  |
| Count an impression     | Automatic, once per ad, when the ad is drawn |

## What it sends

Each request goes to getsidequest.dev. It carries the last question and answer (up to 4,000 characters each), the session ID, and a random per-machine device key. The site forwards the request to Koah with your account. The mod does no IP lookup: the site sees your IP as any web request does. It never sends an email address or phone number. The plugin also reads its latest version number from GitHub (raw.githubusercontent.com) and sends nothing there.

## Requirements

- Claude Code 2.1.292 or later in the terminal. `claude plugin install --marketplace` first shipped in 2.1.292.
- Claude Desktop with bundled Claude Code 2.1.287 or later. Mods first shipped in 2.1.287. Run `/status` in a local Code session to see that version. It can differ from `claude --version`.
- Advertiser icons need `curl`. Icons that are not PNG also need `sips`, which macOS includes. Ads show without an icon when it fails to load.

## Troubleshooting

- **No ad appears.** Some requests return no ad. Ask another question.
- **No ad appears in a Claude Code session on the web.** Ads show only when Claude Code runs on your computer: in the terminal, Claude Desktop, or VS Code.
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

### What each check proves

- `bun run test` runs the unit tests. They own the rules for when an ad shows and when it must not, and they need no setup or machine state.
- The golden scripts prove that an ad draws and that its impression arrives on each real surface. They do not prove that an ad stays hidden.

### Golden render tests

These scripts drive the real apps and prove that an inline ad draws. A local fake site stands in for getsidequest.dev. A surface passes when this run's ad text is on screen and the fake site receives this run's impression.

```
script/golden/tmux
script/golden/ghostty
script/golden/terminal-app
script/golden/desktop
script/golden/all
```

Each script runs alone, and each run has its own port and ad, so runs can go in parallel. `all` runs the terminal scripts in parallel, then `desktop`.

Before the first run, check these once:

1. Sign in to Claude Code. The scripts ask the real model a question.
2. Give your terminal Accessibility and Screen Recording access. The scripts read app windows.
3. Save a device key for `plugin/`:

   ```
   script/golden/connect
   ```

   The key is in `~/.claude/plugins/store/sidequest_inline-*.json`. The installed plugin has its own key in `sidequest_sidequest-*.json`. Keep both files. If you delete or move one, connect again.

The terminal scripts load `plugin/` with `--plugin-dir` and pass the prompt at startup, so they never type. The `desktop` script uses the installed plugin, so install it from this checkout first:

```
claude plugin marketplace remove sidequest && claude plugin marketplace add "$PWD" && claude plugin install sidequest@sidequest
```

The `desktop` script presses Enter once in Claude Desktop, and it edits `~/.claude/settings.json` and restores it on exit. It refuses to start while that file already points at a local site. If a run is killed, remove `env.SIDEQUEST_URL` from that file by hand.

Each run first checks for a saved device key and fails at once without one. For the terminal scripts, run `script/golden/connect`. For Desktop, run `/sidequest-connect` once in a Desktop session; any key works with the fake site.

Any other failure prints three facts: whether the plugin asked for an ad, whether the ad is on screen, and whether the impression arrived. The `desktop` script also fails if Claude Desktop does not show the prompt within 90 seconds.

This suite is manual. Run it before you push a plugin change.

## Checks

```
claude plugin validate plugin
bun run test
bun run typecheck
bun run lint
```

## Test on Claude Desktop

1. Install the plugin from this checkout:

   ```
   claude plugin marketplace add "$PWD"
   claude plugin install sidequest@sidequest
   ```

2. Quit Claude Desktop and open it again.
3. Start a new session and ask a question that matches an ad.
4. Check that the ad shows under the reply and stays after the reply ends.
5. After a code change, uninstall the plugin, install it again and start a new session.

### Known problems on Desktop

- Test with an installed plugin. Desktop checks a `--plugin-dir` plugin more strictly, so a good drawing can fail there.
- Do not give a width to the `Box` that holds the engine's reply. Desktop then drops the drawing and shows the plain reply.
- Desktop shows no error when it drops a drawing.
- The plugin reports the impression before Desktop draws. A dropped drawing still bills an ad that nobody sees.
