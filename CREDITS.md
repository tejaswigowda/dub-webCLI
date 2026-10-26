# Credits

Retrieved and verified: **2026-10-25**.

`redistributed: false` means the file is fetched by the user's browser from its origin and is **not** shipped in this repository. `redistributed: true` means a copy lives in [docs/vendor/](docs/vendor).

> `TUTORIAL_CREDITS_WORKORDER.md` was not available when this file was written. The fields below follow the spec's §10 (weights + licence, library + licence, voice set, date retrieved, `redistributed`). Re-shape them if the work order prescribes a different schema.

## Model and voices

| Item | Detail |
|---|---|
| Name | Kokoro-82M (v1.0), ONNX conversion |
| Author | hexgrad (base model); onnx-community (ONNX export) |
| Source | https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX |
| Pinned revision | `1939ad2a8e416c0acfeecc08a694d14ef25f2231` (last modified 2025-02-08) |
| Licence | Apache-2.0 (model card front matter) |
| Files fetched | `onnx/model_quantized.onnx` (q8, default), `model_fp16.onnx`, `model.onnx`, `model_q4.onnx` on opt-in; `config.json`, `tokenizer*.json` |
| Retrieved | 2026-10-25 |
| redistributed | **false** — fetched by the user's browser at run time |

**Voice set** (`voices/<id>.bin`, same repo and revision, fetched on demand, `redistributed: false`): 28 voices.

- American English, 11 F: `af_heart`, `af_alloy`, `af_aoede`, `af_bella`, `af_jessica`, `af_kore`, `af_nicole`, `af_nova`, `af_river`, `af_sarah`, `af_sky`
- American English, 9 M: `am_adam`, `am_echo`, `am_eric`, `am_fenrir`, `am_liam`, `am_michael`, `am_onyx`, `am_puck`, `am_santa`
- British English, 4 F: `bf_emma`, `bf_isabella`, `bf_alice`, `bf_lily`
- British English, 4 M: `bm_george`, `bm_lewis`, `bm_daniel`, `bm_fable`

## Code

| Component | Version | Licence | Source | redistributed |
|---|---|---|---|---|
| `kokoro-js` (bundle `docs/vendor/kokoro.web.js`) | 1.2.1 | Apache-2.0 | https://www.npmjs.com/package/kokoro-js | **true** |
| `@huggingface/transformers` (inlined in the bundle; ORT glue + wasm in `docs/vendor/ort-wasm-simd-threaded.jsep.*`) | 3.5.1 | Apache-2.0 | https://www.npmjs.com/package/@huggingface/transformers | **true** |
| `onnxruntime-web` (inlined in the bundle and wasm above) | 1.22.0-dev.20250409 | MIT | https://www.npmjs.com/package/onnxruntime-web | **true** |
| `phonemizer` (inlined in the bundle) | 1.2.1 | Apache-2.0 (wrapper) | https://www.npmjs.com/package/phonemizer | **true** |
| **eSpeak NG** (compiled to wasm inside `phonemizer`, inlined in the bundle) | as bundled | **GPL-3.0-or-later** | https://github.com/espeak-ng/espeak-ng | **true** |

### Licence note: eSpeak NG is GPL-3.0

`kokoro-js` is Apache-2.0 and `phonemizer` declares Apache-2.0, but the bundle used here embeds eSpeak NG, which is GPL-3.0-or-later. Redistributing `docs/vendor/kokoro.web.js` therefore means redistributing GPL code. This repository carries the GPL-3.0 text in [LICENSE](LICENSE), the same as `whisper-webCLI`. If that is not the intended licence for `dub`, change it before publishing.

## Development and test only (not shipped)

| Component | Licence | Use |
|---|---|---|
| `kokoro-js` + `onnxruntime-node` 1.21 | Apache-2.0 / MIT | Node `cpu` tests |
| `onnx-community/whisper-tiny.en_timestamped` (ONNX conversion of `openai/whisper-tiny.en`) | Apache-2.0 per the base model card; the conversion repo declares no licence of its own | round-trip gate D1 in `npm run test:e2e`; `redistributed: false` |

Licence texts for the vendored libraries: [docs/vendor/LICENSE.kokoro-js](docs/vendor/LICENSE.kokoro-js), [docs/vendor/LICENSE.transformers](docs/vendor/LICENSE.transformers), [docs/vendor/LICENSE.phonemizer](docs/vendor/LICENSE.phonemizer). `onnxruntime-web` (MIT) and eSpeak NG (GPL-3.0, see [LICENSE](LICENSE)) have no separate copy here; their upstream licences apply.
