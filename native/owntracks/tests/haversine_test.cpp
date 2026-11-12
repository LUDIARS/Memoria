#include <cmath>
#include <cstdio>

#include "haversine.hpp"
#include "test.hpp"

using namespace memoria::owntracks;

//期待値は Node 22 で server/db.ts の gpsHaversine を同じ入力に通した値 (toPrecision(17))。
//  libm の sin / cos / asin は V8 (fdlibm) と最後の 1 ulp で違いうるので、1e-9 m の幅で比べる
TEST(haversine_vectors, "haversine: gpsHaversine と同じ式・定数 (Node の値と 1e-9 m 以内)") {
	struct V {
		double a_lat, a_lon, b_lat, b_lon, want;
	};
	const V vs[] = {
		{ 35, 135, 35.0001, 135, 11.119506627459018 },
		{ 35, 135, 35, 135.0001, 9.1085665853676669 },
		{ 35.66042, 139.69828, 35.66042, 139.69828, 0 },
		{ 0, 0, 0, 180, 20015111.928761799 },
		{ 90, 0, -90, 0, 20015111.928761799 },
		{ 35.681236, 139.767125, 34.702485, 135.495951, 403058.03308846569 },
		{ 51.5, -0.12, 40.7, -74.0, 5571497.7680274248 },
		{ 35, 135, 35.00045, 135, 50.037779821985410 },
	};
	for (const V& v : vs) {
		const double got = gps_haversine_m(v.a_lat, v.a_lon, v.b_lat, v.b_lon);
		if (std::fabs(got - v.want) > 1e-9) {
			char buf[160];
			std::snprintf(buf, sizeof(buf), "haversine(%g,%g,%g,%g) = %.17g, want %.17g", v.a_lat, v.a_lon, v.b_lat, v.b_lon, got, v.want);
			testing::report_failure(__FILE__, __LINE__, buf);
		}
	}
	CHECK(gps_haversine_m(35, 135, 35.00045, 135) >= kGpsStationaryThresholdM);	//50m をわずかに超える
	CHECK(std::isnan(gps_haversine_m(std::nan(""), 0, 0, 0)));	//Math.min(1, NaN) は NaN
}
