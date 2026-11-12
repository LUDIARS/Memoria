#pragma once
//依存を増やさないための最小のテスト枠 (Lapilli の cpp/sqlite/tests/test.hpp と同じ形)
#include <string>
#include <vector>

namespace testing {

struct Case {
	const char* name;
	void (*fn)();
};
std::vector<Case>& registry();
void report_failure(const char* file, int line, const std::string& what);

struct Registrar {
	Registrar(const char* name, void (*fn)()) { registry().push_back(Case{ name, fn }); }
};

//一時ディレクトリの中の、重ならない名前のファイル。破棄で本体と -wal / -shm / -journal を消す
//  ファイルは作らない
class TempPath {
public:
	TempPath();
	~TempPath();
	TempPath(const TempPath&) = delete;
	TempPath& operator=(const TempPath&) = delete;
	const std::string& str() const { return path_; }

private:
	std::string path_;
};

}

#define TEST(id, description) \
	static void test_##id(); \
	static testing::Registrar registrar_##id(description, test_##id); \
	static void test_##id()

#define CHECK(cond) \
	do { \
		if (!(cond)) testing::report_failure(__FILE__, __LINE__, #cond); \
	} while (0)

#define CHECK_EQ(a, b) \
	do { \
		if (!((a) == (b))) testing::report_failure(__FILE__, __LINE__, #a " == " #b); \
	} while (0)

//文字列どうしの比較。食い違ったら両方の値を出す
#define CHECK_STR(a, b) \
	do { \
		const std::string check_a_ = (a); \
		const std::string check_b_ = (b); \
		if (check_a_ != check_b_) testing::report_failure(__FILE__, __LINE__, #a " == " #b " (got \"" + check_a_ + "\", want \"" + check_b_ + "\")"); \
	} while (0)

#define CHECK_THROWS(expr) \
	do { \
		bool threw = false; \
		try { \
			(void)(expr); \
		} catch (...) { \
			threw = true; \
		} \
		if (!threw) testing::report_failure(__FILE__, __LINE__, "expected exception: " #expr); \
	} while (0)
