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
std::string resolve_db_path(const std::string& cwd, const std::string& db_path);

//プロセスの作業ディレクトリ (UTF-8)
std::string current_directory();

}
