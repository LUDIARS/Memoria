let startedAt = 0;

export default {
  pre: (): true => { startedAt = performance.now(); return true; },
  post: (result: string | null, body: string): true | string => {
    if (body.length >= 256 * 1024 && performance.now() - startedAt >= 1000) return 'title scan exceeded one second';
    if (result !== null && (result.length > 200 || result !== result.trimStart() || /\s{2,}/.test(result))) return 'title normalization changed';
    if (body.length >= 256 * 1024 && body === '<title>'.repeat(Math.ceil(256 * 1024 / 7)) && result !== null) return 'unclosed title must be null';
    if (body === '<rss><TITLE lang="ja"><![CDATA[  Feed\n title  ]]></TITLE></rss>' && result !== 'Feed title') return 'CDATA title changed';
    return true;
  },
};
