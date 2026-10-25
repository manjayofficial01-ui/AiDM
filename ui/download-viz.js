/*
 * download-viz.js — the Plexo-derived download visualisation primitives,
 * shared by the renderer (window.DownloadViz) and the Node test suite
 * (module.exports). ONE source of truth: the browser has no module system, so
 * this UMD wrapper publishes the same object to `self` and to `module.exports`.
 *
 * Ported from Plexo's BlockGrid.tsx / ThroughputChart.tsx concepts, adapted to
 * AiDM's vanilla stack:
 *   • BlockGrid  → blocksFromSegments(): a byte-space map, one block per chunk,
 *     each sized by its share of the file and filled by its own progress. The
 *     fill floor (a started chunk floors to a 6% sliver) is Plexo's rule: a
 *     ~12px cell would otherwise round the first bytes to an invisible 0 width.
 *   • ByteMap    → byteBlockHtml(): the SAME map for downloads with no
 *     per-segment breakdown (yt-dlp, torrent, single-connection HTTP) — one
 *     wide block filled to the honest percent. flowBandHtml() covers the
 *     in-flight-but-size-unknown case with an indeterminate stripe, so every
 *     active row animates, none of them fake a percent.
 *   • ThroughputChart → areaPath(): the area+line SVG geometry for the live
 *     speed chart (fixed time axis, newest at the right edge).
 *   • prefersReducedMotion(): the single a11y gate every animation checks.
 *   • assignInterfaces(): Plexo's round-robin chunk→network distribution.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.DownloadViz = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /**
   * True when the OS asks for reduced motion. `mm` is an optional matchMedia
   * handle (passed in so tests can stub it); falls back to the global one.
   */
  function prefersReducedMotion(mm) {
    try {
      if (mm && typeof mm.matches === 'boolean') return mm.matches;
      if (typeof matchMedia === 'function') {
        return matchMedia('(prefers-reduced-motion: reduce)').matches;
      }
    } catch (e) { /* matchMedia unavailable (SSR / very old browser) */ }
    return false;
  }

  /**
   * ETA seconds → compact human string. Plexo commit #149: a time just under a
   * minute reads "1m 0s", never "60s"; sub-minute reads "45s"; under an hour
   * "3m 12s"; over "1h 05m". Empty string when unknown / non-positive.
   */
  function fmtEta(sec) {
    if (sec == null || !isFinite(sec) || sec <= 0) return '';
    sec = Math.ceil(sec);
    if (sec < 60) return sec + 's';
    if (sec < 3600) {
      const m = Math.floor(sec / 60);
      const s = sec % 60;
      return m + 'm ' + String(s).padStart(2, '0') + 's';
    }
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    return h + 'h ' + String(m).padStart(2, '0') + 'm';
  }

  /**
   * One block's fill percent. A done chunk is full; a started chunk floors to a
   * visible sliver so it never reads as 0 before it has meaningful bytes.
   */
  function blockFillPercent(downloaded, length, state) {
    if (state === 'done') return 100;
    if (!length || length <= 0) return 0;
    const raw = Math.floor((Math.max(0, Number(downloaded) || 0) / length) * 100);
    if (raw > 0) return Math.max(6, Math.min(100, raw));
    return 0;
  }

  /**
   * Turn the live per-segment snapshot into the BlockGrid's cells.
   *   • width% : the segment's byte share of the file (so a wide chunk is a
   *     wide block — the map reads as the file itself).
   *   • pct    : that segment's fill (Plexo's 6% floor applied).
   *   • state  : pending | active | done; tail marks a FluxDown micro-split.
   * More than `maxBlocks` segments coalesce (smallest first) so the DOM stays
   * bounded on a many-connection download; merged cells report their range.
   * Returns [] for a single/absent segment so callers fall back to the
   * single-chunk byte map (byteBlockHtml) or the flow band.
   */
  function blocksFromSegments(segs, totalBytes, opts) {
    const o = opts || {};
    const max = Math.max(1, o.maxBlocks || 48);
    if (!Array.isArray(segs) || segs.length <= 1) return [];

    let blocks = segs.map(function (s, i) {
      const start = Number(s.start);
      const end = Number(s.end);
      const len = (end != null && end >= 0 && start >= 0 && isFinite(end)) ? (end - start + 1) : 0;
      const state = s.state || 'pending';
      return {
        len: len > 0 ? len : 0,
        state,
        tail: !!s.tail,
        downloaded: Math.max(0, Number(s.downloaded) || 0),
        idx: i + 1,
        count: 1
      };
    });

    if (blocks.length > max) {
      const group = Math.ceil(blocks.length / max);
      const merged = [];
      for (let i = 0; i < blocks.length; i += group) {
        const slice = blocks.slice(i, i + group);
        const anyActive = slice.some(function (b) { return b.state === 'active'; });
        const allDone = slice.every(function (b) { return b.state === 'done'; });
        merged.push({
          len: slice.reduce(function (n, b) { return n + b.len; }, 0),
          state: anyActive ? 'active' : (allDone ? 'done' : 'pending'),
          tail: slice.some(function (b) { return b.tail; }),
          downloaded: slice.reduce(function (n, b) { return n + b.downloaded; }, 0),
          idx: slice[0].idx,
          count: slice.length
        });
      }
      blocks = merged;
    }

    const hasLens = blocks.every(function (b) { return b.len > 0; });
    const totalLen = blocks.reduce(function (n, b) { return n + b.len; }, 0);
    return blocks.map(function (b) {
      const width = (hasLens && totalLen > 0) ? (b.len / totalLen) * 100 : 100 / blocks.length;
      const pct = blockFillPercent(b.downloaded, b.len, b.state);
      const label = b.count > 1
        ? 'Segments ' + b.idx + '\u2013' + (b.idx + b.count - 1)
        : 'Segment ' + b.idx;
      const kb = b.len > 0 ? Math.max(1, Math.round(b.len / 1024)) : 0;
      const title = label + ': ' + b.state + (b.tail ? ' (tail)' : '') + ' \u2014 ' + pct + '%' +
        (kb ? ' of ' + kb + ' KB' : '');
      return { width: width, pct: pct, state: b.state, tail: b.tail, title: title };
    });
  }

  /**
   * SVG geometry for the live throughput chart: an area polygon plus a top
   * line, from a series of values (bytes at each tick). Fixed width/height,
   * newest sample at the right edge. Returns { line, area } path `d` strings,
   * both '' when there is nothing to draw (so the caller keeps the chart frame).
   */
  function areaPath(values, w, h, pad) {
    const p = (pad == null || pad < 0) ? 1.5 : pad;
    let vals = values;
    if (!Array.isArray(vals) || vals.length === 0) return { line: '', area: '' };
    if (vals.length === 1) vals = [vals[0], vals[0]];
    const n = vals.length;
    let max = 1;
    for (let i = 0; i < n; i++) { const v = Number(vals[i]) || 0; if (v > max) max = v; }
    const step = w / (n - 1);
    let line = '';
    for (let i = 0; i < n; i++) {
      const v = Number(vals[i]) || 0;
      const x = (i * step).toFixed(1);
      const y = (h - p - (v / max) * (h - p * 2)).toFixed(1);
      line += (i === 0 ? 'M' : 'L') + x + ',' + y;
    }
    const area = line + 'L' + w + ',' + h + 'L0,' + h + 'Z';
    return { line: line, area: area };
  }

  /** Max concurrent wave animations per row — beyond this, shimmer only. */
  var LIQUID_MAX_CELLS = 16;

  /**
   * The BlockGrid's markup, ready to drop into the row's progress cell:
   * one flex cell per segment whose width is its byte share of the file and
   * whose inner fill is that segment's own progress. Returns '' when there is
   * nothing to draw (single/absent segment), so the caller falls back to its
   * plain equal-width bar. `esc` is the caller's attribute escaper (injected
   * so the Node tests need no DOM).
   * v5.7.1 "one motion": the grid is deliberately STATIC — the liquid wave
   * on the row's main bar is the single downloading animation.
   */
  function blockGridHtml(segs, esc) {
    const blocks = blocksFromSegments(segs, null);
    if (!blocks.length) return '';
    const e = typeof esc === 'function' ? esc : function (s) { return String(s); };
    const cells = blocks.map(function (b) {
      const cls = ['block', b.state, b.tail ? 'tail' : ''].filter(Boolean).join(' ');
      return '<div class="' + cls + '" style="flex:0 0 ' + b.width.toFixed(2) +
        '%" title="' + e(b.title) + '"><div class="block-fill" style="width:' + b.pct +
        '%"></div></div>';
    }).join('');
    return '<div class="segments-bar block-grid" title="Segment map">' + cells + '</div>';
  }

  /**
   * State of the single-chunk byte map: the whole file as ONE wide block,
   * filled to the real percent. This is the Plexo look for every download
   * that has honest truth but no per-segment breakdown — yt-dlp rows,
   * torrents, and plain single-connection HTTP.
   *   `d` is a row-like object: { downloaded, totalSize, percent, status }
   *   • byte truth (totalSize) always wins over the engine's percent.
   *   • percent alone is FRAGMENT truth (HLS/DASH yt-dlp emits a fragment
   *     fraction while the exact byte count is unknown) — honest, but the
   *     tooltip must say so.
   *   • an active row at literally 0 bytes floors to the 6% sliver (Plexo's
   *     rule: a started chunk must never read as 0 while it is in flight).
   * Returns null when there is nothing honest to draw yet.
   */
  function byteBlockState(d) {
    if (!d) return null;
    const status = d.status || '';
    const done = status === 'completed';
    const state = done ? 'done'
      : (status === 'downloading' || status === 'connecting') ? 'active'
      : (status === 'paused') ? 'paused' : 'stalled';
    const bytes = Number(d.totalSize) || 0;
    const pctField = Number(d.percent);
    let pct = 0;
    let kind = 'bytes';
    if (bytes > 0) {
      pct = blockFillPercent(d.downloaded, d.totalSize, done ? 'done' : undefined);
    } else if (isFinite(pctField) && pctField > 0) {
      pct = Math.max(6, Math.min(100, Math.round(pctField)));
      kind = 'frags';
    } else if (done) {
      pct = 100;
      kind = 'frags';
    } else {
      return null;
    }
    if (pct === 0 && state === 'active') pct = 6;
    const label = kind === 'bytes' ? 'Byte map' : 'Fragment progress';
    const tip = done ? label + ' \u2014 complete'
      : label + ' \u2014 ' + pct + '%' +
        (kind === 'frags' ? ' (byte count unknown)' : '') +
        (status === 'paused' ? ' (paused)' : '');
    return { pct: pct, state: state, tip: tip };
  }

  /**
   * Markup for the single-chunk byte map (see byteBlockState). Reuses the
   * BlockGrid's cell CSS — one cell at 100% width, its own fill percent —
   * so the whole download list shares one visual language. '' when there is
   * no honest truth (caller falls back to the flow band or nothing).
   * v5.7.1 "one motion": deliberately static (no wave) — the main bar owns
   * the single downloading animation.
   */
  function byteBlockHtml(d, esc) {
    const st = byteBlockState(d);
    if (!st) return '';
    const e = typeof esc === 'function' ? esc : function (s) { return String(s); };
    return '<div class="segments-bar block-grid byte-map" title="' + e(st.tip) + '">' +
      '<div class="block ' + st.state + '" style="flex:0 0 100%">' +
      '<div class="block-fill" style="width:' + st.pct + '%"></div></div></div>';
  }

  /**
   * Indeterminate flow band: for rows in flight with NO honest byte truth
   * yet (connecting, or a server that hides Content-Length). A soft stripe
   * slides across the empty track so the row reads as alive without claiming
   * a fake percent. Under prefers-reduced-motion it degrades to a static
   * low-opacity wash (the animation is decoration, never the information).
   */
  function flowBandHtml(esc, mm) {
    const e = typeof esc === 'function' ? esc : function (s) { return String(s); };
    const still = prefersReducedMotion(mm);
    const fillCls = 'block-fill flow-fill' + (still ? ' still' : '');
    return '<div class="segments-bar block-grid byte-map flow-band" title="' +
      e('Downloading \u2014 size unknown') + '">' +
      '<div class="block active" style="flex:0 0 100%">' +
      '<div class="' + fillCls + '"></div></div></div>';
  }

  /**
   * Closed sine-ish wave path, exactly TWO wavelengths across `width`, filled
   * down to the bottom. The two-wavelength rule is what makes the CSS loop
   * seamless: the element is 200% wide and translates by -50% (= one full
   * wavelength pair), so the pattern repeats with no visible seam.
   */
  function wavePathD(width, height, wavelength, amplitude, midY) {
    const half = wavelength / 2;
    let d = 'M0,' + midY;
    let dir = -1;
    for (let x = 0; x < width; x += half) {
      d += ' C' + (x + half * 0.25).toFixed(1) + ',' + (midY + dir * amplitude) +
        ' ' + (x + half * 0.75).toFixed(1) + ',' + (midY + dir * amplitude) +
        ' ' + (x + half).toFixed(1) + ',' + midY;
      dir = -dir;
    }
    d += ' L' + width + ',' + height + ' L0,' + height + ' Z';
    return d;
  }

  /**
   * The liquid crest for an ACTIVE fill: two translucent wave layers sliding
   * at different speeds. Pure CSS `transform` translation on 200%-wide SVGs —
   * GPU-composited, no JS timers. Returns '' under reduced motion (the caller
   * keeps the plain fill; the animation is decoration, never the information).
   * @param {MediaQueryList|null} mm optional matchMedia stub for tests
   */
  function liquidHtml(mm) {
    if (prefersReducedMotion(mm)) return '';
    // Wavelengths must divide 100 exactly (half the width): the -50% translate
    // has to land on an identical phase or the loop visibly jumps.
    const a = wavePathD(200, 10, 50, 2.4, 5);
    const b = wavePathD(200, 10, 25, 1.7, 6.4);
    return '<svg class="liquid" viewBox="0 0 200 10" preserveAspectRatio="none" aria-hidden="true">' +
      '<path class="w" d="' + a + '"></path></svg>' +
      '<svg class="liquid liquid-2" viewBox="0 0 200 10" preserveAspectRatio="none" aria-hidden="true">' +
      '<path class="w" d="' + b + '"></path></svg>';
  }

  /**
   * Plexo distributes chunks across physical networks round-robin. Fewer than
   * two networks can't be combined, so this returns null and the engine keeps
   * its ordinary default-route behaviour.
   */
  function assignInterfaces(interfaces, tick) {
    if (!Array.isArray(interfaces) || interfaces.length < 2) return null;
    const t = Math.max(0, Number(tick) || 0);
    const i = t % interfaces.length;
    return interfaces[i];
  }

  return {
    prefersReducedMotion: prefersReducedMotion,
    fmtEta: fmtEta,
    blockFillPercent: blockFillPercent,
    blocksFromSegments: blocksFromSegments,
    blockGridHtml: blockGridHtml,
    byteBlockState: byteBlockState,
    byteBlockHtml: byteBlockHtml,
    flowBandHtml: flowBandHtml,
    areaPath: areaPath,
    assignInterfaces: assignInterfaces,
    wavePathD: wavePathD,
    liquidHtml: liquidHtml,
    LIQUID_MAX_CELLS: LIQUID_MAX_CELLS
  };
});
