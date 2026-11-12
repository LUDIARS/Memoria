#include <limits>

#include "js_number.hpp"
#include "test.hpp"

using namespace memoria::owntracks;

//期待値は Node 22 の String(x) / x.toFixed(n) の出力
TEST(js_number_to_string_vectors, "js_number: String(x) と同じ字面 (Node 22 の出力)") {
	CHECK_STR(js_number_to_string(1700000000), "1700000000");
	CHECK_STR(js_number_to_string(1700000000.5), "1700000000.5");
	CHECK_STR(js_number_to_string(0.1), "0.1");
	CHECK_STR(js_number_to_string(1e21), "1e+21");
	CHECK_STR(js_number_to_string(1e-7), "1e-7");
	CHECK_STR(js_number_to_string(123e-20), "1.23e-18");
	CHECK_STR(js_number_to_string(-5e-7), "-5e-7");
	CHECK_STR(js_number_to_string(1.5e300), "1.5e+300");
	CHECK_STR(js_number_to_string(123456789012345680000.0), "123456789012345680000");
	CHECK_STR(js_number_to_string(0.000001), "0.000001");
	CHECK_STR(js_number_to_string(-0.0), "0");
	CHECK_STR(js_number_to_string(5e-324), "5e-324");
	CHECK_STR(js_number_to_string(1.7976931348623157e308), "1.7976931348623157e+308");
	CHECK_STR(js_number_to_string(100), "100");
	CHECK_STR(js_number_to_string(std::numeric_limits<double>::infinity()), "Infinity");
}

TEST(js_to_fixed_vectors, "js_number: toFixed は正確な値で中間を大きい方へ丸める (Node 22 の出力)") {
	struct V {
		double x;
		const char* f5;
		const char* f2;
		const char* f0;
	};
	const V vs[] = {
		{ 35.66042, "35.66042", "35.66", "36" },
		{ 0.015625, "0.01563", "0.02", "0" },	//printf("%.5f") は偶数丸めで 0.01562
		{ -0.015625, "-0.01563", "-0.02", "-0" },
		{ -0.0, "0.00000", "0.00", "0" },
		{ 1.005, "1.00500", "1.00", "1" },
		{ 139.698275, "139.69827", "139.70", "140" },
		{ 180, "180.00000", "180.00", "180" },
		{ -180, "-180.00000", "-180.00", "-180" },
		{ 0.000005, "0.00001", "0.00", "0" },
		{ -0.000001, "-0.00000", "-0.00", "-0" },
		{ 89.999995, "89.99999", "90.00", "90" },
		{ 0.125, "0.12500", "0.13", "0" },
		{ 2.5, "2.50000", "2.50", "3" },
	};
	for (const V& v : vs) {
		CHECK_STR(js_to_fixed(v.x, 5), v.f5);
		CHECK_STR(js_to_fixed(v.x, 2), v.f2);
		CHECK_STR(js_to_fixed(v.x, 0), v.f0);
	}
}
