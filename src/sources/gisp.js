/**
 * Адаптер источника «ГИСП» — государственная информационная система
 * промышленности Минпромторга (каталог продукции gisp.gov.ru/goods/).
 *
 * ВАЖНО (результат разведки, см. отчёт задачи): ВСЕ проверенные пути сайта —
 * «/», «/goods/», «/opendata/», угаданные «/api/goods/search» и даже
 * «/robots.txt» — отдают с кодом 200 одну и ту же страницу анти-бота
 * ServicePipe (js-challenge-loader, скрытый <js-captcha-frame>,
 * get_cookie_spsn/spid). Повторный запрос с теми же cookie получает новый
 * вызов проверки — значит, нужна настоящая выдача результата JS-проверки
 * браузером (возможна и капча: в опциях есть флаг is_captcha). Решать такие
 * проверки, подделывать отпечатки или cookie правилами адаптера запрещено
 * (см. docs/ADAPTERS.md, п. 8), поэтому настоящий ответ каталога с ценами
 * получить не удалось и его реальный формат не подтверждён.
 *
 * parseSearch() ниже умеет:
 *  - достоверно (на реальных сохранённых фикстурах) распознавать страницу
 *    анти-бота и сообщать об этом как SourceError('blocked');
 *  - защитно разбирать JSON-каталог по типичным для таких API именам полей —
 *    это НЕ подтверждённый реальный контракт ГИСП, а запасной разбор на
 *    случай, если блокировка будет снята (например, для IP, допущенных
 *    Минпромторгом). Он протестирован только на синтетических JSON-строках,
 *    написанных для тестов, а не на настоящих ответах источника.
 */

import { SourceError } from '../core/http.js';

const BASE_URL = 'https://gisp.gov.ru/goods/';

const ANTIBOT_MARKERS = ['servicepipe', 'js-challenge-loader', 'id_captcha_frame_div', 'get_cookie_spsn', 'get_cookie_spid'];

/** Определяет, что ответ — страница анти-бота ServicePipe, а не каталог ГИСП. */
export function isAntibotChallenge(body) {
  const sample = body.slice(0, 4000).toLowerCase();
  return ANTIBOT_MARKERS.some((marker) => sample.includes(marker));
}

const ITEMS_KEYS = ['items', 'data', 'results', 'rows', 'goods', 'list', 'content'];
const TITLE_KEYS = ['title', 'name', 'goodsName', 'productName', 'naimenovanie'];
const PRICE_KEYS = ['priceRub', 'price', 'cena', 'stoimost', 'cost'];
const UNIT_KEYS = ['unitText', 'unit', 'unitName', 'measureUnit', 'edIzm'];
const URL_KEYS = ['url', 'link', 'detailUrl', 'pageUrl', 'href'];
const ID_KEYS = ['id', 'externalId', 'code', 'sku', 'goodsId', 'productId'];
const SUPPLIER_KEYS = ['supplier', 'manufacturer', 'producer', 'brand', 'organization'];
const REGION_KEYS = ['region', 'regionName', 'subject'];
const OKPD2_KEYS = ['okpd2', 'okpdCode', 'okpd'];
const CHARACTERISTIC_KEYS = ['characteristics', 'specs', 'attributes', 'properties', 'params'];

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pickString(obj, keys) {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return null;
}

function pickPositiveNumber(obj, keys) {
  for (const key of keys) {
    const value = obj[key];
    const num = typeof value === 'number' ? value : typeof value === 'string' ? Number(value.replace(',', '.').replace(/\s/g, '')) : Number.NaN;
    if (Number.isFinite(num) && num > 0) return num;
  }
  return null;
}

function pickCharacteristics(obj) {
  for (const key of CHARACTERISTIC_KEYS) {
    const value = obj[key];
    if (isRecord(value)) {
      const result = {};
      for (const [name, raw] of Object.entries(value)) {
        if (typeof raw === 'string' || typeof raw === 'number') result[name] = String(raw);
      }
      if (Object.keys(result).length > 0) return result;
    }
    if (Array.isArray(value)) {
      const result = {};
      for (const entry of value) {
        if (!isRecord(entry)) continue;
        const name = pickString(entry, ['name', 'title', 'key']);
        const val = pickString(entry, ['value', 'val']);
        if (name && val) result[name] = val;
      }
      if (Object.keys(result).length > 0) return result;
    }
  }
  return {};
}

