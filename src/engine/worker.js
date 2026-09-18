// @ts-check
const { DownloadError, classifyHttpStatus, toDownloadError } = require('./errors');
const { parseContentRange } = require('./probe');
const { parseRetryAfter } = require('./retry');
const { SpeedMeter } = require('./speed');

const SLOW_CHECK_WARMUP_MS = 5000;

/**
 * @param {Response} res
 * @returns {number | null} the body length the server promised, or null
 */
function contentLengthOf(res) {
  const raw = res.headers.get('content-length');
  if (raw === null) return null;
  const trimmed = String(raw).trim();
  if (!/^\d+$/.test(trimmed)) return null;
  return Number(trimmed);
}

/**
 * The error to surface once the composite signal has aborted: prefer the
 * DownloadError the aborter supplied (TIMEOUT from our own read timer,
 * CANCELLED/PAUSED from the task) so retry logic sees the real cause.
 * @param {AbortSignal} signal
 */
function abortError(signal) {
  const reason = /** @type {any} */ (signal).reason;
  if (reason instanceof DownloadError) return reason;
  return new DownloadError('CANCELLED', 'Request aborted', { cause: reason });
}

/**
 * Downloads one segment over one connection.
 * @param {import('./segments').Segment} segment
 * @param {import('./mirrors').Mirror} mirror
 * @param {{
 *   fetchImpl: typeof fetch,
 *   headers: Record<string, string>,
 *   info: any,
 *   writer: import('./file-writer').SegmentFileWriter,
 *   limiters: readonly import('./rate-limiter').TokenBucket[],
 *   signal: AbortSignal,
 *   useRanges: boolean,
 *   connectTimeoutMs: number,
 *   readTimeoutMs: number,
 *   lowestSpeedLimit: number,
 *   canDropSlow: () => boolean,
 *   onBytes: (bytes: number) => void
 * }} ctx
 * @returns {Promise<{ bytes: number, elapsedMs: number }>}
 */
async function runSegmentWorker(segment, mirror, ctx) {
  const startedAt = Date.now();
  const controller = new AbortController();
  const signal = AbortSignal.any([ctx.signal, controller.signal]);
  let timer;

  const arm = (ms, what) => {
    clearTimeout(timer);
    timer = setTimeout(
      () => controller.abort(new DownloadError('TIMEOUT', `${what} timed out after ${ms}ms`, { retryable: true })),
      ms,
    );
  };
  const disarm = () => clearTimeout(timer);

  const from = segment.position;
  const headers = { ...ctx.headers, 'Accept-Encoding': 'identity' };
  let sentIfRange = false;
  if (ctx.useRanges) {
    headers.Range = segment.isOpenEnded ? `bytes=${from}-` : `bytes=${from}-${segment.end}`;
    const validator = ctx.info.etag ?? ctx.info.lastModified;
    if (validator && from > 0) {
      headers['If-Range'] = validator;
      sentIfRange = true;
    }
  }

  const meter = new SpeedMeter(5000);
  let bytes = 0;
  let reader = null;
  let finished = false;

  try {
    arm(ctx.connectTimeoutMs, 'Connection');
    let res;
    try {
      res = await ctx.fetchImpl(mirror.url, { method: 'GET', headers, redirect: 'follow', signal });
    } catch (err) {
      if (signal.aborted) throw abortError(signal);
      throw toDownloadError(err);
    } finally {
      disarm();
    }

    const promisedBytes = inspectResponse(res, segment, from, sentIfRange, ctx);
    if (!res.body) throw new DownloadError('NETWORK', 'Empty response body', { retryable: true });
    reader = res.body.getReader();

    for (;;) {
      if (signal.aborted) break;
      arm(ctx.readTimeoutMs, 'Read');
      let result;
      try {
        result = await reader.read();
      } catch (err) {
        if (signal.aborted) throw abortError(signal);
        throw toDownloadError(err);
      } finally {
        disarm();
      }
      if (signal.aborted || result.done) break;
      const value = result.value;
      if (!value || value.byteLength === 0) continue;

      for (const limiter of ctx.limiters) await limiter.acquire(value.byteLength);
      if (signal.aborted) break;

      const position = segment.position;
      let chunk = value;
      if (!segment.isOpenEnded) {
        const allowed = segment.end - position + 1;
        if (allowed <= 0) break;
        if (chunk.byteLength > allowed) chunk = chunk.subarray(0, allowed);
      }

      // Reserve the bytes synchronously so a concurrent split sees the true frontier.
      segment.downloaded += chunk.byteLength;
      try {
        await ctx.writer.write(chunk, position);
      } catch (err) {
        segment.downloaded -= chunk.byteLength;
        throw err instanceof DownloadError ? err : new DownloadError('IO', 'Disk write failed', { cause: err });
      }

      bytes += chunk.byteLength;
      meter.add(chunk.byteLength);
      ctx.onBytes(chunk.byteLength);

      if (!segment.isOpenEnded && segment.remaining === 0) break;

      if (
        ctx.lowestSpeedLimit > 0 &&
        Date.now() - startedAt > SLOW_CHECK_WARMUP_MS &&
        meter.bytesPerSecond() < ctx.lowestSpeedLimit &&
        ctx.canDropSlow()
      ) {
        throw new DownloadError(
          'SLOW_CONNECTION',
          `Connection to ${mirror.host} fell below ${ctx.lowestSpeedLimit} B/s`,
          { retryable: true },
        );
      }
    }

    if (signal.aborted) throw abortError(signal);

    // The stream said "end". If that is fewer bytes than the server promised
    // (or than the segment asked for) the file would be silently short, so
    // treat it as a failed attempt rather than a finished segment.
    if (promisedBytes !== null && bytes !== promisedBytes) {
      throw new DownloadError(
        'NETWORK',
        `Incomplete response: expected ${promisedBytes} bytes, received ${bytes}`,
        { retryable: true },
      );
    }
    if (!segment.isOpenEnded && segment.remaining > 0) {
      throw new DownloadError('NETWORK', `Connection closed with ${segment.remaining} bytes remaining`, {
        retryable: true,
      });
    }
    finished = true;
    return { bytes, elapsedMs: Date.now() - startedAt };
  } finally {
    disarm();
    if (reader && !finished) reader.cancel().catch(() => {});
  }
}

