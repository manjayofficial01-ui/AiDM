'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'ui', 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'ui', 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'ui', 'styles.css'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');

let pass = 0;
let fail = 0;
function check(name, condition, extra) {
  if (condition) {
    pass++;
    console.log('  OK  ', name, extra === undefined ? '' : `(${extra})`);
  } else {
    fail++;
    console.log('  FAIL', name, extra === undefined ? '' : `(${extra})`);
  }
}

check('options modal is labelled and keyboard-dismissable',
  /id="options-overlay"[\s\S]*?role="dialog" aria-modal="true" aria-labelledby="options-title"/.test(html) &&
  /'options-overlay': hideOptionsModal/.test(app) &&
  /hideOptionsModal\(\); hideSchedulerModal/.test(app));
check('options overlay participates in modal and focus plumbing',
  /isAnyModalOpen\(\)[\s\S]{0,300}'options-overlay'/.test(app) &&
  /const OVERLAY_IDS = \[[^\]]*'options-overlay'/.test(app) &&
  /overlayReturnFocus\.set\(id, document\.activeElement\)/.test(app));
check('context menu exposes priority and options',
  /data-action="priority-high"/.test(html) && /data-action="priority-normal"/.test(html) &&
  /data-action="priority-low"/.test(html) && /data-action="options"/.test(html));
check('row exposes an options control for every non-completed row',
  /dl\.status !== 'completed' \? `<button class="action-btn" data-action="options"/.test(app));
check('current priority choices are not redundantly repeated',
  /a === 'priority-high' && dl\.priority === 'high'/.test(app) &&
  /a === 'priority-normal' && \(!dl\.priority \|\| dl\.priority === 'normal'\)/.test(app) &&
  /a === 'priority-low' && dl\.priority === 'low'/.test(app));
check('apply calls the scheduler and torrent control APIs',
  /window\.aidm\.setDownloadPriority\(/.test(app) &&
  /window\.aidm\.setDownloadSpeedLimit\(id, speedLimit\)/.test(app) &&
  /window\.aidm\.setTorrentSelection\(id, selection\)/.test(app) &&
  /window\.aidm\.setTorrentSeedPolicy\(id, seedPolicy\)/.test(app));
check('UI uses KB/s but sends bytes/sec',
  /Math\.round\(\(Number\(dl\.speedLimit\) \|\| 0\) \/ 1024\)/.test(app) &&
  /const speedLimit = speedKbps \* 1024/.test(app));
check('torrent file list uses safe DOM APIs, never filenames through innerHTML',
  /fileList\.replaceChildren\(\)/.test(app) && /name\.textContent = file\.path/.test(app) &&
  !/innerHTML =.*file\.path|innerHTML =.*file\.name/.test(app));
check('non-per-task transport types disclose their limit behavior',
  /const rateSupported = !dl\.isTorrent && dl\.provider !== 'youtube' && !dl\.isHls && !dl\.isDash/.test(app) &&
  /speedInput\.disabled = !rateSupported/.test(app));
check('row state reflects priority and per-task cap',
  /priorityChipHtml\(dl\)/.test(app) && /limitChipHtml\(dl\)/.test(app) &&
  /\.priority-chip\.high\{/.test(css.replace(/\s+/g, '')) && /\.limit-chip\{/.test(css.replace(/\s+/g, '')));
check('update event carries the new fields to the renderer',
  /if \(typeof data\.priority === 'string'\)/.test(app) &&
  /if \(typeof data\.speedLimit === 'number'\)/.test(app) &&
  /if \(Array\.isArray\(data\.torrentFiles\)\)/.test(app) &&
  /if \(typeof data\.seedPolicy === 'string'\)/.test(app));
check('renderer bridge exposes the new controls',
  /setDownloadPriority:/.test(preload) && /setDownloadSpeedLimit:/.test(preload) &&
  /getTorrentInfo:/.test(preload) && /setTorrentSelection:/.test(preload) &&
  /setTorrentSeedPolicy:/.test(preload));

console.log(`\ndownload-options-ui: ${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
