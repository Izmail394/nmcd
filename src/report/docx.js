/**
 * Документ-обоснование в формате DOCX. Содержит всё, что нужно, чтобы повторить
 * расчёт вручную: описание закупки, выборку со ссылками, исключённые предложения
 * с причинами, поправки к ценам, правило отбора выбросов и формулу с числами.
 */
import {
  AlignmentType,
  Document,
  ExternalHyperlink,
  HeadingLevel,
  Packer,
  PageOrientation,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from 'docx';

import { formatMoney, formatNumber } from '../core/stats.js';

const FONT = 'Times New Roman';
const BODY = 22; // половины пункта: 11 pt
const SMALL = 18;

function text(value, options = {}) {
  return new TextRun({ text: value, font: FONT, size: options.size ?? BODY, bold: options.bold, italics: options.italics });
}

function paragraph(value, options = {}) {
  return new Paragraph({ children: [text(value, options)], alignment: options.align, spacing: { after: 100 } });
}

function heading(value) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_2,
    spacing: { before: 280, after: 120 },
    children: [new TextRun({ text: value, font: FONT, size: 26, bold: true, color: '000000' })],
  });
}

function bullet(value) {
  return new Paragraph({ children: [text(value, { size: SMALL })], bullet: { level: 0 }, spacing: { after: 40 } });
}

function isHttpUrl(value) {
  try {
    const { protocol } = new URL(value);
    return protocol === 'https:' || protocol === 'http:';
  } catch {
    return false;
  }
}

function titleCell(offer) {
  const title = new Paragraph({ children: [text(offer.raw.title, { size: SMALL })] });
  if (!isHttpUrl(offer.raw.url)) return [title];
  const link = new Paragraph({
    children: [new ExternalHyperlink({ link: offer.raw.url, children: [new TextRun({ text: offer.raw.url, font: FONT, size: 16, style: 'Hyperlink' })] })],
  });
  return [title, link];
}

function table(headers, widths, rows) {
  const toCell = (cell, index, header) =>
    new TableCell({
      width: { size: widths[index] ?? 10, type: WidthType.PERCENTAGE },
      shading: header ? { fill: 'E7EEF0' } : undefined,
      margins: { top: 50, bottom: 50, left: 70, right: 70 },
      children: typeof cell === 'string' ? [new Paragraph({ children: [text(cell, { size: SMALL, bold: header })] })] : cell,
    });
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({ tableHeader: true, children: headers.map((header, index) => toCell(header, index, true)) }),
      ...rows.map((row) => new TableRow({ children: row.map((cell, index) => toCell(cell, index, false)) })),
    ],
  });
}

function date(iso) {
  if (!iso) return '—';
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return match ? `${match[3]}.${match[2]}.${match[1]}` : iso;
}

function characteristics(offer) {
  const checks = offer.relevance?.checks ?? [];
  if (checks.length > 0) {
    return checks
      .map(
        (check) =>
          `${check.name}: ${check.found ?? 'нет данных'} (${check.verdict === 'match' ? 'соответствует' : check.verdict === 'mismatch' ? 'не соответствует' : 'не подтверждено'})`,
      )
      .join('; ');
  }
  return (
    Object.entries(offer.raw.characteristics)
      .slice(0, 6)
      .map(([name, value]) => `${name}: ${value}`)
      .join('; ') || '—'
  );
}

