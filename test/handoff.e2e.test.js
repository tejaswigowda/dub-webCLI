// Run: npm run test:handoff
// The hand-off end to end, in real Chrome: a fake opener page (an allowed origin, like Strata) opens dub in a popup and drives it with
// postMessage. Covers the collision prompt, cancel, a closed opener, voice listing/validation and byte-identical re-runs.
// The first run downloads the Kokoro q8 model (~92 MB) into .cache/pw-profile; later runs reuse it. Needs Google Chrome installed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DUB_PORT = 5611;
const DUB = `http://127.0.0.1:${DUB_PORT}/`;
const OPENER = 'http://localhost:5699/';   // another origin on the allow-list, like strataeditor.dev
const DEFAULTS = { voice: 'af_heart', tier: 'default', device: 'wasm' };

const SHORT = `1
00:00:00,000 --> 00:00:03,000
Hello there.

2
00:00:03,500 --> 00:00:07,000
This is a short test.
`;
const COLLIDE = `1
00:00:00,000 --> 00:00:00,800
This sentence is far too long to fit inside such a tiny window.

2
00:00:01,000 --> 00:00:04,000
Next.
`;
const LONG = Array.from({ length: 8 }, (_, k) => `${k + 1}\n00:00:${String(k * 5).padStart(2, '0')},000 --> 00:00:${String(k * 5 + 4).padStart(2, '0')},500\nThis is cue number ${k + 1}, spoken in a calm and steady voice.\n`).join('\n');

const OPENER_HTML = `<!doctype html><title>fake strata</title><script>
window.msgs = [];
const hex = (buf) => crypto.subtle.digest('SHA-256', buf).then((d) => [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join(''));
addEventListener('message', async (e) => {
  const m = e.data;
  if (e.source !== window.win || e.origin !== ${JSON.stringify(DUB.slice(0, -1))} || !m || m.webcli !== 1) return;
  const row = { type: m.type, id: m.id, text: m.text, fraction: m.fraction, message: m.message, meta: m.meta, voices: m.voices, defaults: m.defaults, at: performance.now() };
  if (m.type === 'result') {
    const wav = m.files['narration.wav'];
    row.bytes = wav.byteLength;
    row.riff = String.fromCharCode(...new Uint8Array(wav, 0, 4));
    row.sha = await hex(wav);
  }
  window.msgs.push(row);
});
window.openDub = () => {
  window.win = open(${JSON.stringify(DUB)}, 'dub', 'popup=yes,width=560,height=760');
  const t = setInterval(() => { if (window.msgs.some((m) => m.type === 'ready') || window.win.closed) clearInterval(t); else window.win.postMessage({ webcli: 1, type: 'hello' }, ${JSON.stringify(DUB.slice(0, -1))}); }, 300);
};
window.job = (id, args, srt) => {
  const buf = new TextEncoder().encode(srt).buffer;
  window.win.postMessage({ webcli: 1, type: 'job', id, op: 'dub', args, files: { 'subtitles.srt': buf } }, ${JSON.stringify(DUB.slice(0, -1))}, [buf]);
};
window.cancel = (id) => window.win.postMessage({ webcli: 1, type: 'cancel', id }, ${JSON.stringify(DUB.slice(0, -1))});
</script>`;

let server;
let context;

before(async () => {
  server = spawn('node', ['server.js', String(DUB_PORT)], { cwd: ROOT, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.stdout.on('data', (d) => /Serving/.test(String(d)) && resolve());
  });
  context = await chromium.launchPersistentContext(path.join(ROOT, '.cache', 'pw-profile'), { channel: 'chrome', headless: true });
  await context.route(OPENER + '**', (r) => r.fulfill({ contentType: 'text/html', body: OPENER_HTML }));
});

after(async () => {
  await context?.close();
  server?.kill();
});

/** Open the fake opener and dub's popup from it; resolves once dub has said ready. */
async function openPair() {
  const opener = await context.newPage();
  await opener.goto(OPENER);
  const [popup] = await Promise.all([opener.waitForEvent('popup'), opener.evaluate(() => window.openDub())]);
  const errors = [];
  popup.on('pageerror', (e) => errors.push(e.message));
  await opener.waitForFunction(() => window.msgs.some((m) => m.type === 'ready'), null, { timeout: 30_000 });
  return { opener, popup, errors };
}

