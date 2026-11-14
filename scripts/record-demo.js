/**
 * Запись ответов источников для демо-режима.
 *
 *   node scripts/record-demo.js
 *
 * Запускает сервис в режиме записи (SNAPSHOT_MODE=record), выполняет расчеты по примерам из интерфейса
 * и сохраняет все ответы источников в demo/snapshots. Запускать нужно с российского адреса, иначе
 * часть источников (ЕИС) не ответит. Затем demo/snapshots коммитится в репозиторий, а на сервере без
 * доступа к источникам включается SNAPSHOT_MODE=replay SNAPSHOT_DIR=demo/snapshots.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const snapshotDir = path.join(root, 'demo', 'snapshots');
const port = 3277;

// Примеры должны совпадать с кнопками над полем описания в public/app.js.
const EXAMPLES = [
  { description: 'Бумага офисная А4, плотность 80 г/м2, пачка 500 листов, белизна не менее 146%', quantity: 200, unit: 'упак', okpd2: '17.12.14.110' },
  { description: 'Кабель силовой ВВГнг(А)-LS 3х2,5 мм2, напряжение 0,66 кВ', quantity: 500, unit: 'м', okpd2: '27.32.13' },
  { description: 'Картридж для лазерного принтера HP CF283A, ресурс не менее 1500 страниц', quantity: 20, unit: 'шт' },
  { description: 'Услуги по разработке мобильного приложения для iOS', quantity: 1, unit: 'усл. ед' },
];

fs.rmSync(snapshotDir, { recursive: true, force: true });
const server = spawn(process.execPath, ['src/server.js'], {
  cwd: root,
  env: { ...process.env, SNAPSHOT_MODE: 'record', SNAPSHOT_DIR: snapshotDir, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: path.join(root, 'data', 'record-tmp') },
  stdio: ['ignore', 'ignore', 'inherit'],
});

async function waitForServer() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return;
    } catch {
      /* сервис еще запускается */
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('Сервис не запустился');
}

try {
  await waitForServer();
  for (const body of EXAMPLES) {
    const response = await fetch(`http://127.0.0.1:${port}/api/calculate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const report = await response.json();
    if (!response.ok) throw new Error(report.error ?? `HTTP ${response.status}`);
    const { calculation, sources } = report;
    console.log(`${body.description.slice(0, 48)} | ${calculation.status} | цен ${calculation.count} | НМЦД ${calculation.total ?? '-'}`);
    console.log(`  ${sources.map((source) => `${source.sourceId}:${source.status}`).join(' ')}`);
  }
} finally {
  server.kill();
}

let files = 0;
let bytes = 0;
const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.endsWith('.gz')) {
      files += 1;
      bytes += fs.statSync(full).size;
    }
  }
};
walk(snapshotDir);
console.log(`Записано ответов ${files}, размер ${(bytes / 1048576).toFixed(1)} МБ в ${snapshotDir}`);
