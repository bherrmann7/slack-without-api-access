# slack-without-api-access

Read and post Slack messages **as yourself**, from the command line, on a workspace where
the API is turned off.

Most Slack CLIs assume you can create an app and get a bot token. Plenty of workspaces don't
allow that — the admin has disabled app installs, and there is no token to be had. This tool
exists for that case. It signs in the way you do, in a real browser, and then does everything
through your own session. No app, no bot, no token to request from anyone.

Everything it does, it does **as you**. Messages come from your account, not from a bot with
your avatar.

```console
$ slack-send alice "deploy finished, logs in the thread"
$ slack-send list team-updates --limit 25
$ slack-send react team-updates --ts 1788134175.155179 --emoji white_check_mark --yes
```

## How it works

Two paths, and it prefers the fast one.

**HTTP (default).** Slack's web client is itself a client of `slack.com/api/*`. It
authenticates with a pair — the `xoxc-` token the client keeps in `localStorage`, and the `d`
cookie — and *neither half works alone*. `slack-send login` harvests both from a real signed-in
browser, and everything afterwards is a plain HTTPS call. A round trip is ~200ms.

**Browser (fallback).** The original path: drive the actual web client with
[Playwright](https://playwright.dev). Slower (~10s to boot Chromium) but it needs nothing but
the login. Used automatically when the saved credentials expire, and forced with `--no-api`.

Both paths are covered by the same tests and produce the same output, so you can fall back
without surprises.

## Please read this before using it

This drives Slack with **your own user session**, which is not the same thing as an approved
integration:

- **It is outside Slack's Terms of Service.** Automating a user session is not a supported use
  of the product, whatever the volume. Slack may rate-limit, or act on, traffic it identifies
  this way. Personal, low-volume use is a different risk from wiring it into shared automation.
- **Your workspace admin disabled the API for a reason.** This routes around a deliberate
  policy decision. Whether that's fine or a firing offence depends on your organisation, and
  it's on you to know which.
- **Actions are indistinguishable from you doing them by hand,** because that's what they are.
  There is no bot label and no audit trail saying a script did it.

It was written for one person automating their own workflow on their own account. That is the
use it is fit for.

## Install

```console
git clone https://github.com/bherrmann7/slack-without-api-access
cd slack-without-api-access
npm install
npm link            # puts `slack-send` on your PATH
slack-send login    # opens a browser; sign in there
```

`login` opens a real browser window and waits (up to 5 minutes) for you to sign in. That window
**is** the saved session — don't close it manually; it closes itself once sign-in is detected.

Re-run `slack-send login` whenever the session expires. `slack-send status` tells you where you
stand.

### Releasing a copy for scheduled jobs

If you run this from cron or a launch agent, don't point the job at your working
copy — a half-finished edit becomes what runs, minutes later, unattended.
`./install` publishes a snapshot instead:

```console
./install
```

It runs the tests, checks the syntax, and actually executes `send.js --help`
(parsing is not running — a dangling reference passes a syntax check and dies at
runtime). Only if all of that succeeds does it copy `send.js` to
`~/.slack-send/deploy/` and write a `slack-send` wrapper into `~/bin` pointing
there. It copies rather than symlinks, deliberately: a symlink would put the
working tree back in the execution path.

`slack-send status` then shows which edition is live:

```
deployed  : 55a930b239b1  2026-08-30 22:06:29  git d663c3e   <- what cron runs
source    : 0680ab670455  AHEAD of deploy — run ./install
```

You don't need this for interactive use — `npm link` is enough.

## Commands

| command | what it does |
|---|---|
| `slack-send <recipient> "<message>"` | post a message (also reads stdin) |
| `slack-send list <recipient> [--limit N] [--full]` | print recent messages with timestamps |
| `slack-send react <recipient> --ts <ts,ts> --emoji <name> [--remove]` | add or remove a reaction |
| `slack-send delete <recipient> --match "<text>" \| --ts <ts,ts>` | delete your own messages |
| `slack-send login` / `status` | sign in; report session and credential state |
| `slack-send shot [recipient]` | screenshot the client (read-only, for debugging) |

`<recipient>` is a channel name, a username, or a raw Slack id (`C…`/`D…`/`G…`).

### Safety

**Every mutating command is a dry run by default.** `react` and `delete` report what they
*would* do and change nothing until you add `--yes`. Timestamps come from `list`, so the normal
loop is: list, copy the `ts`, act on it.

Resolution is checked, not guessed. A name resolves to a conversation id, and a cached id is
re-verified against `conversations.info` before any write — if the name no longer denotes that
conversation, it re-resolves rather than acting on a stale id. An ambiguous name is refused
outright instead of picked.

## Flags

```
--yes        actually apply changes (react, delete)
--dry-run    (send) do everything except send
--limit N    how many messages to read
--full       do not truncate message text
--no-api     skip the HTTP path and drive the browser
--force      skip the recipient guard
--quiet      suppress progress output on stderr
```

## State

Everything lives in `~/.slack-send/` (override with `SLACK_SEND_HOME`):

| file | contents |
|---|---|
| `profile/` | the Chromium profile — **this is your login session** |
| `session.json` | the harvested `xoxc` + `d` pair, mode `600` |
| `conv-cache.json` | name → conversation id, 30-day TTL |
| `config.json` | pins `team` (see below) |
| `shots/` | screenshots written on failure |

If you belong to several workspaces, pin the one you mean — otherwise a bare `/client` URL
lands wherever Slack last left you:

```json
{ "team": "T0XXXXXXX" }
```

or set `SLACK_SEND_TEAM`. Your team id is in any Slack URL: `app.slack.com/client/T0XXXXXXX/…`

`session.json` and `profile/` are as sensitive as your password. They are written owner-only;
keep them that way, and don't copy them anywhere.

## Limitations

- **The browser path depends on Slack's DOM.** It leads with the `data-qa` attributes Slack
  ships for its own tests, which are the most durable hooks available, but Slack can still
  change them. Every non-obvious selector carries a comment saying why the obvious choice
  fails — read those before changing one. The HTTP path is unaffected.
- **`delete --match` searches the most recent 50 messages** (`--limit` to widen). Deliberately
  narrow: a wider default would delete more than you expect.
- **`delete` only works on your own messages.** Slack refuses anything else.
- **Threads are not addressable yet** — no `thread_ts` support on send.
- Tested on macOS. Nothing in it is macOS-specific, but that's where it has run.

## Development

```console
npm test              # unit tests, no browser, ~300ms
node --check send.js  # syntax
```

The tests cover the pure logic and the HTTP layer (with an injected fetch double). Anything
that touches Playwright is verified by hand — if you change a selector, drive it against a
real workspace.

Pure helpers are exported at the bottom of `send.js` so tests can reach them, including a smoke
test asserting every command and internal helper still resolves. A helper was once silently
deleted by an edit and only surfaced on use; that test exists to catch it.

**On those exports:** most exist for the tests and carry no stability promise — they can change
in any release. The exception is the browser plumbing (`launch`, `gotoClient`, `isSignedIn`,
`dismissBanners`, `openConversation`, `log`, `die`, `STATE_DIR`), exported so a separate tool can
drive the same client without duplicating the selector layer. If you build on those, pin a
version; if you build on anything else, expect it to move.

## License

MIT