/**
 * Validates the response AND returns the number of body bytes the server
 * promised, so the caller can prove it actually received them.
 * @param {Response} res
 * @param {import('./segments').Segment} segment
 * @param {number} from
 * @param {boolean} sentIfRange
 * @param {any} ctx
 * @returns {number | null} promised body length, or null when unknown
 */
function inspectResponse(res, segment, from, sentIfRange, ctx) {
  const retryAfterMs = parseRetryAfter(res.headers.get('retry-after'));
  // Cap at what this segment actually wants: a server may legitimately
  // answer with a wider range than requested, and we stop reading at our end.
  const wanted = segment.isOpenEnded ? null : segment.end - from + 1;
  const cap = (n) => (n === null || wanted === null ? n : Math.min(n, wanted));

  if (!ctx.useRanges) {
    if (res.status === 200) return cap(contentLengthOf(res));
    throw classifyHttpStatus(res.status, retryAfterMs);
  }

  if (res.status === 206) {
    const range = parseContentRange(res.headers.get('content-range'));
    if (!range || range.start === null || range.end === null) {
      throw new DownloadError('HTTP', '206 response without a valid Content-Range', { retryable: true, status: 206 });
    }
    if (range.start !== from) {
      throw new DownloadError('RESOURCE_CHANGED', `Server returned offset ${range.start}, expected ${from}`);
    }
    if (range.end < range.start) {
      throw new DownloadError('HTTP', '206 response with an inverted Content-Range', { retryable: true, status: 206 });
    }
    if (ctx.info.size !== null && range.total !== null && range.total !== ctx.info.size) {
      throw new DownloadError('RESOURCE_CHANGED', `Remote size changed from ${ctx.info.size} to ${range.total}`);
    }
    const declared = range.end - range.start + 1;
    const len = contentLengthOf(res);
    if (len !== null && len !== declared) {
      throw new DownloadError(
        'HTTP',
        `206 length mismatch: Content-Length ${len} vs Content-Range ${declared}`,
        { retryable: true, status: 206 },
      );
    }
    return cap(declared);
  }

  if (res.status === 200) {
    const coversWholeFile =
      from === 0 && (segment.isOpenEnded || ctx.info.size === null || segment.end === ctx.info.size - 1);
    const len = contentLengthOf(res);
    if (coversWholeFile) {
      if (ctx.info.size !== null && len !== null && len !== ctx.info.size) {
        throw new DownloadError('RESOURCE_CHANGED', `Remote size changed from ${ctx.info.size} to ${len}`);
      }
      return cap(len);
    }
    const etag = res.headers.get('etag');
    const sameEntity = etag !== null && ctx.info.etag !== null && etag === ctx.info.etag;
    const acceptRanges = res.headers.get('accept-ranges');
    if (sentIfRange && !sameEntity && acceptRanges !== 'none') {
      throw new DownloadError('RESOURCE_CHANGED', 'Remote file changed (If-Range precondition failed)');
    }
    // A full-file 200 for a byte-range request: writing it at the segment
    // offset would corrupt the output. Collapse to one connection instead.
    throw new DownloadError('RANGE_UNSUPPORTED', `${new URL(res.url || 'http://x').host} ignored the Range header`);
  }

  if (res.status === 416) {
    throw new DownloadError('RESOURCE_CHANGED', 'Requested range no longer satisfiable');
  }

  throw classifyHttpStatus(res.status, retryAfterMs);
}

module.exports = {
  runSegmentWorker,
};
