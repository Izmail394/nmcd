/**
 * Поиск дублей: одно и то же предложение не должно попасть в расчёт дважды,
 * иначе оно получит двойной вес и исказит среднюю цену.
 */

import { normalizeText } from './text.js';

const TRACKING_PARAMS = /^(utm_|yclid|gclid|fbclid|from|ref|sid|sessionid|_openstat|clid|cpc|rs|sku_from)/i;

export function canonicalUrl(url) {
  try {
    const parsed = new URL(url);
    for (const key of [...parsed.searchParams.keys()]) {
      if (TRACKING_PARAMS.test(key)) parsed.searchParams.delete(key);
    }
    parsed.searchParams.sort();
    parsed.hash = '';
    const path = parsed.pathname.replace(/\/+$/, '');
    const query = parsed.searchParams.toString();
    return `${parsed.hostname.toLowerCase().replace(/^www\./, '')}${path}${query ? `?${query}` : ''}`;
  } catch {
    return null;
  }
}

/** Возвращает для каждого дубля ссылку на первое вхождение. */
export function findDuplicates(offers) {
  const duplicates = new Map();
  const byId = new Map();
  const byUrl = new Map();
  const byContent = new Map();

  offers.forEach((offer, index) => {
    const idKey = `${offer.sourceId}|${offer.externalId}`;
    const url = offer.url ? canonicalUrl(offer.url) : null;
    const supplier = offer.supplier ? normalizeText(offer.supplier) : '';
    const contentKey = `${normalizeText(offer.title)}|${offer.priceRub}|${normalizeText(offer.unitText ?? '')}|${supplier}`;

    const sameId = offer.externalId ? byId.get(idKey) : undefined;
    // Одна ссылка — не всегда одно предложение: позиции одного контракта ЕИС ведут на общую карточку.
    // Если источник сам различает записи идентификаторами, совпадение ссылки дублем не считается.
    const urlHit = url ? byUrl.get(url) : undefined;
    const urlOwner = urlHit === undefined ? undefined : offers[urlHit];
    const distinctItems =
      urlOwner !== undefined && urlOwner.sourceId === offer.sourceId && Boolean(offer.externalId) && urlOwner.externalId !== offer.externalId;
    const sameUrl = distinctItems ? undefined : urlHit;
    const sameContent = byContent.get(contentKey);

    if (sameId !== undefined) {
      duplicates.set(index, { of: sameId, reason: 'тот же идентификатор в том же источнике' });
    } else if (sameUrl !== undefined) {
      duplicates.set(index, { of: sameUrl, reason: 'та же ссылка' });
    } else if (sameContent !== undefined) {
      const original = offers[sameContent];
      const cross = original && original.sourceId !== offer.sourceId ? ' в другом источнике' : '';
      duplicates.set(index, { of: sameContent, reason: `то же наименование, цена и поставщик${cross}` });
    } else {
      if (offer.externalId) byId.set(idKey, index);
      if (url && !byUrl.has(url)) byUrl.set(url, index);
      byContent.set(contentKey, index);
    }
  });
  return duplicates;
}
