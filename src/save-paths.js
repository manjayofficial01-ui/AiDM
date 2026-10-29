'use strict';

const fs = require('fs');
const path = require('path');

function canonicalSavePath(candidate) {
  if (typeof candidate !== 'string' || candidate.includes('\0') || !path.isAbsolute(candidate)) return null;
  let current = path.resolve(candidate);
  const missing = [];
  while (true) {
    try {
      return path.join(fs.realpathSync.native(current), ...missing);
    } catch (error) {
      if (error.code !== 'ENOENT') return null;
      // A dangling link is not a new directory: its eventual target is unknown.
      try { fs.lstatSync(current); return null; } catch (statError) {
        if (statError.code !== 'ENOENT') return null;
      }
      const parent = path.dirname(current);
      if (parent === current) return null;
      missing.unshift(path.basename(current));
      current = parent;
    }
  }
}

function isAllowedSavePath(settings, candidate, approvedFolders = []) {
  const absolute = canonicalSavePath(candidate);
  if (!absolute) return false;
  const roots = [settings && settings.defaultSavePath,
    ...Object.values((settings && settings.categoryPaths) || {}), ...approvedFolders];
  return roots.some((candidateRoot) => {
    const root = canonicalSavePath(candidateRoot);
    if (!root) return false;
    const relative = path.relative(root, absolute);
    return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
  });
}

module.exports = { isAllowedSavePath };
