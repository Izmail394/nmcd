/**
 * Источник: ЕАТ «Берёзка» — единый агрегатор торговли (agregatoreat.ru).
 *
 * ВАЖНО — ограничение, подтверждённое вживую: на дату разработки адаптера сайт отдаёт
 * HTTP 200 с антибот-страницей (вычисление хеша в браузере, установка cookie
 * __js_p_/__jhash_, затем редирект) на ВСЕ проверенные запросы — главную страницу,
 * robots.txt и оба известных API-хоста (tender-cache-api.agregatoreat.ru,
 * registry-api.agregatoreat.ru). Без исполнения стороннего JS (что запрещено правилами
 * адаптеров — никакого обхода защиты) получить реальные данные нельзя, поэтому
 * search() честно бросает SourceError('blocked').
 *
 * Разбор позиций (parseSearch/extractList/mapItem) написан на будущее — на случай,
 * если доступ к источнику появится (другая сеть, white-list IP и т.п.) — по
 * общепринятому для REST-списков шаблону (голый массив или обёртка
 * items/data/result/results/rows/list), с несколькими распространёнными вариантами
 * имён полей на позицию. Эта часть НЕ подтверждена реальным трафиком: ни одного
 * настоящего ответа каталога/лотов получить не удалось. Если реальные имена полей
 * не совпадут — функция просто пропустит предложение (вернёт пустой список), а не
 * придумает данные.
 */

import { SourceError, parseJson } from '../core/http.js';

const SOURCE_ID = 'berezka';
const HOMEPAGE = 'https://agregatoreat.ru/';
/** Лучшее предположение по публичным путям из рекона; метод/параметры не подтверждены трафиком. */
const SEARCH_ENDPOINT = 'https://tender-cache-api.agregatoreat.ru/api/TradeLot/list-published-trade-lots';
const MAX_ALT_ATTEMPTS = 2;
const DEFAULT_DETAIL_LIMIT = 6;

/** Распознаёт антибот-страницу ЕАТ «Берёзка»: JS-испытание с cookie __js_p_ и вычислением хеша. */
export function isAntiBotChallenge(body) {
  return body.includes('noindex, noarchive') && body.includes('__js_p_') && body.includes('get_jhash');
}

const TITLE_KEYS = ['title', 'name', 'productName', 'itemName', 'subject'];
const PRICE_KEYS = ['price', 'unitPrice', 'priceRub', 'cost', 'startPrice', 'finalPrice', 'currentPrice'];
const UNIT_KEYS = ['unit', 'unitText', 'unitName', 'measureUnit', 'okei'];
const URL_KEYS = ['url', 'link', 'offerUrl', 'detailUrl', 'pageUrl'];
const ID_KEYS = ['id', 'externalId', 'sku', 'offerId', 'lotId', 'number'];
const SUPPLIER_KEYS = ['supplier', 'supplierName', 'organizationName', 'providerName', 'seller'];
const CONTAINER_KEYS = ['items', 'data', 'result', 'results', 'rows', 'list'];

function firstString(item, keys) {
  for (const key of keys) {
    const value = item[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return null;
}

function firstNumber(item, keys) {
  for (const key of keys) {
    const value = item[key];
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
    if (typeof value === 'string') {
      const parsed = Number(value.replace(',', '.').replace(/\s/g, ''));
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
  }
  return null;
}

function extractCharacteristics(item) {
  const raw = item['characteristics'];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const result = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'string') result[key] = value;
    else if (typeof value === 'number') result[key] = String(value);
  }
  return result;
}

/** Достаёт список позиций из ответа: голый массив или одна из типовых обёрток. */
function extractList(data) {
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') {
    for (const key of CONTAINER_KEYS) {
      const value = data[key];
      if (Array.isArray(value)) return value;
    }
  }
  return null;
}

