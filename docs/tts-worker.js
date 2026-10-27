// Module worker: owns the Kokoro model so the page stays responsive.
import { KokoroTTS, TextSplitterStream, env } from './vendor/kokoro.web.js';
import { MODEL_ID, MODEL_REVISION } from './core/models.js';
import { installRevisionPin, synthesizeText } from './core/synth.js';

// Everything the runtime needs is self-hosted; the only remote host is the model fetch.
env.wasmPaths = new URL('./vendor/', import.meta.url).href;
installRevisionPin(MODEL_REVISION);

let tts = null;
let loadedKey = null;
let cancelled = false;

const post = (msg, transfer) => self.postMessage(msg, transfer ?? []);

async function load({ dtype, device }) {
  const key = `${dtype}/${device}`;
  if (tts && loadedKey === key) return;
  tts = null;
  const files = new Map();
  tts = await KokoroTTS.from_pretrained(MODEL_ID, {
    dtype,
    device,
    progress_callback: (p) => {
      if (p.status === 'progress' && p.total) {
        files.set(p.file, { loaded: p.loaded, total: p.total });
        let loaded = 0;
        let total = 0;
        for (const f of files.values()) {
          loaded += f.loaded;
          total += f.total;
        }
        post({ type: 'progress', loaded, total, file: p.file });
      }
    },
  });
  loadedKey = key;
}

self.onmessage = async ({ data }) => {
  try {
    if (data.type === 'cancel') {
      cancelled = true;
      return;
    }
    if (data.type === 'load') {
      await load(data);
      post({ type: 'loaded' });
    } else if (data.type === 'preview') {
      await load(data);
      const r = await synthesizeText(tts, TextSplitterStream, data.text, data.voice);
      post({ type: 'preview', samples: r.samples, sampleRate: r.sampleRate }, [r.samples.buffer]);
    } else if (data.type === 'synth') {
      cancelled = false;
      await load(data);
      post({ type: 'loaded' });
      for (let k = 0; k < data.jobs.length; k++) {
        // Inference only awaits microtasks, so without a macrotask turn a 'cancel' message is not delivered until the loop ends.
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (cancelled) {
          post({ type: 'cancelled' });
          return;
        }
        const job = data.jobs[k];
        const r = await synthesizeText(tts, TextSplitterStream, job.text, data.voice);
        post({ type: 'cue', i: job.i, k: k + 1, of: data.jobs.length, samples: r.samples, sampleRate: r.sampleRate, truncated: r.truncated }, [r.samples.buffer]);
      }
      post({ type: 'done' });
    }
  } catch (err) {
    post({ type: 'error', message: err?.message ?? String(err) });
  }
};
