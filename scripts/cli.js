/**
 * Расчёт из командной строки, без HTTP-сервера.
 *
 *   node scripts/cli.js "<описание закупки>" [--qty 10] [--unit упак] [--okpd2 17.12.14.110]
 *                       [--sources etm,ymarket | --no-search] [--offers offers.json] [--json] [--docx out.docx]
 *
 * --offers — JSON-массив ручных предложений: [{ "title", "priceRub", "unit", "supplier", "url" }].
 * Код возврата: 0 — цена рассчитана, 3 — данных недостаточно, 2 — ошибка в аргументах.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHttpClient, loadExtraCa } from '../src/core/http.js';
import { runPipeline } from '../src/core/pipeline.js';
import { loadRules } from '../src/core/rules.js';
import { formatMoney, formatNumber } from '../src/core/stats.js';
import { validateRequest } from '../src/core/validate.js';
import { renderDocx } from '../src/report/docx.js';
import { loadSources } from '../src/sources/registry.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const VALUE_FLAGS = new Set(['--qty', '--unit', '--okpd2', '--sources', '--offers', '--docx']);

function flag(name) {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}

const description = args.find((arg, index) => !arg.startsWith('--') && !VALUE_FLAGS.has(args[index - 1] ?? ''));
if (!description) {
  console.error(
    'Использование: node scripts/cli.js "<описание закупки>" [--qty N] [--unit ед] [--okpd2 код] [--sources a,b | --no-search] [--offers файл.json] [--json] [--docx файл.docx]',
  );
  process.exit(2);
}

const offersFile = flag('offers');
const input = validateRequest({
  description,
  quantity: flag('qty') === undefined ? undefined : Number(flag('qty')),
  unit: flag('unit'),
  okpd2: flag('okpd2'),
  sources: args.includes('--no-search')
    ? []
    : flag('sources')
        ?.split(',')
        .map((id) => id.trim()),
  manualOffers: offersFile ? JSON.parse(fs.readFileSync(path.resolve(offersFile), 'utf8')) : undefined,
});
if (!input.ok) {
  console.error(`Ошибка во входных данных: ${input.error}`);
  process.exit(2);
}

const configDir = path.resolve(process.env.CONFIG_DIR ?? path.join(root, 'config'));
const cpiFile = path.join(configDir, 'cpi.json');
const cpiData = fs.existsSync(cpiFile) ? JSON.parse(fs.readFileSync(cpiFile, 'utf8')) : {};
const registry = await loadSources(path.join(configDir, 'sources.json'));
const packageInfo = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

const report = await runPipeline(input.value, {
  sources: registry.adapters,
  http: createHttpClient({ extraCaPem: loadExtraCa(path.join(root, 'certs')) }),
  rules: loadRules(path.join(configDir, 'rules.json')),
  cpi: { source: cpiData.source ?? 'не настроен', updated: cpiData.updated ?? '', monthly: cpiData.monthly ?? {} },
  now: () => new Date(),
  mode: 'live',
  appVersion: packageInfo.version ?? '0.0.0',
  log: (message) => console.error(message),
});

const docxFile = flag('docx');
if (docxFile) fs.writeFileSync(path.resolve(docxFile), await renderDocx(report));

if (args.includes('--json')) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const { calculation, requirement } = report;
  console.log(`Предмет: ${requirement.subject} — ${formatNumber(requirement.quantity, 3)} ${requirement.unit.code}`);
  console.log(`Характеристики: ${requirement.attributes.map((attribute) => `${attribute.name}: ${attribute.value}`).join('; ') || 'не выделены'}`);
  console.log('\nИсточники:');
  for (const run of report.sources) {
    console.log(
      `  ${run.sourceName}: ${run.status === 'error' ? `недоступен — ${run.errorMessage}` : run.status === 'empty' ? 'ничего не найдено' : `${run.offersFound} предложений`}`,
    );
  }
  console.log('\nПредложения:');
  for (const item of report.offers) {
    const price = item.price.unitPriceRub === null ? 'не приведено' : `${formatMoney(item.price.unitPriceRub)} руб./${item.price.unitCode}`;
    console.log(`  ${item.decision.included ? '[+]' : '[-]'} №${item.n} ${item.sourceName} | ${price} | ${item.raw.title}`);
    console.log(`       ${item.decision.reason}`);
    if (item.raw.url) console.log(`       ${item.raw.url}`);
  }
  console.log('\nРасчёт:');
  if (calculation.status === 'ok' && calculation.total !== null) {
    console.log(`  ${calculation.formula}`);
    console.log(`  n = ${calculation.count}; V = ${formatNumber(calculation.cv ?? 0)}% (порог ${formatNumber(calculation.cvThreshold)}%)`);
    console.log(`  НМЦД: ${formatMoney(calculation.total)} руб. Надёжность: ${report.reliability.level} (${report.reliability.score} из 100)`);
  } else {
    console.log(`  Цена не сформирована. ${calculation.insufficiencyReason ?? ''}`);
  }
  for (const warning of calculation.warnings) console.log(`  Внимание: ${warning}`);
  if (docxFile) console.log(`\nОтчёт сохранён: ${path.resolve(docxFile)}`);
}
process.exit(report.calculation.status === 'ok' ? 0 : 3);
