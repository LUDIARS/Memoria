#include "js_number.hpp"

#include <charconv>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <stdexcept>
#include <system_error>
#include <vector>

namespace memoria::owntracks {

std::string js_number_to_string(double x) {
	if (std::isnan(x)) return "NaN";
	if (x == 0) return "0";	//-0 も "0"
	if (std::isinf(x)) return x < 0 ? "-Infinity" : "Infinity";

	std::string sign;
	if (x < 0) {
		sign = "-";
		x = -x;
	}

	//to_chars の最短表現 (指数形式) から、仕様 (Number::toString) の k 桁の数字と指数 n を取り出す
	//  x = 0.d1d2...dk × 10^n
	char buf[64];
	const std::to_chars_result r = std::to_chars(buf, buf + sizeof(buf), x, std::chars_format::scientific);
	if (r.ec != std::errc()) throw std::runtime_error("to_chars failed");
	const std::string sci(buf, r.ptr);
	const std::size_t e = sci.find('e');
	std::string digits;
	for (std::size_t i = 0; i < e; ++i) {
		if (sci[i] != '.') digits.push_back(sci[i]);
	}
	const int k = static_cast<int>(digits.size());
	const int n = std::atoi(sci.c_str() + e + 1) + 1;

	std::string out;
	if (k <= n && n <= 21) {
		out = digits + std::string(static_cast<std::size_t>(n - k), '0');
	} else if (0 < n && n <= 21) {
		out = digits.substr(0, static_cast<std::size_t>(n)) + "." + digits.substr(static_cast<std::size_t>(n));
	} else if (-6 < n && n <= 0) {
		out = "0." + std::string(static_cast<std::size_t>(-n), '0') + digits;
	} else {
		const int exp = n - 1;
		out = digits.substr(0, 1);
		if (k > 1) out += "." + digits.substr(1);
		out += exp < 0 ? "e-" : "e+";
		out += std::to_string(exp < 0 ? -exp : exp);
	}
	return sign + out;
}

std::string js_to_fixed(double x, int digits) {
	if (digits < 0 || digits > 100) throw std::invalid_argument("toFixed digits out of range");
	if (std::isnan(x)) return "NaN";
	if (std::fabs(x) >= 1e21 || std::isinf(x)) return js_number_to_string(x);

	std::string sign;
	if (x < 0) {	//-0 は負ではない ("0.00000")
		sign = "-";
		x = -x;
	}
	if (x == 0) x = 0;	//-0 を +0 にする (%f は -0 に符号を付ける)

	//2 進の double は 10 進で有限桁に正確に展開できる (1e21 未満なら小数部は 1074 桁以内)。
	//  正確な展開を見て「中間なら大きい方」で丸める。glibc / UCRT の %f は正確な桁を出す
	std::vector<char> buf(1200);
	const int len = std::snprintf(buf.data(), buf.size(), "%.1100f", x);
	if (len <= 0 || static_cast<std::size_t>(len) >= buf.size()) throw std::runtime_error("snprintf failed");
	const std::string exact(buf.data(), static_cast<std::size_t>(len));
	const std::size_t dot = exact.find('.');

	std::string kept = exact.substr(0, dot) + exact.substr(dot + 1, static_cast<std::size_t>(digits));	//小数点なしの数字列
	const char next = exact[dot + 1 + static_cast<std::size_t>(digits)];
	if (next >= '5') {
		//繰り上げ
		std::size_t i = kept.size();
		for (;;) {
			if (i == 0) {
				kept.insert(kept.begin(), '1');
				break;
			}
			--i;
			if (kept[i] == '9') {
				kept[i] = '0';
				continue;
			}
			++kept[i];
			break;
		}
	}
	const std::size_t int_len = kept.size() - static_cast<std::size_t>(digits);
	std::string out = kept.substr(0, int_len);
	if (digits > 0) out += "." + kept.substr(int_len);
	return sign + out;
}

}
