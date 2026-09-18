// Regression harness for the ROW-LEVEL truth of the download list (ui/app.js).
//
// Two user-reported bugs:
//   1. WRONG DIMENSIONS — the list used to trust whatever the extension, a URL
//      regex or the playing <video> element guessed, so a 360p file displayed
//      as 2160p and every video on a page showed the same resolution. Rows now
//      show the geometry proven by src/media-probe.js (`dl.media`), and mark
//      anything else as unverified instead of inventing it.
//   2. SILENT FILES — a video with no audio track gets a 🔇 badge so the user
//      can see why the download is silent (the row stays "Completed").
//
// ui/app.js is a sandboxed browser script, so it is loaded here under a minimal
// DOM stub and the pure helpers are asserted through `window.__aidmTest`.
// Run: node test/ui-dimensions.js
'use strict';

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  OK   ' + name + (extra ? ' — ' + extra : '')); }
  else { fail++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')); }
}

// ── Minimal DOM stub (just enough for ui/app.js to load in plain Node) ───────

function escapeText(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

class El {
  constructor() {
    this._text = ''; this._html = '';
    this.style = {}; this.dataset = {}; this.children = [];
    this.classList = { add() {}, remove() {}, toggle() { return false; }, contains() { return false; } };
  }
  set textContent(v) { this._text = String(v == null ? '' : v); this._html = escapeText(this._text); }
  get textContent() { return this._text; }
  set innerHTML(v) { this._html = String(v); this._text = String(v).replace(/<[^>]*>/g, ''); }
  get innerHTML() { return this._html; }
  addEventListener() {} removeEventListener() {} appendChild(c) { this.children.push(c); return c; }
  querySelector() { return null; } querySelectorAll() { return []; }
  remove() {} focus() {} click() {}
  getBoundingClientRect() { return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }; }
}

global.document = {
  createElement: () => new El(),
  getElementById: () => new El(),
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener: () => {},
  body: new El(),
};
global.window = {};
global.localStorage = { getItem: () => null, setItem: () => {} };

require('../ui/app.js');

const T = global.window.__aidmTest || {};
const X = '×';                       // U+00D7 — the separator the row renders
const strip = (html) => String(html).replace(/<[^>]*>/g, '');

const media = (w, h, extra) => Object.assign({
  width: w, height: h, durationSec: 45.5, hasVideo: true, hasAudio: true,
  vcodec: 'h264', acodec: 'aac', container: 'mp4', probedAt: Date.now(),
}, extra || {});

console.log('\n1. proven geometry wins (regression: 360p must not read 2160p)');

{
  const dl = {
    id: 'r1', filename: 'clip.mp4',
    quality: { label: '2160p', resolution: '3840x2160', size: 999999, format: 'mp4' },
    media: media(640, 360),
  };
  const html = T.formatRowMeta(dl);
  check('640x360 proven media renders 640×360', html.includes('640' + X + '360'), strip(html));
  check('proven row NEVER renders 2160p / 3840x2160', !/2160p|3840/.test(html), strip(html));
  check('proven row is marked proven', /class="dim-readout proven"/.test(html));
  check('proven row is not marked guessed', !/dim-readout guessed/.test(html));
  check('tooltip carries duration + video codec + audio codec + container',
    /Duration 0:45/.test(html) && /video h264/.test(html) && /audio aac/.test(html) && /\bMP4\b/.test(html));
  check('quality label beside the name is untouched by the probe logic',
    /2160p/.test(T.qualityBadgeHtml(dl)));
}

console.log('\n2. a silent file is flagged, not failed');

{
  const dl = {
    id: 'r2', filename: 'silent.mp4', audioMissing: true,
    quality: { label: '720p', resolution: '1280x720' },
    media: media(1280, 720, { hasAudio: false, acodec: null }),
  };
  const html = T.formatRowMeta(dl);
  check('audioMissing shows the mute badge', html.includes('🔇'));
  check('mute badge explains itself', /title="This video has no audio track"/.test(html));
  check('geometry is still shown for a silent file', html.includes('1280' + X + '720'));
  check('mute badge is not an error state (no error class)', !/error/.test(html));
}

{
  const dl = { id: 'r2b', filename: 'withsound.mp4', audioMissing: false, media: media(640, 360) };
  check('a file WITH audio shows no mute badge', !T.formatRowMeta(dl).includes('🔇'));
}

console.log('\n3. guessed resolution is marked unverified');

{
  const dl = { id: 'r3', filename: 'a.mp4', quality: { label: '720p', resolution: '1280x720' } };
  const html = T.formatRowMeta(dl);
  check('guessed resolution still renders', /1280/.test(html) && /720/.test(html), strip(html));
  check('guessed resolution is marked unverified', /class="dim-readout guessed"/.test(html));
  check('guessed resolution is never marked proven', !/dim-readout proven/.test(html));
  check('guessed resolution says why in the tooltip', /Not verified yet/.test(html));
}

console.log('\n4. label only — no fabricated resolution');

{
  const dl = { id: 'r4', filename: 'b.mp4', quality: { label: '720p' } };
  const meta = T.formatRowMeta(dl);
  check('no media ⇒ no fabricated WIDTHxHEIGHT', !/\d+\s*[x×]\s*\d+/.test(meta), JSON.stringify(meta));
  check('no media ⇒ no 16:9 guess (1280)', !/1280/.test(meta), JSON.stringify(meta));
  check('the 720p label is still shown next to the name', /720p/.test(T.qualityBadgeHtml(dl)));
}

{
  const dl = { id: 'r4b', filename: 'c.zip' };
  check('a row with no media and no quality renders nothing', T.formatRowMeta(dl) === '', JSON.stringify(T.formatRowMeta(dl)));
  check('a row with no media and no quality shows no badge', T.qualityBadgeHtml(dl) === '');
}

