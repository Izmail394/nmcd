/**
 * Общие помощники для магазинов, публикующих выдачу в разметке schema.org (JSON-LD).
 * Это не адаптер: имя начинается с «_», в config/sources.json не указывается.
 */

export function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Все корректные блоки <script type="application/ld+json"> страницы. Битые блоки пропускаются. */
export function extractJsonLd(html) {
  const blocks = [];
  const pattern = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (const match of html.matchAll(pattern)) {
    try {
      const parsed = JSON.parse(match[1] ?? '');
      for (const item of Array.isArray(parsed) ? parsed : [parsed]) {
        if (isObject(item)) blocks.push(item);
      }
    } catch {
      // Один повреждённый блок разметки не должен мешать разбору остальных.
    }
  }
  return blocks;
}

export function hasType(block, type) {
  const value = block['@type'];
  return value === type || (Array.isArray(value) && value.includes(type));
}

export function text(value) {
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

/** Цена в рублях из числа или строки вида "2146.50"; null, если цены нет или она не положительна. */
export function price(value) {
  const parsed =
    typeof value === 'number' ? value : typeof value === 'string' && /^\s*\d+(?:[.,]\d+)?\s*$/.test(value) ? Number(value.trim().replace(',', '.')) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function httpUrl(value) {
  const candidate = text(value);
  if (!candidate) return null;
  try {
    const { protocol } = new URL(candidate);
    return protocol === 'https:' || protocol === 'http:' ? candidate : null;
  } catch {
    return null;
  }
}