const sendJob = (opener, id, args, srt) => opener.evaluate(([i, a, s]) => window.job(i, a, s), [id, args, srt]);
const msgs = (opener, id) => opener.evaluate((i) => window.msgs.filter((m) => m.id === i), id);
const waitFor = (opener, id, pred, timeout = 600_000) => opener.waitForFunction(([i, src]) => window.msgs.some((m) => m.id === i && new Function('m', `return (${src})(m)`)(m)), [id, pred.toString()], { timeout, polling: 200 });
const final = async (opener, id) => {
  await waitFor(opener, id, (m) => m.type === 'result' || m.type === 'error');
  return (await msgs(opener, id)).find((m) => m.type === 'result' || m.type === 'error');
};

test('ready lists the voices and the defaults (additive fields)', async () => {
  const { opener, popup } = await openPair();
  const ready = (await opener.evaluate(() => window.msgs.find((m) => m.type === 'ready')));
  assert.deepEqual(ready.defaults, DEFAULTS);
  assert.equal(ready.voices.length, 28);
  assert.deepEqual(Object.keys(ready.voices[0]).sort(), ['accent', 'gender', 'id', 'name']);
  assert.deepEqual(ready.voices[0], { id: 'af_heart', name: 'Heart', accent: 'American', gender: 'F' });
  await opener.close();
  await popup.close();
});

test('an unknown voice, tier or device is an error naming the valid values; nothing is synthesized', async () => {
  const { opener, popup, errors } = await openPair();
  const cases = [
    ['u1', { voice: 'af_hart' }, /Unknown voice "af_hart"\. Valid voices: af_heart, af_alloy/],
    ['u2', { tier: 'q8' }, /Unknown tier "q8"\. Valid tiers: default, better, best, q4/],
    ['u3', { device: 'cpu' }, /Unknown device "cpu"\. Valid devices: wasm/],
  ];
  for (const [id, args, re] of cases) {
    await sendJob(opener, id, args, SHORT);
    const m = await final(opener, id);
    assert.equal(m.type, 'error');
    assert.match(m.message, re);
    assert.deepEqual((await msgs(opener, id)).map((x) => x.type), ['error'], 'no progress, no result');
  }
  assert.deepEqual(errors, []);
  await opener.close();
  await popup.close();
});

test('B.1 collisions: nothing is sent until the user chooses; "Send to Strata anyway" sends the WAV with ok:false; "Don\'t send" is an error naming the problem', async () => {
  const { opener, popup, errors } = await openPair();

  await sendJob(opener, 'c1', {}, COLLIDE);
  const send = popup.getByRole('button', { name: 'Send to Strata anyway' });
  await send.waitFor({ timeout: 600_000 });
  await popup.getByRole('button', { name: "Don't send" }).waitFor();
  await popup.waitForTimeout(1500);
  assert.ok(!(await msgs(opener, 'c1')).some((m) => m.type === 'result' || m.type === 'error'), 'no result or error before the button is pressed');
  assert.match(await popup.locator('#handoffBar').innerText(), /collisions/);

  await send.click();
  const sent = await final(opener, 'c1');
  assert.equal(sent.type, 'result');
  assert.equal(sent.riff, 'RIFF');
  assert.ok(sent.bytes > 44);
  assert.equal(sent.meta.report.ok, false);
  assert.ok(sent.meta.report.collisions >= 1);
  assert.equal(sent.meta.report.wav_sha256, sent.sha, 'the report describes the WAV that was sent');
  assert.match(await popup.locator('#handoffBar').innerText(), /Sent to Strata/);

  await sendJob(opener, 'c2', {}, COLLIDE);
  await popup.getByRole('button', { name: "Don't send" }).click({ timeout: 600_000 });
  const refused = await final(opener, 'c2');
  assert.equal(refused.type, 'error');
  assert.match(refused.message, /\b\d+ collisions?\b.*not sent/);
  assert.ok(!(await msgs(opener, 'c2')).some((m) => m.type === 'result'));
  assert.deepEqual(errors, []);
  await opener.close();
  await popup.close();
});

