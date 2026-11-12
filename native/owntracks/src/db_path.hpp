#pragma once
//MEMORIA_DB_PATH を絶対パスにする
//
//  TS 版は `resolve(<server/>, '..', dbPath.replace(/^\.\//, ''))` で、相対パスを server/ の親
//  (= リポジトリの root) から解決する。`npm run owntracks` は server/ で動くので、作業ディレクトリの
//  親を基準にすれば同じファイルになる。C++ 版も server/ を作業ディレクトリにして起動する
//  (Excubitor の catalog の memoria-server と同じ cwd)。絶対パスはそのまま (正規化だけする)
#include <string>

namespace memoria::owntracks {

//cwd と db_path は UTF-8。戻り値も UTF-8 の絶対パス (末尾の区切りは落とす。Node の path.resolve と同じ)
//  Node はその OS の規則で解決するので、こちらも std::filesystem のその OS の規則に任せる。Windows では
//  区切りが \ になり、ドライブの無い "/x" は cwd のドライブに付く (path.win32.resolve と同じ)。cwd は絶対パスを渡す。
//  Node と字面が違うのは、".." で UNC の共有の root (\\host\share\) に届くか越える場合と、ドライブ相対 ("D:x.db") だけ
//  (前者は共有の root で止まらず末尾の \ も落とす。後者は Node も環境変数に依る)。テストは両方を避けている
std::string resolve_db_path(const std::string& cwd, const std::string& db_path);

//プロセスの作業ディレクトリ (UTF-8)
std::string current_directory();

}
