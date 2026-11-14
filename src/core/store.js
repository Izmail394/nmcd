/**
 * Хранилище отчётов: один JSON-файл на расчёт. Этого достаточно, чтобы любой
 * расчёт можно было открыть, проверить и пересчитать позже.
 */
import fs from 'node:fs';
import path from 'node:path';

const ID_PATTERN = /^r\d{14}-[0-9a-f]{6}$/;

export function isReportId(id) {
  return ID_PATTERN.test(id);
}

export class ReportStore {
  dir;

  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
  }

  fileFor(id) {
    if (!isReportId(id)) throw new Error('Некорректный идентификатор отчёта');
    return path.join(this.dir, `${id}.json`);
  }

  save(report) {
    const file = this.fileFor(report.id);
    const temporary = `${file}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(report, null, 2), 'utf8');
    fs.renameSync(temporary, file);
  }

  get(id) {
    if (!isReportId(id)) return null;
    const file = this.fileFor(id);
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  }

  list(limit = 30) {
    const files = fs
      .readdirSync(this.dir)
      .filter((name) => name.endsWith('.json') && isReportId(name.slice(0, -5)))
      .sort()
      .reverse()
      .slice(0, limit);
    const summaries = [];
    for (const name of files) {
      try {
        const report = JSON.parse(fs.readFileSync(path.join(this.dir, name), 'utf8'));
        summaries.push({
          id: report.id,
          createdAt: report.createdAt,
          subject: report.requirement.subject,
          status: report.calculation.status,
          total: report.calculation.total,
          count: report.calculation.count,
        });
      } catch {
        // Повреждённый файл не должен ломать историю — он просто не показывается.
      }
    }
    return summaries;
  }
}
