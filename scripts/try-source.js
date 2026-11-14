/**
 * Живая проверка одного адаптера источника.
 *
 *   node scripts/try-source.js <id> "<запрос>" [--limit 10] [--okpd2 17.12.14] [--json]
 *
 * Загружает src/sources/<id>.js, выполняет поиск по реальной сети и печатает
 * найденные предложения. Ошибки источника печатаются с их типом.
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHttpClient, loadExtraCa, SourceError } from '../src/core/http.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const VALUE_FLAGS = new Set(['--limit', '--okpd2']);

function flag(name) {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}

const positional = args.filter((arg, index) => !arg.startsWith('--') && !VALUE_FLAGS.has(args[index - 1] ?? ''));
const [id, text] = positional;
if (!id || !text || !/^[a-z0-9_-]+$/.test(id)) {
  console.error('Использование: node scripts/try-source.js <id> "<запрос>" [--limit 10] [--okpd2 код] [--json]');
  process.exit(2);
}

const loaded = await import(pathToFileURL(path.join(root, 'src', 'sources', `${id}.js`)).href);
const source = loaded.default();
const http = createHttpClient({ extraCaPem: loadExtraCa(path.join(root, 'certs')) });
const query = { text, altTexts: [], okpd2: flag('okpd2'), limit: Number(flag('limit') ?? 10) };

const started = Date.now();
try {
  const offers = await source.search(query, {
    http,
    signal: AbortSignal.timeout(90_000),
    log: (message) => console.error(`[${source.id}] ${message}`),
    now: () => new Date(),
  });
  if (args.includes('--json')) {
    console.log(JSON.stringify(offers, null, 2));
  } else {
    console.log(`${source.name}: ${offers.length} предложений за ${Date.now() - started} мс`);
    for (const offer of offers) {
      const characteristics = Object.entries(offer.characteristics)
        .slice(0, 6)
        .map(([name, value]) => `${name}=${value}`)
        .join('; ');
      console.log(`- ${offer.priceRub} руб./${offer.unitText ?? '?'} | ${offer.title}`);
      console.log(`  ${offer.url}`);
      console.log(`  НДС: ${offer.vat}; дата цены: ${offer.priceDate ?? 'текущая'}; поставщик: ${offer.supplier ?? '—'}`);
      if (characteristics) console.log(`  ${characteristics}`);
    }
  }
} catch (error) {
  if (error instanceof SourceError) {
    console.error(`ОШИБКА ИСТОЧНИКА [${error.kind}] ${error.message}${error.url ? ` (${error.url})` : ''}`);
    process.exit(1);
  }
  throw error;
}
