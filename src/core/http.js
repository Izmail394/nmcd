/**
 * HTTP-клиент для адаптеров источников: таймауты, повторы, вежливая пауза между
 * запросами к одному хосту, типизированные ошибки, запись и воспроизведение ответов.
 *
 * Адаптеры не вызывают fetch напрямую — только ctx.http, поэтому все сетевые
 * сбои выглядят одинаково и расчёт можно воспроизвести по сохранённым снимкам.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import tls from 'node:tls';
import { Agent, fetch as undiciFetch } from 'undici';

export class SourceError extends Error {
  kind;
  status;
  url;

  constructor(kind, message, details = {}) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = 'SourceError';
    this.kind = kind;
    this.status = details.status;
    this.url = details.url;
  }
}

/** Разбирает JSON-ответ; при ошибке бросает SourceError('parse'). */
export function parseJson(response) {
  try {
    return JSON.parse(response.body);
  } catch (cause) {
    const head = response.body.slice(0, 120).replace(/\s+/g, ' ');
    throw new SourceError('parse', `Ожидался JSON, получено: «${head}»`, { url: response.url, cause });
  }
}

export const DEFAULT_HTTP_CONFIG = {
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
  timeoutMs: 20_000,
  retries: 1,
  perHostDelayMs: 350,
  maxBodyBytes: 12 * 1024 * 1024,
  extraCaPem: [],
  extraCaHosts: ['.gov.ru'],
};

/** Читает все *.pem / *.crt из каталога; отсутствие каталога — не ошибка. */
export function loadExtraCa(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => /\.(pem|crt|cer)$/i.test(name))
    .map((name) => fs.readFileSync(path.join(dir, name), 'utf8'))
    .filter((pem) => pem.includes('BEGIN CERTIFICATE'));
}

