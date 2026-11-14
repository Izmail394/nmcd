import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createHttpClient, parseJson, SourceError, withSnapshots } from './http.js';

function temporaryDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nmcd-snap-'));
}

async function withServer(handler, run) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const fast = { perHostDelayMs: 0, timeoutMs: 400, retries: 1 };
const kindOf = (kind) => (error) => error instanceof SourceError && error.kind === kind;

test('снимки: запись сохраняет ответ, воспроизведение не обращается к сети и сохраняет дату получения', async () => {
  const dir = temporaryDir();
  let calls = 0;
  const inner = {
    get: async (url) => {
      calls += 1;
      return { status: 200, url, contentType: 'text/html', body: `ответ ${calls}`, fetchedAt: '2026-11-01T00:00:00.000Z' };
    },
    post: async (url, body) => ({ status: 200, url, contentType: 'application/json', body: JSON.stringify(body.json), fetchedAt: '2026-11-01T00:00:00.000Z' }),
  };
  const recorded = await withSnapshots(inner, dir, 'record').get('https://shop.example/search?q=1');
  assert.equal(recorded.body, 'ответ 1');

  const replay = withSnapshots(inner, dir, 'replay');
  const replayed = await replay.get('https://shop.example/search?q=1');
  assert.deepEqual(replayed, recorded);
  assert.equal(calls, 1, 'в режиме воспроизведения сеть не используется');
  await assert.rejects(replay.get('https://shop.example/search?q=2'), kindOf('no_snapshot'));

  // Тело POST входит в ключ снимка: разные запросы не путаются.
  const recorder = withSnapshots(inner, dir, 'record');
  await recorder.post('https://shop.example/api', { json: { q: 'a' } });
  await recorder.post('https://shop.example/api', { json: { q: 'b' } });
  assert.equal((await replay.post('https://shop.example/api', { json: { q: 'b' } })).body, '{"q":"b"}');
  assert.equal(withSnapshots(inner, dir, 'off'), inner);
});

test('HTTP-клиент: коды ответа превращаются в типизированные ошибки, 503 повторяется', async () => {
  let unstable = 0;
  await withServer(
    (request, response) => {
      if (request.url === '/ok') {
        response.setHeader('content-type', 'application/json; charset=utf-8');
        response.end('{"цена":10}');
      } else if (request.url === '/blocked') {
        response.statusCode = 403;
        response.end('нет');
      } else if (request.url === '/missing') {
        response.statusCode = 404;
        response.end();
      } else if (request.url === '/unstable') {
        unstable += 1;
        response.statusCode = unstable === 1 ? 503 : 200;
        response.end('готово');
      } else if (request.url === '/slow') {
        setTimeout(() => response.end('поздно'), 1500).unref();
      } else {
        response.end('<html>не JSON</html>');
      }
    },
    async (base) => {
      const client = createHttpClient(fast);
      const ok = await client.get(`${base}/ok`);
      assert.deepEqual(parseJson(ok), { цена: 10 });
      assert.match(ok.fetchedAt, /^\d{4}-\d{2}-\d{2}T/);
      await assert.rejects(client.get(`${base}/blocked`), kindOf('blocked'));
      await assert.rejects(client.get(`${base}/missing`), kindOf('http'));
      assert.equal((await client.get(`${base}/unstable`)).body, 'готово');
      assert.equal(unstable, 2);
      await assert.rejects(client.get(`${base}/slow`, { retries: 0 }), kindOf('timeout'));
      assert.throws(() => parseJson({ status: 200, url: base, contentType: 'text/html', body: '<html>', fetchedAt: '' }), kindOf('parse'));
    },
  );
});

test('HTTP-клиент: недоступный хост и чужой протокол — понятные ошибки', async () => {
  const client = createHttpClient({ ...fast, retries: 0 });
  await assert.rejects(client.get('http://127.0.0.1:9/'), kindOf('network'));
  await assert.rejects(client.get('file:///etc/passwd'), kindOf('config'));
});