{
  // Probe proved the container/tracks but no geometry (e.g. an MPEG-TS):
  // fall back to the unverified resolution, never to a "proven" readout.
  const dl = {
    id: 'r4c', filename: 'd.ts', quality: { label: '720p', resolution: '1280x720' },
    media: { width: 0, height: 0, durationSec: 12, hasVideo: true, hasAudio: true, vcodec: 'h264', acodec: null, container: 'ts' },
  };
  const html = T.formatRowMeta(dl);
  check('media without geometry is not marked proven', !/dim-readout proven/.test(html));
  check('media without geometry falls back to unverified resolution', /dim-readout guessed/.test(html));
}

console.log('\n5. every row shows its OWN dimensions');

{
  const a = { id: 'a', filename: 'a.mp4', media: media(640, 360) };
  const b = { id: 'b', filename: 'b.mp4', media: media(1920, 1080) };
  const ha = strip(T.formatRowMeta(a));
  const hb = strip(T.formatRowMeta(b));
  check('two rows with different proven heights render differently', ha !== hb, ha + ' vs ' + hb);
  check('row A renders 640×360', ha.includes('640' + X + '360'), ha);
  check('row B renders 1920×1080', hb.includes('1920' + X + '1080'), hb);
}

console.log('\n6. everything is escaped');

{
  const dl = {
    id: 'r6', filename: 'x.mp4',
    media: media(640, 360, { vcodec: 'h264"><img src=x onerror=alert(1)' }),
  };
  const html = T.formatRowMeta(dl);
  check('tooltip payload is escaped', !/<img/.test(html) && /&lt;img/.test(html));
  check('quotes in a tooltip cannot break out of title="…"',
    !/onerror=alert\(1\)"/.test(html) || /&quot;/.test(html));
}

console.log('\n7. quality picker: proven vs claimed');

{
  const proven = T.pickerResolutionInfo({ width: 640, height: 360, quality: '360p' });
  check('picker renders proven geometry', proven.text === '640' + X + '360' && proven.proven === true, proven.text);

  const claimed = T.pickerResolutionInfo({ quality: '2160p', resolution: '3840x2160' });
  check('a site-claimed resolution is not proven', claimed.proven === false, claimed.text);

  const labelOnly = T.pickerResolutionInfo({ quality: '720p' });
  check('a variant with no geometry shows only its label',
    labelOnly.text === '720p' && labelOnly.proven === false && !/1280/.test(labelOnly.text), labelOnly.text);

  check('a variant with nothing says Unknown quality', T.pickerResolutionInfo({}).text === 'Unknown quality');
  check('resolution beats the label when there is no geometry',
    T.pickerResolutionInfo({ quality: '360p', resolution: '854x480' }).text === '854x480');
}

console.log('\n8. quality picker sorting uses real height');

{
  const vids = [
    { quality: '2160p', width: 640, height: 360 },   // lying label, really 360p
    { quality: '360p', width: 3840, height: 2160 },  // really 2160p
    { quality: '720p' },                             // no geometry at all
  ];
  const sorted = [...vids].sort((a, b) => T.qualityVideoCompare(a, b));
  check('real height outranks the label', sorted[0].height === 2160 && sorted[1].height === 360,
    sorted.map(v => v.quality + '@' + (v.height || '?')).join(' > '));
  check('a variant with no geometry sorts last', sorted[2].quality === '720p');

  const tiers = [{ quality: '360p' }, { quality: '1080p' }, { quality: '480p' }]
    .sort((a, b) => T.qualityVideoCompare(a, b));
  check('no geometry anywhere ⇒ tier order still applies',
    tiers.map(v => v.quality).join(',') === '1080p,480p,360p', tiers.map(v => v.quality).join(','));

  const same = [{ quality: '480p', width: 854, height: 480 }, { quality: '720p', width: 854, height: 480 }]
    .sort((a, b) => T.qualityVideoCompare(a, b));
  check('equal geometry falls back to the tier map', same[0].quality === '720p');
  check('height is read out of a "1920x1080" string too', T.qualityHeight({ resolution: '1920x1080' }) === 1080);
  check('no geometry ⇒ height is null', T.qualityHeight({ quality: '720p' }) === null);
}

console.log('\n9. the column is wired into the table');

{
  const ROOT = path.join(__dirname, '..');
  const app = fs.readFileSync(path.join(ROOT, 'ui', 'app.js'), 'utf8');
  const html = fs.readFileSync(path.join(ROOT, 'ui', 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'ui', 'styles.css'), 'utf8');

  check('row renders the media cell', /<td class="col-dims">\$\{mediaMeta\}<\/td>/.test(app));
  check('resize map has a min width for dims', /COL_MIN_WIDTH = \{[^}]*dims:\s*\d+/.test(app));
  check('download-updated merges media + audioMissing',
    /if \(data\.media !== undefined\) dl\.media = data\.media;/.test(app) &&
    /if \(typeof data\.audioMissing === 'boolean'\) dl\.audioMissing = data\.audioMissing;/.test(app));
  check('header column exists and is resizable (data-col + resizer)',
    /<th class="col-dims" data-col="dims"/.test(html) && /col-dims[\s\S]{0,200}col-resizer/.test(html));
  check('styles define the new column + badges',
    /\.col-dims\s*\{/.test(css) && /\.dim-readout\.guessed\s*\{/.test(css) && /\.audio-missing-badge\s*\{/.test(css));
  check('proven-vs-guessed styling differs', /\.dim-readout\.proven\s*\{/.test(css));
}

console.log(`\nui-dimensions: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
