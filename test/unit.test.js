'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const m = require('../send.js');

// ---------------------------------------------------------------- argv

test('option values are consumed, not treated as positionals', () => {
  // The regression: `delete --match "final check" bob` used to resolve the
  // recipient to "final check", and delete ran without the recipient guard.
  const a = m.parseArgv(['delete', '--match', 'final check', 'bob', '--yes']);
  assert.deepStrictEqual(a.positional, ['delete', 'bob']);
  assert.strictEqual(a.opts['--match'], 'final check');
  assert.ok(a.bools.has('--yes'));
});

test('flag order does not change the recipient', () => {
  const before = m.parseArgv(['delete', '--match', 'x', 'bob', '--yes']);
  const after = m.parseArgv(['delete', 'bob', '--match', 'x', '--yes']);
  assert.strictEqual(before.positional[1], after.positional[1]);
  assert.strictEqual(before.positional[1], 'bob');
});

test('react flags do not swallow the recipient', () => {
  const a = m.parseArgv(['react', '--ts', '123.456', '--emoji', 'x', 'bob']);
  assert.strictEqual(a.positional[1], 'bob');
  assert.strictEqual(a.opts['--ts'], '123.456');
});

test('--flag=value form is supported', () => {
  const a = m.parseArgv(['list', 'bob', '--limit=5']);
  assert.strictEqual(a.opts['--limit'], '5');
  assert.strictEqual(a.positional[1], 'bob');
});

test('-- ends option parsing', () => {
  const a = m.parseArgv(['bob', '--', '--not-a-flag']);
  assert.deepStrictEqual(a.positional, ['bob', '--not-a-flag']);
});

test('short flags land in bools, not positionals', () => {
  const a = m.parseArgv(['-h']);
  assert.ok(a.bools.has('-h'));
  assert.strictEqual(a.positional.length, 0);
});

// ---------------------------------------------------------------- validation

test('intOpt rejects non-numeric values instead of failing open', () => {
  assert.strictEqual(m.intOpt({ '--max': '5' }, '--max', null), 5);
  assert.strictEqual(m.intOpt({}, '--max', 7), 7);
  // "--max abc" used to become NaN -> falsy -> burst cap silently disabled.
  for (const bad of ['abc', '0', '-1', '2.5']) {
    assert.throws(() => m.intOpt({ '--max': bad }, '--max', null), /must be a positive integer/);
  }
});

test('emojiName strips colons and rejects selector-breaking input', () => {
  assert.strictEqual(m.emojiName(':repeat:', '--emoji'), 'repeat');
  assert.strictEqual(m.emojiName('white_check_mark', '--emoji'), 'white_check_mark');
  assert.strictEqual(m.emojiName('+1', '--emoji'), '+1');
  for (const bad of ['a"]', 'x y', '', 'REPEAT', 'a<b']) {
    assert.throws(() => m.emojiName(bad, '--emoji'), /invalid emoji name/);
  }
});

// ---------------------------------------------------------------- misc pure

test('rowSelector escapes the dot in a message ts', () => {
  // Unescaped, the dot reads as a class separator and matches nothing.
  assert.strictEqual(m.rowSelector('1787965302.984349'), '#message-list_1787965302\\.984349');
});

test('norm collapses whitespace and lowercases', () => {
  assert.strictEqual(m.norm('  Alice   Example\n'), 'alice example');
  assert.strictEqual(m.norm(null), '');
});

// ------------------------------------------------------------- session / api

const FAKE = { token: 'xoxc-test-token', d: 'xoxd-test-cookie' };

// Minimal fetch double: records the request, replays a canned response.
function fakeFetch(payload, { status = 200, headers = {} } = {}) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, opts });
    return {
      status,
      headers: { get: (k) => headers[k.toLowerCase()] ?? null },
      json: async () => payload,
    };
  };
  fn.calls = calls;
  return fn;
}

test('apiCall sends both halves of the credential pair', async () => {
  const f = fakeFetch({ ok: true, user: 'bob' });
  const out = await m.apiCall('auth.test', {}, { session: FAKE, fetchImpl: f });
  assert.strictEqual(out.ok, true);

  const { url, opts } = f.calls[0];
  assert.strictEqual(url, 'https://slack.com/api/auth.test');
  assert.strictEqual(opts.method, 'POST');
  // the cookie half
  assert.strictEqual(opts.headers.cookie, 'd=xoxd-test-cookie');
  // the token half, in the form body
  assert.match(opts.body, /(^|&)token=xoxc-test-token(&|$)/);
});