test('B.2 cancel: the worker stops, the job answers "Cancelled.", the tool is free, and a second job works without reloading', async () => {
  const { opener, popup, errors } = await openPair();

  await sendJob(opener, 'x1', {}, LONG);
  await waitFor(opener, 'x1', (m) => m.type === 'progress' && /^Cue 1 of 8/.test(m.text));
  await opener.evaluate(() => window.cancel('x1'));
  const m = await final(opener, 'x1');
  assert.deepEqual([m.type, m.message], ['error', 'Cancelled.']);
  const cuesAtCancel = (await msgs(opener, 'x1')).filter((x) => x.type === 'progress' && /^Cue /.test(x.text)).length;
  assert.ok(cuesAtCancel < 8, `stopped early (${cuesAtCancel} of 8 cues)`);

  // busy cleared and the worker is idle: no more progress arrives, no result
  await popup.locator('#cancelBtn').waitFor({ state: 'hidden' });
  assert.ok(await popup.locator('#dubBtn').isEnabled());
  await popup.waitForTimeout(4000);
  const after = await msgs(opener, 'x1');
  assert.equal(after.filter((x) => x.type === 'progress' && /^Cue /.test(x.text)).length, cuesAtCancel, 'no cue is synthesized after the cancel');
  assert.ok(!after.some((x) => x.type === 'result'));
  assert.match(await popup.locator('#handoffBar').innerText(), /Cancelled/);

  // cancelling while the "send anyway" prompt is open
  await sendJob(opener, 'x2', {}, COLLIDE);
  await popup.getByRole('button', { name: 'Send to Strata anyway' }).waitFor({ timeout: 600_000 });
  await opener.evaluate(() => window.cancel('x2'));
  const m2 = await final(opener, 'x2');
  assert.deepEqual([m2.type, m2.message], ['error', 'Cancelled.']);
  assert.equal(await popup.getByRole('button', { name: 'Send to Strata anyway' }).count(), 0, 'the prompt is gone');

  // a second job, same page
  await sendJob(opener, 'x3', {}, SHORT);
  const ok = await final(opener, 'x3');
  assert.equal(ok.type, 'result', ok.message);
  assert.equal(ok.riff, 'RIFF');
  assert.equal(ok.meta.report.ok, true);
  assert.deepEqual(errors, []);
  await opener.close();
  await popup.close();
});

test('B.3 opener closed mid-job: the job is aborted, busy clears, nothing throws, postMessage to the closed window is a no-op', async () => {
  const { opener, popup, errors } = await openPair();
  await sendJob(opener, 'w1', {}, LONG);
  await waitFor(opener, 'w1', (m) => m.type === 'progress' && /^Cue 1 of 8/.test(m.text));
  await popup.evaluate(() => { window.heldOpener = window.opener; });   // Chrome nulls window.opener once the opener is gone; serve() holds its own reference
  await opener.close();

  await popup.locator('#cancelBtn').waitFor({ state: 'hidden', timeout: 60_000 });   // the abort reached the worker and busy cleared
  assert.ok(await popup.locator('#dubBtn').isEnabled());
  assert.match(await popup.locator('#handoffBar').innerText(), /Cancelled/);
  const probe = await popup.evaluate(() => {
    try { window.heldOpener.postMessage({ webcli: 1, type: 'progress', id: 'w1' }, '*'); } catch (e) { return `threw: ${e.message}`; }
    return { closed: window.heldOpener.closed };
  });
  assert.deepEqual(probe, { closed: true });
  await popup.waitForTimeout(3000);
  assert.deepEqual(errors, [], 'no uncaught error in the popup');
  await popup.close();
});

test('C.3 same SRT, voice, tier and device: byte-identical WAV, the report says reproducible; absent args are the defaults, not the last job\'s choice', async () => {
  const { opener, popup, errors } = await openPair();
  const run = async (id, args) => {
    await sendJob(opener, id, args, SHORT);
    const m = await final(opener, id);
    assert.equal(m.type, 'result', m.message);
    return m;
  };
  const a = await run('r1', {});
  const b = await run('r2', { voice: 'af_heart', tier: 'default', device: 'wasm' });
  assert.equal(a.sha, b.sha, 'identical bytes');
  assert.equal(a.meta.report.wav_sha256, a.sha);
  assert.equal(a.meta.report.reproducible, true);
  assert.deepEqual([a.meta.voice, a.meta.tier, a.meta.device], ['af_heart', 'default', 'wasm']);
  assert.equal(a.meta.report.model.dtype, 'q8');

  const other = await run('r3', { voice: 'bm_george' });
  assert.equal(other.meta.voice, 'bm_george');
  assert.notEqual(other.sha, a.sha, 'the requested voice is the one used');
  const again = await run('r4', {});
  assert.equal(again.meta.voice, 'af_heart', 'the previous job\'s voice does not stick');
  assert.equal(again.sha, a.sha);
  assert.deepEqual(errors, []);
  await opener.close();
  await popup.close();
});
