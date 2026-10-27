// Model, tier and voice constants. Pure data, no DOM, no network.

export const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';
// Pinned commit of the model repo (last modified 2025-02-08). Never a floating tag.
export const MODEL_REVISION = '1939ad2a8e416c0acfeecc08a694d14ef25f2231';
export const KOKORO_JS_VERSION = '1.2.1';
export const SAMPLE_RATE = 24000;
// Kokoro truncates anything beyond ~510 phoneme tokens per chunk; the worker reports it instead of hiding it.
export const MAX_PHONEMES = 510;
export const VOICE_BYTES = 523264; // one voices/<name>.bin

// Sizes are the real byte counts of the files at MODEL_REVISION (HF tree API, 2026-10-25).
export const TIERS = {
  default: { dtype: 'q8', label: 'Default', file: 'model_quantized.onnx', bytes: 92361116, note: 'Fastest to usable. Integer weights; the reproducible choice on wasm.' },
  better: { dtype: 'fp16', label: 'Better', file: 'model_fp16.onnx', bytes: 163234740, note: 'Opt-in. Best used with WebGPU.' },
  best: { dtype: 'fp32', label: 'Best', file: 'model.onnx', bytes: 325532232, note: 'Opt-in. Recommended with WebGPU.' },
  q4: { dtype: 'q4', label: 'q4', file: 'model_q4.onnx', bytes: 305215966, note: 'Opt-in. Not smaller than q8 in this repo: the q4 file is 305 MB.' },
};

export const DEVICES = {
  wasm: { label: 'wasm (CPU)', note: 'Deterministic. Use this for reproducible output.' },
  webgpu: { label: 'webgpu', note: 'Faster, but not bit-reproducible across GPUs.' },
};

export function fmtBytes(n) {
  return n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : `${Math.round(n / 1e6)} MB`;
}

const V = (id, name, accent, gender, grade) => ({ id, name, accent, gender, grade });
export const VOICES = [
  V('af_heart', 'Heart', 'American', 'F', 'A'),
  V('af_alloy', 'Alloy', 'American', 'F', 'C'),
  V('af_aoede', 'Aoede', 'American', 'F', 'C+'),
  V('af_bella', 'Bella', 'American', 'F', 'A-'),
  V('af_jessica', 'Jessica', 'American', 'F', 'D'),
  V('af_kore', 'Kore', 'American', 'F', 'C+'),
  V('af_nicole', 'Nicole', 'American', 'F', 'B-'),
  V('af_nova', 'Nova', 'American', 'F', 'C'),
  V('af_river', 'River', 'American', 'F', 'D'),
  V('af_sarah', 'Sarah', 'American', 'F', 'C+'),
  V('af_sky', 'Sky', 'American', 'F', 'C-'),
  V('am_adam', 'Adam', 'American', 'M', 'F+'),
  V('am_echo', 'Echo', 'American', 'M', 'D'),
  V('am_eric', 'Eric', 'American', 'M', 'D'),
  V('am_fenrir', 'Fenrir', 'American', 'M', 'C+'),
  V('am_liam', 'Liam', 'American', 'M', 'D'),
  V('am_michael', 'Michael', 'American', 'M', 'C+'),
  V('am_onyx', 'Onyx', 'American', 'M', 'D'),
  V('am_puck', 'Puck', 'American', 'M', 'C+'),
  V('am_santa', 'Santa', 'American', 'M', 'D-'),
  V('bf_emma', 'Emma', 'British', 'F', 'B-'),
  V('bf_isabella', 'Isabella', 'British', 'F', 'C'),
  V('bf_alice', 'Alice', 'British', 'F', 'D'),
  V('bf_lily', 'Lily', 'British', 'F', 'D'),
  V('bm_george', 'George', 'British', 'M', 'C'),
  V('bm_lewis', 'Lewis', 'British', 'M', 'D+'),
  V('bm_daniel', 'Daniel', 'British', 'M', 'D'),
  V('bm_fable', 'Fable', 'British', 'M', 'C'),
];

export const PREVIEW_TEXT = 'The square on the hypotenuse equals the sum of the squares on the other two sides.';

export const DEFAULTS = { voice: 'af_heart', tier: 'default', device: 'wasm' };

/**
 * Resolve the voice/tier/device a hand-off job asks for. Absent or empty means dub's default; anything else must be a
 * known, enabled value, otherwise this throws an error that names the valid ones (the caller must not get a voice it did not ask for).
 * `webgpu` is whether this browser offers WebGPU.
 */
export function resolveArgs(args = {}, { webgpu = true } = {}) {
  const sets = {
    voice: VOICES.map((v) => v.id),
    tier: Object.keys(TIERS),
    device: Object.keys(DEVICES).filter((d) => d !== 'webgpu' || webgpu),
  };
  const out = {};
  for (const [key, valid] of Object.entries(sets)) {
    const v = args[key];
    if (v === undefined || v === null || v === '') out[key] = DEFAULTS[key];
    else if (typeof v === 'string' && valid.includes(v)) out[key] = v;
    else throw new Error(`Unknown ${key} ${JSON.stringify(v)}. Valid ${key}s: ${valid.join(', ')}. Leave it out for the default (${DEFAULTS[key]}).`);
  }
  return out;
}
