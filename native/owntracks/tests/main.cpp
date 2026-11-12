#include <atomic>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <exception>
#include <filesystem>
#include <random>
#include <system_error>

#include "test.hpp"

namespace testing {

static std::atomic<int> g_failures{0};

std::vector<Case>& registry() {
	static std::vector<Case> cases;
	return cases;
}

void report_failure(const char* file, int line, const std::string& what) {
	++g_failures;
	std::fprintf(stderr, "    FAILED %s:%d  %s\n", file, line, what.c_str());
}

//プロセス id を使わずに重ならない名前を作る (乱数 + 時刻でプロセス間を、連番でプロセス内を分ける)
static std::string unique_name() {
	static std::atomic<unsigned> counter{0};
	static const unsigned long long seed = [] {
		std::random_device rd;
		return (static_cast<unsigned long long>(rd()) << 32) ^ static_cast<unsigned long long>(rd()) ^
			static_cast<unsigned long long>(std::chrono::steady_clock::now().time_since_epoch().count());
	}();
	char buf[64];
	std::snprintf(buf, sizeof(buf), "memoria-owntracks-%016llx-%u.db", seed, counter.fetch_add(1));
	return buf;
}

TempPath::TempPath() : path_((std::filesystem::temp_directory_path() / unique_name()).string()) {}

TempPath::~TempPath() {
	std::error_code ec;
	for (const char* suffix : { "", "-wal", "-shm", "-journal" }) std::filesystem::remove(path_ + suffix, ec);
}

}

int main(int argc, char** argv) {
	const char* filter = argc > 1 ? argv[1] : nullptr;
	int ran = 0;
	int failed_cases = 0;
	for (const testing::Case& c : testing::registry()) {
		if (filter && !std::strstr(c.name, filter)) continue;
		const int before = testing::g_failures.load();
		try {
			c.fn();
		} catch (const std::exception& ex) {
			testing::report_failure(__FILE__, __LINE__, std::string("unexpected exception: ") + ex.what());
		} catch (...) {
			testing::report_failure(__FILE__, __LINE__, "unexpected exception");
		}
		const bool ok = testing::g_failures.load() == before;
		std::printf("%s %s\n", ok ? "ok  " : "FAIL", c.name);
		std::fflush(stdout);
		++ran;
		if (!ok) ++failed_cases;
	}
	std::printf("\n%d tests, %d failed\n", ran, failed_cases);
	return failed_cases == 0 && ran > 0 ? 0 : 1;
}
