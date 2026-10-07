export default {
  post: (result: string[]): true | string => {
    const tools = result.indexOf('--tools');
    return (tools >= 0 && result[tools + 1] === '' && result.includes('--strict-mcp-config')
      && result.includes('--no-session-persistence') && result.includes('{"disableAllHooks":true}')) || 'summary runner must disable tools, MCP and hooks';
  },
};
