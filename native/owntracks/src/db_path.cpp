#include "db_path.hpp"

#include <filesystem>

namespace memoria::owntracks {

namespace fs = std::filesystem;

std::string resolve_db_path(const std::string& cwd, const std::string& db_path) {
	//replace(/^\.\//, '') は 1 回だけ "./" を落とす。正規化で "." は消えるので結果は変わらないが、
	//  "././x" のような入力でも TS と同じ手順になるよう写しておく
	std::string p = db_path;
	if (p.compare(0, 2, "./") == 0) p.erase(0, 2);

	const fs::path given = fs::u8path(p);
	//path.resolve と同じく、字面だけで "." と ".." を畳む (シンボリックリンクは辿らない)
	fs::path out = given.is_absolute() ? given.lexically_normal() : (fs::u8path(cwd) / ".." / given).lexically_normal();
	std::string s = out.u8string();
	//Node は root 以外の末尾の区切りを残さない ("" や "." を渡すとディレクトリ名で終わる)
	while (s.size() > 1 && (s.back() == '/' || s.back() == '\\') && fs::u8path(s) != fs::u8path(s).root_path()) s.pop_back();
	return s;
}

std::string current_directory() {
	return fs::current_path().u8string();
}

}
