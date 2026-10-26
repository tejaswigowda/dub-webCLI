// End-to-end gates D1–D3 on Node (onnxruntime-node, cpu). Downloads ~92 MB (Kokoro q8) and ~40 MB (whisper-tiny.en)
// on first run. Node cpu is not the browser's wasm path: the browser D3 check is documented in README.md.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { KokoroTTS, TextSplitterStream } from 'kokoro-js';
import { pipeline } from '@huggingface/transformers';
import { parseSrt } from '../docs/core/srt.js';
import { layout, mix, encodeWav, buildReport, sha256Hex } from '../docs/core/timeline.js';
import { installRevisionPin, synthesizeText } from '../docs/core/synth.js';
import { MODEL_ID, MODEL_REVISION } from '../docs/core/models.js';

// Cue windows are generous so a fit failure means a real bug, not a tight SRT.
const SRT = `1
00:00:00,500 --> 00:00:04,900
<i>In a right-angled triangle,</i> the square on the hypotenuse

2
00:00:05,000 --> 00:00:09,500
equals the sum of the squares
on the other two sides.

3
00:00:10,500 --> 00:00:13,500
{\\an8}That is the Pythagorean theorem.

4
00:00:14,000 --> 00:00:18,000
Pythagoras was born on the island of Samos.
`;

let tts;
let unpin;
before(async () => {
  unpin = installRevisionPin(MODEL_REVISION);
  tts = await KokoroTTS.from_pretrained(MODEL_ID, { dtype: 'q8', device: 'cpu' });
});

async function dub(srt, voice = 'af_heart') {
  const parsed = parseSrt(srt);
  assert.equal(parsed.fatal, false);
  const audio = new Map();
  let sr = 24000;
  for (const c of parsed.cues.filter((x) => x.status === 'ok')) {
    const r = await synthesizeText(tts, TextSplitterStream, c.text, voice);
    audio.set(c.i, { samples: r.samples, truncated: r.truncated });
    sr = r.sampleRate;
  }
  const lay = layout(parsed.cues, audio, sr);
  const wav = encodeWav(mix(lay.placed, lay.total), sr);
  const report = buildReport({ cues: parsed.cues, issues: parsed.issues, lay, sr, model: { id: MODEL_ID, revision: MODEL_REVISION, dtype: 'q8', device: 'cpu' }, voice, wavSha256: await sha256Hex(wav) });
  return { parsed, wav, report, sr };
}

const words = (s) => s.toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').split(/\s+/).filter(Boolean);

test('D2 + D3 + D1', { timeout: 1_800_000 }, async () => {
  const a = await dub(SRT);
  console.log('report:', JSON.stringify({ ...a.report, detail: a.report.detail.map(({ i, start, window, actual, status }) => ({ i, start, window, actual, status })) }));

  // D2: no collisions
  assert.equal(a.report.collisions, 0, 'D2: collisions in report');
  assert.equal(a.report.ok, true);
  // markup must not reach the synthesizer
  assert.ok(!a.parsed.cues.some((c) => /[<>{}\\]/.test(c.text)));

  // D3: identical settings, identical bytes
  const b = await dub(SRT);
  assert.equal(a.report.wav_sha256, b.report.wav_sha256, 'D3: WAVs differ between runs');
  assert.deepEqual(Buffer.from(a.wav), Buffer.from(b.wav));

  // D1: whisper(dub(srt)) ≈ srt — every cue present, in order, at roughly the right time
  const f32 = new Float32Array((a.wav.length - 44) / 2);
  const dv = new DataView(a.wav.buffer, 44);
  for (let n = 0; n < f32.length; n++) f32[n] = dv.getInt16(n * 2, true) / 32768;
  const ratio = a.sr / 16000;
  const pcm16k = Float32Array.from({ length: Math.floor(f32.length / ratio) }, (_, n) => {
    const x = n * ratio;
    const i = Math.floor(x);
    return f32[i] + (f32[Math.min(i + 1, f32.length - 1)] - f32[i]) * (x - i);
  });
  unpin(); // the pin is for the Kokoro repo only
  const asr = await pipeline('automatic-speech-recognition', 'onnx-community/whisper-tiny.en_timestamped', { dtype: 'q8', device: 'cpu' });
  const out = await asr(pcm16k, { return_timestamps: 'word', chunk_length_s: 30 });
  const heard = out.chunks.map((c) => ({ w: words(c.text).join(''), t: c.timestamp[0] })).filter((x) => x.w);
  console.log('transcript:', out.text);

  let cursor = 0;
  for (const cue of a.parsed.cues) {
    const want = words(cue.text);
    let matched = 0;
    let firstT = null;
    for (const w of want) {
      for (let k = cursor; k < Math.min(heard.length, cursor + want.length + 6); k++) {
        if (heard[k].w === w.replace(/[^a-z0-9]/g, '')) {
          if (firstT === null) firstT = heard[k].t;
          cursor = k + 1;
          matched++;
          break;
        }
      }
    }
    assert.ok(matched / want.length >= 0.8, `D1: cue ${cue.i} only ${matched}/${want.length} words found in order`);
    assert.ok(Math.abs(firstT - cue.startMs / 1000) < 1.0, `D1: cue ${cue.i} heard at ${firstT}s, expected ~${cue.startMs / 1000}s`);
  }
});
