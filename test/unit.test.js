import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSrt } from '../docs/core/srt.js';
import { layout, mix, encodeWav, buildReport, sha256Hex } from '../docs/core/timeline.js';
import { installRevisionPin } from '../docs/core/synth.js';
import { resolveArgs, DEFAULTS, VOICES, TIERS } from '../docs/core/models.js';

const codes = (r) => r.issues.map((i) => i.code);

test('accepts comma and dot millis, BOM, CRLF, missing and non-sequential indices', () => {
  const r = parseSrt('\uFEFF7\r\n00:00:01,000 --> 00:00:02.500\r\nHello\r\n\r\n00:00:03,000 --> 00:00:04,000\r\nNo index\r\n\r\n2\r\n00:00:05,000 --> 00:00:06,000\r\nBack\r\n');
  assert.equal(r.fatal, false);
  assert.deepEqual(r.cues.map((c) => [c.i, c.srtIndex, c.startMs, c.endMs]), [[1, 7, 1000, 2500], [2, null, 3000, 4000], [3, 2, 5000, 6000]]);
  assert.deepEqual(r.issues, []);
});

test('multi-line text is joined with one space; markup is stripped', () => {
  const r = parseSrt('1\n00:00:00,000 --> 00:00:03,000\n{\\an8}<i>Hello</i>\n<font color="#ff0000">big</font>   <b>world</b> &amp; all\n');
  assert.equal(r.cues[0].text, 'Hello big world & all');
});

test('stray angle brackets in prose survive', () => {
  const r = parseSrt('1\n00:00:00,000 --> 00:00:03,000\nif x < y and y > z\n');
  assert.equal(r.cues[0].text, 'if x < y and y > z');
});

test('empty cue is skipped and reported, not dropped silently', () => {
  const r = parseSrt('1\n00:00:00,000 --> 00:00:01,000\n<i> </i>\n');
  assert.equal(r.cues[0].status, 'empty');
  assert.deepEqual(codes(r), ['empty']);
  assert.equal(r.issues[0].line, 2);
});

test('zero and negative duration are errors with line numbers', () => {
  const r = parseSrt('1\n00:00:01,000 --> 00:00:01,000\nzero\n\n2\n00:00:05,000 --> 00:00:04,000\nneg\n');
  assert.deepEqual(r.cues.map((c) => c.status), ['zero_duration', 'negative_duration']);
  assert.deepEqual(r.issues.map((i) => i.line), [2, 6]);
  assert.ok(r.issues.every((i) => i.severity === 'error'));
});

test('a cue starting before the previous one ends is an overlap error', () => {
  const r = parseSrt('1\n00:00:00,000 --> 00:00:03,000\na\n\n2\n00:00:02,000 --> 00:00:04,000\nb\n\n3\n00:00:04,000 --> 00:00:05,000\nc\n');
  assert.deepEqual(r.cues.map((c) => c.status), ['ok', 'overlap', 'ok']);
  assert.equal(r.cues[1].overlapsWith, 1);
});

test('out-of-order cues are reported as overlap, not reordered', () => {
  const r = parseSrt('1\n00:00:10,000 --> 00:00:12,000\nlate\n\n2\n00:00:01,000 --> 00:00:02,000\nearly\n');
  assert.equal(r.cues[1].status, 'overlap');
});

test('malformed input fails loudly with the offending line number', () => {
  const r = parseSrt('1\n00:00:00,000 --> 00:00:01,000\nok\n\n2\n00:00:02,00 --> 00:00:03,000\nbad millis\n');
  assert.equal(r.fatal, true);
  assert.equal(r.issues[0].code, 'bad_timing');
  assert.equal(r.issues[0].line, 6);
});

test('a text line without a timing line is fatal, with its line', () => {
  const r = parseSrt('1\n00:00:00,000 --> 00:00:01,000\nfine\n\njust some text\n');
  assert.equal(r.fatal, true);
  assert.equal(r.issues[0].line, 5);
});

test('out-of-range minutes/seconds and empty files are fatal', () => {
  assert.equal(parseSrt('1\n00:61:00,000 --> 00:62:00,000\nx\n').fatal, true);
  assert.equal(parseSrt('  \n\n').fatal, true);
});

// ── timeline ──
const SR = 1000; // 1 sample per ms keeps the arithmetic readable
const tone = (n, v = 0.5) => new Float32Array(n).fill(v);

function run(srt, lengths) {
  const parsed = parseSrt(srt);
  const audio = new Map(Object.entries(lengths).map(([i, n]) => [Number(i), { samples: tone(n) }]));
  const lay = layout(parsed.cues, audio, SR);
  return { parsed, lay, report: buildReport({ cues: parsed.cues, issues: parsed.issues, lay, sr: SR, model: { dtype: 'q8', device: 'wasm' }, voice: 'v' }) };
}

const TWO = '1\n00:00:01,000 --> 00:00:03,000\na\n\n2\n00:00:04,000 --> 00:00:06,000\nb\n';

test('fitting cues: no overrun, no collision, track ends at last cue end', () => {
  const { lay, report } = run(TWO, { 1: 1500, 2: 1000 });
  assert.equal(report.ok, true);
  assert.equal(report.overruns, 0);
  assert.equal(report.collisions, 0);
  assert.equal(lay.total, 6000);
});

test('overrun is reported, audio is not stretched', () => {
  const { lay, report } = run(TWO, { 1: 2500, 2: 1000 });
  assert.equal(report.overruns, 1);
  assert.equal(report.collisions, 0);
  assert.equal(report.detail[0].overrun, 0.5);
  assert.equal(report.detail[0].status, 'overrun');
  assert.equal(lay.placed[0].actual, 2500);
});

