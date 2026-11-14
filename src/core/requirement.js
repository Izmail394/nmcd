/**
 * Разбор описания закупки по правилам: наименование, ключевые слова,
 * существенные характеристики, количество, единица измерения, поисковые запросы.
 */

import { keywordStems, normalizeText, parseNumber } from './text.js';
import { DEFAULT_UNIT, parseUnit } from './units.js';

// Порядок важен: более длинные и составные единицы — раньше.
const ATTR_UNITS = [
  { pattern: 'г(?:р)?\\.?\\s?/\\s?(?:м2|м²|кв\\.?\\s?м)', unit: 'г/м2', defaultName: 'плотность' },
  { pattern: 'мм2|мм²|кв\\.?\\s?мм', unit: 'мм2', defaultName: 'сечение' },
  { pattern: 'об\\.?\\s?/\\s?мин', unit: 'об/мин', defaultName: 'частота вращения' },
  { pattern: 'л\\s?/\\s?мин', unit: 'л/мин', defaultName: 'производительность' },
  { pattern: 'мач|ма·ч|mah', unit: 'мАч', defaultName: 'ёмкость аккумулятора' },
  { pattern: 'квт', unit: 'Вт', defaultName: 'мощность', factor: 1000 },
  { pattern: 'вт|w(?![a-z])', unit: 'Вт', defaultName: 'мощность' },
  { pattern: 'ггц|ghz', unit: 'ГГц', defaultName: 'частота' },
  { pattern: 'мгц|mhz', unit: 'МГц', defaultName: 'частота' },
  { pattern: 'гц|hz', unit: 'Гц', defaultName: 'частота' },
  { pattern: 'тб|tb', unit: 'ГБ', defaultName: 'объём накопителя', factor: 1024 },
  { pattern: 'гб|gb', unit: 'ГБ', defaultName: 'объём памяти' },
  { pattern: 'мб|mb', unit: 'МБ', defaultName: 'объём памяти' },
  { pattern: 'дюйм(?:ов|а)?|"|”|″', unit: 'дюйм', defaultName: 'диагональ' },
  { pattern: 'листов|листа|лист', unit: 'лист', defaultName: 'количество листов' },
  { pattern: 'страниц|стр', unit: 'стр', defaultName: 'ресурс' },
  { pattern: 'мпа', unit: 'МПа', defaultName: 'давление' },
  { pattern: 'бар', unit: 'бар', defaultName: 'давление' },
  { pattern: 'лм', unit: 'лм', defaultName: 'световой поток' },
  { pattern: 'мм', unit: 'мм', defaultName: 'размер' },
  { pattern: 'см', unit: 'мм', defaultName: 'размер', factor: 10 },
  { pattern: 'км', unit: 'м', defaultName: 'длина', factor: 1000 },
  { pattern: 'кг', unit: 'кг', defaultName: 'масса' },
  { pattern: 'мл', unit: 'мл', defaultName: 'объём' },
  { pattern: 'мес(?:яц(?:ев|а)?)?', unit: 'мес', defaultName: 'срок' },
  { pattern: '%', unit: '%', defaultName: 'показатель' },
  { pattern: 'м', unit: 'м', defaultName: 'длина' },
  { pattern: 'г(?:р)?', unit: 'г', defaultName: 'масса' },
  { pattern: 'л', unit: 'л', defaultName: 'объём' },
  { pattern: 'кв', unit: 'В', defaultName: 'напряжение', factor: 1000, strictCase: 'кВ' },
  { pattern: 'в', unit: 'В', defaultName: 'напряжение', strictCase: 'В' },
  { pattern: 'а', unit: 'А', defaultName: 'сила тока', strictCase: 'А' },
  { pattern: 'к', unit: 'К', defaultName: 'цветовая температура', strictCase: 'К' },
];

/** Существительные-названия характеристик; ищутся перед числом. */
const ATTR_NAMES = [
  'плотность',
  'белизна',
  'яркость',
  'толщина',
  'длина',
  'ширина',
  'высота',
  'глубина',
  'диаметр',
  'объем',
  'объём',
  'вес',
  'масса',
  'мощность',
  'напряжение',
  'ток',
  'частота',
  'диагональ',
  'память',
  'емкость',
  'ёмкость',
  'сечение',
  'количество',
  'размер',
  'ресурс',
  'скорость',
  'разрешение',
  'давление',
  'температура',
  'гарантия',
  'срок',
  'грузоподъемность',
  'грузоподъёмность',
  'производительность',
  'непрозрачность',
  'вместимость',
  'накопитель',
  'жирность',
  'концентрация',
  'вязкость',
  'поток',
  'нагрузка',
];

