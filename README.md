# dub webCLI

[![GitHub stars](https://img.shields.io/github/stars/tejaswigowda/dub-webCLI?style=social)](https://github.com/tejaswigowda/dub-webCLI/stargazers)

A browser-based subtitle-to-speech dubber powered by [Kokoro](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX) text-to-speech. **SRT in, timed WAV out.** <b><ins>No uploads, no servers, no API keys. All processing happens locally</ins></b> in your browser using [Transformers.js](https://huggingface.co/docs/transformers.js) and ONNX Runtime WebAssembly.

▶ **Live app:** https://tejaswigowda.com/dub-webCLI/

> Part of the **webCLI** family of zero-egress, offline-first browser tools, and the inverse of [whisper-webCLI](https://github.com/tejaswigowda/whisper-webCLI): whisper turns audio into timed text, dub turns timed text into audio. Same look and feel, same privacy promise: your script never leaves your device.

---

## Paper

This tool is a reference implementation of the **Web-CLI** architecture, described in:

> **The Web-CLI: Verifiable Privacy for Tools, Models, and Inference Engines in the Browser**
> Tejaswi Gowda, Arizona State University.
> arXiv: https://arxiv.org/abs/2608.28950

The paper defines the four properties (fidelity, progressive disclosure, offline-first, zero egress), presents four reference implementations, and argues that for sensitive data, client-side should be the default architecture because it makes privacy a *verifiable* technical property rather than a policy promise.

---

## Key Features

- **No Server Uploads**: your SRT is parsed and voiced entirely on your device

- **Kokoro TTS**: an 82M-parameter model (Apache-2.0) running locally via ONNX Runtime WebAssembly, with 28 English voices (American and British, male and female) and a per-voice preview

- **One Full-Length Track**: every cue is placed at its absolute timestamp in a single mono WAV, so muxing is a one-line `ffmpeg` command with no filter graph

- **Honest Timing**: no time-stretching and no silent rate adjustment. Overruns and collisions are reported, never hidden in the audio

- **Strict SRT Parsing**: comma or dot milliseconds, BOM, CRLF, missing indices, multi-line cues, markup stripping, and loud line-numbered errors for anything malformed

- **`report.json`**: per-cue fit, overruns and collisions, plus model id, pinned revision, dtype, device and voice. Any collision is a visible `FAILED` state, not a log line

- **Reproducible Output**: same SRT + voice + model revision + dtype gives a byte-identical WAV on `wasm`/`q8`. The WAV's SHA-256 is shown so you can compare runs without diffing files

- **Model Tiers**: q8 (default), fp16, fp32 and q4, with the download size shown **before** you commit. Weights are cached after the first fetch

- **Waveform with Cue Boundaries**: cue windows, overruns and collisions marked on the track; click to seek

- **Fast & Responsive**: synthesis runs in a Web Worker to keep the UI smooth

- **Privacy First**: zero telemetry, zero third-party requests after the model fetch; the runtime is self-hosted

---

## What It Replaces

| Tool | What you replace |
|---|---|
| ElevenLabs / Murf / WellSaid | Paid cloud text-to-speech with a script upload |
| Amazon Polly / Google Cloud TTS / Azure Speech | Metered cloud TTS APIs and API keys |
| Descript / Veed / Kapwing | Cloud voiceover and dubbing tools |
| `speechSynthesis` screen-capture hacks | Recording the OS speaker output to get a file |

**The difference that matters:** every one of those tools sends your script to a server. Some are free with limits, some charge per character, but all of them *read your text*, and all are subject to data breaches, subpoenas, and privacy-policy changes. `speechSynthesis` (the Web Speech API) never gives you a file at all: it renders to the speakers and exposes no buffer.

dub-webCLI turns a cue list into a timed audio track for free, with text that **never leaves your device**.

---

## Usage

### ▤ 1 · Load an SRT
Drag & drop or click to load a `.srt`, or press **Load sample**. The cue count and every issue found are listed with their source line numbers.

### ⚙ 2 · Pick a Voice and Model
Choose one of 28 voices and press **▶ Preview** to hear a sample line. Pick a **model tier**; the download size is shown next to each tier, and the Dub button reads `Download ~93 MB & Dub` until the model is cached. Choose a **device**: `wasm` (deterministic) or `webgpu` (faster, not bit-reproducible).

### ◉ 3 · Dub
Each cue is synthesized in order and placed at its start time. Progress shows the cue being voiced.

### ✎ 4 · Review
The result banner shows **OK** or **FAILED**. The waveform marks cue windows (blue), overruns (amber) and collisions (red); the table lists every cue with its start, window, actual length, overrun, colliding cue and status.

### ↓ 5 · Download
Export **`dub.wav`** and **`report.json`**. Mux with [ffmpeg-webCLI](https://github.com/tejaswigowda/ffmpeg-webCLI) or locally:

```bash
ffmpeg -i short.mp4 -i dub.wav -c:v copy -c:a aac -shortest out.mp4
```

---

## Timing: Place Honestly, Report, Never Fit

TTS produces whatever duration it produces; the cue window is fixed. They will not match. dub does **not** time-stretch or rate-adjust. Each cue is placed at its start time as synthesized, and the report says what happened:

- **overrun**: the audio is longer than the cue window (`actual > window`).
- **collision**: the audio runs past the next cue's start. Any collision turns the result banner red and sets `"ok": false`. Overlapping audio is summed, not truncated.
- **truncated**: Kokoro limits one chunk to about 510 phoneme tokens. Long cues are split on sentence boundaries; a single sentence over the limit is flagged rather than silently cut.

The author decides: fix the SRT or the shot timing and run again. Track length is `max(last cue start + its audio, last cue end)`; silence fills the gaps. Kokoro's native 24 kHz is kept; let `ffmpeg` resample if needed.

---

## SRT Handling

| Case | Handling |
|---|---|
| `HH:MM:SS,mmm` and `HH:MM:SS.mmm` | both accepted |
| BOM, CRLF | stripped / normalised |
| Missing or non-sequential indices | accepted; cues are renumbered internally (`i`), the original is kept as `srt_index` |
| Multi-line text | joined with one space |
| `<i>`, `<b>`, `<font …>`, `{\an8}`, common HTML entities | stripped before synthesis |
| Empty cue after stripping | skipped, reported |
| Zero duration, `end < start` | error, not synthesized |
| Cue starts before the previous one ends (also any out-of-order cue) | overlap error, not synthesized |
| Anything else malformed | **fatal**: nothing is synthesized; each problem is listed with its line number |

Milliseconds must be exactly three digits; there is no guessing. An error on one cue does not block the others, but it sets `"ok": false` and the result shows `FAILED`.

---

## report.json

```json
{ "ok": false, "cues": 24, "synthesized": 24, "overruns": 2, "collisions": 1, "truncated": 0, "input_errors": 0,
  "duration_s": 118.4, "sample_rate": 24000,
  "model": { "id": "onnx-community/Kokoro-82M-v1.0-ONNX", "revision": "1939ad2a…", "dtype": "q8", "device": "wasm", "library": "kokoro-js@1.2.1" },
  "voice": "af_heart", "reproducible": true, "wav_sha256": "…",
  "issues": [ { "severity": "error", "code": "overlap", "line": 41, "cue": 9, "message": "…" } ],
  "detail": [ { "i": 7, "srt_index": 7, "line": 26, "start": 31.2, "window": 2.1, "actual": 2.64,
                "overrun": 0.54, "collides_with": 8, "overlap": 0.31, "status": "collision", "text": "…" } ] }
```

`detail` lists every cue (`status`: `ok`, `overrun`, `collision`, `truncated`, `empty`, `zero_duration`, `negative_duration`, `overlap`). The report contains no timestamps, so it is as reproducible as the WAV.

---

## Model Sizes & Determinism

Sizes are the real file sizes at the pinned model revision (plus ~0.5 MB per voice).

| Tier | dtype | Size | Use |
|---|---|---|---|
| Default | `q8` | 92 MB | first load; the reproducible choice |
| Better | `fp16` | 163 MB | opt-in |
| Best | `fp32` | 326 MB | opt-in, recommended with `webgpu` |
| q4 | `q4` | 305 MB | opt-in; **not smaller than q8** in this repo |

**Determinism:** same SRT + voice + model revision + dtype → byte-identical WAV, on `wasm` with `q8`.

- The model is pinned to a commit, not `main`. `kokoro-js` cannot pin a revision itself, so `docs/core/synth.js` rewrites `resolve/main/` to the pinned commit at the fetch layer (model, tokenizer and voices).
- Kokoro inference involves no sampling randomness.
- Without cross-origin isolation, ONNX Runtime stays single-threaded. `server.js` deliberately sends no COOP/COEP headers.
- **`webgpu` is faster but not bit-reproducible across GPUs.** The UI says so next to the device selector, and the report's `reproducible` flag is true only for `wasm` + `q8`.
- Node `cpu` and browser `wasm` are different runtimes and produce different bytes; each is reproducible against itself.

---

## How It Works

dub-webCLI brings Kokoro text-to-speech to the browser via Transformers.js:

1. **ONNX model**: Kokoro-82M is exported as ONNX, enabling portable inference.
2. **Phonemizer**: text is converted to phonemes in the browser (eSpeak NG compiled to WebAssembly, inside the `kokoro-js` bundle).
3. **Browser execution**: the model runs in a Web Worker on ONNX Runtime WebAssembly (or WebGPU if selected).
4. **Placement**: each cue's audio is written into one full-length buffer at its absolute start time, then encoded as 16-bit mono WAV. Nothing is stretched.
5. **Zero network egress**: only the model weights are fetched, once, from Hugging Face, then cached.

```
┌──────────────────────────────────────────┐
│ index.html + app.js (UI)                 │
│ - SRT drop / voice / tier / device       │
│ - waveform, report table, downloads      │
└──────────────┬───────────────────────────┘
               │ postMessage
┌──────────────▼───────────┐   ┌─────────────────────────────┐
│ tts-worker.js            │   │ core/ (pure ES modules)     │
│ - Kokoro via kokoro-js   │   │ - srt.js      parser        │
│ - off-main-thread        │   │ - timeline.js place + WAV   │
│ - revision pin           │   │ - synth.js    per-cue TTS   │
└──────────────┬───────────┘   └─────────────────────────────┘
               │ first run only
┌──────────────▼──────────────────────────┐
│ huggingface.co: pinned Kokoro revision  │
│ cached in the browser (Cache Storage)   │
└─────────────────────────────────────────┘
```

---

## Privacy & Security

**Zero-egress verification:**
1. Open DevTools (F12) → Network tab.
2. Load the app, dub an SRT once so the model is cached, then reload and dub again.
3. Observe **zero outbound requests** on the second run. The first run shows only the model download from `huggingface.co`. No telemetry, no analytics, no fonts or scripts from a CDN.

**Self-hosted runtime:** `kokoro-js` and the ONNX Runtime wasm live in `docs/vendor/`. `npm test` fails if any host other than `huggingface.co` appears in the shipped page code.

**Data storage:**
- Model weights and voices are cached locally in the browser's Cache Storage.
- Your SRT and the generated audio are never stored or sent anywhere.

---

## Running Locally

### Prerequisites
- Node.js 20+ (only for the dev server and tests)
- A modern browser (Chrome, Edge, Firefox, Safari 15+)

### Setup

```bash
git clone https://github.com/tejaswigowda/dub-webCLI.git
cd dub-webCLI

# Start the development server
npm run serve          # or: node server.js

# Open http://127.0.0.1:5500
```

### Deployment

Deploy the `docs/` folder to any static host:

- **GitHub Pages**: enable in repo settings; serve from `docs/`.
- **Vercel / Netlify / Cloudflare Pages**: drag & drop the `docs/` folder.
- **Traditional web server**: copy `docs/` to the web root.

Unlike ffmpeg-webCLI and whisper-webCLI, **no special headers are needed**. Do not add COOP/COEP unless you accept multi-threaded inference, which gives up the byte-identical guarantee. Serve `.wasm` as `application/wasm`.

### Tests and Gates

```bash
npm test            # parser, timeline, WAV, pinning, no-third-party-host checks (fast, offline)
npm run test:e2e    # gates D1–D3 on Node cpu/q8; downloads Kokoro q8 (~92 MB) and whisper-tiny.en (~40 MB)
```

| Gate | Check | Status |
|---|---|---|
| D1 | `whisper(dub(srt)) ≈ srt`: every cue found in order, at about the right time | `test:e2e` (whisper-tiny.en word timestamps) |
| D2 | no collisions in `report.json` | `test:e2e` |
| D3 | two runs, same settings → identical WAV | `test:e2e` on Node cpu/q8; in the browser on `wasm`/`q8`, two fresh page loads of the bundled sample both produced `9501fd6f…d7c3c` (2026-10-25) |

---

## Project Structure

```
docs/
├── index.html                # Main UI (webCLI look & feel)
├── style.css                 # Dark theme, shared webCLI design tokens
├── app.js                    # App controller (UI + orchestration)
├── tts-worker.js             # Web Worker: Kokoro model + synthesis
├── core/
│   ├── srt.js                # Strict SRT parser
│   ├── timeline.js           # Placement, mixing, WAV encoding, report
│   ├── synth.js              # Per-cue synthesis, revision pin
│   └── models.js             # Pinned revision, tiers, voices
└── vendor/                   # Self-hosted kokoro-js bundle + ONNX Runtime wasm

server.js                     # Node.js static dev server
test/                         # Unit tests + e2e gates D1–D3
CREDITS.md                    # Model, voice and library licensing
```

`docs/vendor/ort-wasm-simd-threaded.jsep.*` must match the `@huggingface/transformers` version inside `kokoro.web.js` (3.5.1). Do not update one without the other.

The `core/` modules have no DOM dependencies, so the same parser, placement and report code runs in the page, the worker and Node.

---

## Dependencies

**None at runtime** beyond the vendored `kokoro-js` bundle (Transformers.js, ONNX Runtime, phonemizer). Node.js is only used for the local dev server and tests.

---

## Out of Scope

Time-stretching or any automatic fitting, MP3/AAC/Opus encoding (use ffmpeg), translation or multi-language (revisit with Piper), voice cloning, music/SFX/mixing, recorded-take ingestion.

---

## Part of the Web-CLI family

A family of zero-egress browser tools - your data never leaves your device, verifiable in DevTools. All free and open source.

- **[ffmpeg-webCLI](https://github.com/tejaswigowda/ffmpeg-webCLI)** - full FFmpeg in the browser: trim, convert, compress, caption, and 30+ video operations. ([live](https://tejaswigowda.com/ffmpeg-webCLI/))
- **[whisper-webCLI](https://github.com/tejaswigowda/whisper-webCLI)** - speech-to-text with Whisper (Transformers.js), ~99 languages, on-device. ([live](https://tejaswigowda.com/whisper-webCLI/))
- **[chat-webCLI](https://github.com/tejaswigowda/chat-webCLI)** - local LLM chat via WebLLM/WebGPU; prompts never leave the device. ([live](https://tejaswigowda.com/chat-webCLI/))
- **[3mf-webCLI](https://github.com/tejaswigowda/3mf-webCLI)** - GLB to multi-material 3MF for AMS/MMU 3D printing, client-side. ([live](https://tejaswigowda.com/3mf-webCLI/))

Architecture paper: [arXiv:2608.28950](https://arxiv.org/abs/2608.28950)

---

## Acknowledgments

- **Kokoro-82M** - hexgrad (Apache-2.0); ONNX conversion by onnx-community
- **kokoro-js** - hexgrad (Apache-2.0)
- **Transformers.js** - Hugging Face / Xenova (Apache-2.0)
- **ONNX Runtime** - Microsoft & community (MIT)
- **eSpeak NG** - phonemizer, compiled to WebAssembly (GPL-3.0)
- **whisper-webCLI** - sibling project and the round-trip verification gate
- **ffmpeg-webCLI** - sibling project and design inspiration

Full details, pinned revision and retrieval dates: [CREDITS.md](CREDITS.md).

---

## License

GPL-3.0 - see [LICENSE](LICENSE). The vendored `kokoro-js` bundle embeds eSpeak NG (GPL-3.0); Kokoro (Apache-2.0), Transformers.js (Apache-2.0) and ONNX Runtime (MIT) are compatible with GPL-3.0.

---

**Questions?** Open an [issue](https://github.com/tejaswigowda/dub-webCLI/issues) or submit a PR.
