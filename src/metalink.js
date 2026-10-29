'use strict';

const { normalizeChecksum } = require('./engine/checksum');

const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;
const MAX_FILES = 1000;
const MAX_URLS_PER_FILE = 100;
const METALINK_NAMESPACES = ['urn:ietf:params:xml:ns:metalink'];

function decodeEntities(value) {
  return String(value || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, decimal) => String.fromCodePoint(Number(decimal)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function tagValue(source, tagName) {
  const escaped = tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`<(?:[A-Za-z_][\\w.-]*:)?${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:[A-Za-z_][\\w.-]*:)?${escaped}>`, 'i').exec(source);
  return match ? decodeEntities(match[1]).trim() : null;
}

function tagBlocks(source, tagName) {
  const escaped = tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`<(?:[A-Za-z_][\\w.-]*:)?${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:[A-Za-z_][\\w.-]*:)?${escaped}>`, 'gi');
  const out = [];
  let match;
  while ((match = re.exec(source))) out.push(match[1]);
  return out;
}

function tagAttributes(tag, names) {
  const out = {};
  for (const name of names) {
    const re = new RegExp(`\\b(?:[A-Za-z_][\\w.-]*:)?${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i');
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = new RegExp(`\\b(?:[A-Za-z_][\\w.-]*:)?${escaped}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(tag);
    if (match) out[name] = decodeEntities(match[1] ?? match[2]);
  }
  return out;
}

function matchingTagBlocks(document, tagName) {
  const escaped = tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const openRe = new RegExp(`<(?:[A-Za-z_][\\w.-]*:)?${escaped}\\b(?:\\s[^>]*)?>`, 'gi');
  const out = [];
  let open;
  while ((open = openRe.exec(document))) {
    if (open[0].startsWith('</')) continue;
    const afterOpen = openRe.lastIndex;
    const boundaryRe = new RegExp(`<(?:[A-Za-z_][\\w.-]*:)?${escaped}\\b(?:\\s[^>]*)?>|<\\/(?:[A-Za-z_][\\w.-]*:)?${escaped}\\s*>`, 'gi');
    boundaryRe.lastIndex = afterOpen;
    let depth = 1;
    let inner;
    let close;
    while ((inner = boundaryRe.exec(document))) {
      if (inner[0].startsWith('</')) depth--;
      else depth++;
      if (depth === 0) {
        close = inner;
        break;
      }
    }
    if (!close) break;
    out.push({ tag: open[0], inner: document.slice(afterOpen, close.index) });
    openRe.lastIndex = close.index + close[0].length;
  }
  return out;
}

function isSafeHttpUrl(value) {
  try {
    const parsed = new URL(String(value || '').trim());
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      !parsed.username && !parsed.password;
  } catch (_) {
    return false;
  }
}

function parsePieceHashes(fileSource) {
  const pieces = matchingTagBlocks(fileSource, 'pieces')[0];
  if (!pieces) return null;
  const attrs = tagAttributes(pieces.tag, ['type', 'length', 'hashlengthbits']);
  const hashes = tagBlocks(pieces.inner, 'hash');
  const type = String(attrs.type || '').toLowerCase().replace(/-/g, '');
  const expectedLength = { md5: 32, sha1: 40, sha256: 64, sha512: 128 }[type];
  if (!expectedLength || hashes.length === 0) return null;
  const pieceLength = Math.floor(Number(attrs.length) || 0);
  if (!Number.isFinite(pieceLength) || pieceLength <= 0) return null;
  const bitLength = Number(attrs.hashlengthbits || 256);
  if (bitLength !== 256 && type === 'sha256') return null;
  const hashesOnly = [];
  for (const hash of hashes) {
    const clean = hash.replace(/<[\s\S]*$/g, '').trim().toLowerCase();
    if (/^[0-9a-f]+$/.test(clean) && clean.length === expectedLength) hashesOnly.push(clean);
    else if (hashesOnly.length) return null;
  }
  return { algorithm: type, pieceLengthBytes: pieceLength, hashes: hashesOnly };
}

function parseFileBlock(file) {
  const attrs = tagAttributes(file.tag, ['name']);
  const name = attrs.name || tagValue(file.inner, 'name');
  if (!name) return null;
  const urlMatches = [];
  const urlRe = /<(?:[A-Za-z_][\w.-]*:)?url\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?url\s*>)/gi;
  let match;
  while ((match = urlRe.exec(file.inner))) {
    const urlAttrs = tagAttributes(match[0], ['priority', 'type', 'value']);
    const value = decodeEntities((match[2] || '').trim()) || decodeEntities(String(urlAttrs.value || '').trim());
    if (isSafeHttpUrl(value)) {
      urlMatches.push({
        url: value,
        priority: Math.max(1, Math.min(999, Math.floor(Number(urlAttrs.priority) || 1))),
        feed: String(urlAttrs.type || '').toLowerCase() === 'feed',
      });
    }
  }
  urlMatches.sort((a, b) => a.priority - b.priority);
  const urls = [...new Set(urlMatches.map((entry) => entry.url))].slice(0, MAX_URLS_PER_FILE);
  if (!urls.length) return null;

  const sizeText = tagValue(file.inner, 'length');
  const size = sizeText ? Math.floor(Number(sizeText.replace(/[^\d]/g, ''))) : null;
  const hashes = tagBlocks(file.inner, 'hash').map((h) => h.replace(/<[\s\S]*$/g, '').trim()).filter(Boolean);
  let checksum = null;
  for (const raw of hashes) {
    try {
      checksum = normalizeChecksum(raw);
      break;
    } catch (_) { /* ignore unknown hashes */ }
  }
  return {
    filename: name.replace(/^.*[\\/]/g, ''),
    size: Number.isFinite(size) && size > 0 ? size : null,
    checksum,
    pieces: parsePieceHashes(file.inner),
    urls,
  };
}

