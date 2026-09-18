// @ts-check
/**
 * Types & Constants for the Next-Gen Download Engine (v4.0.0)
 */

/**
 * @typedef {'md5' | 'sha1' | 'sha256' | 'sha512'} HashAlgorithm
 * @typedef {'largest' | 'inorder'} PieceSelection
 * @typedef {'none' | 'sparse' | 'full'} Preallocation
 * @typedef {'rename' | 'overwrite' | 'fail'} ConflictPolicy
 * @typedef {'restart' | 'fail'} ResourceChangePolicy
 * @typedef {'strict' | 'lenient'} ResumeValidation
 * @typedef {'queued' | 'probing' | 'downloading' | 'paused' | 'verifying' | 'completed' | 'failed' | 'cancelled'} DownloadState
 * @typedef {'pending' | 'active' | 'done'} SegmentState
 */

const DEFAULT_RETRY_POLICY = {
  maxTries: 8,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
  factor: 2,
};

const DEFAULT_TASK_DEFAULTS = {
  maxConnections: 8,
  maxConnectionsPerServer: 8,
  initialConnections: 4,
  minSplitSize: 1024 * 1024,
  adaptiveConnections: true,
  pieceSelection: 'largest',
  speedLimit: 0,
  lowestSpeedLimit: 0,
  connectTimeoutMs: 30000,
  readTimeoutMs: 30000,
  preallocation: 'sparse',
  onConflict: 'rename',
  onResourceChange: 'restart',
  resumeValidation: 'lenient',
  preserveRemoteTime: true,
};

module.exports = {
  DEFAULT_RETRY_POLICY,
  DEFAULT_TASK_DEFAULTS,
};
