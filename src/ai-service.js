/**
 * AiDM AI Service — TokenHarbor provider integration
 *
 * OpenAI-compatible client for https://tokenharbor.ai/v1
 * Supports primary + fallback model routing:
 *   primary  = mimo-v2.5:free       (Xiaomi MiMo, strong reasoning / agent work)
 *   fallback = deepseek-v4-flash:free (fast, cheap general work)
 *
 * Both `:free` IDs are never billed — they draw from a rolling 7-day
 * free allowance, then return 429 rate-limit. Drop the `:free` suffix
 * to use the paid zero-data-retention route.
 *
 * Auth: Bearer <TOKENHARBOR_API_KEY>
 *   1. process.env.TOKENHARBOR_API_KEY (preferred, never committed)
 *   2. settings.aiApiKey (local settings file only, never logged)
 *
 * No external dependencies — uses global fetch (Node 18+ / Electron 28+).
 */

const DEFAULT_BASE_URL = 'https://tokenharbor.ai/v1';
const DEFAULT_PRIMARY_MODEL = 'mimo-v2.5:free';
const DEFAULT_FALLBACK_MODEL = 'deepseek-v4-flash:free';

class AiService {
  constructor(opts = {}) {
    this.baseURL = (opts.baseURL || process.env.TOKENHARBOR_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, '');
    this.apiKey = opts.apiKey || process.env.TOKENHARBOR_API_KEY || '';
    this.primaryModel = opts.primaryModel || process.env.TOKENHARBOR_PRIMARY_MODEL || DEFAULT_PRIMARY_MODEL;
    this.fallbackModel = opts.fallbackModel || process.env.TOKENHARBOR_FALLBACK_MODEL || DEFAULT_FALLBACK_MODEL;
    this.timeoutMs = opts.timeoutMs || 60000;
  }

  configure({ baseURL, apiKey, primaryModel, fallbackModel, timeoutMs } = {}) {
    if (baseURL) this.baseURL = String(baseURL).replace(/\/$/, '');
    if (typeof apiKey === 'string' && apiKey.length > 0) this.apiKey = apiKey;
    if (primaryModel) this.primaryModel = primaryModel;
    if (fallbackModel) this.fallbackModel = fallbackModel;
    if (timeoutMs) this.timeoutMs = timeoutMs;
  }

  setApiKey(key) {
    if (typeof key === 'string') this.apiKey = key;
  }

  isConfigured() {
    return Boolean(this.apiKey && this.apiKey.length > 8);
  }

  getConfigStatus() {
    return {
      configured: this.isConfigured(),
      baseURL: this.baseURL,
      primaryModel: this.primaryModel,
      fallbackModel: this.fallbackModel,
      // Never expose the key — only presence + safe hint
      hasKey: this.isConfigured(),
      keyPrefix: this.isConfigured() ? this.apiKey.slice(0, 8) + '…' : null,
    };
  }