test('collision is a failure state and names the other cue', () => {
  const { report } = run(TWO, { 1: 3500, 2: 1000 });
  assert.equal(report.ok, false);
  assert.equal(report.collisions, 1);
  assert.equal(report.detail[0].collides_with, 2);
  assert.equal(report.detail[0].overlap, 0.5);
  assert.equal(report.detail[0].status, 'collision');
});

test('track length covers audio that runs past the last cue end', () => {
  const { lay } = run(TWO, { 1: 1000, 2: 3000 });
  assert.equal(lay.total, 7000);
});

test('audio lands at absolute positions with silence between cues', () => {
  const { lay } = run(TWO, { 1: 100, 2: 100 });
  const out = mix(lay.placed, lay.total);
  assert.equal(out[999], 0);
  assert.equal(out[1000], 0.5);
  assert.equal(out[1099], 0.5);
  assert.equal(out[1100], 0);
  assert.equal(out[4000], 0.5);
});

test('invalid cues are not synthesized and make the report not ok', () => {
  const { report } = run('1\n00:00:01,000 --> 00:00:01,000\nz\n\n2\n00:00:02,000 --> 00:00:03,000\nb\n', { 2: 500 });
  assert.equal(report.synthesized, 1);
  assert.equal(report.input_errors, 1);
  assert.equal(report.ok, false);
  assert.equal(report.detail[0].status, 'zero_duration');
});

test('truncated synthesis is surfaced', () => {
  const parsed = parseSrt(TWO);
  const audio = new Map([[1, { samples: tone(100), truncated: true }], [2, { samples: tone(100) }]]);
  const lay = layout(parsed.cues, audio, SR);
  const report = buildReport({ cues: parsed.cues, issues: [], lay, sr: SR, model: { dtype: 'q8', device: 'wasm' }, voice: 'v' });
  assert.equal(report.truncated, 1);
  assert.equal(report.ok, false);
});

test('report is reproducible: only wasm + q8 is flagged', () => {
  const { report } = run(TWO, { 1: 100, 2: 100 });
  assert.equal(report.reproducible, true);
});

test('WAV: valid header and identical bytes for identical input', async () => {
  const s = Float32Array.from({ length: 480 }, (_, i) => Math.sin(i / 7) * 0.8);
  const a = encodeWav(s, 24000);
  const b = encodeWav(s, 24000);
  assert.equal(a.length, 44 + 960);
  assert.equal(new TextDecoder().decode(a.slice(0, 4)), 'RIFF');
  assert.equal(new DataView(a.buffer).getUint32(24, true), 24000);
  assert.equal(await sha256Hex(a), await sha256Hex(b));
});

test('revision pin rewrites resolve/main for Hugging Face only', async () => {
  const seen = [];
  const fake = { fetch: async (u) => (seen.push(String(u)), null) };
  installRevisionPin('abc123', fake);
  await fake.fetch('https://huggingface.co/m/resolve/main/voices/af_heart.bin');
  await fake.fetch(new URL('https://huggingface.co/m/resolve/main/config.json'));
  await fake.fetch('https://example.com/resolve/main/x');
  assert.deepEqual(seen, ['https://huggingface.co/m/resolve/abc123/voices/af_heart.bin', 'https://huggingface.co/m/resolve/abc123/config.json', 'https://example.com/resolve/main/x']);
});

test('zero third-party hosts in shipped page code', () => {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs');
  const allowed = [/^https?:\/\/huggingface\.co\//, /^https?:\/\/github\.com\/tejaswigowda\/dub-webCLI/, /^http:\/\/www\.w3\.org\//];
  for (const f of ['index.html', 'style.css', 'app.js', 'tts-worker.js', ...fs.readdirSync(path.join(root, 'core')).map((n) => `core/${n}`)]) {
    const urls = fs.readFileSync(path.join(root, f), 'utf8').match(/https?:\/\/[^\s'"`)<>]+/g) ?? [];
    for (const u of urls) assert.ok(allowed.some((a) => a.test(u)), `${f}: unexpected host ${u}`);
  }
});

test('hand-off args: absent or empty means the documented reproducible default', () => {
  assert.deepEqual(DEFAULTS, { voice: 'af_heart', tier: 'default', device: 'wasm' });
  assert.equal(TIERS[DEFAULTS.tier].dtype, 'q8');
  assert.deepEqual(resolveArgs({}), DEFAULTS);
  assert.deepEqual(resolveArgs(undefined), DEFAULTS);
  assert.deepEqual(resolveArgs({ voice: '', tier: null, device: undefined }), DEFAULTS);
  assert.deepEqual(resolveArgs({ voice: 'bm_george', tier: 'better', device: 'webgpu' }), { voice: 'bm_george', tier: 'better', device: 'webgpu' });
});

test('hand-off args: an unknown or disabled value is an error naming the valid ones', () => {
  assert.throws(() => resolveArgs({ voice: 'af_hart' }), (e) => /Unknown voice "af_hart"/.test(e.message) && VOICES.every((v) => e.message.includes(v.id)));
  assert.throws(() => resolveArgs({ tier: 'q8' }), /Unknown tier "q8"\. Valid tiers: default, better, best, q4/);
  assert.throws(() => resolveArgs({ device: 'cpu' }), /Unknown device "cpu"\. Valid devices: wasm, webgpu/);
  assert.throws(() => resolveArgs({ device: 'webgpu' }, { webgpu: false }), /Valid devices: wasm\./);
  assert.throws(() => resolveArgs({ voice: 7 }), /Unknown voice 7/);
});
