#include "utf8_decode.hpp"

namespace memoria::owntracks {

namespace {

const char kReplacement[] = "\xEF\xBF\xBD";

}

std::string decode_utf8_lossy(std::string_view bytes) {
	std::string out;
	out.reserve(bytes.size());

	//WHATWG の UTF-8 decoder: 残りバイト数と、次のバイトに許す範囲 (lower..upper) を持って進む
	int needed = 0;
	int seen = 0;
	unsigned lower = 0x80;
	unsigned upper = 0xBF;
	std::size_t start = 0;	//いま読んでいる文字の先頭

	std::size_t i = 0;
	while (i < bytes.size()) {
		const unsigned b = static_cast<unsigned char>(bytes[i]);
		if (needed == 0) {
			start = i;
			if (b <= 0x7F) {
				out.push_back(static_cast<char>(b));
			} else if (b >= 0xC2 && b <= 0xDF) {
				needed = 1;
			} else if (b >= 0xE0 && b <= 0xEF) {
				if (b == 0xE0) lower = 0xA0;	//冗長表現を拒む
				if (b == 0xED) upper = 0x9F;	//サロゲートを拒む
				needed = 2;
			} else if (b >= 0xF0 && b <= 0xF4) {
				if (b == 0xF0) lower = 0x90;
				if (b == 0xF4) upper = 0x8F;	//U+10FFFF を超えない
				needed = 3;
			} else {
				out += kReplacement;
			}
			++i;
			continue;
		}
		if (b < lower || b > upper) {
			//途中までの並びを 1 文字の U+FFFD にし、このバイトは読み直す (次の文字の先頭かもしれない)
			needed = seen = 0;
			lower = 0x80;
			upper = 0xBF;
			out += kReplacement;
			continue;
		}
		lower = 0x80;
		upper = 0xBF;
		++seen;
		++i;
		if (seen == needed) {
			out.append(bytes.substr(start, i - start));
			needed = seen = 0;
		}
	}
	if (needed != 0) out += kReplacement;	//途中で終わった
	return out;
}

}
