#include "db_path.hpp"
#include "test.hpp"

using namespace memoria::owntracks;

//期待値は Node の path.resolve('/repo/server', '..', p.replace(/^\.\//, '')) (POSIX)
TEST(db_path_relative_to_parent_of_cwd, "db_path: 相対パスは作業ディレクトリの親から解決 (server/ で起動すると TS と同じ <repo>/data/memoria.db)") {
	CHECK_STR(resolve_db_path("/repo/server", "./data/memoria.db"), "/repo/data/memoria.db");
	CHECK_STR(resolve_db_path("/repo/server", "data/memoria.db"), "/repo/data/memoria.db");
	CHECK_STR(resolve_db_path("/repo/server", "././data/x.db"), "/repo/data/x.db");
	CHECK_STR(resolve_db_path("/repo/server", "../other/x.db"), "/other/x.db");
	CHECK_STR(resolve_db_path("/repo/server/", "data//x.db"), "/repo/data/x.db");
}

TEST(db_path_absolute, "db_path: 絶対パスはそのまま (正規化だけ)") {
	CHECK_STR(resolve_db_path("/repo/server", "/var/lib/m.db"), "/var/lib/m.db");
	CHECK_STR(resolve_db_path("/repo/server", "/var/lib/../m.db"), "/var/m.db");
}

TEST(db_path_empty, "db_path: 空文字列は作業ディレクトリの親そのもの (開けずに起動を止める)") {
	CHECK_STR(resolve_db_path("/repo/server", ""), "/repo");
	CHECK_STR(resolve_db_path("/repo/server", "."), "/repo");
	CHECK_STR(resolve_db_path("/", "x.db"), "/x.db");
}
