/**
 * Проверка входных данных API. Возвращает очищенный запрос или понятное сообщение об ошибке.
 */

const LIMITS = { description: 5000, text: 300, unit: 30, manualOffers: 50, sources: 30 };

function isPlain(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** undefined — поле не задано; null — задано неверно. */
function optionalText(value, max) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || value.length > max) return null;
  return value.trim() || undefined;
}

function positive(value, max) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= max ? value : null;
}

function httpUrl(value) {
  try {
    const { protocol } = new URL(value);
    return protocol === 'https:' || protocol === 'http:';
  } catch {
    return false;
  }
}

function manualOffer(input, index) {
  const label = `Предложение №${index + 1}`;
  if (!isPlain(input)) return { ok: false, error: `${label}: ожидался объект.` };
  const title = optionalText(input.title, LIMITS.text);
  if (!title) return { ok: false, error: `${label}: укажите наименование (до ${LIMITS.text} символов).` };
  const priceRub = positive(input.priceRub, 1e12);
  if (priceRub === null) return { ok: false, error: `${label}: цена должна быть положительным числом.` };
  const unit = optionalText(input.unit, LIMITS.unit);
  const supplier = optionalText(input.supplier, LIMITS.text);
  const url = optionalText(input.url, 1000);
  const priceDate = optionalText(input.priceDate, 10);
  if (unit === null || supplier === null || url === null || priceDate === null) return { ok: false, error: `${label}: слишком длинное значение поля.` };
  if (url && !httpUrl(url)) return { ok: false, error: `${label}: ссылка должна начинаться с http:// или https://.` };
  if (priceDate && (!/^\d{4}-\d{2}-\d{2}$/.test(priceDate) || Number.isNaN(Date.parse(priceDate)))) {
    return { ok: false, error: `${label}: дата цены должна быть в формате ГГГГ-ММ-ДД.` };
  }
  const vat = input.vat === undefined || input.vat === null || input.vat === '' ? undefined : input.vat;
  if (vat !== undefined && vat !== 'included' && vat !== 'excluded' && vat !== 'unknown') return { ok: false, error: `${label}: неизвестное значение НДС.` };
  return { ok: true, value: { title, priceRub, unit, supplier, url, priceDate, vat: vat } };
}

export function validateRequest(body) {
  if (!isPlain(body)) return { ok: false, error: 'Ожидался JSON-объект с описанием закупки.' };
  const description = typeof body.description === 'string' ? body.description.trim() : '';
  if (description.length < 3 || description.length > LIMITS.description) {
    return { ok: false, error: `Введите описание закупки от 3 до ${LIMITS.description} символов.` };
  }
  let quantity;
  if (body.quantity !== undefined && body.quantity !== null && body.quantity !== '') {
    const parsed = positive(body.quantity, 1e9);
    if (parsed === null) return { ok: false, error: 'Количество должно быть положительным числом.' };
    quantity = parsed;
  }
  const unit = optionalText(body.unit, LIMITS.unit);
  const region = optionalText(body.region, LIMITS.text);
  const okpd2 = optionalText(body.okpd2, 20);
  if (unit === null || region === null || okpd2 === null) return { ok: false, error: 'Слишком длинное значение единицы измерения, региона или ОКПД2.' };
  if (okpd2 && !/^\d{2}(\.\d{1,2}){0,2}(\.\d{3})?$/.test(okpd2)) return { ok: false, error: 'Код ОКПД2 должен иметь вид 17.12.14.110.' };

  let sources;
  if (body.sources !== undefined && body.sources !== null) {
    const list = body.sources;
    if (!Array.isArray(list) || list.length > LIMITS.sources || list.some((id) => typeof id !== 'string' || !/^[a-z][a-z0-9-]{1,30}$/.test(id))) {
      return { ok: false, error: 'Список источников задан неверно.' };
    }
    sources = list;
  }

  const manualOffers = [];
  if (body.manualOffers !== undefined && body.manualOffers !== null) {
    if (!Array.isArray(body.manualOffers) || body.manualOffers.length > LIMITS.manualOffers) {
      return { ok: false, error: `Ручных предложений может быть не больше ${LIMITS.manualOffers}.` };
    }
    for (const [index, input] of body.manualOffers.entries()) {
      const result = manualOffer(input, index);
      if (!result.ok) return result;
      manualOffers.push(result.value);
    }
  }
  return { ok: true, value: { description, quantity, unit, okpd2, region, sources, manualOffers: manualOffers.length > 0 ? manualOffers : undefined } };
}

/** Номера предложений для ручного включения/исключения. */
export function validateOverrides(body) {
  if (!isPlain(body)) return { ok: false, error: 'Ожидался объект { exclude: number[], include: number[] }.' };
  const read = (value) => {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value) || value.length > 500 || value.some((n) => !Number.isInteger(n) || n < 1 || n > 100000)) return null;
    return [...new Set(value)];
  };
  const exclude = read(body.exclude);
  const include = read(body.include);
  if (!exclude || !include) return { ok: false, error: 'Номера предложений должны быть положительными целыми числами.' };
  if (exclude.some((n) => include.includes(n))) return { ok: false, error: 'Одно предложение нельзя одновременно включить и исключить.' };
  return { ok: true, value: { exclude, include } };
}