  async _post(path, body) {
    if (!this.isConfigured()) {
      throw new Error('AI not configured: set TOKENHARBOR_API_KEY env var or paste key in Settings → AI.');
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.baseURL}${path}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      const text = await res.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch { /* keep raw */ }
      if (!res.ok) {
        const msg = (data && (data.error?.message || data.error || data.message)) || text.slice(0, 300) || `HTTP ${res.status}`;
        const err = new Error(`TokenHarbor ${res.status}: ${msg}`);
        err.status = res.status;
        err.code = data?.error?.code;
        throw err;
      }
      return data;
    } catch (err) {
      if (err.name === 'AbortError') throw new Error(`AI request timed out after ${this.timeoutMs}ms`);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Core chat call with automatic fallback.
   * Tries primary model, falls back to fallbackModel on 429 / 5xx / timeout.
   */
  async chat(messages, opts = {}) {
    const { temperature = 0.3, max_tokens = 1024, model } = opts;
    const tried = [];
    const candidates = model ? [model] : [this.primaryModel, this.fallbackModel].filter(Boolean);
    // dedupe while preserving order
    const models = [...new Set(candidates)];

    let lastErr = null;
    for (const m of models) {
      tried.push(m);
      try {
        const data = await this._post('/chat/completions', {
          model: m,
          messages,
          temperature,
          max_tokens,
        });
        const choice = data?.choices?.[0]?.message;
        return {
          content: choice?.content || '',
          model: data?.model || m,
          requestedModel: m,
          usage: data?.usage || null,
          tried,
          fallbackUsed: tried.length > 1,
        };
      } catch (err) {
        lastErr = err;
        const retryable = err.status === 429 || (err.status >= 500 && err.status < 600) || /timed out|ECONN|fetch failed/i.test(err.message);
        if (!retryable || m === models[models.length - 1]) throw err;
        // otherwise continue to next model
      }
    }
    throw lastErr || new Error('AI chat failed');
  }

  quickComplete(prompt, opts = {}) {
    return this.chat([{ role: 'user', content: prompt }], opts);
  }

  // ── AiDM-specific helpers ──────────────────────────────────────────

  /** Suggest a clean filesystem-safe filename for a URL. */
  async smartFilename(url, hint = '') {
    const { content } = await this.quickComplete(
      `Generate ONE clean download filename (with correct extension) for this URL. Reply with ONLY the filename, nothing else.\nURL: ${url}${hint ? `\nHint: ${hint}` : ''}`,
      { max_tokens: 120, temperature: 0.2 }
    );
    return String(content || '').trim().replace(/^["']|["']$/g, '').split('\n')[0].slice(0, 180) || null;
  }

  /** Classify a download into one of AiDM's categories. */
  async categorize(url, filename = '') {
    const { content } = await this.quickComplete(
      `Classify this download into exactly one category: video, audio, document, archive, software, image, other. Reply with ONLY the category word.\nURL: ${url}\nFilename: ${filename}`,
      { max_tokens: 20, temperature: 0 }
    );
    const cat = String(content || '').trim().toLowerCase();
    return ['video', 'audio', 'document', 'archive', 'software', 'image', 'other'].includes(cat) ? cat : 'other';
  }

  /** Summarize a page/video title for the quality-picker context. */
  async summarize(title, pageUrl = '') {
    const { content } = await this.chat([
      { role: 'system', content: 'You help organize downloads. Be concise.' },
      { role: 'user', content: `In one short line, describe what this looks like (for a download manager label):\nTitle: ${title}\nURL: ${pageUrl}` },
    ], { max_tokens: 150 });
    return (content || '').trim();
  }

  /** Explain a download error in plain language with one fix suggestion. */
  async explainError(errorMsg, url = '') {
    const { content } = await this.chat([
      { role: 'system', content: 'You are a download-manager troubleshooting assistant. Keep answers under 80 words.' },
      { role: 'user', content: `Download failed${url ? ` for ${url}` : ''}.\nError: ${errorMsg}\nExplain likely cause + one fix.` },
    ], { max_tokens: 250 });
    return (content || '').trim();
  }

  async listModels() {
    if (!this.isConfigured()) throw new Error('AI not configured');
    const res = await fetch(`${this.baseURL}/models`, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });
    if (!res.ok) throw new Error(`TokenHarbor ${res.status}: unable to list models`);
    const data = await res.json();
    return (data?.data || []).map((m) => m.id);
  }

  async healthCheck() {
    const started = Date.now();
    const r = await this.quickComplete('Reply with exactly: OK', { max_tokens: 10, temperature: 0 });
    return {
      ok: /OK/i.test(r.content || ''),
      latencyMs: Date.now() - started,
      model: r.model,
      fallbackUsed: r.fallbackUsed,
    };
  }
}

module.exports = { AiService, DEFAULT_BASE_URL, DEFAULT_PRIMARY_MODEL, DEFAULT_FALLBACK_MODEL };