test('apiCall url-encodes params and drops null/undefined', async () => {
  const f = fakeFetch({ ok: true });
  await m.apiCall('chat.postMessage',
    { channel: 'D123', text: 'a&b c', thread_ts: null, unfurl: undefined },
    { session: FAKE, fetchImpl: f });
  const body = f.calls[0].opts.body;
  assert.match(body, /channel=D123/);
  assert.match(body, /text=a%26b\+c/);
  assert.doesNotMatch(body, /thread_ts/);
  assert.doesNotMatch(body, /unfurl/);
});

test('apiCall throws AuthError on a dead pair, not a generic failure', async () => {
  for (const err of ['not_authed', 'invalid_auth', 'token_revoked', 'account_inactive']) {
    const f = fakeFetch({ ok: false, error: err });
    await assert.rejects(
      () => m.apiCall('auth.test', {}, { session: FAKE, fetchImpl: f }),
      (e) => e instanceof m.AuthError && new RegExp(err).test(e.message),
      `${err} should map to AuthError`);
  }
});

test('apiCall returns non-auth errors for the caller to handle', async () => {
  const f = fakeFetch({ ok: false, error: 'channel_not_found' });
  const out = await m.apiCall('chat.postMessage', { channel: 'nope' }, { session: FAKE, fetchImpl: f });
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.error, 'channel_not_found');
});

test('apiCall rejects a malformed method name before any request', async () => {
  const f = fakeFetch({ ok: true });
  await assert.rejects(
    () => m.apiCall('chat.postMessage; rm -rf /', {}, { session: FAKE, fetchImpl: f }),
    (e) => e instanceof m.ExitError);
  assert.strictEqual(f.calls.length, 0, 'must not have sent anything');
});

test('apiCall without a session throws AuthError rather than sending a naked call', async () => {
  const f = fakeFetch({ ok: true });
  await assert.rejects(
    () => m.apiCall('auth.test', {}, { session: null, fetchImpl: f }),
    (e) => e instanceof m.AuthError);
});

test('apiCall surfaces rate limiting with the retry hint', async () => {
  const f = fakeFetch(null, { status: 429, headers: { 'retry-after': '30' } });
  await assert.rejects(
    () => m.apiCall('conversations.history', { channel: 'C1' }, { session: FAKE, fetchImpl: f }),
    (e) => e instanceof m.ExitError && /rate limited.*30/.test(e.message));
});

test('isAuthError distinguishes a dead pair from a bad request', () => {
  assert.ok(m.isAuthError('invalid_auth'));
  assert.ok(m.isAuthError('token_expired'));
  assert.ok(!m.isAuthError('channel_not_found'));
  assert.ok(!m.isAuthError(undefined));
});

// ------------------------------------------------------- api text / resolution

test('slackTextToPlain keeps the bare URL, so callers can still parse links', () => {
  const raw = 'see <https://example.com/org/repo/pull/3041|PR 3041> please';
  const out = m.slackTextToPlain(raw);
  assert.match(out, /https:\/\/example\.com\/org\/repo\/pull\/3041/);
  assert.match(out, /PR 3041/);
});
test('slackTextToPlain unwraps angle-bracket links and mentions', () => {
  assert.strictEqual(m.slackTextToPlain('<https://x.test/a>'), 'https://x.test/a');
  assert.strictEqual(m.slackTextToPlain('hi <@U123ABC> there'), 'hi @U123ABC there');
  assert.strictEqual(m.slackTextToPlain('in <#C123ABC|general>'), 'in #general');
  assert.strictEqual(m.slackTextToPlain('<!here> look'), '@here look');
});

test('slackTextToPlain decodes entities after link parsing, not before', () => {
  // &lt;not-a-tag&gt; must survive as literal text rather than becoming markup
  assert.strictEqual(m.slackTextToPlain('a &lt;b&gt; c &amp; d'), 'a <b> c & d');
});

test('slackTextToPlain collapses whitespace and tolerates empty input', () => {
  assert.strictEqual(m.slackTextToPlain('a\n\n  b\t c'), 'a b c');
  assert.strictEqual(m.slackTextToPlain(''), '');
  assert.strictEqual(m.slackTextToPlain(null), '');
  assert.strictEqual(m.slackTextToPlain(undefined), '');
});

