#include "js_date.hpp"

#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>

namespace memoria::owntracks {

namespace {

constexpr double kMaxTimeMs = 8.64e15;	//ECMAScript の Date が表せる範囲 (±1 億日)
constexpr std::int64_t kMsPerDay = 86400000;

//0 方向ではなく負の無限大方向への除算 (1970 年より前の日付で日をまたがないように)
std::int64_t floor_div(std::int64_t a, std::int64_t b) {
	std::int64_t q = a / b;
	if ((a % b != 0) && ((a < 0) != (b < 0))) --q;
	return q;
}

//1970-01-01 からの日数を暦の年月日にする (先発グレゴリオ暦、H. Hinnant の civil_from_days)
void civil_from_days(std::int64_t z, std::int64_t& y, int& m, int& d) {
	z += 719468;
	const std::int64_t era = floor_div(z, 146097);
	const std::int64_t doe = z - era * 146097;
	const std::int64_t yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
	y = yoe + era * 400;
	const std::int64_t doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
	const std::int64_t mp = (5 * doy + 2) / 153;
	d = static_cast<int>(doy - (153 * mp + 2) / 5 + 1);
	m = static_cast<int>(mp < 10 ? mp + 3 : mp - 9);
	if (m <= 2) ++y;
}

}

std::optional<std::string> js_iso_string_from_epoch_ms(double ms) {
	if (!std::isfinite(ms) || std::fabs(ms) > kMaxTimeMs) return std::nullopt;
	//TimeClip: ToIntegerOrInfinity は 0 方向への切り捨て (-0.5 ms は 0)
	const std::int64_t t = static_cast<std::int64_t>(std::trunc(ms));

	const std::int64_t days = floor_div(t, kMsPerDay);
	const std::int64_t in_day = t - days * kMsPerDay;
	std::int64_t year = 0;
	int month = 0;
	int day = 0;
	civil_from_days(days, year, month, day);
	const int hh = static_cast<int>(in_day / 3600000);
	const int mi = static_cast<int>(in_day / 60000 % 60);
	const int ss = static_cast<int>(in_day / 1000 % 60);
	const int mss = static_cast<int>(in_day % 1000);

	char ybuf[32];
	if (year >= 0 && year <= 9999) {
		std::snprintf(ybuf, sizeof(ybuf), "%04lld", static_cast<long long>(year));
	} else {
		std::snprintf(ybuf, sizeof(ybuf), "%c%06lld", year < 0 ? '-' : '+', static_cast<long long>(year < 0 ? -year : year));
	}
	char buf[128];
	std::snprintf(buf, sizeof(buf), "%s-%02d-%02dT%02d:%02d:%02d.%03dZ", ybuf, month, day, hh, mi, ss, mss);
	return std::string(buf);
}

std::optional<std::string> js_iso_string_from_epoch_seconds(double tst) {
	//掛け算は JS と同じく double で行う (ここで丸まった値を切り捨てる)
	return js_iso_string_from_epoch_ms(tst * 1000);
}

}
