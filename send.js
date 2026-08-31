#!/usr/bin/env node
// send.js — post a Slack message as yourself by driving the Slack web client
// with a persistent Playwright profile. No Slack API token, no workspace app.
//
// The session lives in a Chromium profile directory (~/.slack-send/profile), so
// `login` is a one-time interactive step; every later `send` is headless.
//
// Slack's DOM is React with hashed class names. The only durable hooks are the
// data-qa attributes Slack ships for its own test suite, so every selector below
// leads with data-qa and falls back to a structural guess. When both miss we
// screenshot and fail loudly rather than typing into whatever has focus.

'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const { chromium } = require('playwright');

const HOME = os.homedir();
const STATE_DIR = process.env.SLACK_SEND_HOME || path.join(HOME, '.slack-send');
const PROFILE_DIR = path.join(STATE_DIR, 'profile');
const SHOT_DIR = path.join(STATE_DIR, 'shots');

const CONFIG_FILE = path.join(STATE_DIR, 'config.json');
// Holds the harvested { token, d } pair — see the session/api section below.
const SESSION_FILE = path.join(STATE_DIR, 'session.json');
// The released edition cron runs — see ./install. Deliberately NOT this file.
const DEPLOY_DIR = path.join(STATE_DIR, 'deploy');
// name -> conversation id, so repeated runs do not re-list every channel and user.
const CONV_CACHE_FILE = path.join(STATE_DIR, 'conv-cache.json');

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch (_) {
    return {};
  }
}

// Slack redirects a bare /client to the last-used workspace, which is ambiguous
// if you belong to several. Pinning the team id makes the landing deterministic.
const CONFIG = loadConfig();
const TEAM_ID = process.env.SLACK_SEND_TEAM || CONFIG.team || '';
const CLIENT_URL = TEAM_ID
  ? `https://app.slack.com/client/${TEAM_ID}`
  : 'https://app.slack.com/client';
const NAV_TIMEOUT = 45000;
const UI_TIMEOUT = 20000;

// ---------------------------------------------------------------- selectors

const SEL = {
  // Slack builds BOTH the search box and the message composer from the same
  // Quill widget, and both carry data-qa="texty_input". The only thing telling
  // them apart is role: combobox for search, textbox for the composer. Matching
  // on data-qa alone will happily type your message into the search bar.
  composer: '[data-qa="message_input"] [role="textbox"], [data-qa="texty_input"][role="textbox"]',
  composerBox: '[data-qa="message_input"]',
  // Cmd+K opens the unified search dialog. Its field is a contenteditable div,
  // NOT an <input>, so fill() does nothing — it has to be typed into.
  switcherBox: '[data-qa="texty_input"][role="combobox"], [role="combobox"][aria-label="Query"]',
  switcherRow: '[role="option"]',
  // Conversation header — used to PROVE we opened the right DM before typing.
  header: '[data-qa="channel_name"], [data-qa="channel_name_button"], .p-view_header__title',
  // "Send now". Clicking this beats pressing Enter: it cannot be hijacked by
  // whatever holds focus, and it ignores the Enter-vs-Shift+Enter preference.
  sendButton: '[data-qa="texty_send_button"]',
  // Slack stacks dismissible banners (unsupported browser, enable notifications)
  // that steal focus and shrink the composer.
  bannerClose: '[data-qa="banner_close_btn"]',
  // Autocomplete popup for a trailing @, #, or :.
  suggestions: '[role="listbox"], [class*="autocomplete"] [role="option"]',
  // One rendered message row. The id embeds Slack's message ts, which is the
  // only stable per-message handle — text can repeat, positions shift.
  msgRow: '[data-qa="virtual-list-item"][id^="message-list_"]',
  // The "..." overflow INSIDE a message's hover toolbar. Note that
  // [data-qa="message-actions"] is the whole 264px toolbar, not this button —
  // clicking that lands on a gap between the reaction icons.
  moreActions: '[data-qa="more_message_actions"]',
  // An existing reaction pill. Its aria reads "N reactions, react with <name>
  // emoji", which is the only place the emoji's identity is exposed.
  reactji: '[data-qa="reactji"]',
  // Opens the emoji picker: the first lives in the hover toolbar, the second in
  // the reaction bar of a message that already has reactions.
  addReaction: '[data-qa="add_reaction"], [data-qa="add_reaction_button"]',
  emojiInput: '[data-qa="emoji_picker_input"]',
  // Signed-out markers.
  signedOut: '[data-qa="signin_button"], [data-qa="signin_form"], form[action*="signin"], #email',
  // Signed-in shell.
  shell: '[data-qa="channel_sidebar"], [data-qa="workspace_actions"], .p-client_container, [data-qa="message_input"]',
};

// ---------------------------------------------------------------- utilities

// Thrown rather than exiting on the spot. process.exit() inside a command body
// skips every `finally`, so the browser context was being abandoned instead of
// closed — and an exiting function cannot be asserted on from a test.
class ExitError extends Error {
  constructor(msg, code) {
    super(msg);
    this.name = 'ExitError';
    this.exitCode = code;
  }
}

function die(msg, code = 1) {
  throw new ExitError(msg, code);
}

function log(msg) {
  if (!QUIET) console.error(`slack-send: ${msg}`);
}

let QUIET = false;

function ensureDirs() {
  for (const d of [STATE_DIR, PROFILE_DIR, SHOT_DIR]) {
    fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  }
  // The profile holds a live Slack session cookie. Keep it owner-only.
  try { fs.chmodSync(STATE_DIR, 0o700); } catch (_) {}
}

async function shot(page, label) {
  try {
    const p = path.join(SHOT_DIR, `${label}-${Date.now()}.png`);
    await page.screenshot({ path: p, fullPage: false });
    return p;
  } catch (_) {
    return null;
  }
}

async function failWithShot(page, msg) {
  const p = await shot(page, 'error');
  die(`${msg}${p ? `\n  screenshot: ${p}` : ''}`);
}

// Slack renders the same conceptual element under several data-qa values across
// releases. Take the first locator that actually resolves to a visible node.
async function firstVisible(page, selector, timeout = UI_TIMEOUT) {
  const loc = page.locator(selector).first();
  await loc.waitFor({ state: 'visible', timeout });
  return loc;
}

function norm(s) {
  return (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

// ---------------------------------------------------------------- browser

// Chromium reports "HeadlessChrome" in its UA, and Slack serves that a stripped
// "unsupported browser" client with no composer. Present the normal Chrome UA.
// Bump the major version when the bundled Chromium moves (see `status` output).
const UA_MAJOR = '140';
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  `(KHTML, like Gecko) Chrome/${UA_MAJOR}.0.0.0 Safari/537.36`;

async function launch({ headless }) {
  ensureDirs();
  // channel:'chromium' selects the full Chromium build running Chrome's new
  // headless mode. The default headless path uses chromium_headless_shell,
  // which Slack's web client serves a degraded/unsupported experience to.
  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless,
    channel: 'chromium',
    viewport: { width: 1512, height: 945 },
    locale: 'en-US',
    timezoneId: Intl.DateTimeFormat().resolvedOptions().timeZone,
    userAgent: headless ? USER_AGENT : undefined,
    args: ['--disable-blink-features=AutomationControlled'],
  });
  ctx.setDefaultTimeout(UI_TIMEOUT);
  ctx.setDefaultNavigationTimeout(NAV_TIMEOUT);
  // navigator.webdriver is the other obvious automation tell.
  await ctx.addInitScript(() => {
    try {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    } catch (_) {}
  });
  const page = ctx.pages()[0] || (await ctx.newPage());
  return { ctx, page };
}