test('pickConversation prefers an exact name over a substring', () => {
  const cands = [{ id: 'C1', name: 'updates' }, { id: 'C2', name: 'team-updates' }];
  assert.strictEqual(m.pickConversation(cands, 'updates').id, 'C1');
});

test('pickConversation resolves a unique substring', () => {
  const cands = [{ id: 'C1', name: 'team-updates' }, { id: 'C2', name: 'random' }];
  assert.strictEqual(m.pickConversation(cands, 'updates').id, 'C1');
});

test('pickConversation refuses an ambiguous match rather than guessing', () => {
  const cands = [{ id: 'C1', name: 'team-updates' }, { id: 'C2', name: 'team-updates-old' }];
  assert.throws(() => m.pickConversation(cands, 'updates'),
    (e) => e instanceof m.ExitError && /ambiguous/.test(e.message));
});

test('pickConversation exactOnly refuses substrings — the mpdm trap', () => {
  // "bob" appears inside Slack's generated group-DM names; an exactOnly pass
  // must not match them, or resolving a person dies as "ambiguous".
  const mpdms = [
    { id: 'G1', name: 'mpdm-alice--carol--bob-1' },
    { id: 'G2', name: 'mpdm-bob--dave--erin-1' },
  ];
  assert.strictEqual(m.pickConversation(mpdms, 'bob', { exactOnly: true }), null);
  // without exactOnly the same input is ambiguous, which is why order matters
  assert.throws(() => m.pickConversation(mpdms, 'bob'), (e) => e instanceof m.ExitError);
});

test('pickConversation matches a user alias, not just the handle', () => {
  const users = [{ id: 'U1', name: 'asmith', alt: ['Alice', 'Alice Smith'] }];
  assert.strictEqual(m.pickConversation(users, 'alice', { exactOnly: true }).id, 'U1');
  assert.strictEqual(m.pickConversation(users, 'Alice Smith', { exactOnly: true }).id, 'U1');
});

test('pickConversation returns null when nothing matches, so callers can try users', () => {
  assert.strictEqual(m.pickConversation([{ id: 'C1', name: 'general' }], 'nobody'), null);
});

test('pickConversation ignores a leading # or @ and is case-insensitive', () => {
  const cands = [{ id: 'C1', name: 'General' }];
  assert.strictEqual(m.pickConversation(cands, '#general').id, 'C1');
});

test('messageText falls back to filenames — file uploads have empty text', () => {
  // Regression: the DOM path lists these rows, so the http path must too, or
  // react/delete cannot target a message the user can plainly see.
  assert.strictEqual(m.messageText({ text: '', files: [{ name: 'image.png' }] }), 'image.png');
  assert.strictEqual(
    m.messageText({ files: [{ name: 'a.gif' }, { title: 'b.pdf' }] }), 'a.gif, b.pdf');
});

test('messageText prefers real text over attachments', () => {
  assert.strictEqual(
    m.messageText({ text: 'hello', files: [{ name: 'x.png' }] }), 'hello');
});

test('messageText falls back to an attachment fallback last', () => {
  assert.strictEqual(m.messageText({ text: '', attachments: [{ fallback: 'a preview' }] }), 'a preview');
  assert.strictEqual(m.messageText({ text: '' }), '');
});

// ------------------------------------------------------------- conv id cache

const fsx = require('node:fs');
const pathx = require('node:path');
const osx = require('node:os');

// The cache lives under SLACK_SEND_HOME, which send.js reads at require time,
// so point it at a temp dir before requiring. (unit.test.js requires send.js at
// the top, so instead we exercise the pure cache functions against whatever
// STATE_DIR resolved to and clean up after ourselves.)
test('conversation cache round-trips and expires', () => {
  const before = m.loadConvCache();
  try {
    m.saveConvCache({ 'test-chan': { id: 'C_TEST', name: 'test-chan', at: Date.now() } });
    const hit = m.cachedConversation('test-chan');
    assert.strictEqual(hit.id, 'C_TEST');
    assert.strictEqual(hit.cached, true);

    // an entry older than the TTL is ignored rather than trusted
    m.saveConvCache({ 'test-chan': { id: 'C_TEST', name: 'test-chan', at: 1 } });
    assert.strictEqual(m.cachedConversation('test-chan'), null);

    // and a malformed entry does not throw
    m.saveConvCache({ 'test-chan': { name: 'no id' } });
    assert.strictEqual(m.cachedConversation('test-chan'), null);
  } finally {
    m.saveConvCache(before);
  }
});

