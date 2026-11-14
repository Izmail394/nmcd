/**
 * Точка входа: читает конфигурацию и переменные окружения, собирает зависимости и запускает HTTP-сервер.
 *
 * Переменные окружения (все необязательны):
 *   PORT, HOST            — адрес сервера (по умолчанию 127.0.0.1:3000);
 *   DATA_DIR              — каталог отчётов и снимков (по умолчанию ./data);
 *   CONFIG_DIR            — каталог sources.json, rules.json, cpi.json (по умолчанию ./config);
 *   SNAPSHOT_MODE         — off | record | replay: запись и воспроизведение ответов источников;
 *   SNAPSHOT_DIR          — каталог снимков (по умолчанию DATA_DIR/snapshots);
 *   EXTRA_CA_HOSTS        — суффиксы хостов для сертификатов из ./certs (по умолчанию .gov.ru).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from './app.js';
import { createHttpClient, loadExtraCa, withSnapshots } from './core/http.js';
import { loadRules } from './core/rules.js';
import { ReportStore } from './core/store.js';
import { loadSources } from './sources/registry.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = process.env;
const configDir = path.resolve(env.CONFIG_DIR ?? path.join(root, 'config'));
const dataDir = path.resolve(env.DATA_DIR ?? path.join(root, 'data'));

function readJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function snapshotMode(value) {
  if (value === undefined || value === '' || value === 'off') return 'off';
  if (value === 'record' || value === 'replay') return value;
  throw new Error(`SNAPSHOT_MODE должен быть off, record или replay (получено «${value}»)`);
}

const packageInfo = readJson(path.join(root, 'package.json'), {});
const mode = snapshotMode(env.SNAPSHOT_MODE);
const rules = loadRules(path.join(configDir, 'rules.json'));
const cpiFile = readJson(path.join(configDir, 'cpi.json'), {});
const cpi = { source: cpiFile.source ?? 'не настроен', updated: cpiFile.updated ?? '', monthly: cpiFile.monthly ?? {} };
const registry = await loadSources(path.join(configDir, 'sources.json'));

const extraCaPem = loadExtraCa(path.join(root, 'certs'));
const extraCaHosts = env.EXTRA_CA_HOSTS?.split(',')
  .map((host) => host.trim())
  .filter(Boolean);
const snapshotDir = path.resolve(env.SNAPSHOT_DIR || path.join(dataDir, 'snapshots'));
const metaFile = path.join(snapshotDir, '_meta.json');
if (mode === 'record') {
  fs.mkdirSync(snapshotDir, { recursive: true });
  fs.writeFileSync(metaFile, JSON.stringify({ recordedAt: new Date().toISOString() }, null, 2));
}
// В режиме воспроизведения «сегодня» равно дню записи: давность цен и индексация считаются так же, как при записи.
const recordedAt = mode === 'replay' && fs.existsSync(metaFile) ? readJson(metaFile, {}).recordedAt : undefined;
const http = withSnapshots(createHttpClient({ extraCaPem, ...(extraCaHosts?.length ? { extraCaHosts } : {}) }), snapshotDir, mode);

const app = await buildApp({
  registry,
  http,
  rules,
  cpi,
  store: new ReportStore(path.join(dataDir, 'reports')),
  mode: mode === 'replay' ? 'replay' : 'live',
  snapshotDate: recordedAt,
  now: recordedAt ? () => new Date(recordedAt) : undefined,
  appVersion: packageInfo.version ?? '0.0.0',
  publicDir: path.join(root, 'public'),
});

for (const item of registry.list) {
  if (item.problem) app.log.warn(`${item.id}: ${item.problem}`);
}
app.log.info(
  `Источников включено: ${registry.adapters.length}; режим данных: ${mode}; доп. корневых сертификатов: ${extraCaPem.length}; месяцев ИПЦ: ${Object.keys(cpi.monthly).length}`,
);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    app.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  });
}

await app.listen({ port: Number(env.PORT ?? 3000), host: env.HOST ?? '127.0.0.1' });