async function gotoClient(page) {
  await page.goto(CLIENT_URL, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
  // Slack boots asynchronously; wait for either the app shell or a signin form.
  await Promise.race([
    page.locator(SEL.shell).first().waitFor({ state: 'visible', timeout: NAV_TIMEOUT }),
    page.locator(SEL.signedOut).first().waitFor({ state: 'visible', timeout: NAV_TIMEOUT }),
  ]).catch(() => {});
}

// Dismiss Slack's stacked notice banners. They shrink the composer and, worse,
// put a focusable "Learn more" link in the tab order — a stray Enter opened the
// Help panel instead of sending during testing.
async function dismissBanners(page) {
  for (let i = 0; i < 4; i++) {
    const btn = page.locator(SEL.bannerClose).first();
    if ((await btn.count()) === 0 || !(await btn.isVisible().catch(() => false))) break;
    await btn.click({ timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(300);
  }
}

async function isSignedIn(page) {
  if (/\/(signin|signout)\b/.test(page.url())) return false;
  const shell = await page.locator(SEL.shell).first().count();
  if (shell > 0) return true;
  const out = await page.locator(SEL.signedOut).first().count();
  return out === 0 && /app\.slack\.com\/client\/T/.test(page.url());
}

// ------------------------------------------------------------- session / api

// Slack's web client is itself a client of the slack.com/api/* endpoints: every
// action this tool performs by clicking is the UI POSTing to one of them. Those
// calls authenticate with a pair — the xoxc- token the client keeps in
// localStorage under "localConfig_v2", and the `d` cookie — and NEITHER half
// works alone (token without cookie returns not_authed). Harvesting the pair at
// login turns a ~10s Chromium launch into a ~200ms round trip.
//
// The workspace has no Slack API token and cannot install apps; that restriction
// blocks bot tokens, not this path, which is the same one the browser uses.
//
// This pair IS the session, exactly as sensitive as profile/. Written 0600 and
// never logged — print `present`/`missing`, never a value.
const API_BASE = 'https://slack.com/api/';

// Slack rejecting the stored pair is recoverable: callers fall back to the
// browser path and tell the user to re-run `login`. A plain failure is not.
class AuthError extends Error {}

function saveSession(session) {
  ensureDirs();
  fs.writeFileSync(SESSION_FILE, JSON.stringify(session, null, 2) + '\n', { mode: 0o600 });
  // writeFileSync's mode is ignored when the file already exists.
  try { fs.chmodSync(SESSION_FILE, 0o600); } catch (_) {}
}

// What is deployed, and whether the working tree has moved on. The whole point
// of ./install is that cron does not run the file you are editing, so `status`
// has to say which edition is live or you are back to guessing from mtimes.
function deployInfo() {
  let meta = null;
  try {
    meta = JSON.parse(fs.readFileSync(path.join(DEPLOY_DIR, 'VERSION.json'), 'utf8'));
  } catch (_) {
    return null;
  }
  let sourceHash = null;
  try {
    const crypto = require('crypto');
    const buf = fs.readFileSync(meta.source);
    sourceHash = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 12);
  } catch (_) {}
  // An unreadable source is NOT a match — it means the project moved or was
  // deleted, and claiming "matches deploy" there would assert something this
  // function just failed to check.
  return {
    ...meta,
    sourceHash,
    stale: !!(sourceHash && sourceHash !== meta.hash),
    sourceMissing: !sourceHash,
  };
}

function loadSession() {
  try {
    const s = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
    return s && s.token && s.d ? s : null;
  } catch (_) {
    return null;
  }
}

function clearSession() {
  try { fs.unlinkSync(SESSION_FILE); } catch (_) {}
}

// Read the pair out of a live, signed-in context. Returns null if either half is
// absent, which is the normal answer when the session has expired.
async function harvestSession(ctx, page) {
  const cookies = await ctx.cookies();
  const d = cookies.find((c) => c.name === 'd');
  const token = await page
    .evaluate(() => {
      for (let i = 0; i < localStorage.length; i++) {
        const v = localStorage.getItem(localStorage.key(i)) || '';
        const m = v.match(/xoxc-[A-Za-z0-9-]{20,}/);
        if (m) return m[0];
      }
      return null;
    })
    .catch(() => null);
  if (!d || !token) return null;
  const session = { token, d: d.value, team: TEAM_ID, fetchedAt: new Date().toISOString() };
  saveSession(session);
  return session;
}

// POST to one Web API method with the harvested pair. `session` and `fetchImpl`
// are injectable so the unit tests can exercise error mapping offline.
async function apiCall(method, params = {}, opts = {}) {
  if (!/^[a-z]+\.[a-zA-Z]+$/.test(method)) die(`bad api method: ${method}`);
  // Distinguish "not supplied" from "explicitly none". `session || loadSession()`
  // would let a caller that passes null silently pick up the ambient session.json
  // — which also made this untestable once a real one existed on disk.
  const s = 'session' in opts ? opts.session : loadSession();
  const fetchImpl = opts.fetchImpl;
  if (!s) throw new AuthError('no saved session — run `slack-send login`');

  const body = new URLSearchParams({ token: s.token });
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) body.set(k, String(v));
  }

  const res = await (fetchImpl || fetch)(API_BASE + method, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded; charset=utf-8',
      // Both halves of the pair travel on every call.
      cookie: `d=${s.d}`,
      'user-agent': USER_AGENT,
    },
    body: body.toString(),
  });

  // Slack signals throttling with a real 429 plus Retry-After seconds; the JSON
  // body is empty in that case, so check status before parsing.
  if (res.status === 429) {
    const wait = res.headers && res.headers.get ? res.headers.get('retry-after') : null;
    die(`api ${method}: rate limited, retry after ${wait || '?'}s`);
  }

  const json = await res.json().catch(() => null);
  if (!json) die(`api ${method}: non-JSON response (HTTP ${res.status})`);
  if (!json.ok && isAuthError(json.error)) {
    throw new AuthError(`slack rejected the saved session (${json.error}) — run \`slack-send login\``);
  }
  return json;
}

// The errors that mean "this pair is dead", as opposed to "this call was wrong".
function isAuthError(err) {
  return ['not_authed', 'invalid_auth', 'token_revoked', 'token_expired', 'account_inactive'].includes(err);
}

