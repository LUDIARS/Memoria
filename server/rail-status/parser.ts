import { HTMLElement, parse } from 'node-html-parser';
import { SOURCE_URL, type RailData, type RailLine } from './types.js';

/** Read only the full company tables; the separate disruption summary duplicates their rows. */
export function parseKantoPage(html: string): RailData {
  const root = parse(html);
  if (!root.querySelector('h1')?.text.includes('関東')) throw new Error('unexpected_page');
  const sourceUpdatedAt = root.querySelector('#main .labelLarge')?.text.match(/\d{1,2}月\d{1,2}日\s*\d{1,2}時\d{1,2}分更新/)?.[0];
  const area = root.querySelector('#mdAreaMajorLine');
  if (!area || !sourceUpdatedAt) throw new Error('missing_page_structure');
  const lines = new Map<string, RailLine>();
  let company = '';
  let groups = 0;
  let waitingForTable = false;
  for (const child of area.childNodes) {
    if (!(child instanceof HTMLElement)) continue;
    const heading = child.querySelector('h3');
    if (heading) {
      if (waitingForTable) throw new Error('missing_company_table');
      company = heading.text.trim();
      waitingForTable = true;
    }
    const table = child.querySelector('table');
    if (!table) continue;
    if (!company || !waitingForTable) throw new Error('unexpected_company_table');
    const rows = table.querySelectorAll('tr').filter(row => row.querySelector('td'));
    if (!rows.length) throw new Error('empty_company_table');
    for (const row of rows) {
      const cells = row.querySelectorAll('td');
      const link = cells[0]?.querySelector('a');
      const href = link?.getAttribute('href');
      if (cells.length !== 3 || !href || !/^\/diainfo\/\d+\/\d+$/.test(href)) throw new Error('invalid_line_row');
      const name = link?.text.trim() ?? '';
      const status = cells[1].text.trim();
      const detail = cells[2].text.trim();
      if (!name || !status || !detail) throw new Error('incomplete_line_row');
      const line = { id: href, name, company, status, detail, url: new URL(href, SOURCE_URL).href,
        disrupted: status !== '平常運転' };
      const previous = lines.get(href);
      if (previous && JSON.stringify(previous) !== JSON.stringify(line)) throw new Error('conflicting_duplicate_line');
      lines.set(href, line);
    }
    waitingForTable = false;
    groups++;
  }
  // A partial document must not replace a whole-region snapshot with a plausible short list.
  if (waitingForTable || groups < 10 || lines.size < 100) throw new Error('incomplete_region');
  return { sourceUpdatedAt, lines: [...lines.values()] };
}