function resolveUrl(raw) {
  try {
    return new URL(raw, BASE_URL).toString();
  } catch {
    return raw;
  }
}

function extractItems(data) {
  if (Array.isArray(data)) return data;
  if (isRecord(data)) {
    for (const key of ITEMS_KEYS) {
      const value = data[key];
      if (Array.isArray(value)) return value;
    }
  }
  return null;
}

/**
 * Чистая функция разбора ответа каталога ГИСП. Тестируется на фикстурах из
 * test/fixtures/gisp/ (реальные страницы анти-бота) и на синтетических JSON
 * из gisp.test.js (запасной разбор каталога — см. пояснение в заголовке файла).
 */
export function parseSearch(body, fetchedAt) {
  if (isAntibotChallenge(body)) {
    throw new SourceError(
      'blocked',
      'ГИСП отклоняет автоматические запросы: вместо каталога отдаётся страница проверки браузера (защита ServicePipe). Источник пропущен; цены из ГИСП можно добавить вручную.',
    );
  }

  let data;
  try {
    data = JSON.parse(body);
  } catch (cause) {
    const head = body.slice(0, 120).replace(/\s+/g, ' ');
    throw new SourceError('parse', `Ответ ГИСП не похож ни на известную страницу анти-бота, ни на JSON каталога: «${head}»`, { cause });
  }

  const items = extractItems(data);
  if (items === null) {
    throw new SourceError(
      'parse',
      'В ответе ГИСП не найден ожидаемый список товаров (ни один из контейнеров items/data/results/rows/goods/list/content ' +
        'не оказался массивом) — формат ответа, по-видимому, изменился',
    );
  }

  const offers = [];
  for (const raw of items) {
    if (!isRecord(raw)) continue;
    const title = pickString(raw, TITLE_KEYS);
    const priceRub = pickPositiveNumber(raw, PRICE_KEYS);
    const urlRaw = pickString(raw, URL_KEYS);
    const externalId = pickString(raw, ID_KEYS);
    // Нет названия, цены (>0), ссылки или устойчивого id — позицию пропускаем, остальные обрабатываем.
    if (!title || priceRub === null || !urlRaw || !externalId) continue;

    offers.push({
      sourceId: 'gisp',
      externalId,
      url: resolveUrl(urlRaw),
      title,
      priceRub,
      unitText: pickString(raw, UNIT_KEYS),
      vat: 'unknown',
      characteristics: pickCharacteristics(raw),
      supplier: pickString(raw, SUPPLIER_KEYS) ?? undefined,
      region: pickString(raw, REGION_KEYS) ?? undefined,
      okpd2: pickString(raw, OKPD2_KEYS) ?? undefined,
      fetchedAt,
      evidence: JSON.stringify(raw).slice(0, 300),
    });
  }
  return offers;
}

async function fetchAndParse(ctx, text, limit) {
  const url = `${BASE_URL}?search=${encodeURIComponent(text)}`;
  const response = await ctx.http.get(url, { signal: ctx.signal });
  return parseSearch(response.body, response.fetchedAt).slice(0, limit);
}

const createSource = (options = {}) => {
  const detailLimit = typeof options.detailLimit === 'number' ? options.detailLimit : 6;

  return {
    id: 'gisp',
    name: 'ГИСП — каталог продукции Минпромторга',
    kind: 'gov_catalog',
    homepage: BASE_URL,
    async search(query, ctx) {
      ctx.log(
        `detailLimit=${detailLimit} зарезервирован и сейчас не используется: адреса карточек товаров неизвестны, так как ` +
          'ГИСП блокирует автоматические запросы анти-ботом (см. комментарий в начале gisp.js)',
      );
      const texts = [query.text, ...query.altTexts.slice(0, 2)];
      let offers = [];
      for (const text of texts) {
        offers = await fetchAndParse(ctx, text, query.limit);
        if (offers.length > 0) break;
      }
      return offers;
    },
  };
};

export default createSource;
