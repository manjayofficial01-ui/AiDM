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
   * Returns [] for a single/absent segment so callers fall back to the plain bar.
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

  /**
   * The BlockGrid's markup, ready to drop into the row's progress cell:
   * one flex cell per segment whose width is its byte share of the file and
   * whose inner fill is that segment's own progress. Returns '' when there is
   * nothing to draw (single/absent segment), so the caller falls back to its
   * plain equal-width bar. `esc` is the caller's attribute escaper (injected
   * so the Node tests need no DOM).
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
    areaPath: areaPath,
    assignInterfaces: assignInterfaces
  };
});
