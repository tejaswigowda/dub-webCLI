// Strict SRT parser. Pure ESM, no DOM: shared by the page, the worker and the Node tests.
//
// Returns { cues, issues, fatal }.
//   fatal  – true when the file is malformed; nothing may be synthesized.
//   issues – every problem found, each with the 1-based source line it belongs to.
//   cues   – every cue with a parseable timing line, in file order. Each carries
//            `status`: 'ok' | 'empty' | 'zero_duration' | 'negative_duration' | 'overlap'.
//            Only status 'ok' cues are synthesized.

const TIME = '(\\d+):(\\d{2}):(\\d{2})[,.](\\d{3})';
const TIMING_RE = new RegExp(`^\\s*${TIME}\\s*-->\\s*${TIME}(?:\\s+\\S.*)?\\s*$`);
const LOOSE_TIMING_RE = /-->/;
const INDEX_RE = /^\s*\d+\s*$/;

const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'", '&nbsp;': ' ' };

function toMs(h, m, s, ms) {
  return ((Number(h) * 60 + Number(m)) * 60 + Number(s)) * 1000 + Number(ms);
}

/** join_lines → strip_markup, in the order the spec prescribes. */
export function cleanCueText(lines) {
  return lines
    .join(' ')
    .replace(/\{\\[^}]*\}/g, '') // {\an8} and other ASS overrides
    .replace(/<\/?[A-Za-z][^>]*>/g, '') // <i>, <b>, <font color="…">, …
    .replace(/&(?:amp|lt|gt|quot|apos|nbsp|#39);/g, (e) => ENTITIES[e])
    .replace(/\s+/g, ' ')
    .trim();
}

export function parseSrt(input) {
  const text = String(input).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  const cues = [];
  const issues = [];
  let fatal = false;

  const fail = (line, code, message) => {
    fatal = true;
    issues.push({ severity: 'fatal', code, line, message });
  };

  // Group into blocks of consecutive non-blank lines, remembering line numbers.
  const blocks = [];
  let cur = null;
  lines.forEach((raw, idx) => {
    if (raw.trim() === '') {
      cur = null;
    } else {
      if (!cur) blocks.push((cur = []));
      cur.push({ n: idx + 1, s: raw });
    }
  });

  if (blocks.length === 0) {
    fail(1, 'no_cues', 'No cues found: the file is empty.');
    return { cues, issues, fatal };
  }

  for (const block of blocks) {
    let pos = 0;
    let srtIndex = null;
    if (INDEX_RE.test(block[0].s)) {
      srtIndex = Number(block[0].s);
      pos = 1;
    }
    const timingLine = block[pos];
    if (!timingLine) {
      fail(block[0].n, 'missing_timing', `Cue index ${srtIndex} has no timing line.`);
      continue;
    }
    const m = TIMING_RE.exec(timingLine.s);
    if (!m) {
      const why = LOOSE_TIMING_RE.test(timingLine.s)
        ? 'Malformed timing line (expected HH:MM:SS,mmm --> HH:MM:SS,mmm)'
        : 'Expected a cue index or a timing line';
      fail(timingLine.n, 'bad_timing', `${why}: "${timingLine.s.trim()}"`);
      continue;
    }
    if (Number(m[2]) > 59 || Number(m[3]) > 59 || Number(m[6]) > 59 || Number(m[7]) > 59) {
      fail(timingLine.n, 'bad_timing', `Minutes and seconds must be 00–59: "${timingLine.s.trim()}"`);
      continue;
    }

    const body = block.slice(pos + 1);
    const cue = {
      i: cues.length + 1, // internal, renumbered
      srtIndex,
      line: timingLine.n,
      startMs: toMs(m[1], m[2], m[3], m[4]),
      endMs: toMs(m[5], m[6], m[7], m[8]),
      raw: body.map((b) => b.s).join('\n'),
      text: cleanCueText(body.map((b) => b.s)),
      status: 'ok',
    };
    cues.push(cue);
  }

  // Semantic checks, in file order. An overlap is "starts before the previous cue ends".
  let prevEndMs = -Infinity;
  let prevI = null;
  for (const cue of cues) {
    const dur = cue.endMs - cue.startMs;
    if (dur < 0) {
      mark(cue, issues, 'negative_duration', `Cue ${cue.i} ends before it starts (end < start).`);
      continue;
    }
    if (dur === 0) {
      mark(cue, issues, 'zero_duration', `Cue ${cue.i} has zero duration.`);
      continue;
    }
    if (cue.text === '') {
      mark(cue, issues, 'empty', `Cue ${cue.i} has no text after stripping markup; skipped.`, 'skipped');
      continue;
    }
    if (cue.startMs < prevEndMs) {
      mark(cue, issues, 'overlap', `Cue ${cue.i} starts before cue ${prevI} ends; two voices cannot share one track.`);
      cue.overlapsWith = prevI;
      continue;
    }
    prevEndMs = cue.endMs;
    prevI = cue.i;
  }

  return { cues, issues, fatal };
}

function mark(cue, issues, code, message, severity = 'error') {
  cue.status = code;
  issues.push({ severity, code, line: cue.line, cue: cue.i, message });
}
