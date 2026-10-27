# Work Order — dub.webcli.app: Strata hand-off

**Created:** 2026-10-27
**Target repo:** `dub-webCLI` (deployed as `dub.webcli.app`)
**Consumer:** Strata's Publish step (`strataeditor.dev`, repo `strata-editor`)
**Sibling order:** `STRATA_HANDOFF_WORKORDER.md` in `ffmpeg.wasm.editor` (same protocol, other tool)
**Protocol spec:** `strata-editor/guides/HANDOFF.md` (read it first; it is the contract)

---

## 0. What this is

Strata's Publish step opens dub in a popup, sends the scene's subtitle cues as an SRT, and gets back the timed narration WAV plus dub's own report. Files move by `postMessage` between the two windows in the same browser. Nothing is uploaded.

The hand-off is **already written and working in this repo's working tree, but uncommitted and not deployed**. This order is: review it, harden it, close the untested paths, ship it.

### 0.1 Already done (working tree, uncommitted)

| File | Change |
|---|---|
| `docs/handoff.js` | new. `serve()` answers only `window.opener`, only from an allowed origin, replies to that origin only. Byte-identical to `ffmpeg.wasm.editor/docs/handoff.js` |
| `docs/app.js` | `dub()` now returns the result or `null` (and sets `state.lastError`); `showProgress` also feeds `state.onProgress`; new `handleDub` op; `serve({ tool: 'dub.webcli.app', version: '1', handlers: { dub } })` |
| `docs/index.html` | `<div id="handoffBar" class="banner" hidden>` above the grid |
| `test/handoff.test.mjs` | 7 tests for `serve()`; `npm test` runs it with `unit.test.js` (28 pass) |
| `README.md` | "Use it from another page" section |

Verified in real Chrome against the editor's own Publish step with dub served locally: 79.05 s WAV for Strata's `projectile` subtitles, 12 cues, no collisions; **two runs gave byte-identical WAVs** (`sha256:ff6d763a…`), wasm + q8.

### 0.2 The contract (do not change without changing Strata's `export/handoff.js` and the ffmpeg tool)

```
opener -> dub  { webcli: 1, type: 'job', id, op: 'dub', args: { voice?, tier?, device?, name? }, files: { 'subtitles.srt': ArrayBuffer } }
dub -> opener  { webcli: 1, type: 'ready' | 'progress' | 'result' | 'error', id, ... }
result.files['narration.wav'] (ArrayBuffer), result.meta = { report, voice, tier, device }
```

---

## PART A — ship what exists

**A.1** Review the diff above. Keep `docs/handoff.js` byte-identical with the ffmpeg repo's copy (`cmp` must say identical); if you change one, change both and say so in the commit.

**A.2** `npm test` green. Commit as one change, deploy.

**A.3** Verify on the **deployed** site, not localhost: open `https://dub.webcli.app/` from a page on `https://strataeditor.dev` (Strata → Render → Publish → *Dub the subtitles*). The ready handshake must complete and a WAV must come back. This has never been run against the deployed origin.

**GATE D1:** deployed dub answers Strata's popup and returns a WAV.

---

## PART B — close the paths that were written but not exercised

### B.1 "Send to Strata anyway" (collisions)

`handleDub` waits on `askToSend()` when `report.ok` is false. Never run. Write a Playwright test (use the repo's e2e setup) with an SRT whose cues collide, driven through a fake opener page, and assert: no result is posted until the button is pressed; *Send to Strata anyway* posts the WAV and the report with `ok: false`; *Don't send* posts an `error` whose message names the problem.

### B.2 Cancel

Strata sends `{ type: 'cancel', id }` when its user aborts. `serve()` aborts the job's signal and `handleDub` forwards it to the worker. Verify that: the worker stops, the job answers `error: Cancelled.`, `state.busy` clears, and a **second job then works** without reloading the page.

### B.3 Window closed mid-job

If the popup is closed during synthesis the worker keeps running until the page dies. Confirm nothing leaks and nothing throws when `opener.postMessage` targets a closed window (it is wrapped in try/catch in `serve()`; prove it).

**GATE D2:** all three paths have a passing automated test.

---

## PART C — what the consumer needs

### C.1 Say which voices exist

Strata's voice field is free text (`af_heart`), so a typo is a failed job. Add `voices: [{ id, name, accent, gender }]` and `defaults: { voice, tier, device }` to the `ready` message (additive: protocol stays v1, old clients ignore it). Coordinate the field names with Strata's owner before shipping; Strata will then offer a select.

### C.2 Reject unknown voice/tier/device loudly

`handleDub`'s `choose()` silently keeps dub's default when `args.voice` is not an option. For a hand-off that is wrong: the narration would use a voice the caller did not ask for, and `render.json` would record the requested one. Make an unknown or disabled value an `error` that names the valid values. Empty or absent still means "default".

### C.3 Reproducibility must survive the hand-off

Strata records the WAV's sha256 and the model in `render.json`. Keep the defaults `device: wasm`, `tier: default` (q8), the combination dub documents as byte-reproducible, and make the `report` in the result say `reproducible: true/false` as it does in the UI. Add a test: two hand-off jobs with the same SRT, voice, tier and device return identical WAV bytes.

### C.4 Background-tab throttling

The popup sits behind Strata's window while it synthesizes. Chrome throttles background tabs; the first run took 148 s to 244 s in testing against 79 s of speech. Measure synthesis with the popup in the background and in the foreground; if throttling matters, either ask Strata to open the popup focused or tell the user in `handoffBar` ("keep this window visible while it works"). Report the numbers either way.

**GATE D3:** C.1 to C.4 done or each explicitly declined with a reason.

---

## PART D — hygiene

- **Origin allow-list** lives in `docs/handoff.js` (`ALLOWED_ORIGINS`: `strataeditor.dev`, `www.strataeditor.dev`; localhost and 127.0.0.1 on any port for development). If Strata moves domains, this is the one line to change, in **both** tools.
- The localhost allowance means any page on the user's own machine can drive the popup. That is intended for development; note it in the README, and do not widen it.
- The model download (about 90 MB, cached per site) happens inside the popup on first use. Make sure the `handoffBar` says so when the model is not cached, so the user does not think it is stuck.
- Keep dub's standalone behaviour unchanged: opened in a normal tab (no `window.opener`) `serve()` returns `null` and nothing else runs.

---

## Gates

| Gate | Condition |
|---|---|
| **D1** | deployed `dub.webcli.app` answers a popup opened from `strataeditor.dev` and returns a WAV |
| **D2** | collision prompt, cancel (and a second job after it), and closed-window paths are tested |
| **D3** | voices advertised, unknown values rejected, same-input hand-offs byte-identical, throttling measured |
| **D4** | `docs/handoff.js` is byte-identical with the ffmpeg repo's; `npm test` green |

## Out of scope

- more ops than `dub` (no translation, no voice cloning, no multi-language)
- any server, upload, or account
- changing Strata (separate repo); report protocol questions to its owner
- changing how dub works standalone
