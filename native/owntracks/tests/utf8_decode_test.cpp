#include <string>

#include "test.hpp"
#include "utf8_decode.hpp"

using namespace memoria::owntracks;

namespace {

std::string from_hex(const char* hex) {
	std::string out;
	for (const char* p = hex; p[0] && p[1]; p += 2) {
		const auto nib = [](char c) { return c <= '9' ? c - '0' : c - 'a' + 10; };
		out.push_back(static_cast<char>(nib(p[0]) * 16 + nib(p[1])));
	}
	return out;
}

}

//期待値は Node 22 の Buffer.from(bytes).toString('utf8') を UTF-8 に戻したもの
TEST(utf8_decode_vectors, "utf8_decode: 不正な並びの置き換え方が Buffer#toString('utf8') と同じ") {
	struct V {
		const char* in;
		const char* out;
	};
	const V vs[] = {
		{ "61", "61" },
		{ "ff", "efbfbd" },
		{ "c080", "efbfbdefbfbd" },
		{ "e381", "efbfbd" },
		{ "e38182", "e38182" },
		{ "eda080", "efbfbdefbfbdefbfbd" },
		{ "f09f9880", "f09f9880" },
		{ "f09f98", "efbfbd" },
		{ "f4908080", "efbfbdefbfbdefbfbdefbfbd" },
		{ "e08080", "efbfbdefbfbdefbfbd" },
		{ "c241", "efbfbd41" },
		{ "e3418182", "efbfbd41efbfbdefbfbd" },
		{ "8080", "efbfbdefbfbd" },
		{ "f09f41", "efbfbd41" },
		{ "efbbbf7b", "efbbbf7b" },	//BOM は残す
	};
	for (const V& v : vs) CHECK(decode_utf8_lossy(from_hex(v.in)) == from_hex(v.out));
}