test('cachedConversation preserves user, so DM verification can succeed', () => {
  // Regression: dropping `user` here made verifyConversation fall through to
  // the name===id branch, so every DM re-resolved on every single call.
  const before = m.loadConvCache();
  try {
    m.saveConvCache({ bob: { id: 'D1', name: 'bob', user: 'U_BOB', at: Date.now() } });
    assert.strictEqual(m.cachedConversation('bob').user, 'U_BOB');
  } finally {
    m.saveConvCache(before);
  }
});

test('forgetConversation drops only the named entry', () => {
  const before = m.loadConvCache();
  try {
    m.saveConvCache({
      keep: { id: 'C_KEEP', at: Date.now() },
      drop: { id: 'C_DROP', at: Date.now() },
    });
    m.forgetConversation('drop');
    const after = m.loadConvCache();
    assert.ok(after.keep, 'keep survived');
    assert.ok(!after.drop, 'drop removed');
  } finally {
    m.saveConvCache(before);
  }
});

test('cache lookup is case-insensitive, matching resolution', () => {
  const before = m.loadConvCache();
  try {
    m.saveConvCache({ 'team-updates': { id: 'C1', at: Date.now() } });
    assert.strictEqual(m.cachedConversation('Team-Updates').id, 'C1');
  } finally {
    m.saveConvCache(before);
  }
});

// ------------------------------------------------------------- http writes

test('reactViaApi maps already_reacted to a skip, not a failure', async () => {
  const f = fakeFetch({ ok: false, error: 'already_reacted' });
  const r = await m.reactViaApi('C1', '1.2', 'repeat', false, { session: FAKE, fetchImpl: f });
  assert.deepStrictEqual({ ok: r.ok, skipped: r.skipped }, { ok: true, skipped: true });
});

test('reactViaApi maps no_reaction to a skip — this is the not-yours case', async () => {
  // The DOM path had to read aria-pressed to avoid ADDING a reaction while
  // trying to remove someone else's. reactions.remove only touches your own,
  // so the same situation simply reports no_reaction.
  const f = fakeFetch({ ok: false, error: 'no_reaction' });
  const r = await m.reactViaApi('C1', '1.2', 'x', true, { session: FAKE, fetchImpl: f });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.skipped, true);
  assert.match(r.why, /not yours|not present/);
});

test('reactViaApi picks the right endpoint for add vs remove', async () => {
  const add = fakeFetch({ ok: true });
  await m.reactViaApi('C1', '1.2', 'repeat', false, { session: FAKE, fetchImpl: add });
  assert.match(add.calls[0].url, /reactions\.add$/);

  const rm = fakeFetch({ ok: true });
  await m.reactViaApi('C1', '1.2', 'repeat', true, { session: FAKE, fetchImpl: rm });
  assert.match(rm.calls[0].url, /reactions\.remove$/);
  // timestamp, not ts, for the reactions family — a silent no-op if wrong
  assert.match(rm.calls[0].opts.body, /timestamp=1\.2/);
});

test('reactViaApi reports a genuine failure as a failure', async () => {
  const f = fakeFetch({ ok: false, error: 'invalid_name' });
  const r = await m.reactViaApi('C1', '1.2', 'nope', false, { session: FAKE, fetchImpl: f });
  assert.strictEqual(r.ok, false);
  assert.match(r.why, /no emoji named/);
});

test('deleteViaApi refuses to claim success on cant_delete_message', async () => {
  const f = fakeFetch({ ok: false, error: 'cant_delete_message' });
  const r = await m.deleteViaApi('C1', '1.2', { session: FAKE, fetchImpl: f });
  assert.strictEqual(r.ok, false);
  assert.match(r.why, /not yours/);
});

test('deleteViaApi sends ts (not timestamp) — the chat family differs', async () => {
  const f = fakeFetch({ ok: true });
  await m.deleteViaApi('C1', '1.2', { session: FAKE, fetchImpl: f });
  assert.match(f.calls[0].opts.body, /(^|&)ts=1\.2(&|$)/);
  assert.match(f.calls[0].url, /chat\.delete$/);
});

test('sendViaApi returns the posted ts on success', async () => {
  const f = fakeFetch({ ok: true, ts: '999.111' });
  const r = await m.sendViaApi('D1', 'hello', { session: FAKE, fetchImpl: f });
  assert.deepStrictEqual(r, { ok: true, ts: '999.111' });
});

