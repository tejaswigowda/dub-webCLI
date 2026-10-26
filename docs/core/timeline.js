// Placement, mixing, WAV encoding and report assembly. Pure ESM, no DOM.
// No time-stretching and no rate adjustment anywhere: audio is placed as synthesized.

export const TOOL = { name: 'dub.webcli.app', version: '1.0.0' };

const round3 = (x) => Math.round(x * 1000) / 1000;

/**
 * @param {Array} cues     cues from parseSrt (all of them; only status 'ok' are laid out)
 * @param {Map<number,{samples:Float32Array, truncated?:boolean}>} audio  keyed by cue.i
 * @param {number} sr      sample rate of the synthesized audio
 */
export function layout(cues, audio, sr) {
  const toSample = (ms) => Math.round((ms * sr) / 1000);
  const placed = cues
    .filter((c) => c.status === 'ok' && audio.has(c.i))
    .map((c) => {
      const a = audio.get(c.i);
      const start = toSample(c.startMs);
      const end = toSample(c.endMs);
      return { cue: c, samples: a.samples, truncated: !!a.truncated, start, window: end - start, actual: a.samples.length, end };
    });

  placed.forEach((p, k) => {
    p.overrun = Math.max(0, p.actual - p.window);
    const audioEnd = p.start + p.actual;
    const next = placed[k + 1];
    p.collidesWith = next && audioEnd > next.start ? next.cue.i : null;
    p.overlap = p.collidesWith === null ? 0 : audioEnd - next.start;
  });

  // max(last_cue.start + last_audio.duration, last_cue.end), generalised over every placed cue
  const total = placed.reduce((m, p) => Math.max(m, p.start + p.actual, p.end), 0);
  return { placed, total };
}

/** Sum every cue into one full-length mono track at its absolute position. */
export function mix(placed, total) {
  const out = new Float32Array(total);
  for (const p of placed) {
    const s = p.samples;
    for (let n = 0; n < s.length; n++) out[p.start + n] += s[n];
  }
  return out;
}

/** 16-bit PCM mono WAV. Header carries no timestamps, so identical input gives identical bytes. */
export function encodeWav(samples, sr) {
  const dataBytes = samples.length * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const v = new DataView(buf);
  const str = (o, s) => [...s].forEach((ch, i) => v.setUint8(o + i, ch.charCodeAt(0)));
  str(0, 'RIFF');
  v.setUint32(4, 36 + dataBytes, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, sr, true);
  v.setUint32(28, sr * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, dataBytes, true);
  for (let n = 0; n < samples.length; n++) {
    const x = Math.max(-1, Math.min(1, samples[n]));
    v.setInt16(44 + n * 2, Math.round(x < 0 ? x * 32768 : x * 32767), true);
  }
  return new Uint8Array(buf);
}

export async function sha256Hex(bytes) {
  const d = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * @param {object} p
 * @param {Array}  p.cues      all cues from parseSrt
 * @param {Array}  p.issues    issues from parseSrt
 * @param {object} p.lay       result of layout()
 * @param {number} p.sr
 * @param {object} p.model     { id, revision, dtype, device, ... }
 * @param {string} p.voice
 * @param {string} [p.wavSha256]
 */
export function buildReport({ cues, issues, lay, sr, model, voice, wavSha256 }) {
  const byCue = new Map(lay.placed.map((p) => [p.cue.i, p]));
  const detail = cues.map((c) => {
    const p = byCue.get(c.i);
    const base = { i: c.i, srt_index: c.srtIndex, line: c.line, start: round3(c.startMs / 1000), window: round3((c.endMs - c.startMs) / 1000) };
    if (!p) return { ...base, status: c.status, text: c.text };
    const status = p.truncated ? 'truncated' : p.collidesWith !== null ? 'collision' : p.overrun > 0 ? 'overrun' : 'ok';
    return {
      ...base,
      actual: round3(p.actual / sr),
      overrun: round3(p.overrun / sr),
      collides_with: p.collidesWith,
      overlap: round3(p.overlap / sr),
      status,
      text: c.text,
    };
  });

  const count = (s) => detail.filter((d) => d.status === s).length;
  const overruns = lay.placed.filter((p) => p.overrun > 0).length;
  const collisions = lay.placed.filter((p) => p.collidesWith !== null).length;
  const truncated = count('truncated');
  const inputErrors = issues.filter((i) => i.severity === 'error').length;

  return {
    ok: collisions === 0 && truncated === 0 && inputErrors === 0,
    cues: cues.length,
    synthesized: lay.placed.length,
    overruns,
    collisions,
    truncated,
    input_errors: inputErrors,
    duration_s: round3(lay.total / sr),
    sample_rate: sr,
    model,
    voice,
    reproducible: model.device === 'wasm' && model.dtype === 'q8',
    wav_sha256: wavSha256 ?? null,
    tool: TOOL,
    issues,
    detail,
  };
}
