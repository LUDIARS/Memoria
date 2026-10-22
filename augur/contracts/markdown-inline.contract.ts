export default {
  post: (result: string, input: string): true | string => {
    if (input.startsWith('<') && !result.startsWith('&lt;')) return 'raw HTML must be displayed literally';
    // Any tag outside the renderer's vocabulary indicates a raw HTML bypass.
    const stripped = result.replace(/<\/?(?:b|i|code)>|<\/a>|<a href="(?:https?:|mailto:|\/|#)[^"<>]*" rel="noopener noreferrer" target="_blank">/gi, '');
    return !/[<>]/.test(stripped) || 'inline output contains untrusted markup';
  },
};
