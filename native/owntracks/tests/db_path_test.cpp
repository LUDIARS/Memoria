#include "db_path.hpp"
#include "test.hpp"

using namespace memoria::owntracks;

//期待値は Node の path.resolve(cwd, '..', p.replace(/^\.\//, ''))。Node はその OS の規則で解決するので、
//  POSIX と Windows で別の期待値を持つ (Windows は path.win32.resolve で出した値。区切りは \ になり、
//  ドライブの無い "/x" は作業ディレクトリのドライブから解決する)。cwd は current_directory() と同じく絶対パスを渡す
#ifndef _WIN32

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

#else

TEST(db_path_relative_to_parent_of_cwd, "db_path: 相対パスは作業ディレクトリの親から解決 (server/ で起動すると TS と同じ <repo>\\data\\memoria.db)") {
	CHECK_STR(resolve_db_path("C:\\repo\\server", "./data/memoria.db"), "C:\\repo\\data\\memoria.db");
	CHECK_STR(resolve_db_path("C:\\repo\\server", "data/memoria.db"), "C:\\repo\\data\\memoria.db");
	CHECK_STR(resolve_db_path("C:\\repo\\server", "data\\memoria.db"), "C:\\repo\\data\\memoria.db");
	CHECK_STR(resolve_db_path("C:\\repo\\server", "././data/x.db"), "C:\\repo\\data\\x.db");
	CHECK_STR(resolve_db_path("C:\\repo\\server", "../other/x.db"), "C:\\other\\x.db");
	CHECK_STR(resolve_db_path("C:\\repo\\server\\", "data//x.db"), "C:\\repo\\data\\x.db");
	CHECK_STR(resolve_db_path("C:/repo/server", "data/x.db"), "C:\\repo\\data\\x.db");
	//ドライブ文字の大小は Node と同じく手を付けない
	CHECK_STR(resolve_db_path("c:\\repo\\server", "x.db"), "c:\\repo\\x.db");
	CHECK_STR(resolve_db_path("\\\\host\\share\\repo\\server", "data\\x.db"), "\\\\host\\share\\repo\\data\\x.db");
}

TEST(db_path_absolute, "db_path: 絶対パスはそのまま (正規化だけ)") {
	CHECK_STR(resolve_db_path("C:\\repo\\server", "D:\\var\\lib\\m.db"), "D:\\var\\lib\\m.db");
	CHECK_STR(resolve_db_path("C:\\repo\\server", "D:/var/lib/../m.db"), "D:\\var\\m.db");
	//ドライブの無い root からのパスは、作業ディレクトリのドライブに付く
	CHECK_STR(resolve_db_path("C:\\repo\\server", "/var/lib/m.db"), "C:\\var\\lib\\m.db");
	CHECK_STR(resolve_db_path("C:\\repo\\server", "\\var\\m.db"), "C:\\var\\m.db");
}

TEST(db_path_empty, "db_path: 空文字列は作業ディレクトリの親そのもの (開けずに起動を止める)") {
	CHECK_STR(resolve_db_path("C:\\repo\\server", ""), "C:\\repo");
	CHECK_STR(resolve_db_path("C:\\repo\\server", "."), "C:\\repo");
	CHECK_STR(resolve_db_path("C:\\", "x.db"), "C:\\x.db");
	CHECK_STR(resolve_db_path("C:\\", "..\\x.db"), "C:\\x.db");
}

#endif
