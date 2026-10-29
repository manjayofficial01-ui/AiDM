'use strict';

function publicSettings(settings, portable = false) {
  const view = structuredClone(settings);
  delete view.aiApiKey;
  delete view.hasAiApiKey;
  if (!portable) view.hasAiApiKey = !!settings.aiApiKey;
  for (const [host, cfg] of Object.entries(view.fileHosts || {})) {
    if (!cfg || typeof cfg !== 'object') continue;
    delete cfg.password;
    delete cfg.cookie;
    delete cfg.hasPassword;
    delete cfg.hasCookie;
    if (!portable) {
      cfg.hasPassword = !!settings.fileHosts[host].password;
      cfg.hasCookie = !!settings.fileHosts[host].cookie;
    }
  }
  delete view.hasProxyCredentials;
  let proxyUrl = settings.proxyUrl || '';
  let privateProxy = false;
  if (proxyUrl) {
    try {
      const url = new URL(proxyUrl);
      privateProxy = !!(url.username || url.password);
      if (privateProxy) {
        url.username = '';
        url.password = '';
        proxyUrl = url.toString().replace(/\/$/, '');
      }
    } catch {
      privateProxy = true;
      proxyUrl = '';
    }
  }
  if (portable && privateProxy) delete view.proxyUrl;
  else view.proxyUrl = proxyUrl;
  if (!portable) view.hasProxyCredentials = privateProxy;
  return view;
}

module.exports = { publicSettings };