// Slack's API returns raw message markup, not the rendered text the DOM path
// scrapes: links arrive as <url|label> or <url>, mentions as <@U123>, and &<>
// are entity-escaped. Normalise to something that reads like the UI *and* still
// contains bare URLs, so callers can parse links out of it.
function slackTextToPlain(raw) {
  if (!raw) return '';
  return String(raw)
    // <url|label> -> label (url), so the URL survives for a caller to parse
    .replace(/<(https?:\/\/[^|>]+)\|([^>]*)>/g, (_, url, label) => `${label} (${url})`)
    .replace(/<(https?:\/\/[^>]+)>/g, '$1')
    .replace(/<mailto:([^|>]+)(\|[^>]*)?>/g, '$1')
    .replace(/<@([UW][A-Z0-9]+)(\|[^>]*)?>/g, '@$1')
    .replace(/<#(C[A-Z0-9]+)\|([^>]*)>/g, '#$2')
    .replace(/<!(here|channel|everyone)>/g, '@$1')
    // entities last: a literal &lt; in the source must not become a fake tag
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

// Choose one conversation from the API's list. Mirrors openConversation's rule:
// be sure, or refuse. Returns { id, name } or throws with the candidates.
function pickConversation(candidates, query, { exactOnly = false } = {}) {
  const q = norm(query).replace(/^[#@]/, '');
  const byName = (c) => norm(c.name || '').replace(/^[#@]/, '');
  // An exact name, or any of a user's aliases (display name, real name).
  const names = (c) => [byName(c), ...(c.alt || []).map((a) => norm(a))];
  const exact = candidates.filter((c) => names(c).includes(q));
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) die(`"${query}" matches ${exact.length} conversations by exact name — pass an id`, 2);
  if (exactOnly) return null;
  const partial = candidates.filter((c) => byName(c).includes(q));
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) {
    const names = partial.slice(0, 8).map((c) => c.name).join(', ');
    die(`"${query}" is ambiguous: ${names}${partial.length > 8 ? ', …' : ''} — be more specific`, 2);
  }
  return null;
}

// Page a cursor-based endpoint until `want` items or the end. Slack caps page
// size well below what it advertises for session tokens, so always follow the
// cursor rather than asking for one big page.
async function apiPaged(method, params, key, want, opts) {
  const out = [];
  let cursor;
  for (let i = 0; i < 20; i++) {
    const res = await apiCall(method, { ...params, limit: 200, cursor }, opts);
    if (!res.ok) die(`api ${method}: ${res.error || 'failed'}`);
    out.push(...(res[key] || []));
    cursor = res.response_metadata && res.response_metadata.next_cursor;
    if (!cursor || (want && out.length >= want)) break;
  }
  return out;
}

// Resolve a recipient to a conversation id. This is the HTTP path's answer to
// openConversation's chokepoint: instead of proving after the fact which row
// Enter hit, we address the conversation by id and it cannot be wrong. The
// caller still prints what resolved, so a mistake is visible before it acts.
async function resolveConversation(to, opts) {
  if (/^[CDG][A-Z0-9]{6,}$/.test(to)) return { id: to, name: to };

  const chanList = await apiPaged('conversations.list',
    { types: 'public_channel,private_channel,mpim', exclude_archived: true }, 'channels', 0, opts);
  const chans = chanList.map((c) => ({ id: c.id, name: c.name }));

  // Precedence matters. A bare name like "bob" is a PERSON, but Slack's
  // generated mpdm names ("mpdm-alice--carol--bob-1") contain it as a substring, so
  // a substring pass over channels first matches eight group DMs and refuses.
  // Order: exact channel -> exact person -> fuzzy channel.
  const exactChan = pickConversation(chans, to, { exactOnly: true });
  if (exactChan) return exactChan;

  if (!to.startsWith('#')) {
    const users = await apiPaged('users.list', {}, 'members', 0, opts);
    const cands = users
      .filter((u) => !u.deleted)
      .map((u) => ({ id: u.id, name: u.name, alt: [(u.profile || {}).display_name, u.real_name].filter(Boolean) }));
    const who = pickConversation(cands, to, { exactOnly: true });
    if (who) {
          const im = await apiCall('conversations.open', { users: who.id }, opts);
      if (!im.ok) die(`conversations.open failed for ${who.name}: ${im.error}`);
      return { id: im.channel.id, name: who.name, user: who.id };
    }
  }

  const who = pickConversation(chans, to);
  if (!who) die(`no channel or user matches "${to}"`, 2);
  return who;
}

// A message's display text is not always m.text. File uploads post with an
// EMPTY text and the filename in m.files — the DOM path shows those rows, so
// dropping them here would hide messages that `react`/`delete` must still be
// able to target. Link-unfurl attachments are the same story.
function messageText(m) {
  const t = slackTextToPlain(m.text);
  if (t) return t;
  const files = (m.files || []).map((f) => f.name || f.title || f.filetype).filter(Boolean);
  if (files.length) return files.join(', ');
  const att = (m.attachments || [])
    .map((a) => slackTextToPlain(a.fallback || a.text || a.title))
    .filter(Boolean);
  if (att.length) return att.join(' | ');
  return '';
}

// Resolving a name costs a full conversations.list AND users.list page-through
// — ~2s, dwarfing the ~200ms history call it exists to serve. A script polling
// the same channel pays that on every run, so cache it.
//
// A channel id is stable across renames, so the entry stays valid for a long
// time; the risk is a name later pointing at a DIFFERENT channel. Two guards:
// entries expire, and any channel_not_found drops the entry and re-resolves.
const CONV_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function loadConvCache() {
  try { return JSON.parse(fs.readFileSync(CONV_CACHE_FILE, 'utf8')); } catch (_) { return {}; }
}

function saveConvCache(cache) {
  ensureDirs();
  try {
    fs.writeFileSync(CONV_CACHE_FILE, JSON.stringify(cache, null, 2) + '\n', { mode: 0o600 });
  } catch (_) {}
}

function forgetConversation(to) {
  const cache = loadConvCache();
  if (cache[norm(to)]) { delete cache[norm(to)]; saveConvCache(cache); }
}

function cachedConversation(to) {
  const hit = loadConvCache()[norm(to)];
  if (!hit || !hit.id) return null;
  if (Date.now() - (hit.at || 0) > CONV_CACHE_TTL_MS) return null;
  // `user` must survive: verifyConversation compares it for DMs, and dropping
  // it here made every DM fail verification and re-resolve on every call.
  return { id: hit.id, name: hit.name || to, user: hit.user || null, cached: true };
}

// openConversation reads which row Enter will act on and aborts on mismatch —
// CLAUDE.md's safety chokepoint. The http path has no rows, so a cached id is
// the ONLY thing standing between a write and the wrong channel. Prove the id
// still denotes what the name claimed before trusting it to write.
async function verifyConversation(conv, opts) {
  const info = await apiCall('conversations.info', { channel: conv.id }, opts);
  if (!info.ok || !info.channel) return false;
  const ch = info.channel;
  if (ch.is_im) {
    // A DM has no name; it is identified by who is on the other end.
    if (conv.user) return ch.user === conv.user;
    // No expected user means either a raw D-id the caller typed (nothing to
    // compare against) or a stale entry from before ids were recorded — and a
    // stale one must be re-resolved rather than trusted.
    return conv.name === conv.id;
  }
  return norm(ch.name || '') === norm(conv.name || '');
}

async function resolveConversationCached(to, opts) {
  const hit = cachedConversation(to);
  if (hit) {
    if (await verifyConversation(hit, opts)) return hit;
    log(`cached id for "${to}" no longer matches — re-resolving`);
    forgetConversation(to);
  }
  const conv = await resolveConversation(to, opts);
  const cache = loadConvCache();
  cache[norm(to)] = { id: conv.id, name: conv.name, user: conv.user || null, at: Date.now() };
  saveConvCache(cache);
  return conv;
}

// Read history by name, healing a stale cache entry rather than failing on it.
async function historyByName(to, want, selfId, opts) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const conv = await resolveConversationCached(to, opts);
    try {
      return { conv, rows: await historyViaApi(conv.id, want, selfId, opts) };
    } catch (e) {
      const stale = /channel_not_found|is_archived/.test(String((e && e.message) || ''));
      if (!stale || attempt === 1) throw e;
      log(`cached id for "${to}" is stale — re-resolving`);
      forgetConversation(to);
    }
  }
}

// Newest-first from Slack; returned oldest-first to match the DOM path's order.
async function historyViaApi(channel, want, selfId, opts) {
  const msgs = await apiPaged('conversations.history', { channel }, 'messages', want, opts);
  // Filter BEFORE slicing. Slicing first and filtering after silently returns
  // fewer rows than asked for, and the DOM path does not behave that way —
  // collectMessages accumulates filtered rows until it has `want`. The two
  // paths have to agree on coverage or the --no-api fallback is not equivalent.
  return msgs
    .map((m) => ({
      ts: m.ts,
      text: messageText(m),
      reactions: (m.reactions || []).map((r) => r.name),
      // The DOM path can only tell yours apart via aria-pressed; here the API
      // hands us the reactor list outright.
      reactionsMine: (m.reactions || []).filter((r) => (r.users || []).includes(selfId)).map((r) => r.name),
    }))
    .filter((m) => m.text || m.reactions.length)
    .slice(0, want)
    .sort((a, b) => Number(a.ts) - Number(b.ts));
}

// ------------------------------------------------------------- http writes

// The write side of the fast path. Each helper returns the SAME shape as its
// browser twin so callers can swap paths without reshaping results.

// reactOne's central hazard does not exist here. Clicking a reaction pill
// toggles YOUR reaction, so removing one you do not own silently ADDS yours —
// which is why the DOM path must check aria-pressed first. reactions.add and
// reactions.remove only ever touch your own, so "someone else's reaction"
// simply comes back as no_reaction and is skipped.
async function reactViaApi(channel, ts, emoji, remove, opts) {
  const res = await apiCall(remove ? 'reactions.remove' : 'reactions.add',
    { channel, timestamp: ts, name: emoji }, opts);
  if (res.ok) return { ts, ok: true };
  // Both of these mean "the end state you asked for already holds".
  if (res.error === 'already_reacted') return { ts, ok: true, skipped: true, why: 'already has it' };
  if (res.error === 'no_reaction') return { ts, ok: true, skipped: true, why: 'not present (or not yours)' };
  if (res.error === 'message_not_found') return { ts, ok: false, why: 'message not found' };
  if (res.error === 'invalid_name') return { ts, ok: false, why: `no emoji named "${emoji}"` };
  return { ts, ok: false, why: res.error || 'failed' };
}

// chat.delete only ever deletes your own message; someone else's returns
// cant_delete_message rather than succeeding.
async function deleteViaApi(channel, ts, opts) {
  const res = await apiCall('chat.delete', { channel, ts }, opts);
  if (res.ok) return { ts, ok: true };
  if (res.error === 'message_not_found') return { ts, ok: false, why: 'message not found' };
  if (res.error === 'cant_delete_message') return { ts, ok: false, why: 'not yours to delete' };
  return { ts, ok: false, why: res.error || 'failed' };
}

// Newlines need no special handling here. The DOM path must send each one as
// Shift+Enter or every line posts as a separate message; chat.postMessage takes
// the text whole.
async function sendViaApi(channel, text, opts) {
  const res = await apiCall('chat.postMessage', {
    channel,
    text,
    // Post as the user, matching what the web client does.
    as_user: true,
  }, opts);
  if (res.ok) return { ok: true, ts: res.ts };
  return { ok: false, why: res.error || 'failed' };
}

// ---------------------------------------------------------------- commands

async function cmdLogin() {
  const { ctx, page } = await launch({ headless: false });
  try {
    await gotoClient(page);
    if (await isSignedIn(page)) {
      const session = await harvestSession(ctx, page).catch(() => null);
      log('already signed in' + (session ? '; api credentials refreshed.' : '.'));
      return;
    }
    console.error(
      'slack-send: a browser window is open. Sign in to your Slack workspace there.\n' +
      'slack-send: this window IS the saved session — do not close it manually;\n' +
      'slack-send: it closes itself once sign-in is detected (waiting up to 5 min).'
    );
    await page.locator(SEL.shell).first().waitFor({ state: 'visible', timeout: 300000 });
    // Let Slack flush its session cookies to the profile before we tear down.
    await page.waitForTimeout(3000);
    log('signed in; session saved to ' + PROFILE_DIR);
    // Harvest the api pair while the context is open and known-good. Failure is
    // not fatal: the browser path still works, we just lose the fast path.
    const session = await harvestSession(ctx, page).catch(() => null);
    log(session ? 'api credentials saved to ' + SESSION_FILE : 'api credentials not found — browser path only');
  } finally {
    await ctx.close();
  }
}

async function cmdStatus() {
  const { ctx, page } = await launch({ headless: true });
  try {
    await gotoClient(page);
    const signedIn = await isSignedIn(page);
    if (!signedIn) {
      const p = await shot(page, 'status');
      console.log('signed in : no');
      console.log('profile   : ' + PROFILE_DIR);
      if (p) console.log('screenshot: ' + p);
      console.log('\nRun `slack-send login` to authenticate.');
      process.exitCode = 3;
      return;
    }
    const m = page.url().match(/\/client\/(T[A-Z0-9]+)/);
    console.log('signed in : yes');
    console.log('workspace : ' + (m ? m[1] : 'unknown'));
    console.log('url       : ' + page.url());
    console.log('profile   : ' + PROFILE_DIR);
    console.log('ua        : ' + (await page.evaluate(() => navigator.userAgent)));
    console.log('config    : ' + CONFIG_FILE + (TEAM_ID ? ` (team=${TEAM_ID})` : ' (no team pinned)'));
    // Report the api pair by presence and age only — never the values.
    const dep = deployInfo();
    if (dep) {
      console.log(`deployed  : ${dep.hash}  ${dep.deployedAt}${dep.git ? '  git ' + dep.git : ''}   <- what cron runs`);
      const verdict = dep.sourceMissing
        ? `source not readable at ${dep.source} — moved? re-run ./install there`
        : dep.stale
          ? 'AHEAD of deploy — run ./install'
          : 'matches deploy';
      console.log(`source    : ${dep.sourceHash || '(missing)'}  ${verdict}`);
    }
    const sess = loadSession();
    if (!sess) {
      console.log('api creds : none — run `slack-send login` to harvest them');
    } else {
      const live = await apiCall('auth.test', {}, { session: sess }).catch((e) => ({ ok: false, error: e.message }));
      const age = sess.fetchedAt ? `, saved ${sess.fetchedAt}` : '';
      console.log(`api creds : ${live.ok ? 'valid' : 'STALE (' + (live.error || 'rejected') + ')'}${age}`);
    }
  } finally {
    await ctx.close();
  }
}

// Open a conversation via the quick switcher and PROVE which one landed.
// Returns { title, picked } — the header text after navigation, and the text of
// the row that Enter actually acted on.
async function openConversation(page, to, force) {
  // Escape first: a leftover overlay swallows the Cmd+K.
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(200);
  await page.keyboard.press('Meta+k');

  let box;
  try {
    box = await firstVisible(page, SEL.switcherBox, UI_TIMEOUT);
  } catch (_) {
    await failWithShot(page, 'the quick switcher (Cmd+K) never opened.');
  }

  // Cmd+K focuses the field itself; click only if something stole that focus.
  const focused = await box.evaluate((el) => el === document.activeElement).catch(() => false);
  if (!focused) {
    await box.click();
    await page.waitForTimeout(150);
  }
  await page.keyboard.type(to, { delay: 40 });

  // Results are debounced server-side with no load event to await, so wait for
  // a row to render, then settle briefly while ranking stabilises.
  try {
    await page.locator(SEL.switcherRow).first().waitFor({ state: 'visible', timeout: UI_TIMEOUT });
  } catch (_) {
    await failWithShot(page, `the quick switcher returned no match for "${to}".`);
  }
  await page.waitForTimeout(1200);

  // Which row will Enter take? The combobox names it via aria-activedescendant;
  // absent that, Slack acts on the first row. Checking this BEFORE pressing
  // Enter is what stops a mis-ranked result from DMing the wrong person.
  const picked = await page.evaluate((rowSel) => {
    const cb = document.querySelector('[role="combobox"]');
    const id = cb && cb.getAttribute('aria-activedescendant');
    const el = (id && document.getElementById(id)) || document.querySelector(rowSel);
    if (!el) return null;
    return { aria: el.getAttribute('aria-label') || '', text: el.innerText || '' };
  }, SEL.switcherRow);

  const aria = norm(picked && picked.aria);
  const rowText = norm(picked && picked.text).replace(/\s*enter$/, '');
  log(`switcher will open: "${rowText || '(unreadable)'}"`);

  if (!force) {
    if (!picked) {
      await failWithShot(page, 'could not read the highlighted switcher row. Nothing was sent. Re-run with --force to override.');
    }
    // When nothing matches, Slack's top row is a "Search for: <query>" escape
    // hatch. Its label echoes the query, so a naive substring check passes and
    // Enter runs a search instead of opening a conversation.
    //
    // Do NOT try to whitelist by aria-label shape: DM rows read "Alice, Direct
    // Message" but channel rows are a bare "acme-corp" with no suffix, so
    // requiring one silently rejects every channel. Reject the search row itself.
    if (/^(search for|show results for)\b/i.test(rowText)) {
      await failWithShot(page, `no conversation matched "${to}" — the switcher only offered a search. Nothing was sent.`);
    }
    const needle = norm(to).replace(/^[@#]/, '');
    if (!aria.includes(needle) && !rowText.includes(needle)) {
      await failWithShot(page, `recipient mismatch: asked for "${to}" but the switcher highlighted "${rowText}". Nothing was sent. Re-run with --force to override.`);
    }
  }

  await page.keyboard.press('Enter');

  // Composer presence means a conversation actually opened.
  try {
    await firstVisible(page, SEL.composer, UI_TIMEOUT);
  } catch (_) {
    await failWithShot(page, `opened something for "${to}" but found no message composer.`);
  }
  await page.waitForTimeout(800);

  let title = '';
  try {
    title = await page.locator(SEL.header).first().innerText({ timeout: 5000 });
  } catch (_) {
    title = '';
  }
  return { title: norm(title), picked: rowText };
}

async function cmdSend(opts) {
  const { to, text, force, dryRun, noApi } = opts;

  if (!noApi) {
    try {
      const conv = await resolveConversationCached(to);
      // The id is unambiguous, but the user typed a name — say which one it
      // became BEFORE posting. This is the http path's answer to the DOM
      // path's two-stage recipient guard.
      log(`sending to ${conv.name} (${conv.id})${conv.cached ? ' [cached id]' : ''}`);
      if (dryRun) {
        console.log(`dry run — not sent. Would post ${String(text).length} char(s) to ${conv.name}.`);
        return;
      }
      const r = await sendViaApi(conv.id, text);
      if (!r.ok) die(`send failed: ${r.why}`);
      log(`sent (ts ${r.ts})`);
      return;
    } catch (e) {
      if (!(e instanceof AuthError)) throw e;
      log(`${e.message}; falling back to the browser path`);
    }
  }

  const { ctx, page } = await launch({ headless: true });
  try {
    await gotoClient(page);
    if (!(await isSignedIn(page))) {
      await shot(page, 'signedout');
      die('not signed in. Run `slack-send login` first.', 3);
    }

    const { title } = await openConversation(page, to, force);
    log(`opened conversation: "${title || '(header unreadable)'}"`);

    // Second guard, after navigation: the header must also name the target. The
    // pre-Enter check can pass while a slow route lands somewhere else.
    if (!force && title) {
      const needle = norm(to).replace(/^[@#]/, '');
      if (!title.includes(needle)) {
        await failWithShot(page, `recipient mismatch after opening: asked for "${to}" but landed on "${title}". Nothing was sent. Re-run with --force to override.`);
      }
    }

    await dismissBanners(page);

    let composer;
    try {
      composer = await firstVisible(page, SEL.composer, UI_TIMEOUT);
    } catch (_) {
      await failWithShot(page, `no message composer on the page opened for "${to}" — that is not a conversation. Nothing was sent.`);
    }
    await composer.click();
    await page.waitForTimeout(250);

    // Every keystroke below goes through the composer locator rather than
    // page.keyboard, so it cannot land in a banner link or the search box.
    const focused = await composer.evaluate((el) => el === document.activeElement).catch(() => false);
    if (!focused) await failWithShot(page, 'could not put the cursor in the message composer.');

    // Clear any leftover draft so it cannot be prepended to this message.
    await composer.press('Meta+a');
    await composer.press('Backspace');
    await page.waitForTimeout(200);

    // Newlines must be Shift+Enter or each one sends a separate message.
    const lines = String(text).split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (i > 0) {
        await composer.press('Shift+Enter');
        await page.waitForTimeout(80);
      }
      if (lines[i]) await page.keyboard.type(lines[i], { delay: 8 });
    }
    await page.waitForTimeout(500);

    // A trailing @, #, or : leaves an autocomplete menu open that would swallow
    // the send. Only Escape when one is actually showing — a needless Escape
    // blurs the composer.
    if (await page.locator(SEL.suggestions).first().isVisible().catch(() => false)) {
      await composer.press('Escape');
      await page.waitForTimeout(250);
    }

    if (dryRun) {
      const p = await shot(page, 'dryrun');
      log('dry run — message typed but NOT sent.');
      if (p) log('screenshot: ' + p);
      return;
    }

    const sendBtn = page.locator(SEL.sendButton).first();
    if (await sendBtn.isVisible().catch(() => false)) {
      await sendBtn.click();
    } else {
      await composer.press('Enter');
    }

    // Confirm delivery: Slack empties the composer only after the message is
    // accepted. A still-full composer means it did not go.
    let sent = false;
    for (let i = 0; i < 24; i++) {
      await page.waitForTimeout(250);
      const left = norm(await composer.innerText().catch(() => ''));
      if (left === '') { sent = true; break; }
    }
    if (!sent) {
      await failWithShot(page, 'the composer never cleared — the message did not send.');
    }

    // Slack debounce-saves the composer to the server as a draft while you type,
    // and deletes that draft over the websocket only after the send. Closing the
    // browser too early lands the message BUT strands the draft, which then
    // reappears with an unread badge. Long messages cross the save debounce, so
    // this shows up intermittently. Let the delete flush, then clear any residue.
    await page.waitForTimeout(2500);
    const residue = norm(await composer.innerText().catch(() => ''));
    if (residue) {
      log('clearing a draft Slack restored after the send');
      await composer.click();
      await composer.press('Meta+a');
      await composer.press('Backspace');
      await page.waitForTimeout(1500);
    }
    log(`sent to ${title || to}`);
  } finally {
    await ctx.close();
  }
}

// slack-send shot [recipient] — screenshot the client, optionally after opening
// a conversation. Read-only: it never touches the composer.
async function cmdShot(to, { force } = {}) {
  const { ctx, page } = await launch({ headless: true });
  try {
    await gotoClient(page);
    if (!(await isSignedIn(page))) die('not signed in. Run `slack-send login` first.', 3);
    if (to) await openConversation(page, to, !!force);
    else await page.waitForTimeout(2500);
    console.log(await shot(page, 'view'));
  } finally {
    await ctx.close();
  }
}

// A ts like "1787965302.984349" goes into a CSS id selector, where the dot would
// otherwise read as a class separator.
function rowSelector(ts) {
  return `#message-list_${String(ts).replace('.', '\\.')}`;
}

// Enumerate the rendered messages. Slack virtualises the list, so this sees only
// what is currently in the DOM — call loadOlder() first to reach back further.
//
// The same container holds date separators ("Today"), dividers and a bottom
// spacer. Real messages are the ones whose ts is <10 digits>.<6 digits>; the
// separators use a 13-digit epoch-millis id instead.
async function listMessages(page) {
  const rows = await page.evaluate((sel) => {
    return [...document.querySelectorAll(sel)].map((el) => ({
      ts: el.id.replace('message-list_', ''),
      text: (el.innerText || '').replace(/\s+/g, ' ').trim(),
      // "1 reaction, react with white check mark emoji" -> white_check_mark.
      // The label is IDENTICAL whether or not you are one of the reactors —
      // aria-pressed is the only thing that says the reaction is yours.
      reactions: [...el.querySelectorAll('[data-qa="reactji"]')]
        .map((r) => {
          const m = (r.getAttribute('aria-label') || '').match(/react with (.+?) emoji/i);
          return m ? m[1].trim().replace(/\s+/g, '_') : null;
        })
        .filter(Boolean),
      reactionsMine: [...el.querySelectorAll('[data-qa="reactji"]')]
        .filter((r) => r.getAttribute('aria-pressed') === 'true' || /c-reaction--reacted/.test(r.className || ''))
        .map((r) => {
          const m = (r.getAttribute('aria-label') || '').match(/react with (.+?) emoji/i);
          return m ? m[1].trim().replace(/\s+/g, '_') : null;
        })
        .filter(Boolean),
    }));
  }, SEL.msgRow);
  return rows.filter((r) => /^\d{10}\.\d{6}$/.test(r.ts) && r.text);
}

// Scroll back until a specific message is mounted; virtualisation means an older
// row simply is not in the DOM until it has been paged in.
// Scroll until a specific message is mounted. It may be either side of the
// current viewport — after reacting to an old message the pane is parked up in
// history, and anything newer is BELOW — so search up, then sweep back down.
// A one-directional search silently fails on every target newer than the last.
async function ensureRendered(page, ts) {
  const sel = rowSelector(ts);
  // Wait for the virtual list to finish mounting BEFORE deciding to scroll.
  // Right after a conversation opens the list is briefly empty; treating that
  // as "not here" sends the pane scrolling up and away from rows that were
  // about to render exactly where it started.
  for (let i = 0; i < 15; i++) {
    if (await page.locator(sel).count()) return true;
    await page.waitForTimeout(400);
  }
  await hoverMessagePane(page);

  for (let i = 0; i < 22; i++) {
    await page.mouse.wheel(0, -1200);
    await page.waitForTimeout(450);
    if (await page.locator(sel).count()) return true;
  }
  // Twice as many steps coming back, since we may have started part-way up.
  for (let i = 0; i < 46; i++) {
    await page.mouse.wheel(0, 1200);
    await page.waitForTimeout(450);
    if (await page.locator(sel).count()) return true;
  }
  return false;
}

// Drive the pane back to the newest message.
//
// Re-opening the conversation is NOT enough: within a session Slack restores the
// scroll offset you left the channel at, so after collectMessages has paged back
// through history you land right back up there. Scroll down until the bottom
// spacer is visible and the last row stops changing.
async function scrollToLatest(page) {
  await hoverMessagePane(page);
  let last = '';
  for (let i = 0; i < 90; i++) {
    const cur = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('[data-qa="virtual-list-item"]')];
      return rows.length ? rows[rows.length - 1].id : '';
    });
    const atBottom = await page.locator('#message-list_bottomSpacer').isVisible().catch(() => false);
    if (atBottom && cur === last && cur) return true;
    last = cur;
    await page.mouse.wheel(0, 2400);
    await page.waitForTimeout(350);
  }
  return false;
}

// Add (or with remove:true, toggle off) one emoji reaction on one message.
async function reactOne(page, ts, emoji, remove) {
  if (!(await ensureRendered(page, ts))) return { ts, ok: false, why: 'message not reachable by scrolling' };
  const row = page.locator(rowSelector(ts));
  await row.scrollIntoViewIfNeeded().catch(() => {});
  await row.hover();
  await page.waitForTimeout(400);

  const existing = row.locator(`${SEL.reactji}[aria-label*="react with ${emoji.replace(/_/g, ' ')} emoji"]`).first();
  const has = (await existing.count()) > 0;
  // Clicking a pill toggles YOUR reaction. If the pill is someone else's, a
  // click adds yours rather than removing theirs — so removal must check first.
  const mine = has
    ? await existing.evaluate(
        (el) => el.getAttribute('aria-pressed') === 'true' || /c-reaction--reacted/.test(el.className || '')
      ).catch(() => false)
    : false;

  if (has && !remove) return { ts, ok: true, skipped: true, why: 'already has it' };
  if (remove) {
    if (!has) return { ts, ok: true, skipped: true, why: 'not present' };
    if (!mine) return { ts, ok: true, skipped: true, why: "someone else's reaction — left alone" };
    await existing.click();
    await page.waitForTimeout(1000);
    if (await row.locator(`${SEL.reactji}[aria-label*="react with ${emoji.replace(/_/g, ' ')} emoji"][aria-pressed="true"]`).count()) {
      return { ts, ok: false, why: 'reaction still present after clicking' };
    }
    return { ts, ok: true };
  }

  const btn = row.locator(SEL.addReaction).first();
  if ((await btn.count()) === 0) return { ts, ok: false, why: 'no add-reaction button' };
  await btn.click();
  await page.waitForTimeout(1200);

  const input = page.locator(SEL.emojiInput).first();
  if ((await input.count()) === 0) {
    await page.keyboard.press('Escape').catch(() => {});
    return { ts, ok: false, why: 'emoji picker did not open' };
  }
  await input.fill(emoji);
  await page.waitForTimeout(1200);

  // Exact data-name match. A prefix match would pick repeat_one over repeat.
  const opt = page.locator(`[data-qa="emoji_list_item"][data-name="${emoji}"]`).first();
  if ((await opt.count()) === 0) {
    await page.keyboard.press('Escape').catch(() => {});
    return { ts, ok: false, why: `no emoji named "${emoji}"` };
  }
  await opt.click();
  await page.waitForTimeout(1400);

  const now = row.locator(`${SEL.reactji}[aria-label*="react with ${emoji.replace(/_/g, ' ')} emoji"]`);
  if ((await now.count()) === 0) return { ts, ok: false, why: 'reaction did not appear' };
  return { ts, ok: true };
}

// slack-send react <recipient> --ts a,b --emoji NAME [--remove] [--yes]
async function cmdReact(to, { tsList, emoji, remove, yes, force, noApi }) {
  if (!to || !tsList || !tsList.length || !emoji) {
    die('usage: slack-send react <recipient> --ts <ts,ts> --emoji <name> [--remove] [--yes]', 2);
  }

  if (!noApi) {
    try {
      const conv = await resolveConversationCached(to);
      console.log(`${remove ? 'Removing' : 'Adding'} :${emoji}: on ${tsList.length} message(s) in ${conv.name} (${conv.id})`);
      if (!yes) {
        console.log('Nothing changed. Re-run with --yes to apply.');
        return;
      }
      let ok = 0;
      for (const ts of tsList) {
        const r = await reactViaApi(conv.id, ts, emoji, remove);
        if (r.ok) ok++;
        log(`${r.ok ? (r.skipped ? 'skipped' : 'reacted') : 'FAILED '} ${ts}${r.why ? '  — ' + r.why : ''}`);
      }
      console.log(`\n${ok}/${tsList.length} ok`);
      if (ok !== tsList.length) process.exitCode = 1;
      return;
    } catch (e) {
      if (!(e instanceof AuthError)) throw e;
      log(`${e.message}; falling back to the browser path`);
    }
  }

  const { ctx, page } = await launch({ headless: true });
  try {
    await gotoClient(page);
    if (!(await isSignedIn(page))) die('not signed in. Run `slack-send login` first.', 3);
    await openConversation(page, to, !!force);
    await dismissBanners(page);
    await page.waitForTimeout(1500);

    console.log(`${remove ? 'Removing' : 'Adding'} :${emoji}: on ${tsList.length} message(s) in ${to}`);
    if (!yes) {
      console.log('Nothing changed. Re-run with --yes to apply.');
      return;
    }
    let ok = 0;
    for (const ts of tsList) {
      const r = await reactOne(page, ts, emoji, remove);
      if (r.ok) ok++;
      log(`${r.ok ? (r.skipped ? 'skipped' : 'reacted') : 'FAILED '} ${ts}${r.why ? '  — ' + r.why : ''}`);
    }
    console.log(`\n${ok}/${tsList.length} ok`);
    if (ok !== tsList.length) process.exitCode = 1;
  } finally {
    await ctx.close();
  }
}

// Park the pointer inside the message pane so wheel events go to the message
// list. Deriving this from the first rendered row is wrong: once the pane is
// scrolled up that row sits ABOVE the viewport with a negative y, putting the
// pointer outside the window, where the wheel does nothing at all.
async function hoverMessagePane(page) {
  const vp = page.viewportSize() || { width: 1512, height: 945 };
  const x = Math.max(600, Math.min(vp.width - 80, Math.round(vp.width * 0.62)));
  const y = Math.max(200, Math.min(vp.height - 220, Math.round(vp.height * 0.5)));
  await page.mouse.move(x, y);
}

// Collect at least `want` messages, scrolling back through history as needed.
//
// Two Slack behaviours make the naive version wrong. First, every ancestor of
// the list has overflow:hidden — it is a custom virtualised scroller, so setting
// scrollTop does nothing and only real wheel events page older messages in.
// Second, scrolling up UNMOUNTS the newest rows, so reading the DOM once at the
// end loses them. Accumulate by ts across every step instead.
async function collectMessages(page, want) {
  const acc = new Map();
  const add = (rows) => rows.forEach((r) => acc.set(r.ts, r));
  add(await listMessages(page));

  // Put the pointer over the message pane so the wheel goes to the right list.
  await hoverMessagePane(page);

  for (let i = 0; i < 40 && acc.size < want; i++) {
    await page.mouse.wheel(0, -1200);
    await page.waitForTimeout(700);
    const before = acc.size;
    add(await listMessages(page));
    if (acc.size === before) {
      await page.waitForTimeout(1400); // one grace round for a slow page-in
      add(await listMessages(page));
      if (acc.size === before) break; // top of history
    }
  }
  return [...acc.values()].sort((a, b) => Number(a.ts) - Number(b.ts));
}

// One shared printer so the HTTP and DOM paths cannot drift in output format.
function printMessages(rows, want, full) {
  if (rows.length < want) log(`only ${rows.length} message(s) reachable`);
  for (const m of rows.slice(-want)) {
    const rx = m.reactions.length ? `  [${m.reactions.join(' ')}]` : '';
    console.log(`${m.ts}  ${full ? m.text : m.text.slice(0, 120)}${rx}`);
  }
}

async function listViaApi(to, want) {
  const me = await apiCall('auth.test');
  if (!me.ok) die(`auth.test: ${me.error}`);
  const { conv, rows } = await historyByName(to, want, me.user_id);
  // Say what resolved before printing: the id is unambiguous, but the user
  // asked for a name, and they should see which one it became.
  log(`reading ${conv.name} (${conv.id}) over http${conv.cached ? ' [cached id]' : ''}`);
  return rows;
}

// slack-send list <recipient> [--limit N] [--full] — print the most recent N.
//
// Tries the HTTP path first: a browser launch costs ~10s against ~200ms for a
// round trip, and conversations.history pages with a cursor instead of wheeling
// a virtual scroller. Falls back to the DOM path when the saved pair is dead or
// absent, so `list` keeps working on a machine that has never run the harvest.
async function cmdList(to, { limit, full, force, noApi }) {
  if (!to) die('usage: slack-send list <recipient> [--limit N] [--full]', 2);
  const want = limit || 20;

  if (!noApi) {
    try {
      const rows = await listViaApi(to, want);
      printMessages(rows, want, full);
      return;
    } catch (e) {
      if (!(e instanceof AuthError)) throw e;
      log(`${e.message}; falling back to the browser path`);
    }
  }

  const { ctx, page } = await launch({ headless: true });
  try {
    await gotoClient(page);
    if (!(await isSignedIn(page))) die('not signed in. Run `slack-send login` first.', 3);
    await openConversation(page, to, !!force);
    await dismissBanners(page);
    await page.waitForTimeout(1500);

    const all = await collectMessages(page, want);
    printMessages(all, want, full);
  } finally {
    await ctx.close();
  }
}

async function deleteMessage(page, ts) {
  if (!(await ensureRendered(page, ts))) return { ts, ok: false, why: 'message not reachable by scrolling' };
  const row = page.locator(rowSelector(ts));
  await row.scrollIntoViewIfNeeded().catch(() => {});
  await row.hover();
  await page.waitForTimeout(500);

  const more = row.locator(SEL.moreActions).first();
  if ((await more.count()) === 0) return { ts, ok: false, why: 'no overflow button' };
  await more.click();
  await page.waitForTimeout(900);

  const item = page.getByRole('menuitem', { name: /delete message/i }).first();
  if ((await item.count()) === 0) {
    await page.keyboard.press('Escape').catch(() => {});
    return { ts, ok: false, why: '"Delete message" not offered (not your message?)' };
  }
  await item.click();
  await page.waitForTimeout(900);

  const dialog = page.locator('[role="dialog"]').last();
  const confirm = dialog.getByRole('button', { name: /^delete$/i }).first();
  if ((await confirm.count()) === 0) {
    await page.keyboard.press('Escape').catch(() => {});
    return { ts, ok: false, why: 'no confirm button in the delete dialog' };
  }
  await confirm.click();

  try {
    await row.waitFor({ state: 'detached', timeout: 10000 });
  } catch (_) {
    return { ts, ok: false, why: 'row still present after confirming' };
  }
  await page.waitForTimeout(400);
  return { ts, ok: true };
}

// slack-send delete <recipient> [--match X] [--ts a,b] [--yes]
// Lists matches and deletes NOTHING unless --yes is given. Deletion is permanent.
async function cmdDelete(to, { match, tsList, yes, force, noApi, limit }) {
  if (!to) die('usage: slack-send delete <recipient> [--match "<text>"] [--ts a,b] [--yes]', 2);

  if (!noApi) {
    try {
      const me = await apiCall('auth.test');
      if (!me.ok) die(`auth.test: ${me.error}`);
      // The DOM path can only match against rows Slack has rendered — roughly
      // the most recent few dozen. Keep the http window deliberately close to
      // that: a --match that suddenly reached ten times further back would
      // delete far more than the same command did yesterday.
      const window = limit || 50;
      const { conv, rows } = await historyByName(to, window, me.user_id);
      let targets = rows;
      if (tsList && tsList.length) {
        const want = new Set(tsList);
        targets = rows.filter((m) => want.has(m.ts));
        const missing = tsList.filter((t) => !rows.some((m) => m.ts === t));
        if (missing.length) log(`not in the last ${window} message(s): ${missing.join(', ')}`);
      } else if (match) {
        const needle = match.toLowerCase();
        targets = rows.filter((m) => m.text.toLowerCase().includes(needle));
      } else {
        die('refusing to target every message — pass --match or --ts.', 2);
      }

      console.log(`${targets.length} message(s) matched in ${conv.name} (${conv.id}), within the last ${window}:`);
      for (const m of targets) console.log(`  ${m.ts}  ${m.text.slice(0, 90)}`);
      if (!targets.length) return;

      if (!yes) {
        console.log('\nNothing deleted. Re-run with --yes to delete these permanently.');
        return;
      }
      const ordered = [...targets].sort((a, b) => Number(b.ts) - Number(a.ts));
      const results = [];
      for (const m of ordered) {
        const r = await deleteViaApi(conv.id, m.ts);
        results.push(r);
        log(`${r.ok ? 'deleted' : 'FAILED '} ${m.ts}  ${m.text.slice(0, 60)}${r.ok ? '' : '  — ' + r.why}`);
      }
      const okCount = results.filter((r) => r.ok).length;
      console.log(`\ndeleted ${okCount}/${results.length}`);
      if (okCount !== results.length) process.exitCode = 1;
      return;
    } catch (e) {
      if (!(e instanceof AuthError)) throw e;
      log(`${e.message}; falling back to the browser path`);
    }
  }

  const { ctx, page } = await launch({ headless: true });
  try {
    await gotoClient(page);
    if (!(await isSignedIn(page))) die('not signed in. Run `slack-send login` first.', 3);
    await openConversation(page, to, !!force);
    await dismissBanners(page);
    await page.waitForTimeout(1200);

    const all = await listMessages(page);
    let targets = all;
    if (tsList && tsList.length) {
      const want = new Set(tsList);
      targets = all.filter((m) => want.has(m.ts));
      const missing = tsList.filter((t) => !all.some((m) => m.ts === t));
      if (missing.length) log(`not currently rendered: ${missing.join(', ')}`);
    } else if (match) {
      const needle = match.toLowerCase();
      targets = all.filter((m) => m.text.toLowerCase().includes(needle));
    } else {
      die('refusing to target every message — pass --match or --ts.', 2);
    }

    if (!targets.length) {
      console.log('no messages matched.');
      return;
    }

    console.log(`${targets.length} message(s) matched:`);
    for (const m of targets) console.log(`  ${m.ts}  ${m.text.slice(0, 90)}`);

    if (!yes) {
      console.log('\nNothing deleted. Re-run with --yes to delete these permanently.');
      return;
    }

    // Delete newest-first: removing a row reflows the list, and going bottom-up
    // keeps the rows above it at stable positions.
    const ordered = [...targets].sort((a, b) => Number(b.ts) - Number(a.ts));
    const results = [];
    for (const m of ordered) {
      const r = await deleteMessage(page, m.ts);
      results.push(r);
      log(`${r.ok ? 'deleted' : 'FAILED '} ${m.ts}  ${m.text.slice(0, 60)}${r.ok ? '' : '  — ' + r.why}`);
    }
    const okCount = results.filter((r) => r.ok).length;
    console.log(`\ndeleted ${okCount}/${results.length}`);
    if (okCount !== results.length) process.exitCode = 1;
  } finally {
    await ctx.close();
  }
}

// ---------------------------------------------------------------- argv

// Flags that take a value. The value is NOT --prefixed, so a naive
// filter(a => !a.startsWith('--')) leaves it in the positional list, where it
// can be mistaken for the recipient — `delete --match "x" bob` resolved the
// recipient to "x". Consuming values here is what keeps positionals honest.
const VALUE_FLAGS = new Set([
  '--match', '--ts', '--emoji', '--limit',
]);

function parseArgv(argv) {
  const opts = Object.create(null);
  const bools = new Set();
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { positional.push(...argv.slice(i + 1)); break; }
    if (a.startsWith('--')) {
      let name = a;
      let val = null;
      const eq = a.indexOf('=');
      if (eq > 2) { name = a.slice(0, eq); val = a.slice(eq + 1); }
      if (VALUE_FLAGS.has(name)) {
        if (val === null) val = argv[++i];
        if (val === undefined) die(`${name} needs a value`, 2);
        opts[name] = val;
      } else {
        bools.add(name);
      }
    } else if (a.length > 1 && a.startsWith('-')) {
      bools.add(a); // short flags such as -h
    } else {
      positional.push(a);
    }
  }
  return { opts, bools, positional };
}

function intOpt(opts, name, def) {
  if (!(name in opts)) return def;
  const n = Number(opts[name]);
  if (!Number.isInteger(n) || n <= 0) {
    die(`${name} must be a positive integer (got "${opts[name]}")`, 2);
  }
  return n;
}

// Emoji names reach CSS selectors and API parameters, and may come from a
// script or environment rather than a human. Keep them to what Slack allows.
function emojiName(raw, flag) {
  const e = String(raw == null ? '' : raw).replace(/^:|:$/g, '');
  if (!/^[a-z0-9_+-]+$/.test(e)) die(`${flag}: invalid emoji name "${raw}"`, 2);
  return e;
}

// ---------------------------------------------------------------- cli

function usage() {
  console.error(`usage:
  slack-send <recipient> "<message>"   send a message (headless)
  slack-send <recipient>               read the message from stdin
  slack-send login                     one-time interactive sign-in
  slack-send status                    report session state
  slack-send shot [recipient]          screenshot the client (read-only)
  slack-send list <recipient> [--limit N] [--full] [--no-api]
                                       print the most recent N messages (default 20)
  slack-send react <recipient> --ts <ts,ts> --emoji <name> [--remove] [--yes]
                                       add/remove an emoji reaction
  slack-send delete <recipient> --match "<text>" [--yes]
  slack-send delete <recipient> --ts <ts,ts> [--yes]
                                       list matching messages, then delete them

options:
  --yes        actually apply changes; without it these commands only report
  --dry-run    (send) type the message but do not press Enter
  --force      skip the recipient guard / allow a leading "/" in a message
  --quiet      suppress progress chatter on stderr
  --no-api     skip the http fast path and drive the browser instead

notes:
  Option values are consumed by the parser, so flag order does not matter.
  Destructive commands verify the opened conversation matches <recipient>
  unless --force is given.

state    : ${STATE_DIR}
team     : ${TEAM_ID || '(none pinned — set SLACK_SEND_TEAM or config.json)'}`);
}

const COMMANDS = {
  login: (a) => cmdLogin(),
  status: (a) => cmdStatus(),
  shot: (a) => cmdShot(a.positional[1], { force: a.bools.has('--force') }),
  list: (a) => cmdList(a.positional[1], {
    limit: intOpt(a.opts, '--limit', null),
    full: a.bools.has('--full'),
    force: a.bools.has('--force'),
    noApi: a.bools.has('--no-api'),
  }),
  react: (a) => cmdReact(a.positional[1], {
    tsList: a.opts['--ts'] ? a.opts['--ts'].split(',').map((t) => t.trim()).filter(Boolean) : null,
    emoji: emojiName(a.opts['--emoji'], '--emoji'),
    remove: a.bools.has('--remove'),
    yes: a.bools.has('--yes'),
    force: a.bools.has('--force'),
    noApi: a.bools.has('--no-api'),
  }),
  delete: (a) => cmdDelete(a.positional[1], {
    match: a.opts['--match'] || null,
    tsList: a.opts['--ts'] ? a.opts['--ts'].split(',').map((t) => t.trim()).filter(Boolean) : null,
    yes: a.bools.has('--yes'),
    force: a.bools.has('--force'),
    noApi: a.bools.has('--no-api'),
    limit: intOpt(a.opts, '--limit', null),
  }),
};

async function main() {
  const argv = process.argv.slice(2);
  const a = parseArgv(argv);
  QUIET = a.bools.has('--quiet');

  if (a.bools.has('--help') || a.bools.has('-h') || a.positional.length === 0) {
    usage();
    process.exit(a.positional.length === 0 && !a.bools.has('--help') && !a.bools.has('-h') ? 2 : 0);
  }

  const sub = a.positional[0];
  if (Object.prototype.hasOwnProperty.call(COMMANDS, sub)) return COMMANDS[sub](a);

  // Default form: slack-send <recipient> "<message>"
  const to = a.positional[0];
  let text = a.positional.slice(1).join(' ');
  if (!text) {
    if (process.stdin.isTTY) die('no message given (pass one as an argument or pipe it in).', 2);
    text = fs.readFileSync(0, 'utf8').replace(/\n+$/, '');
  }
  if (!text.trim()) die('refusing to send an empty message.', 2);

  // A leading slash is a Slack command, not text. Almost never intended here.
  if (text.trimStart().startsWith('/') && !a.bools.has('--force')) {
    die('message starts with "/" — Slack would run it as a slash command. Re-run with --force if that is intended.', 2);
  }

  return cmdSend({
    to,
    text,
    force: a.bools.has('--force'),
    dryRun: a.bools.has('--dry-run'),
    noApi: a.bools.has('--no-api'),
  });
}

// Only run when executed directly, so tests can require() the pure helpers.
if (require.main === module) {
  main().catch((e) => {
    if (e instanceof ExitError) {
      console.error(`slack-send: ${e.message}`);
      process.exit(e.exitCode);
    }
    console.error(`slack-send: ${e && e.stack ? e.stack : String(e)}`);
    process.exit(1);
  });
}

module.exports = {
  parseArgv, intOpt, emojiName, norm, rowSelector, COMMANDS, ExitError,
  // The browser plumbing, exported so a separate tool can drive the same
  // client without duplicating the selector layer or the login handling.
  launch, gotoClient, isSignedIn, dismissBanners, log, die, STATE_DIR,
  // exported so a smoke test can assert the internal helpers still exist
  listMessages, ensureRendered, reactOne, deleteMessage, collectMessages,
  scrollToLatest, hoverMessagePane, openConversation,
  // session / api fast path
  apiCall, harvestSession, loadSession, saveSession, clearSession, isAuthError, AuthError,
  slackTextToPlain, pickConversation, resolveConversation, historyViaApi,
  apiPaged, listViaApi, printMessages, messageText,
  resolveConversationCached, cachedConversation, forgetConversation,
  loadConvCache, saveConvCache, historyByName,
  reactViaApi, deleteViaApi, sendViaApi, verifyConversation, deployInfo,
};