const GE_WORDS = /(?:не\s+менее|не\s+меньше|не\s+ниже|от|минимум|мин\.?|>=|≥|более|свыше)\s*$/i;
const LE_WORDS = /(?:не\s+более|не\s+больше|не\s+выше|до|максимум|макс\.?|<=|≤|менее)\s*$/i;

const COLORS = [
  'белый',
  'черный',
  'чёрный',
  'синий',
  'красный',
  'зеленый',
  'зелёный',
  'желтый',
  'жёлтый',
  'серый',
  'коричневый',
  'оранжевый',
  'фиолетовый',
  'голубой',
  'розовый',
  'бежевый',
  'прозрачный',
  'серебристый',
];

const LEADING_FILLER =
  /^(?:поставка|закупка|приобретение|покупка|оказание\s+услуг(?:и)?(?:\s+по)?|выполнение\s+работ(?:ы)?(?:\s+по)?|на\s+поставку|товар\s*[:—–-]?)\s+/i;

const REQUEST_FIELD_NAMES =
  /^(количество|кол-во|объ[её]м\s+закупки|единица\s+измерения|ед\.?\s*изм\.?|окпд\s*2?|регион|место\s+поставки|срок\s+поставки|адрес)/i;

function paperContext(description) {
  return /бумаг|лист|тетрад|блокнот|ватман|картон|пач(ка|ек|ки)/i.test(description);
}

function nameBefore(prefix) {
  const words = prefix
    .toLowerCase()
    .replace(/ё/g, 'е')
    .split(/[^a-zа-я]+/)
    .filter(Boolean)
    .slice(-4);
  for (let index = words.length - 1; index >= 0; index -= 1) {
    const word = words[index] ?? '';
    const known = ATTR_NAMES.find((name) => {
      const base = name.replace(/ё/g, 'е');
      return word.startsWith(base.slice(0, Math.max(4, base.length - 2)));
    });
    if (known) return known;
  }
  return null;
}

function formatNumber(value) {
  return String(Math.round(value * 1000) / 1000).replace('.', ',');
}

/**
 * Все «число + единица» в тексте: «80 г/м2», «16А», «15,6"».
 * Используется и для описания закупки, и для названий/характеристик предложений —
 * поэтому значения сравниваются в одних и тех же единицах.
 */
export function findMeasurements(text, paper = paperContext(text)) {
  const found = [];
  const overlaps = (start, end) => found.some((item) => start < item.end && end > item.start);

  for (const def of ATTR_UNITS) {
    const pattern = new RegExp(`(?<![0-9a-zа-яё.,xх×*])(\\d+(?:[.,]\\d+)?)(\\s?)(${def.pattern})(?![a-zа-яё0-9/²])`, 'gi');
    for (const match of text.matchAll(pattern)) {
      const start = match.index ?? 0;
      const end = start + match[0].length;
      if (overlaps(start, end)) continue;
      const rawUnit = match[3] ?? '';
      if (def.strictCase && rawUnit !== def.strictCase && !(match[2] === '' && rawUnit.toLowerCase() === def.strictCase.toLowerCase())) continue;
      const value = parseNumber(match[1] ?? '');
      if (value === null) continue;
      // «500 л» в описании бумаги — листы, а не литры
      if (def.unit === 'л' && paper) {
        found.push({ numeric: value, unit: 'лист', defaultName: 'количество листов', start, end, raw: match[0] });
      } else {
        found.push({ numeric: value * (def.factor ?? 1), unit: def.unit, defaultName: def.defaultName, start, end, raw: match[0] });
      }
    }
  }
  return found.sort((a, b) => a.start - b.start);
}