/** Сопоставляет одну позицию ответа с RawOffer. Без цены, ссылки или названия — null (пропуск). */
function mapItem(raw, fetchedAt) {
  if (!raw || typeof raw !== 'object') return null;
  const item = raw;

  const priceRub = firstNumber(item, PRICE_KEYS);
  const url = firstString(item, URL_KEYS);
  const title = firstString(item, TITLE_KEYS);
  if (priceRub === null || !url || !title) return null;

  const externalId = firstString(item, ID_KEYS) ?? url;
  const unitText = firstString(item, UNIT_KEYS);
  const supplier = firstString(item, SUPPLIER_KEYS) ?? undefined;

  return {
    sourceId: SOURCE_ID,
    externalId,
    url,
    title,
    priceRub,
    unitText,
    vat: 'unknown',
    characteristics: extractCharacteristics(item),
    supplier,
    fetchedAt,
  };
}

/**
 * Чистый разбор ответа поиска.
 * - Антибот-страница -> SourceError('blocked').
 * - Не JSON -> SourceError('parse') (бросает parseJson).
 * - JSON без распознанного списка позиций -> SourceError('parse').
 * - Пустой список -> [].
 * - Позиции без цены/ссылки/названия пропускаются, остальные возвращаются.
 */
export function parseSearch(response) {
  if (isAntiBotChallenge(response.body)) {
    throw new SourceError(
      'blocked',
      'ЕАТ «Берёзка» отклоняет автоматические запросы: вместо данных отдаётся страница проверки браузера. Источник пропущен; цены с «Берёзки» можно добавить вручную.',
      { url: response.url },
    );
  }

  const data = parseJson(response);
  const list = extractList(data);
  if (list === null) {
    throw new SourceError('parse', 'Не найден ожидаемый список предложений (массив верхнего уровня или поле items/data/result/results/rows/list)', {
      url: response.url,
    });
  }

  const offers = [];
  for (const rawItem of list) {
    const offer = mapItem(rawItem, response.fetchedAt);
    if (offer) offers.push(offer);
  }
  return offers;
}

async function runSearch(ctx, text, limit) {
  const url = `${SEARCH_ENDPOINT}?search=${encodeURIComponent(text)}&take=${encodeURIComponent(String(limit))}`;
  const response = await ctx.http.get(url, { signal: ctx.signal });
  return parseSearch(response);
}

/** Дозапрашивает карточку предложения и дополняет характеристики, если источник их не отдал в выдаче. */
async function enrichWithDetails(offers, ctx, detailLimit) {
  let enriched = 0;
  for (const offer of offers) {
    if (enriched >= detailLimit) break;
    if (Object.keys(offer.characteristics).length > 0) continue;
    enriched += 1;
    try {
      const response = await ctx.http.get(offer.url, { signal: ctx.signal });
      if (isAntiBotChallenge(response.body)) continue;
      const data = parseJson(response);
      if (data && typeof data === 'object') {
        const characteristics = extractCharacteristics(data);
        if (Object.keys(characteristics).length > 0) offer.characteristics = characteristics;
      }
    } catch (error) {
      ctx.log(`Не удалось дозапросить характеристики для ${offer.externalId}: ${error.message}`);
    }
  }
}

const createSource = (options = {}) => {
  const detailLimit = typeof options.detailLimit === 'number' && options.detailLimit >= 0 ? options.detailLimit : DEFAULT_DETAIL_LIMIT;

  return {
    id: SOURCE_ID,
    name: 'ЕАТ «Берёзка»',
    kind: 'aggregator',
    homepage: HOMEPAGE,

    async search(query, ctx) {
      const texts = [query.text, ...query.altTexts.slice(0, MAX_ALT_ATTEMPTS)].filter((text) => text.trim().length > 0);

      let lastOffers = [];
      for (const text of texts) {
        const offers = await runSearch(ctx, text, query.limit);
        if (offers.length > 0) {
          const limited = offers.slice(0, query.limit);
          if (detailLimit > 0) await enrichWithDetails(limited, ctx, detailLimit);
          return limited;
        }
        lastOffers = offers;
      }
      return lastOffers;
    },
  };
};

export default createSource;
