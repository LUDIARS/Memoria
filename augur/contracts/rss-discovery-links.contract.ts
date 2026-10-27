let startedAt = 0;

export default {
  pre: (): true => { startedAt = performance.now(); return true; },
  post: (result: { url: string; title: string | null }[], body: string): true | string => {
    if (body.length >= 256 * 1024 && performance.now() - startedAt >= 1000) return 'link scan exceeded one second';
    if (new Set(result.map((feed) => feed.url)).size !== result.length) return 'duplicate feed URL';
    if (result.some((feed) => !URL.canParse(feed.url) || (feed.title !== null && (feed.title.length > 200 || feed.title !== feed.title.trimStart())))) return 'invalid URL or title';
    if (body.length >= 256 * 1024 && body === '<link '.repeat(Math.ceil(256 * 1024 / 6)) && result.length !== 0) return 'unclosed link must be ignored';
    return true;
  },
};
