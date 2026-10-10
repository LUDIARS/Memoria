// 日記詳細パネルの「外部節」 (外部サービスが書いた節。例: Concordia のデイリーゴールのまとめ)。
// 表示と削除だけを持ち、 編集 UI は持たない。 Spec: spec/feature/diary.md
import { renderMarkdownBlock } from './markdown-block.js';

interface DiarySection { date: string; source: string; title: string; markdown: string; updated_at: string }

let currentDate = '';

function render(date: string, items: DiarySection[]): void {
  const root = document.getElementById('diarySections');
  if (!root || date !== currentDate) return;
  root.replaceChildren();
  root.hidden = items.length === 0;
  for (const section of items) {
    const box = document.createElement('section'), head = document.createElement('div');
    const title = document.createElement('h4'), meta = document.createElement('span'), remove = document.createElement('button');
    const body = document.createElement('div');
    box.className = 'diary-section';
    head.className = 'diary-section-head';
    title.textContent = section.title;
    meta.className = 'diary-section-meta';
    meta.textContent = `${section.source} · ${section.updated_at}`;
    remove.type = 'button';
    remove.textContent = '削除';
    remove.addEventListener('click', () => void removeSection(section));
    // renderMarkdownBlock escapes the source before building markup.
    body.className = 'diary-section-body md-block';
    body.innerHTML = renderMarkdownBlock(section.markdown);
    head.append(title, meta, remove);
    box.append(head, body);
    root.append(box);
  }
}

async function removeSection(section: DiarySection): Promise<void> {
  if (!window.confirm(`「${section.title}」 (${section.source}) を削除しますか?`)) return;
  const response = await fetch(`/api/diary/${section.date}/sections/${encodeURIComponent(section.source)}`, { method: 'DELETE' });
  if (!response.ok && response.status !== 404) {
    window.alert(`外部節の削除に失敗しました (HTTP ${response.status})`);
    return;
  }
  await loadDiarySections(section.date);
}

export async function loadDiarySections(date: string): Promise<void> {
  currentDate = date;
  try {
    const response = await fetch(`/api/diary/${date}/sections`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json() as { items: DiarySection[] };
    render(date, body.items);
  } catch {
    // The rest of the diary panel stays usable when sections cannot be read.
    render(date, []);
  }
}
