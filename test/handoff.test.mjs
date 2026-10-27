// Run: node --test test/handoff.test.mjs
// The popup side of the hand-off (docs/handoff.js, identical in ffmpeg.webcli.app): it answers only the window that opened it, from an
// allowed origin, and only to that origin.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serve, originAllowed, PROTOCOL } from '../docs/handoff.js';

function setup(handlers, { opener = {}, info, watchMs = 5 } = {}) {
  const posts = [];
  const real = { closed: false, postMessage: (msg, origin, transfer) => { if (real.throws) throw new Error('window is closed'); posts.push({ msg, origin, transfer }); } };
  const listeners = [];
  globalThis.window = { opener: opener === null ? null : real, addEventListener: (t, f) => listeners.push(f) };
  const handle = serve({ tool: 't', version: '1', handlers, info, watchMs });
  const send = (data, { source = real, origin = 'https://strataeditor.dev' } = {}) => Promise.all(listeners.map((f) => f({ source, origin, data })));
  return { handle, posts, send, real };
}
const job = (id, op, extra = {}) => ({ webcli: PROTOCOL, type: 'job', id, op, args: {}, files: {}, ...extra });
const tick = () => new Promise((r) => setTimeout(r, 5));

test('origins: Strata, and localhost for development; nothing else', () => {
  assert.ok(originAllowed('https://strataeditor.dev'));
  assert.ok(originAllowed('http://localhost:5599'));
  assert.ok(originAllowed('http://127.0.0.1:8080'));
  assert.ok(!originAllowed('https://evil.example'));
  assert.ok(!originAllowed('https://strataeditor.dev.evil.example'));
  assert.ok(!originAllowed('https://localhost:5599'));
});

test('in a normal tab (no opener) it does nothing', () => {
  const { handle } = setup({ x: async () => ({}) }, { opener: null });
  assert.equal(handle, null);
});

test('it announces itself to its opener, and again on hello', async () => {
  const { posts, send } = setup({ dub: async () => ({}) });
  assert.deepEqual(posts[0].msg, { webcli: 1, type: 'ready', tool: 't', version: '1', ops: ['dub'] });
  await send({ webcli: 1, type: 'hello' });
  assert.equal(posts.filter((p) => p.msg.type === 'ready').length, 2);
});

test('a job runs the handler and the result goes back to the sender origin, buffers transferred', async () => {
  const seen = [];
  const { posts, send } = setup({
    dub: async ({ args, files, progress }) => {
      seen.push([args, Object.keys(files)]);
      progress(0.5, 'half');
      return { files: { 'narration.wav': Uint8Array.of(1, 2, 3).subarray(1) }, meta: { n: 1 } };
    },
  });
  await send(job('a', 'dub', { args: { voice: 'v' }, files: { 'subtitles.srt': new ArrayBuffer(2) } }));
  await tick();
  assert.deepEqual(seen, [[{ voice: 'v' }, ['subtitles.srt']]]);
  const out = posts.filter((p) => p.msg.id === 'a');
  assert.deepEqual(out.map((p) => p.msg.type), ['progress', 'result']);
  assert.ok(out.every((p) => p.origin === 'https://strataeditor.dev'));
  assert.deepEqual(Array.from(new Uint8Array(out[1].msg.files['narration.wav'])), [2, 3], 'a view into a larger buffer is copied, not sent whole');
  assert.equal(out[1].transfer.length, 1);
});

test('a message from another origin, or from another window, is ignored: no reply at all', async () => {
  let ran = 0;
  const { posts, send } = setup({ dub: async () => { ran++; return {}; } });
  const before = posts.length;
  await send(job('b', 'dub'), { origin: 'https://evil.example' });
  await send(job('c', 'dub'), { source: { postMessage() {} } });
  await send({ webcli: 2, type: 'job', id: 'd', op: 'dub' });
  await tick();
  assert.equal(ran, 0);
  assert.equal(posts.length, before);
});

test('an unknown op, a failing handler and a second job while one runs each get an error', async () => {
  let release;
  const { posts, send } = setup({
    slow: () => new Promise((r) => { release = r; }),
    boom: async () => { throw new Error('kaput'); },
  });
  await send(job('e', 'nope'));
  assert.match(posts.find((p) => p.msg.id === 'e').msg.message, /Unknown op 'nope'.*slow, boom/);
  await send(job('f', 'boom'));
  await tick();
  assert.equal(posts.find((p) => p.msg.id === 'f').msg.message, 'kaput');
  const running = send(job('g', 'slow'));
  await tick();
  await send(job('h', 'slow'));
  assert.match(posts.find((p) => p.msg.id === 'h').msg.message, /already running/);
  release({ files: {} });
  await running;
  assert.equal(posts.find((p) => p.msg.id === 'g' && p.msg.type === 'result').msg.type, 'result');
});

test('cancel aborts the running job', async () => {
  let signal;
  const { posts, send } = setup({ slow: ({ signal: s }) => new Promise((_, rej) => { signal = s; s.addEventListener('abort', () => rej(new Error('Cancelled.'))); }) });
  const running = send(job('i', 'slow'));
  await tick();
  await send({ webcli: 1, type: 'cancel', id: 'other' });
  assert.ok(!signal.aborted, 'a cancel for another job id is ignored');
  await send({ webcli: 1, type: 'cancel', id: 'i' });
  await running;
  assert.ok(signal.aborted);
  assert.equal(posts.at(-1).msg.message, 'Cancelled.');
});

test('ready carries the additive info, which cannot override the protocol fields', async () => {
  const { posts } = setup({ dub: async () => ({}) }, { info: { voices: [{ id: 'v' }], defaults: { voice: 'v' }, type: 'x', ops: [] } });
  assert.deepEqual(posts[0].msg, { webcli: 1, voices: [{ id: 'v' }], defaults: { voice: 'v' }, type: 'ready', tool: 't', version: '1', ops: ['dub'] });
});

test('closing the opener aborts the running job and frees the tool for the next one', async () => {
  let signal;
  const { posts, send, real } = setup({ slow: ({ signal: s }) => new Promise((_, rej) => { signal = s; s.addEventListener('abort', () => rej(new Error('Cancelled.'))); }), fast: async () => ({ files: {} }) });
  const running = send(job('j', 'slow'));
  await tick();
  assert.ok(!signal.aborted);
  real.closed = true;
  await running;
  assert.ok(signal.aborted);
  real.closed = false;
  await send(job('k', 'fast'));
  assert.equal(posts.find((p) => p.msg.id === 'k').msg.type, 'result', 'the tool serves again after the abort');
});

test('postMessage to a closed or gone opener throws nowhere: not on ready, progress, result or error', async () => {
  const { send, real, posts } = setup({
    ok: async ({ progress }) => { real.throws = true; progress(0.1, 'x'); return { files: { f: new ArrayBuffer(1) } }; },
    bad: async () => { throw new Error('kaput'); },
  });
  const before = posts.length;
  await send(job('l', 'ok'));
  await send(job('m', 'bad'));
  await send({ webcli: 1, type: 'hello' });
  assert.equal(posts.length, before, 'nothing delivered, nothing thrown');
  real.throws = false;
  await send(job('n', 'bad'));
  assert.equal(posts.at(-1).msg.message, 'kaput', 'and the tool still answers once the window is reachable');
});