/** Числовые характеристики вида «80 г/м2», «не менее 8 ГБ», «16А». */
function extractNumeric(description) {
  return findMeasurements(description).map((measurement) => {
    const prefix = description.slice(Math.max(0, measurement.start - 40), measurement.start);
    const clause = prefix.split(/[,;\n(]/).pop() ?? '';
    const comparator = GE_WORDS.test(clause) ? 'ge' : LE_WORDS.test(clause) ? 'le' : 'eq';
    const name = nameBefore(clause.replace(GE_WORDS, '').replace(LE_WORDS, '')) ?? measurement.defaultName;
    const sign = comparator === 'ge' ? 'не менее ' : comparator === 'le' ? 'не более ' : '';
    return {
      name,
      value: `${sign}${formatNumber(measurement.numeric)} ${measurement.unit}`,
      numeric: measurement.numeric,
      unit: measurement.unit,
      sourceText: measurement.raw.trim(),
      comparator,
      // Сроки и гарантия описывают условия договора, а не сам товар.
      importance: /^(срок|гарантия)$/.test(name) || measurement.unit === 'мес' ? 'nice' : 'must',
      origin: 'rules',
    };
  });
}

/** Формат бумаги, типоразмеры, класс, цвет. */
function extractCategorical(description) {
  const found = [];
  const format = /(?<![a-zа-яё0-9])([AА])\s?([0-6])(?![0-9a-zа-яё])/i.exec(description);
  if (format) {
    found.push({ name: 'формат', value: `A${format[2]}`, importance: 'must', origin: 'rules' });
  }
  const size = /(?<![0-9.,])(\d+(?:[.,]\d+)?)\s?[xх×*]\s?(\d+(?:[.,]\d+)?)(?:\s?[xх×*]\s?(\d+(?:[.,]\d+)?))?/i.exec(description);
  if (size) {
    const parts = [size[1], size[2], size[3]].filter((part) => Boolean(part)).map((part) => part.replace(',', '.'));
    found.push({ name: 'типоразмер', value: parts.join('x'), importance: 'must', origin: 'rules' });
  }
  const klass = /класс(?:а|у|ом)?\s+(?:[а-яё]+\s+)?["«]?([A-ZА-Я][+]{0,3}|\d{1,2})["»]?(?![a-zа-яё])/.exec(description);
  if (klass?.[1]) {
    found.push({ name: 'класс', value: klass[1], importance: 'nice', origin: 'rules' });
  }
  const lowered = description.toLowerCase();
  const color = COLORS.find((candidate) => new RegExp(`(?<![а-яё])${candidate.slice(0, -2)}[а-яё]{2,3}(?![а-яё])`).test(lowered));
  if (color && /цвет/i.test(description)) {
    found.push({ name: 'цвет', value: color.replace(/ё/g, 'е'), importance: 'nice', origin: 'rules' });
  }
  return found;
}

/** Текстовые характеристики вида «Материал: сталь», «Тип — лазерный». */
function extractKeyValue(description, numericNames) {
  const found = [];
  for (const segment of description.split(/[\n;]+/)) {
    const match = /^\s*[-•*\d.)]*\s*([А-Яа-яЁёA-Za-z][А-Яа-яЁёA-Za-z ]{2,38}?)\s*[:—–]\s*(.{1,80})$/.exec(segment.trim());
    if (!match) continue;
    const name = (match[1] ?? '').trim().toLowerCase().replace(/ё/g, 'е');
    const value = (match[2] ?? '').trim().replace(/[.,;]+$/, '');
    if (!value || REQUEST_FIELD_NAMES.test(name) || /\d/.test(value)) continue; // числовые значения разобраны отдельно
    if (numericNames.has(name) || value.split(/\s+/).length > 5) continue;
    found.push({ name, value: value.toLowerCase(), importance: 'nice', origin: 'rules' });
  }
  return found;
}

