import { parseSrt } from './core/srt.js';
import { layout, mix, encodeWav, sha256Hex, buildReport } from './core/timeline.js';
import { MODEL_ID, MODEL_REVISION, KOKORO_JS_VERSION, SAMPLE_RATE, TIERS, DEVICES, VOICES, PREVIEW_TEXT, VOICE_BYTES, fmtBytes } from './core/models.js';

const $ = (id) => document.getElementById(id);
const HF_BASE = `https://huggingface.co/${MODEL_ID}/resolve/main/`;
const SAMPLE_SRT = `1
00:00:00,500 --> 00:00:04,800
<i>In a right-angled triangle,</i> the square on the hypotenuse

2
00:00:05,000 --> 00:00:09,000
equals the sum of the squares on the other two sides.

3
00:00:10,000 --> 00:00:13,000
That is the Pythagorean theorem.
`;

const state = { srt: null, busy: false, result: null, worker: null, cachedTiers: new Set(), cachedVoices: new Set() };

// ── status helpers ──
function setStatus(text, kind = '') {
  $('statusText').textContent = text;
  $('dot').className = `dot ${kind}`;
}

// ── selectors ──
function fillSelectors() {
  const voice = $('voice');
  for (const accent of ['American', 'British']) {
    const g = document.createElement('optgroup');
    g.label = accent;
    for (const v of VOICES.filter((x) => x.accent === accent)) {
      const o = new Option(`${v.name} (${v.gender}, grade ${v.grade})`, v.id);
      g.append(o);
    }
    voice.append(g);
  }
  voice.value = 'af_heart';

  for (const key of Object.keys(TIERS)) $('tier').append(new Option('', key));
  $('tier').value = 'default';

  for (const [key, d] of Object.entries(DEVICES)) $('device').append(new Option(d.label, key));
  $('device').value = 'wasm';
  if (!('gpu' in navigator)) $('device').querySelector('option[value="webgpu"]').disabled = true;
}

async function inCache(cacheName, url) {
  try {
    return !!(await (await caches.open(cacheName)).match(url));
  } catch {
    return false;
  }
}

async function refreshCacheState() {
  state.cachedTiers.clear();
  state.cachedVoices.clear();
  for (const [key, t] of Object.entries(TIERS)) if (await inCache('transformers-cache', HF_BASE + 'onnx/' + t.file)) state.cachedTiers.add(key);
  for (const v of VOICES) if (await inCache('kokoro-voices', `${HF_BASE}voices/${v.id}.bin`)) state.cachedVoices.add(v.id);
  refreshUi();
}

function downloadBytes() {
  const tier = $('tier').value;
  const voice = $('voice').value;
  return (state.cachedTiers.has(tier) ? 0 : TIERS[tier].bytes) + (state.cachedVoices.has(voice) ? 0 : VOICE_BYTES);
}

function refreshUi() {
  const tierKey = $('tier').value;
  [...$('tier').options].forEach((o) => {
    const t = TIERS[o.value];
    o.textContent = `${t.label} · ${t.dtype} · ${fmtBytes(t.bytes)}${state.cachedTiers.has(o.value) ? ' · cached ✓' : ''}`;
  });
  const t = TIERS[tierKey];
  const cached = state.cachedTiers.has(tierKey);
  $('tierHint').textContent = `${t.note} ${cached ? 'Already cached in this browser.' : `Downloads ${fmtBytes(t.bytes)} on first use, then cached.`}`;

  const device = $('device').value;
  const repro = device === 'wasm' && t.dtype === 'q8';
  const dh = $('deviceHint');
  if (device === 'webgpu') {
    dh.textContent = 'WebGPU is faster but not bit-reproducible across GPUs. Use wasm + q8 for output you can diff.';
    dh.className = 'hint caution';
  } else if (repro) {
    dh.textContent = 'wasm + q8: same SRT + voice + model revision gives a byte-identical WAV.';
    dh.className = 'hint good';
  } else {
    dh.textContent = 'wasm is deterministic, but byte-identical output is only verified for q8.';
    dh.className = 'hint';
  }

  const need = downloadBytes();
  const ready = state.srt && !state.srt.parsed.fatal && state.srt.parsed.cues.some((c) => c.status === 'ok');
  $('dubBtn').textContent = need > 0 ? `Download ~${fmtBytes(need)} & Dub` : 'Dub';
  $('dubBtn').disabled = state.busy || !ready;
  $('previewBtn').disabled = state.busy;
  $('cancelBtn').hidden = !state.busy;
}

