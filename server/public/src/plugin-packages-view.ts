interface CatalogRelease {
  manifest: { id: string; name: string; version: string; description: string; capabilities: string[] };
  artifact: { sha256: string };
}

function status(root: HTMLElement, message: string): void {
  const element = document.createElement('p');
  element.setAttribute('role', 'status');
  element.textContent = message;
  root.replaceChildren(element);
}

export function mountPluginPackages(root: HTMLElement, refreshApps: () => Promise<void>): void {
  const details = document.createElement('details');
  const summary = document.createElement('summary');
  summary.textContent = 'アプリを取得する';
  const content = document.createElement('div');
  const refresh = document.createElement('button');
  refresh.type = 'button';
  refresh.textContent = '配信一覧を取得';
  details.append(summary, refresh, content);
  root.replaceChildren(details);
  refresh.addEventListener('click', () => { void load(); });

  async function load(): Promise<void> {
    refresh.disabled = true;
    status(content, '配信一覧を取得中…');
    try {
      const response = await fetch('/api/plugin-packages/catalog', { cache: 'no-store' });
      const body = await response.json() as { sourceOrigin?: string; releases?: CatalogRelease[]; error?: string };
      if (!response.ok) throw new Error(body.error || '一覧を取得できませんでした。');
      content.replaceChildren();
      if (body.sourceOrigin) {
        const source = document.createElement('p');
        source.textContent = `配信元: ${body.sourceOrigin}`;
        content.append(source);
      }
      for (const release of body.releases ?? []) {
        const row = document.createElement('div');
        row.className = 'userapps-package';
        const title = document.createElement('strong');
        title.textContent = `${release.manifest.name} ${release.manifest.version}`;
        const description = document.createElement('p');
        description.textContent = release.manifest.description;
        const capabilities = document.createElement('p');
        capabilities.textContent = `利用する機能: ${release.manifest.capabilities.join('、') || 'なし'}`;
        const install = document.createElement('button');
        install.type = 'button';
        install.textContent = '取得して追加';
        install.addEventListener('click', () => { void acquire(release, install); });
        row.append(title, description, capabilities, install);
        content.append(row);
      }
      if (!body.releases?.length) status(content, '配信中のアプリはありません。');
    } catch (error) { status(content, error instanceof Error ? error.message : '一覧を取得できませんでした。'); }
    finally { refresh.disabled = false; }
  }

  async function acquire(release: CatalogRelease, button: HTMLButtonElement): Promise<void> {
    if (!confirm(`${release.manifest.name} ${release.manifest.version} をこの端末で実行します。\n配布元を信頼し、表示された利用機能を確認しましたか？`)) return;
    button.disabled = true;
    button.textContent = '取得中…';
    try {
      const response = await fetch('/api/plugin-packages/install', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: release.manifest.id, version: release.manifest.version, sha256: release.artifact.sha256, trusted: true }) });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error || '取得できませんでした。');
      await refreshApps();
    } catch (error) {
      button.disabled = false;
      button.textContent = '再試行';
      const message = document.createElement('p');
      message.setAttribute('role', 'alert');
      message.textContent = error instanceof Error ? error.message : '取得できませんでした。';
      button.after(message);
    }
  }
}
