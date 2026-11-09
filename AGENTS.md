# Agent notes

- Run `script/golden/all` before you push a change to `plugin/`.
- During development, run one surface from `script/golden/` to check a render change.
- Desktop users may not have the `claude` CLI, so do not rely on running `claude` commands.

## Critical paths

The unit tests in `plugin/tests/sidequest.test.tsx` own these contracts. The golden scripts prove only that an ad draws, so they cannot catch an ad that shows when it must not.

- The plugin asks for an ad only after a turn that a person typed in the composer.
- These turns get no ad request: slash commands, `!` shell commands, background tasks, schedules, peers, Remote Control, `claude -p`, subagents, and turns that end aborted, refused or in error.
- The plugin asks for no ad when the account is not connected, when ads are off, or when no surface can draw an ad.
- The ad draws under the newest message of the answer, with its "Sponsored" label. The plugin sends one impression for each ad, and it retries a failed impression.

When you change turn, request or render logic, each case you touch must have a test that fails on the code before your change. Mutate the code by hand to check this.

Band ads are off (`BAND_ADS` in `plugin/hooks/features.ts`), so `bandTest` cases do not run. Do not put an inline contract in a `bandTest`.

## Test machine state

- `~/.claude/plugins/store/sidequest_*.json` holds the saved device keys. There is one file for each plugin identity: `sidequest_inline-*` for `--plugin-dir plugin`, and `sidequest_sidequest-*` for the installed plugin. Do not move or delete these files. Without a key, the plugin asks for no ad, so the golden scripts stop before they wait.
- `script/golden/desktop` needs the plugin installed from this checkout. Installing it replaces an install from GitHub, so tell the person before you do it.
- `script/golden/desktop` writes `env.SIDEQUEST_URL` into `~/.claude/settings.json` and restores the file when it exits. If a run is killed, remove that key by hand.