// ── SRT input ──
function loadSrt(name, text) {
  const parsed = parseSrt(text);
  state.srt = { name, parsed };
  const { cues, issues, fatal } = parsed;
  const ok = cues.filter((c) => c.status === 'ok').length;
  const info = $('srtInfo');
  info.hidden = false;
  info.replaceChildren();
  const b = document.createElement('b');
  b.textContent = name;
  info.append(b, ` — ${cues.length} cues parsed, ${ok} will be synthesized, ${issues.length} issue${issues.length === 1 ? '' : 's'}.`);

  const ul = $('issues');
  ul.replaceChildren();
  for (const i of issues) {
    const li = document.createElement('li');
    li.className = i.severity;
    const ln = document.createElement('span');
    ln.className = 'ln';
    ln.textContent = `line ${i.line}`;
    li.append(ln, i.message);
    ul.append(li);
  }
  if (fatal) setStatus('This SRT is malformed. Fix the lines listed and load it again; nothing was synthesized.', 'fail');
  else if (issues.some((i) => i.severity === 'error')) setStatus('SRT parsed with errors. Flagged cues will not be synthesized.', 'fail');
  else setStatus('SRT ready. Press Dub.', 'ready');
  state.result = null;
  $('result').hidden = true;
  refreshUi();
}

function wireInput() {
  const drop = $('drop');
  const readFile = async (f) => f && loadSrt(f.name, await f.text());
  $('file').addEventListener('change', (e) => readFile(e.target.files[0]));
  drop.addEventListener('keydown', (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), $('file').click()));
  drop.addEventListener('click', (e) => {
    e.preventDefault();
    $('file').click();
  });
  ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => (e.preventDefault(), drop.classList.add('over'))));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => (e.preventDefault(), drop.classList.remove('over'))));
  drop.addEventListener('drop', (e) => readFile(e.dataTransfer.files[0]));
  $('sampleBtn').addEventListener('click', () => loadSrt('sample.srt', SAMPLE_SRT));
}

// ── worker ──
function getWorker() {
  if (!state.worker) state.worker = new Worker(new URL('./tts-worker.js', import.meta.url), { type: 'module' });
  return state.worker;
}

/** Send a request; `onMsg` sees every message, the promise settles on a terminal one. */
function request(msg, terminal, onMsg) {
  const w = getWorker();
  return new Promise((resolve, reject) => {
    const handler = ({ data }) => {
      if (data.type === 'error') {
        w.removeEventListener('message', handler);
        reject(new Error(data.message));
        return;
      }
      onMsg?.(data);
      if (terminal.includes(data.type)) {
        w.removeEventListener('message', handler);
        resolve(data);
      }
    };
    w.addEventListener('message', handler);
    w.postMessage(msg);
  });
}

function showProgress(frac, text) {
  $('progress').hidden = frac === null;
  if (frac !== null) $('bar').style.width = `${Math.round(frac * 100)}%`;
  $('progressText').textContent = text ?? '';
}

function onLoadProgress(d) {
  if (d.type === 'progress') {
    showProgress(d.loaded / d.total, `Downloading model: ${fmtBytes(d.loaded)} of ${fmtBytes(d.total)}`);
  }
}

