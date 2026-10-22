export default {
  post: (result: string, input: string): true | string => {
    const tags = result.match(/<[^>]*>/g) ?? [];
    for (const tag of tags) {
      if (/\son\w+\s*=|javascript:|data:/i.test(tag)) return 'active HTML in block output';
      if (!/^<\/?(?:h[1-6]|p|ul|ol|li|blockquote|pre|code|table|thead|tbody|tr|th|td|hr|br|b|i|a)(?:\s[^<>]*)?>$/.test(tag)) {
        return 'unexpected HTML element in block output';
      }
    }
    const structures: [RegExp, string][] = [
      [/^# /m, '<h1'], [/^- /m, '<ul'], [/^1\. /m, '<ol'],
      [/^> /m, '<blockquote'], [/^\| ---/m, '<table'], [/^```/m, '<pre'],
    ];
    for (const [pattern, tag] of structures) {
      if (pattern.test(input) && !result.includes(tag)) return 'Markdown block structure was lost';
    }
    return true;
  },
};
