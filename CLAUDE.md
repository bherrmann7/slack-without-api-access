# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`slack-send` reads and posts Slack messages, adds/removes reactions and deletes messages **as
the logged-in user**, on a workspace where the Slack API is disabled — no app, no bot token.
It gets in the way the user does: a real browser login, and then that same session's
credentials.

Everything lives in one file, `send.js`, plus `test/unit.test.js`.

## Commands

```bash
npm test                          # unit tests (no browser, ~300ms)
node --test test/unit.test.js     # same thing
node --test --test-name-pattern 'apiCall' test/unit.test.js   # single test
node --check send.js              # syntax check — do this after every edit
node send.js --help               # RUN it too: --check cannot see a ReferenceError
```

There is no build, no linter, and no CI.

## Running it

```bash
slack-send alice "message"                     # send
slack-send list <channel> --limit 25 [--full]  # read history
slack-send status                              # session + credential state
```

**Every mutating command is dry-run by default and requires `--yes` to act** (`react`,
`delete`). Keep it that way. When testing changes, prefer your own DM over a shared channel.

## State (outside the repo)

`~/.slack-send/` holds `profile/` (the persistent Chromium profile — **this is the login
session**, re-run `slack-send login` if it expires), `session.json` (the harvested API
credential pair, mode 600), `conv-cache.json` (name → conversation id), `config.json` (pins
`team`), and `shots/` (failure screenshots — read these when debugging).

## Architecture

`send.js` is banner-sectioned: selectors → utilities → browser → session/api → http writes →
commands → argv → cli.

**Two paths, HTTP preferred.** Slack's web client is itself a client of `slack.com/api/*`,
authenticating with a pair: the `xoxc-` token in `localStorage["localConfig_v2"]` plus the `d`
cookie. Neither half works alone. `harvestSession()` reads both from a live context at the end
of `login`; `apiCall(method, params)` POSTs with them. A round trip is ~200ms against ~10s to
boot Chromium, so commands try HTTP first and fall back to the DOM path on `AuthError`.
`--no-api` forces the browser.

**Selector layer (`SEL`).** Slack is React with hashed class names; the only durable hooks are
the `data-qa` attributes Slack ships for its own tests. Every non-obvious selector carries a
comment explaining why the obvious choice fails. Read those before changing one — they encode
expensive discoveries, e.g. the search box and the message composer *both* use
`data-qa="texty_input"` and are distinguished only by `role` (`combobox` vs `textbox`).

**The safety chokepoint differs per path.** On the browser path, `openConversation(page, to,
force)` reads which quick-switcher row `Enter` will act on *before* pressing it and aborts on
mismatch. Pass `force` from `--force` only — never hardcode `true`. On the HTTP path there are
no rows, so the guard becomes: address by id, and prove the id still denotes what the name
claimed. `resolveConversationCached()` calls `verifyConversation()` on every cache hit —
`conversations.info` must return a matching channel name, or for a DM the same other party — and
re-resolves on mismatch. Do not skip the verify to save a round trip; without it a wrong cached
id would write to the wrong channel with nothing to catch it.

## Hard-won behaviours — do not "simplify" these

These each caused a real bug. The comments in the code say the same thing; this is the index.

- **`scrollTop` does nothing.** Every ancestor of the message list is `overflow:hidden` — it is a custom virtual scroller. Only real `page.mouse.wheel` events page history in.
- **The mouse must be inside the viewport** for wheel events to register. Use `hoverMessagePane()`; deriving the point from the first rendered row gives a negative `y` once scrolled up, and the wheel is then silently discarded.
- **Scrolling up unmounts the newest rows.** `collectMessages()` accumulates by `ts` across scroll steps rather than reading the DOM once at the end.
- **Re-opening a conversation does not reset scroll** — Slack restores the previous offset within a session. Use `scrollToLatest()` before acting.
- **Act newest-first.** Targets then sit progressively upward and the pane scrolls one direction.
- **Wait for the virtual list to mount before scrolling.** An empty list right after open means "not rendered yet", not "not here".
- **A reaction's `aria-label` is identical whether or not you are one of the reactors.** Only `aria-pressed="true"` / `c-reaction--reacted` says it is yours — and clicking a pill toggles *your* reaction, so removing without that check *adds* yours to someone else's.
- **The API has no such hazard.** `reactions.remove` only ever touches your own, so the same situation returns `no_reaction`. Treat `already_reacted`/`no_reaction` as successes ("the state you asked for already holds"), not failures.
- **`reactions.*` takes `timestamp`; `chat.delete` takes `ts`.** Getting it wrong is a silent no-op.
- **A file upload posts with an EMPTY `text`** and the filename in `m.files`. The DOM path lists those rows, so the HTTP path must too (`messageText()`), or `react`/`delete` cannot target a message the user can plainly see.
- **A bare name is a PERSON, but Slack's generated mpdm names contain it.** `bob` substring-matches every `mpdm-alice--carol--bob-1` group DM, so `resolveConversation()` goes exact-channel → exact-person → fuzzy-channel. A substring pass over channels first makes every DM lookup ambiguous.
- **Newlines need `Shift+Enter`** on the DOM path, or each line posts as a separate message. `chat.postMessage` takes the text whole.
- **Send by clicking `[data-qa="texty_send_button"]`**, not `Enter` — a stray `Enter` can activate a focused banner link instead.
- **Slack debounce-saves drafts server-side.** Closing too soon after a send strands a draft; wait, then clear residue.
- **Drive keys through the composer locator, not `page.keyboard`**, so input cannot land in a banner or the search box.
- **Slack serves a composer-less client to a `HeadlessChrome` UA.** `send.js` spoofs `Chrome/${UA_MAJOR}`; bump that constant if sends start failing mysteriously (`slack-send status` prints the live UA).
- **Never open the profile with anything but `launch()`.** A plain `chromium.launchPersistentContext(PROFILE_DIR)` gets Playwright's default `chromium_headless_shell` — a different binary whose OSCrypt/Keychain identity cannot decrypt the cookie store. Chromium's response to a store it cannot read is to discard it and write a fresh one, which **silently destroys the login session**. `launch()` passes `channel: 'chromium'` for exactly this reason. To experiment against a real session, copy the profile first and open the copy — never the live directory.

## Conventions

- `die()` **throws** `ExitError`; it does not call `process.exit()`. That keeps `finally` blocks running (so the browser closes) and makes failures assertable. Do not reintroduce `process.exit()` inside command bodies.
- Untrusted input: message text comes from anyone who can post. Keep channel/emoji values validated before they reach a URL or a CSS selector.
- Keep pure logic (`parseArgv`, `emojiName`, `intOpt`, `norm`, `rowSelector`, `slackTextToPlain`, `pickConversation`, `messageText`) free of Playwright so it stays unit-testable. `apiCall` takes an injectable `fetchImpl` for the same reason — and note it distinguishes "no `session` key" from an explicit `session: null`, so a test cannot silently pick up real credentials from disk.
- Anything browser-touching is verified by hand.
- Exports at the bottom exist for tests, including a smoke test asserting every command and internal helper still resolves — a helper was once silently deleted by an edit and only surfaced on use. Add new helpers there.
- Selector discovery: write a throwaway probe script that dumps candidate elements' `data-qa`/`role`/`aria-label` from the live page. Guessing selectors has failed repeatedly here.