// ── dub ──
async function dub() {
  const { parsed } = state.srt;
  const tierKey = $('tier').value;
  const device = $('device').value;
  const voice = $('voice').value;
  const dtype = TIERS[tierKey].dtype;
  const jobs = parsed.cues.filter((c) => c.status === 'ok').map((c) => ({ i: c.i, text: c.text }));

  state.busy = true;
  refreshUi();
  setStatus(state.cachedTiers.has(tierKey) ? 'Loading model…' : `Downloading model (${fmtBytes(TIERS[tierKey].bytes)})…`, 'busy');
  const audio = new Map();
  let sampleRate = SAMPLE_RATE;
  try {
    const end = await request({ type: 'synth', dtype, device, voice, jobs }, ['done', 'cancelled'], (d) => {
      onLoadProgress(d);
      if (d.type === 'loaded') setStatus('Synthesizing…', 'busy');
      if (d.type === 'cue') {
        audio.set(d.i, { samples: d.samples, truncated: d.truncated });
        sampleRate = d.sampleRate;
        showProgress(d.k / d.of, `Cue ${d.k} of ${d.of}`);
      }
    });
    if (end.type === 'cancelled') {
      setStatus('Cancelled.', '');
      return;
    }
    await finish({ audio, sampleRate, dtype, device, voice, parsed });
  } catch (err) {
    setStatus(`Failed: ${err.message}`, 'fail');
  } finally {
    state.busy = false;
    showProgress(null);
    refreshCacheState();
  }
}

async function finish({ audio, sampleRate, dtype, device, voice, parsed }) {
  const lay = layout(parsed.cues, audio, sampleRate);
  const wav = encodeWav(mix(lay.placed, lay.total), sampleRate);
  const model = { id: MODEL_ID, revision: MODEL_REVISION, dtype, device, library: `kokoro-js@${KOKORO_JS_VERSION}`, crossOriginIsolated: self.crossOriginIsolated };
  const report = buildReport({ cues: parsed.cues, issues: parsed.issues, lay, sr: sampleRate, model, voice, wavSha256: await sha256Hex(wav) });
  state.result = { wav, report, lay, sr: sampleRate };
  renderResult();
}

// ── result ──
function renderResult() {
  const { wav, report, lay, sr } = state.result;
  $('result').hidden = false;

  const banner = $('banner');
  const parts = [];
  if (report.collisions) parts.push(`${report.collisions} collision${report.collisions === 1 ? '' : 's'}`);
  if (report.truncated) parts.push(`${report.truncated} truncated`);
  if (report.input_errors) parts.push(`${report.input_errors} input error${report.input_errors === 1 ? '' : 's'}`);
  banner.className = `banner ${report.ok ? 'ok' : 'fail'}`;
  banner.replaceChildren();
  const head = document.createElement('div');
  head.textContent = report.ok ? `OK — ${report.synthesized} cues placed, no collisions.` : `FAILED — ${parts.join(', ')}.`;
  const small = document.createElement('small');
  small.textContent = `${report.overruns} overrun${report.overruns === 1 ? '' : 's'} · ${report.duration_s}s at ${sr} Hz · ${report.model.dtype}/${report.model.device} · ${report.reproducible ? 'reproducible' : 'not verified bit-reproducible'}`;
  const sha = document.createElement('small');
  sha.textContent = `WAV sha256 ${report.wav_sha256}`;
  banner.append(head, small, sha);
  setStatus(report.ok ? 'Done.' : 'Done, with failures. Fix the SRT or the shot timing and run again.', report.ok ? 'ready' : 'fail');

  if (state.wavUrl) URL.revokeObjectURL(state.wavUrl);
  state.wavUrl = URL.createObjectURL(new Blob([wav], { type: 'audio/wav' }));
  $('player').src = state.wavUrl;

  const tbody = $('report').tBodies[0];
  tbody.replaceChildren();
  const fmt = (x) => (x === undefined || x === null ? '' : x.toFixed(3));
  for (const d of report.detail) {
    const tr = document.createElement('tr');
    tr.className = d.status;
    const cells = [d.i, d.line, fmt(d.start), fmt(d.window), fmt(d.actual), d.overrun ? `+${fmt(d.overrun)}` : '', d.collides_with ?? '', d.status, d.text];
    cells.forEach((v, k) => {
      const td = document.createElement('td');
      if (k === 8) td.className = 'text';
      td.textContent = v;
      tr.append(td);
    });
    tbody.append(tr);
  }
  drawWave();
}

