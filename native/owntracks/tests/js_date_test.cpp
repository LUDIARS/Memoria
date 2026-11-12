#include <limits>

#include "js_date.hpp"
#include "test.hpp"

using namespace memoria::owntracks;

namespace {

void check_iso(double tst, const char* want) {
	const std::optional<std::string> got = js_iso_string_from_epoch_seconds(tst);
	if (!want) {
		if (got) testing::report_failure(__FILE__, __LINE__, "expected Invalid time value, got " + *got);
		return;
	}
	if (!got) {
		testing::report_failure(__FILE__, __LINE__, std::string("expected ") + want + ", got Invalid time value");
		return;
	}
	CHECK_STR(*got, want);
}

}

//期待値は Node 22 の `new Date(tst * 1000).toISOString()` (nullptr は RangeError: Invalid time value)
TEST(js_date_vectors, "js_date: toISOString と同じ字面。端数は 0 方向へ切り捨て、範囲外は不正") {
	check_iso(1700000000, "2023-11-14T22:13:20.000Z");
	check_iso(0, "1970-01-01T00:00:00.000Z");
	check_iso(-1, "1969-12-31T23:59:59.000Z");
	check_iso(-1.5, "1969-12-31T23:59:58.500Z");
	check_iso(1700000000.1234, "2023-11-14T22:13:20.123Z");
	check_iso(1700000000.9999, "2023-11-14T22:13:20.999Z");	//丸めない
	check_iso(-0.0005, "1970-01-01T00:00:00.000Z");	//-0.5ms は 0 方向で 0 (floor なら 23:59:59.999)
	check_iso(-0.0004, "1970-01-01T00:00:00.000Z");
	check_iso(0.0004, "1970-01-01T00:00:00.000Z");
	check_iso(0.0005, "1970-01-01T00:00:00.000Z");
	check_iso(253402300799, "9999-12-31T23:59:59.000Z");
	check_iso(253402300800, "+010000-01-01T00:00:00.000Z");
	check_iso(-62135596800, "0001-01-01T00:00:00.000Z");
	check_iso(-62135596801, "0000-12-31T23:59:59.000Z");
	check_iso(-62198755200, "-000001-01-01T00:00:00.000Z");
	check_iso(-62198755201, "-000002-12-31T23:59:59.000Z");
	check_iso(8.64e12, "+275760-09-13T00:00:00.000Z");
	check_iso(-8.64e12, "-271821-04-20T00:00:00.000Z");
	check_iso(8.64e12 + 0.0001, "+275760-09-13T00:00:00.000Z");	//掛けた後の丸めで 8.64e15 ちょうど
	check_iso(8640000000000.0005, nullptr);
	check_iso(1e-320, "1970-01-01T00:00:00.000Z");
	check_iso(-1e-320, "1970-01-01T00:00:00.000Z");
	check_iso(1700000000.0015, "2023-11-14T22:13:20.001Z");
	check_iso(1234567890.123, "2009-02-13T23:31:30.123Z");
	check_iso(-86400.0001, "1969-12-31T00:00:00.000Z");
	check_iso(-8.64e12 - 1, nullptr);
	check_iso(5e-324, "1970-01-01T00:00:00.000Z");
	check_iso(1.7976931348623157e308, nullptr);
	check_iso(std::numeric_limits<double>::infinity(), nullptr);
	check_iso(std::numeric_limits<double>::quiet_NaN(), nullptr);
}
