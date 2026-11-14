/**
 * Реестр источников. Список и настройки берутся из config/sources.json:
 * включить, отключить или добавить источник можно без изменения основной логики.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SOURCES_DIR = path.dirname(fileURLToPath(import.meta.url));
const ID_PATTERN = /^[a-z][a-z0-9-]{1,30}$/;

function parseConfig(file) {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  const entries = parsed?.sources;
  if (!Array.isArray(entries)) throw new Error(`${file}: ожидался объект с массивом «sources»`);
  return entries.map((entry, index) => {
    const item = entry ?? {};
    if (typeof item.id !== 'string' || !ID_PATTERN.test(item.id)) {
      throw new Error(`${file}: sources[${index}].id должен состоять из строчных латинских букв, цифр и «-»`);
    }
    const defaultUnit = typeof item.defaultUnit === 'string' && item.defaultUnit.trim() ? item.defaultUnit.trim() : undefined;
    return { id: item.id, enabled: item.enabled !== false, options: item.options ?? {}, defaultUnit, note: item.note };
  });
}

export async function loadSources(configFile) {
  const adapters = [];
  const list = [];
  for (const entry of parseConfig(configFile)) {
    const modulePath = path.join(SOURCES_DIR, `${entry.id}.js`);
    try {
      if (!fs.existsSync(modulePath)) throw new Error(`нет модуля src/sources/${entry.id}.js`);
      const loaded = await import(pathToFileURL(modulePath).href);
      if (typeof loaded.default !== 'function') throw new Error('модуль не экспортирует фабрику по умолчанию');
      const adapter = loaded.default(entry.options);
      if (entry.defaultUnit) adapter.defaultUnit = entry.defaultUnit;
      list.push({ id: adapter.id, name: adapter.name, kind: adapter.kind, homepage: adapter.homepage, enabled: entry.enabled, note: entry.note });
      if (entry.enabled) adapters.push(adapter);
    } catch (error) {
      list.push({
        id: entry.id,
        name: entry.id,
        kind: 'unknown',
        homepage: '',
        enabled: false,
        note: entry.note,
        problem: `Источник не загружен: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }
  return { adapters, list };
}