function drawWave() {
  const { lay, sr, wav } = state.result;
  const canvas = $('wave');
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth * dpr;
  const h = canvas.clientHeight * dpr;
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  const total = lay.total;
  const x = (s) => (s / total) * w;

  ctx.fillStyle = '#0d0f1a';
  ctx.fillRect(0, 0, w, h);

  for (const p of lay.placed) {
    ctx.fillStyle = 'rgba(54,101,182,.28)';
    ctx.fillRect(x(p.start), 0, Math.max(1, x(p.end) - x(p.start)), h);
    if (p.overrun > 0) {
      ctx.fillStyle = 'rgba(245,158,11,.4)';
      ctx.fillRect(x(p.end), 0, Math.max(1, x(p.start + p.actual) - x(p.end)), h);
    }
    if (p.collidesWith !== null) {
      ctx.fillStyle = 'rgba(239,68,68,.55)';
      const nextStart = p.start + p.actual - p.overlap;
      ctx.fillRect(x(nextStart), 0, Math.max(2, x(p.overlap)), h);
    }
    ctx.fillStyle = '#81e2f8';
    ctx.fillRect(x(p.start), 0, Math.max(1, dpr), h);
    ctx.fillStyle = '#94a3b8';
    ctx.font = `${10 * dpr}px sans-serif`;
    ctx.fillText(String(p.cue.i), x(p.start) + 3 * dpr, 11 * dpr);
  }

  // Peaks come from the encoded WAV so the picture matches the file exactly.
  const pcm = new Int16Array(wav.buffer, wav.byteOffset + 44, total);
  ctx.fillStyle = '#e2e8f0';
  const per = total / w;
  for (let px = 0; px < w; px++) {
    let lo = 0;
    let hi = 0;
    const a = Math.floor(px * per);
    const b = Math.min(total, Math.max(a + 1, Math.floor((px + 1) * per)));
    for (let s = a; s < b; s++) {
      const v = pcm[s] / 32768;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    ctx.fillRect(px, h / 2 - hi * (h / 2) * 0.9, 1, Math.max(1, (hi - lo) * (h / 2) * 0.9));
  }

  const t = $('player').currentTime;
  if (t) {
    ctx.fillStyle = '#70db97';
    ctx.fillRect(x(t * sr), 0, Math.max(1, dpr), h);
  }
}

function download(name, bytes, type) {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ── preview ──
async function preview() {
  const voice = $('voice').value;
  const tierKey = $('tier').value;
  state.busy = true;
  refreshUi();
  setStatus(state.cachedTiers.has(tierKey) ? 'Loading model…' : `Downloading model (${fmtBytes(TIERS[tierKey].bytes)})…`, 'busy');
  try {
    const r = await request({ type: 'preview', dtype: TIERS[tierKey].dtype, device: $('device').value, voice, text: PREVIEW_TEXT }, ['preview'], onLoadProgress);
    const url = URL.createObjectURL(new Blob([encodeWav(r.samples, r.sampleRate)], { type: 'audio/wav' }));
    const a = new Audio(url);
    a.onended = () => URL.revokeObjectURL(url);
    await a.play();
    setStatus('Preview playing.', 'ready');
  } catch (err) {
    setStatus(`Preview failed: ${err.message}`, 'fail');
  } finally {
    state.busy = false;
    showProgress(null);
    refreshCacheState();
  }
}

// ── boot ──
fillSelectors();
wireInput();
refreshUi();
refreshCacheState();
['tier', 'device', 'voice'].forEach((id) => $(id).addEventListener('change', refreshUi));
$('dubBtn').addEventListener('click', dub);
$('previewBtn').addEventListener('click', preview);
$('cancelBtn').addEventListener('click', () => state.worker?.postMessage({ type: 'cancel' }));
$('dlWav').addEventListener('click', () => download('dub.wav', state.result.wav, 'audio/wav'));
$('dlReport').addEventListener('click', () => download('report.json', JSON.stringify(state.result.report, null, 2), 'application/json'));
$('player').addEventListener('timeupdate', () => state.result && drawWave());
$('wave').addEventListener('click', (e) => {
  if (!state.result) return;
  const r = e.currentTarget.getBoundingClientRect();
  $('player').currentTime = ((e.clientX - r.left) / r.width) * (state.result.lay.total / state.result.sr);
});
window.addEventListener('resize', () => state.result && drawWave());
