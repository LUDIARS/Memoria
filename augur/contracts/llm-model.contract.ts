export default {
  post: (result: string, provider: string, model: string): true | string => {
    const role = model.replace(/\[\d+[km]\]$/i, '');
    const context = model.slice(role.length);
    if (provider === 'claude' && ['opus', 'sonnet', 'haiku', 'fable'].includes(role)) {
      return ((result.startsWith('claude-') || (role !== 'fable' && result === model))
        && (!context || /\[\d+[km]\]$/i.test(result))) || 'Claude role or context was lost';
    }
    if (provider === 'codex' && ['astra', 'sol', 'luna'].includes(role)) {
      return (result !== model && !result.startsWith('claude-')) || 'Codex role was not resolved';
    }
    return result === model || 'Explicit model ID was changed';
  },
};