const RETRYABLE_STATUS = new Set([502, 503, 504]);
const BLOCKED_STATUS = new Set([401, 403, 429]);

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function charsetOf(contentType) {
  const match = /charset=["']?([\w-]+)/i.exec(contentType);
  return match?.[1]?.toLowerCase() ?? 'utf-8';
}

function decodeBody(bytes, contentType) {
  const charset = charsetOf(contentType);
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

function describeCause(error) {
  const cause = error?.cause;
  const code = cause?.code ?? error?.code;
  const message = cause?.message ?? error?.message ?? String(error);
  return code ? `${code}: ${message}` : message;
}

export function createHttpClient(overrides = {}) {
  const config = { ...DEFAULT_HTTP_CONFIG, ...overrides };
  const extraCaAgent = config.extraCaPem.length > 0 ? new Agent({ connect: { ca: [...tls.rootCertificates, ...config.extraCaPem] } }) : null;
  const lastRequestAt = new Map();
  const hostQueue = new Map();

  function dispatcherFor(hostname) {
    if (!extraCaAgent) return undefined;
    const matches = config.extraCaHosts.some((suffix) => hostname === suffix.replace(/^\./, '') || hostname.endsWith(suffix));
    return matches ? extraCaAgent : undefined;
  }

  /** Запросы к одному хосту идут по очереди с паузой, чтобы не провоцировать блокировку. */
  async function waitTurn(hostname, signal) {
    const previous = hostQueue.get(hostname) ?? Promise.resolve();
    const turn = previous
      .catch(() => undefined)
      .then(async () => {
        const elapsed = Date.now() - (lastRequestAt.get(hostname) ?? 0);
        if (elapsed < config.perHostDelayMs) await sleep(config.perHostDelayMs - elapsed, signal);
        lastRequestAt.set(hostname, Date.now());
      });
    hostQueue.set(
      hostname,
      turn.catch(() => undefined),
    );
    await turn;
  }

  async function once(method, url, body, options) {
    const target = new URL(url);
    if (target.protocol !== 'https:' && target.protocol !== 'http:') {
      throw new SourceError('config', `Неподдерживаемый протокол: ${target.protocol}`, { url });
    }
    const timeoutMs = options.timeoutMs ?? config.timeoutMs;
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;

    const headers = {
      'user-agent': config.userAgent,
      accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
      'accept-language': 'ru-RU,ru;q=0.9',
      ...options.headers,
    };
    let payload;
    if (body) {
      if (body.json !== undefined) {
        payload = JSON.stringify(body.json);
        headers['content-type'] = body.contentType ?? 'application/json';
      } else if (body.form) {
        payload = new URLSearchParams(body.form).toString();
        headers['content-type'] = body.contentType ?? 'application/x-www-form-urlencoded';
      } else if (body.text !== undefined) {
        payload = body.text;
        headers['content-type'] = body.contentType ?? 'text/plain;charset=utf-8';
      }
    }

    await waitTurn(target.hostname, signal);

    let response;
    try {
      response = await undiciFetch(url, {
        method,
        headers,
        body: payload,
        signal,
        redirect: 'follow',
        dispatcher: dispatcherFor(target.hostname),
      });
    } catch (error) {
      if (options.signal?.aborted) throw new SourceError('timeout', 'Запрос отменён: истекло общее время на источник', { url, cause: error });
      if (timeoutSignal.aborted) throw new SourceError('timeout', `Источник не ответил за ${timeoutMs} мс`, { url, cause: error });
      throw new SourceError('network', `Сетевая ошибка: ${describeCause(error)}`, { url, cause: error });
    }

    const contentType = response.headers.get('content-type') ?? '';
    const declared = Number(response.headers.get('content-length') ?? '0');
    if (declared > config.maxBodyBytes) {
      await response.body?.cancel();
      throw new SourceError('http', `Ответ слишком большой: ${declared} байт`, { url, status: response.status });
    }
    let bytes;
    try {
      bytes = new Uint8Array(await response.arrayBuffer());
    } catch (error) {
      if (timeoutSignal.aborted) throw new SourceError('timeout', `Источник не успел отдать ответ за ${timeoutMs} мс`, { url, cause: error });
      throw new SourceError('network', `Обрыв при чтении ответа: ${describeCause(error)}`, { url, cause: error });
    }
    if (bytes.byteLength > config.maxBodyBytes) {
      throw new SourceError('http', `Ответ слишком большой: ${bytes.byteLength} байт`, { url, status: response.status });
    }

    if (BLOCKED_STATUS.has(response.status)) {
      throw new SourceError('blocked', `Источник отклонил запрос (HTTP ${response.status}) — вероятно, защита от автоматических запросов`, {
        url,
        status: response.status,
      });
    }
    if (response.status >= 400) {
      throw new SourceError('http', `Источник вернул ошибку HTTP ${response.status}`, { url, status: response.status });
    }

    return {
      status: response.status,
      url: response.url || url,
      contentType,
      body: decodeBody(bytes, contentType),
      fetchedAt: new Date().toISOString(),
    };
  }

  async function request(method, url, body, options = {}) {
    const retries = options.retries ?? config.retries;
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        return await once(method, url, body, options);
      } catch (error) {
        lastError = error;
        if (options.signal?.aborted) break;
        const retryable =
          error instanceof SourceError &&
          (error.kind === 'network' || error.kind === 'timeout' || (error.kind === 'http' && RETRYABLE_STATUS.has(error.status ?? 0)));
        if (!retryable || attempt === retries) break;
        await sleep(400 * 2 ** attempt, options.signal).catch(() => undefined);
      }
    }
    throw lastError;
  }

  return {
    get: (url, options) => request('GET', url, undefined, options),
    post: (url, body, options) => request('POST', url, body, options),
  };
}

// ---------- Запись и воспроизведение ----------

function snapshotKey(method, url, body) {
  const bodyText = body ? JSON.stringify(body.json ?? body.form ?? body.text ?? null) : null;
  const key = createHash('sha256')
    .update(`${method}\n${url}\n${bodyText ?? ''}`)
    .digest('hex')
    .slice(0, 32);
  return { key, bodyText };
}

/**
 * Оборачивает клиент:
 *  - record: каждый успешный ответ сохраняется в каталог снимков;
 *  - replay: сеть не используется, ответы читаются из снимков (с исходной датой получения).
 */
export function withSnapshots(inner, dir, mode) {
  if (mode === 'off') return inner;

  function fileFor(method, url, body) {
    const { key, bodyText } = snapshotKey(method, url, body);
    const host = new URL(url).hostname.replace(/[^a-z0-9.-]/gi, '_');
    return { file: path.join(dir, host, `${key}.json`), bodyText };
  }

  async function handle(method, url, body, options) {
    const { file, bodyText } = fileFor(method, url, body);
    if (mode === 'replay') {
      if (!fs.existsSync(file)) {
        throw new SourceError('no_snapshot', 'Режим воспроизведения: для этого запроса нет сохранённого ответа', { url });
      }
      const snapshot = JSON.parse(fs.readFileSync(file, 'utf8'));
      return snapshot.response;
    }
    const response = method === 'GET' ? await inner.get(url, options) : await inner.post(url, body ?? {}, options);
    const snapshot = { method, requestUrl: url, requestBody: bodyText, response };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(snapshot), 'utf8');
    return response;
  }

  return {
    get: (url, options) => handle('GET', url, undefined, options),
    post: (url, body, options) => handle('POST', url, body, options),
  };
}