test('sendViaApi sends multi-line text whole, no per-line splitting', async () => {
  const f = fakeFetch({ ok: true, ts: '1' });
  await m.sendViaApi('D1', 'line one\nline two', { session: FAKE, fetchImpl: f });
  const body = f.calls[0].opts.body;
  assert.match(body, /text=line\+one%0Aline\+two/);
  assert.strictEqual(f.calls.length, 1, 'one call, not one per line');
});

test('sendViaApi surfaces an error instead of reporting a phantom send', async () => {
  const f = fakeFetch({ ok: false, error: 'channel_not_found' });
  const r = await m.sendViaApi('D1', 'hi', { session: FAKE, fetchImpl: f });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.why, 'channel_not_found');
});

test('verifyConversation rejects an id whose channel name has changed', async () => {
  const f = fakeFetch({ ok: true, channel: { id: 'C1', name: 'some-other-channel' } });
  const ok = await m.verifyConversation({ id: 'C1', name: 'team-updates' },
    { session: FAKE, fetchImpl: f });
  assert.strictEqual(ok, false, 'a mismatched name must not be trusted for writes');
});

test('verifyConversation accepts a matching channel', async () => {
  const f = fakeFetch({ ok: true, channel: { id: 'C1', name: 'team-updates' } });
  assert.strictEqual(
    await m.verifyConversation({ id: 'C1', name: 'team-updates' }, { session: FAKE, fetchImpl: f }),
    true);
});

test('verifyConversation checks the other party for a DM, which has no name', async () => {
  const good = fakeFetch({ ok: true, channel: { id: 'D1', is_im: true, user: 'U_BOB' } });
  assert.strictEqual(
    await m.verifyConversation({ id: 'D1', name: 'bob', user: 'U_BOB' }, { session: FAKE, fetchImpl: good }),
    true);

  const wrong = fakeFetch({ ok: true, channel: { id: 'D1', is_im: true, user: 'U_SOMEONE_ELSE' } });
  assert.strictEqual(
    await m.verifyConversation({ id: 'D1', name: 'bob', user: 'U_BOB' }, { session: FAKE, fetchImpl: wrong }),
    false, 'a DM pointing at a different person must not be trusted');
});

test('verifyConversation re-resolves a legacy DM entry that records no user', async () => {
  const f = fakeFetch({ ok: true, channel: { id: 'D1', is_im: true, user: 'U_BOB' } });
  // name !== id means it was resolved from a name, but no user was stored
  assert.strictEqual(
    await m.verifyConversation({ id: 'D1', name: 'bob' }, { session: FAKE, fetchImpl: f }),
    false, 'an unverifiable DM entry must not be trusted');
  // a raw D-id typed by hand has nothing to compare and is accepted
  const g = fakeFetch({ ok: true, channel: { id: 'D1', is_im: true, user: 'U_ANY' } });
  assert.strictEqual(
    await m.verifyConversation({ id: 'D1', name: 'D1' }, { session: FAKE, fetchImpl: g }), true);
});

test('verifyConversation treats an api failure as unverified, not as fine', async () => {
  const f = fakeFetch({ ok: false, error: 'channel_not_found' });
  assert.strictEqual(
    await m.verifyConversation({ id: 'C1', name: 'x' }, { session: FAKE, fetchImpl: f }), false);
});

// ---------------------------------------------------------------- smoke

test('every subcommand resolves to a function', () => {
  for (const name of ['login', 'status', 'shot', 'list', 'react', 'delete']) {
    assert.strictEqual(typeof m.COMMANDS[name], 'function', `${name} missing`);
  }
});

test('internal helpers used by commands still exist', () => {
  // deleteMessage was once silently removed by an edit and only surfaced when
  // `slack-send delete` was invoked. This catches that class of breakage.
  for (const fn of [
    'listMessages', 'ensureRendered', 'reactOne', 'deleteMessage',
    'collectMessages', 'scrollToLatest', 'hoverMessagePane',
    'openConversation',
    'apiCall', 'harvestSession', 'loadSession', 'saveSession', 'clearSession', 'isAuthError',
    'slackTextToPlain', 'pickConversation', 'resolveConversation', 'historyViaApi',
    'apiPaged', 'listViaApi', 'printMessages', 'messageText',
    'resolveConversationCached', 'cachedConversation', 'forgetConversation', 'historyByName',
    'reactViaApi', 'deleteViaApi', 'sendViaApi', 'verifyConversation', 'deployInfo',
  ]) {
    assert.strictEqual(typeof m[fn], 'function', `${fn} missing`);
  }
});
