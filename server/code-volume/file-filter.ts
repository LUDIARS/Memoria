/**
 * 「コードを書いた行数」 に数えるファイルの判定。
 * 拡張子でソースを選び、 生成物・同梱ライブラリ・ロックファイルの置き場は外す。
 */

const CODE_EXT = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|cs|c|cc|cpp|cxx|h|hh|hpp|inl|rs|go|py|rb|php|java|kt|swift|lua|gd|glsl|hlsl|wgsl|shader|compute|vert|frag|vue|svelte|css|scss|html|sh|ps1|sql)$/i;

// 生成レポート (report/)・成果物の保管 (artifacts/)・同梱 SDK (sdk/) も手で書いた行ではないので外す
const SKIP_PATH = /(^|\/)(node_modules|dist|build|out|vendor|third_party|ThirdParty|Plugins|generated|Library|Packages|\.next|reports?|artifacts|sdk)\//;
const SKIP_NAME = /\.min\.(js|css)$|\.(g|generated|designer)\.cs$/i;

export function isCodeFile(path: string): boolean {
  const p = path.replace(/\\/g, '/');
  return CODE_EXT.test(p) && !SKIP_PATH.test(p) && !SKIP_NAME.test(p);
}