export async function renderDocx(report) {
  const { calculation, requirement, offers } = report;
  const included = offers.filter((offer) => offer.decision.included);
  const excluded = offers.filter((offer) => !offer.decision.included);
  const adjusted = included.filter((offer) => offer.price.adjustments.length > 0);
  const children = [];

  children.push(
    new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 80 }, children: [text('ОБОСНОВАНИЕ', { bold: true, size: 30 })] }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 80 },
      children: [text('начальной (максимальной) цены договора', { bold: true, size: 26 })],
    }),
    paragraph(`Расчёт № ${report.id} от ${date(report.createdAt)}. Метод: ${calculation.method.toLowerCase()}.`, { align: AlignmentType.CENTER, size: SMALL }),
  );

  const must = requirement.attributes.filter((attribute) => attribute.importance === 'must');
  const nice = requirement.attributes.filter((attribute) => attribute.importance !== 'must');
  const subjectRows = [
    ['Описание закупки (как введено)', report.request.description],
    ['Наименование предмета', requirement.subject],
    ['Количество', `${formatNumber(requirement.quantity, 3)} ${requirement.unit.code}`],
  ];
  if (requirement.okpd2) subjectRows.push(['Код ОКПД2', requirement.okpd2]);
  if (requirement.region) subjectRows.push(['Регион поставки', requirement.region]);
  subjectRows.push(
    ['Существенные характеристики', must.map((attribute) => `${attribute.name}: ${attribute.value}`).join('; ') || 'не выделены'],
    ['Дополнительные характеристики', nice.map((attribute) => `${attribute.name}: ${attribute.value}`).join('; ') || '—'],
    ['Поисковые запросы', requirement.searchQueries.map((query) => `«${query}»`).join(', ')],
  );
  children.push(heading('1. Предмет закупки'), table(['Показатель', 'Значение'], [28, 72], subjectRows));
  for (const note of requirement.notes) children.push(paragraph(note, { size: SMALL, italics: true }));

  children.push(heading('2. Результат'));
  if (calculation.status === 'ok' && calculation.total !== null && calculation.unitPrice !== null) {
    children.push(
      paragraph(`Начальная (максимальная) цена договора: ${formatMoney(calculation.total)} руб.`, { bold: true, size: 26 }),
      paragraph(
        `Цена за единицу: ${formatMoney(calculation.unitPrice)} руб. за 1 ${calculation.unitCode}; количество: ${formatNumber(calculation.quantity, 3)} ${calculation.unitCode}.`,
      ),
    );
  } else {
    children.push(
      paragraph('Цена не сформирована.', { bold: true, size: 26 }),
      paragraph(calculation.insufficiencyReason ?? 'Недостаточно надёжных данных для расчёта.'),
    );
  }
  if (calculation.count > 0) {
    const money = (value) => (value === null ? '—' : formatMoney(value));
    children.push(
      table(
        ['Число цен (n)', 'Минимум', 'Максимум', 'Среднее', 'Медиана', 'Ср. кв. отклонение', 'Коэфф. вариации', 'Порог'],
        [11, 12, 12, 13, 13, 15, 13, 11],
        [
          [
            String(calculation.count),
            money(calculation.min),
            money(calculation.max),
            money(calculation.mean),
            money(calculation.median),
            money(calculation.stdDev),
            calculation.cv === null ? '—' : `${formatNumber(calculation.cv)}%`,
            `${formatNumber(calculation.cvThreshold)}%`,
          ],
        ],
      ),
    );
  }
  if (calculation.formula) children.push(paragraph(`Расчёт: ${calculation.formula}`));
  children.push(
    paragraph(
      'Формулы: V = σ / <ц> × 100%; σ = √( Σ(цᵢ − <ц>)² / (n − 1) ); НМЦД = v × <ц>, где <ц> — среднее арифметическое цен за единицу, v — количество.',
      { size: SMALL },
    ),
  );
  for (const warning of calculation.warnings) children.push(paragraph(`Внимание: ${warning}`, { size: SMALL, italics: true }));
  if (report.reliability.factors.length > 0) {
    children.push(paragraph(`Оценка надёжности: ${report.reliability.level} (${report.reliability.score} из 100).`, { bold: true }));
    for (const factor of report.reliability.factors) children.push(bullet(`${factor.name}: ${factor.value} — ${factor.points} из ${factor.max}`));
  }

  children.push(
    heading(
      calculation.status === 'ok'
        ? `3. Предложения, включённые в расчёт (${included.length})`
        : `3. Сопоставимые предложения — расчёт не выполнен (${included.length})`,
    ),
  );
  if (included.length === 0) {
    children.push(paragraph('Сопоставимых предложений нет.'));
  } else {
    children.push(
      table(
        ['№', 'Источник', 'Наименование и ссылка', 'Характеристики', 'Цена в источнике', 'Цена за ед. закупки, руб.', 'Получено', 'Обоснование'],
        [4, 10, 24, 18, 10, 9, 8, 17],
        included.map((offer) => [
          String(offer.n),
          `${offer.sourceName}${offer.raw.supplier ? `; ${offer.raw.supplier}` : ''}`,
          titleCell(offer),
          characteristics(offer),
          `${formatMoney(offer.raw.priceRub)} руб. / ${offer.raw.unitText ?? 'ед. не указана'}${offer.raw.priceDate ? `; цена от ${date(offer.raw.priceDate)}` : ''}`,
          offer.price.unitPriceRub === null ? '—' : formatMoney(offer.price.unitPriceRub),
          date(offer.raw.fetchedAt),
          offer.decision.reason,
        ]),
      ),
    );
  }

  children.push(heading(`4. Исключённые предложения (${excluded.length})`));
  if (excluded.length === 0) {
    children.push(paragraph('Исключённых предложений нет.'));
  } else {
    children.push(
      table(
        ['№', 'Источник', 'Наименование и ссылка', 'Цена в источнике', 'Причина исключения'],
        [4, 12, 34, 14, 36],
        excluded.map((offer) => [
          String(offer.n),
          offer.sourceName,
          titleCell(offer),
          Number.isFinite(offer.raw.priceRub) ? `${formatMoney(offer.raw.priceRub)} руб. / ${offer.raw.unitText ?? 'ед. не указана'}` : '—',
          offer.decision.reason,
        ]),
      ),
    );
  }

  children.push(heading('5. Приведение цен к сопоставимому виду'));
  if (adjusted.length === 0) {
    children.push(paragraph('Цены включённых предложений опубликованы за единицу измерения закупки; пересчёт не потребовался.'));
  } else {
    for (const offer of adjusted) children.push(bullet(`№${offer.n}: ${offer.price.adjustments.map((adjustment) => adjustment.description).join(' ')}`));
  }

  children.push(heading('6. Исключение аномальных цен'));
  if (calculation.outlierSteps.length === 0) children.push(paragraph('Этап не выполнялся: недостаточно сопоставимых цен.'));
  for (const step of calculation.outlierSteps) {
    children.push(paragraph(step.description, { size: SMALL }));
    for (const removed of step.removed) children.push(bullet(`№${removed.n}: ${removed.why}`));
  }

  children.push(
    heading('7. Источники'),
    table(
      ['Источник', 'Адрес', 'Результат', 'Время, мс'],
      [28, 24, 38, 10],
      report.sources.map((run) => [
        run.sourceName,
        run.homepage || '—',
        run.status === 'error'
          ? `Недоступен: ${run.errorMessage ?? ''} [${run.errorKind ?? ''}]`
          : run.status === 'empty'
            ? 'Ничего не найдено'
            : `Найдено предложений: ${run.offersFound}`,
        String(run.durationMs),
      ]),
    ),
  );

  children.push(heading('8. Ход расчёта'));
  for (const step of report.trace) {
    children.push(paragraph(step.step, { bold: true }), paragraph(step.summary, { size: SMALL }));
    for (const detail of step.details ?? []) children.push(bullet(detail));
  }

  children.push(
    heading('9. Условия расчёта'),
    bullet(`Правила отбора и расчёта (снимок): ${JSON.stringify(report.rules)}`),
    bullet('Все числа получены детерминированным расчётом по правилам, указанным выше.'),
    bullet(
      `Режим данных: ${report.mode === 'replay' ? 'воспроизведение сохранённых ответов источников (даты получения — исходные)' : 'живые запросы к источникам'}. Версия сервиса: ${report.appVersion}.`,
    ),
    bullet('Документ сформирован автоматически и требует проверки специалистом: ссылок, условий поставки, НДС и применимости метода к данной закупке.'),
  );

  const document = new Document({
    creator: 'Сервис обоснования НМЦД',
    title: `Обоснование НМЦД — ${requirement.subject}`,
    sections: [
      {
        properties: { page: { size: { orientation: PageOrientation.LANDSCAPE }, margin: { top: 850, bottom: 850, left: 1000, right: 850 } } },
        children,
      },
    ],
  });
  return Packer.toBuffer(document);
}