function extractSubject(description) {
  const firstLine =
    description
      .split(/\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? '';
  let head = firstLine.replace(LEADING_FILLER, '');
  // До первого разделителя; если до запятой всего одно слово — берём и следующий фрагмент.
  const cut = head.search(/[;:(]|\s[—–-]\s|\.\s|\.$/);
  if (cut > 0) head = head.slice(0, cut);
  const parts = head
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  let subject = parts[0] ?? '';
  if (subject.split(/\s+/).length === 1 && parts[1] && !/\d/.test(parts[1]) && parts[1].split(/\s+/).length <= 3) {
    subject = `${subject} ${parts[1]}`;
  }
  // Числа с единицами и сравнения в наименование не входят.
  subject = subject
    .replace(/(?:не\s+(?:менее|более)|от|до)\s+\d[\d.,]*\s*[^\s,]*/gi, ' ')
    .replace(/\d+(?:[.,]\d+)?\s?(?:г\/м2|г\/м²|[а-яё%"]{1,6}\.?)(?=\s|$)/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const words = subject.split(' ').slice(0, 7);
  return words.join(' ') || firstLine.split(/\s+/).slice(0, 5).join(' ');
}

function extractQuantity(description) {
  const match = /(?:количеств[оае]|кол-во|в\s+количестве|объ[её]м\s+закупки)\s*[:—–-]?\s*(\d[\d  ]*(?:[.,]\d+)?)\s*([а-яё.]{1,12}(?:\s?[а-яё.]{1,4})?)?/i.exec(
    description,
  );
  if (!match) return {};
  const quantity = parseNumber(match[1] ?? '');
  if (quantity === null || quantity <= 0) return {};
  const unitText = match[2]?.trim();
  const unit = unitText && parseUnit(unitText)?.dimension !== 'unknown' ? unitText : undefined;
  return { quantity, unit };
}

function extractOkpd2(description) {
  return /(?<![0-9.])(\d{2}\.\d{2}\.\d{2}(?:\.\d{3})?)(?![0-9])/.exec(description)?.[1];
}

/** Содержимое фасовки: «пачка 500 листов», «упаковка 100 шт», «рулон 50 м». */
function extractPackContent(description, attributes) {
  const sheets = attributes.find((attribute) => attribute.unit === 'лист' && attribute.numeric);
  if (sheets?.numeric) return { value: sheets.numeric, unit: 'лист' };
  const pieces =
    /(?:упаковк[аеиу]|упак\.?|уп\.?|пачк[аеиу]|набор[еа]?|комплект[еа]?)\s*(?:из|по|-|:)?\s*(\d{1,5})\s?(?:шт|штук)/i.exec(description) ??
    /(\d{1,5})\s?(?:шт|штук)\.?\s?(?:\/|в)\s?(?:уп|упак|упаковк|пач|наб|компл)/i.exec(description);
  const count = Number(pieces?.[1]);
  if (pieces && count >= 2) return { value: count, unit: 'шт' };
  return undefined;
}

function buildQueries(subject, attributes) {
  const queries = [];
  const key = attributes
    .filter((attribute) => attribute.importance === 'must' && attribute.comparator !== 'ge' && attribute.comparator !== 'le')
    .slice(0, 2)
    .filter((attribute) => !(attribute.name === 'формат' && /[aа]\s?[0-6](?![0-9])/i.test(subject)))
    .map((attribute) => attribute.sourceText ?? attribute.value)
    .filter((value) => !normalizeText(subject).includes(normalizeText(value)));
  if (key.length > 0) queries.push(`${subject} ${key.join(' ')}`);
  queries.push(subject);
  // Короткий запрос — первые два значимых слова (без предлогов).
  const short = subject
    .split(' ')
    .filter((word) => word.length > 3 || /\d/.test(word))
    .slice(0, 2)
    .join(' ');
  if (short !== subject) queries.push(short);
  return [...new Set(queries.map((query) => query.trim()).filter(Boolean))];
}

export function buildRequirement(request) {
  const description = request.description.trim();
  const notes = [];

  const numeric = extractNumeric(description);
  const categorical = extractCategorical(description);
  const keyValue = extractKeyValue(description, new Set(numeric.map((attribute) => attribute.name)));
  const attributes = [];
  for (const attribute of [...numeric, ...categorical, ...keyValue]) {
    const duplicate = attributes.some((existing) => existing.name === attribute.name && existing.unit === attribute.unit);
    if (!duplicate) attributes.push(attribute);
  }

  const subject = extractSubject(description);
  const keywords = keywordStems(subject).filter((stemmed) => !/^[aа][0-6]$/.test(stemmed));
  if (keywords.length === 0) notes.push('Не удалось выделить наименование предмета закупки — уточните описание.');

  const parsed = extractQuantity(description);
  let quantity = request.quantity ?? parsed.quantity ?? 1;
  if (!(quantity > 0) || !Number.isFinite(quantity)) quantity = 1;
  if (request.quantity === undefined && parsed.quantity === undefined) {
    notes.push('Количество не указано — расчёт выполнен на 1 единицу.');
  }

  const unitText = request.unit?.trim() || parsed.unit;
  let unit = parseUnit(unitText) ?? DEFAULT_UNIT;
  if (!unitText) notes.push('Единица измерения не указана — принята «шт».');
  if (unit.dimension === 'unknown') {
    notes.push(`Единица измерения «${unitText}» не распознана — цены сопоставляются с ней без пересчёта.`);
    unit = { ...unit };
  }

  const okpd2 = request.okpd2?.trim() || extractOkpd2(description);
  const packContent = unit.dimension === 'pack' ? extractPackContent(description, attributes) : undefined;
  if (packContent) {
    // Фасовка учитывается пересчётом цены, а не как причина исключения.
    const index = attributes.findIndex((attribute) => attribute.unit === packContent.unit && attribute.numeric === packContent.value);
    if (index >= 0) attributes.splice(index, 1);
    notes.push(
      `Единица закупки фасованная: 1 ${unit.code} = ${packContent.value} ${packContent.unit}. Цены предложений с другой фасовкой пересчитываются пропорционально.`,
    );
  }

  return {
    subject,
    keywords,
    searchQueries: buildQueries(subject, attributes),
    okpd2: okpd2 || undefined,
    region: request.region?.trim() || undefined,
    quantity,
    unit,
    attributes,
    packContent,
    extractedBy: 'rules',
    notes,
  };
}