function parseMetalinkDocument(xml) {
  const text = String(xml || '');
  if (Buffer.byteLength(text, 'utf8') > MAX_DOCUMENT_BYTES) throw new Error('Metalink document is too large');
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new Error('Metalink DOCTYPE and entity declarations are not allowed');
  if (!/<(?:[A-Za-z_][\w.-]*:)?metalink\b/i.test(text)) throw new Error('Not a Metalink document');

  const files = [];
  for (const file of matchingTagBlocks(text, 'file')) {
    const parsed = parseFileBlock(file);
    if (parsed) files.push(parsed);
    if (files.length > MAX_FILES) throw new Error('Metalink contains too many files');
  }
  const dynamic = /<(?:[A-Za-z_][\w.-]*:)?dynamic(?:\s[^>]*)?>\s*true\s*<\//i.test(text);
  return { version: /version=["']4(?:\.0)?["']/i.test(text) ? 4 : 3, files, dynamic };
}

function isMetalinkSource(url, contentType) {
  const clean = String(url || '').split(/[?#]/)[0].toLowerCase();
  const type = String(contentType || '').split(';')[0].trim().toLowerCase();
  return /\.meta4$/.test(clean) || /\.metalink$/.test(clean) ||
    type === 'application/metalink4+xml' || type === 'application/metalink+xml' ||
    type === 'text/metalink';
}

function metalinkRequestOptions(download) {
  return {
    maxRedirects: 5,
    timeoutMs: 15000,
    headers: download && download.headers ? { ...download.headers } : {},
    cookies: download && download.cookies,
  };
}

module.exports = {
  MAX_DOCUMENT_BYTES,
  MAX_FILES,
  MAX_URLS_PER_FILE,
  decodeEntities,
  isMetalinkSource,
  isSafeHttpUrl,
  parseMetalinkDocument,
  metalinkRequestOptions,
};
