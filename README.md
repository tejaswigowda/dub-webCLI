# dub webCLI

**SRT in, timed WAV out.** Local, in-browser, no server, no API key. The sibling and inverse of [whisper-webCLI](https://github.com/tejaswigowda/whisper-webCLI): whisper turns audio into timed text, dub turns timed text into audio.

Text-to-speech is today's means, not the definition: the tool's job is "produce a timed audio track from a cue list".

## Use

```bash
npm run serve        # http://127.0.0.1:5500  (any static host works; docs/ is the site)
```

1. Drop an `.srt` (or press **Load sample**).
2. Pick a voice (▶ Preview plays a sample line) and a model tier. The download size is shown before you commit; the Dub button reads `Download ~93 MB & Dub` until the model is cached.
3. **Dub**. Download `dub.wav` and `report.json`.
4. Mux with [ffmpeg.webcli.app](https://ffmpeg.webcli.app), or locally:

```bash
ffmpeg -i short.mp4 -i dub.wav -c:v copy -c:a aac -shortest out.mp4
```

Cues are placed at their absolute timestamps in one full-length 16-bit mono WAV (Kokoro's native 24 kHz), so no filter graph is needed.

## Timing: place honestly, report, never fit

TTS duration will not match the cue window. dub does **not** time-stretch or rate-adjust. Each cue is placed at its start time as synthesized, and the report says what happened:

- **overrun**: audio is longer than the cue window (`actual > window`).
- **collision**: audio runs past the next cue's start. Any collision turns the result banner red (`FAILED`) and sets `"ok": false`. Overlapping audio is summed, not truncated.
- **truncated**: Kokoro limits one chunk to about 510 phoneme tokens. Long cues are split on sentence boundaries; a single sentence over the limit is flagged rather than silently cut.

The author decides: fix the SRT or the shot timing and run again.

## SRT handling

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
| Anything else malformed | **fatal**: nothing is synthesized, each problem is listed with its line number |

Millis must be exactly three digits; there is no guessing. Errors on individual cues do not block the others, but they set `"ok": false` and the result shows `FAILED`.

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

`detail` lists every cue (`status`: `ok`, `overrun`, `collision`, `truncated`, `empty`, `zero_duration`, `negative_duration`, `overlap`). It contains no timestamps, so the report is as reproducible as the WAV.

## Determinism

Same SRT + voice + model revision + dtype → byte-identical WAV, **on `wasm` with `q8`**.

- The model is pinned to a commit, not `main`. `kokoro-js` cannot pin a revision itself, so `docs/core/synth.js` rewrites `resolve/main/` to the pinned commit at the fetch layer (model, tokenizer and voices).
- No sampling randomness is involved in Kokoro inference.
- Without cross-origin isolation (no COOP/COEP headers; `server.js` deliberately sends none) ONNX Runtime stays single-threaded.
- **`webgpu` is faster but not bit-reproducible across GPUs.** The UI says so next to the device selector, and the report's `reproducible` flag is true only for `wasm` + `q8`.
- The result banner shows the WAV's SHA-256, so two runs can be compared without diffing files.

## Model tiers

Sizes are the real file sizes at the pinned revision (plus ~0.5 MB per voice).

| Tier | dtype | Size | Use |
|---|---|---|---|
| Default | `q8` | 92 MB | first load; the reproducible choice |
| Better | `fp16` | 163 MB | opt-in |
| Best | `fp32` | 326 MB | opt-in, recommended with `webgpu` |
| q4 | `q4` | 305 MB | opt-in; **not smaller than q8** in this repo |

Weights are cached in the browser's Cache Storage after the first fetch.

## Privacy

After the model fetch there are no third-party requests: the runtime (`kokoro-js`, ONNX Runtime wasm) is self-hosted in `docs/vendor/`, with no CDN fonts, icons or scripts. The only remote host is `huggingface.co`, for the model files, and only until they are cached. `npm test` fails if any other host appears in the shipped page code.

## Tests and gates

```bash
npm test            # parser, timeline, WAV, pinning, no-third-party-host checks (fast, offline)
npm run test:e2e    # gates D1–D3 on Node cpu/q8; downloads Kokoro q8 (~92 MB) and whisper-tiny.en (~40 MB)
```

| Gate | Check | Status |
|---|---|---|
| D1 | `whisper(dub(srt)) ≈ srt`: every cue found in order, at about the right time | `test:e2e` (whisper-tiny.en word timestamps) |
| D2 | no collisions in `report.json` | `test:e2e` |
| D3 | two runs, same settings → identical WAV | `test:e2e` on Node cpu/q8; in the browser on `wasm`/`q8`, two fresh page loads of the bundled sample both produced `9501fd6f…d7c3c` (2026-10-25) |

Node cpu (onnxruntime-node) and browser wasm are different runtimes and produce different bytes; each is reproducible against itself.

## Layout

```
docs/index.html, style.css, app.js   UI
docs/tts-worker.js                   Kokoro in a module worker
docs/core/srt.js                     strict SRT parser
docs/core/timeline.js                placement, mixing, WAV, report
docs/core/synth.js                   per-cue synthesis, revision pin
docs/core/models.js                  pinned revision, tiers, voices
docs/vendor/                         self-hosted kokoro-js bundle + ONNX Runtime wasm
server.js                            static server for docs/
test/                                unit + e2e gates
```

No build step. `docs/vendor/ort-wasm-simd-threaded.jsep.*` must match the `@huggingface/transformers` version inside `kokoro.web.js` (3.5.1); do not update one without the other.

## Out of scope

Time-stretching or any automatic fitting, MP3/AAC/Opus encoding (that is ffmpeg), translation / multi-language (revisit with Piper), voice cloning, music/SFX/mixing, recorded-take ingestion.

## Licence

GPL-3.0-or-later, see [LICENSE](LICENSE) and [CREDITS.md](CREDITS.md) (the vendored bundle embeds eSpeak NG, GPL-3.0).