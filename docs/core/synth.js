// Shared synthesis step, used by the worker (browser) and the Node tests.
import { MAX_PHONEMES } from './models.js';

const HF = 'https://huggingface.co/';
const MAIN = `/resolve/main/`;

/**
 * kokoro-js cannot pin a model revision: from_pretrained() has no `revision` option and the voice
 * files are fetched from a hard-coded `resolve/main/` URL. Rewriting at the fetch layer pins
 * model, tokenizer and voices alike. Returns a restore function.
 */
export function installRevisionPin(revision, target = globalThis) {
  const real = target.fetch;
  const pinned = (u) => (typeof u === 'string' && u.startsWith(HF) ? u.replace(MAIN, `/resolve/${revision}/`) : u);
  target.fetch = (input, init) => {
    if (typeof input === 'string') return real.call(target, pinned(input), init);
    if (input instanceof URL) return real.call(target, pinned(input.href), init);
    if (input && typeof input.url === 'string' && pinned(input.url) !== input.url) {
      return real.call(target, new Request(pinned(input.url), input), init);
    }
    return real.call(target, input, init);
  };
  return () => {
    target.fetch = real;
  };
}

/**
 * Synthesize one text. Uses stream() so that text longer than one model window is split on
 * sentence boundaries instead of being silently truncated by generate().
 * stream() given a plain string never closes its splitter and hangs, so a closed
 * TextSplitterStream (from the same kokoro-js build as `tts`) is passed instead.
 * @returns {{samples: Float32Array, sampleRate: number, truncated: boolean}}
 */
export async function synthesizeText(tts, TextSplitterStream, text, voice) {
  const splitter = new TextSplitterStream();
  splitter.push(text);
  splitter.close();
  const chunks = [];
  let truncated = false;
  let sampleRate = 24000;
  for await (const c of tts.stream(splitter, { voice })) {
    if (c.phonemes.length > MAX_PHONEMES) truncated = true;
    chunks.push(c.audio.audio);
    sampleRate = c.audio.sampling_rate;
  }
  const len = chunks.reduce((n, a) => n + a.length, 0);
  const samples = new Float32Array(len);
  let o = 0;
  for (const a of chunks) {
    samples.set(a, o);
    o += a.length;
  }
  return { samples, sampleRate, truncated };
}
