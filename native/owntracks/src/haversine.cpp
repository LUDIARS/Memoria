#include "haversine.hpp"

#include <cmath>

namespace memoria::owntracks {

namespace {

constexpr double kEarthRadiusM = 6371008;	//平均半径 (TS の R = 6_371_008)
constexpr double kPi = 3.141592653589793;	//Math.PI

double to_rad(double d) {
	return (d * kPi) / 180;
}

//Math.min(1, x): NaN は NaN のまま (std::fmin は NaN を捨てる)
double js_min_one(double x) {
	if (std::isnan(x)) return x;
	return x < 1 ? x : 1;
}

}

double gps_haversine_m(double a_lat, double a_lon, double b_lat, double b_lon) {
	const double d_lat = to_rad(b_lat - a_lat);
	const double d_lon = to_rad(b_lon - a_lon);
	const double sa = std::sin(d_lat / 2);
	const double so = std::sin(d_lon / 2);
	//JS は左から順に評価する: ((cos(a) * cos(b)) * so) * so
	const double h = sa * sa + std::cos(to_rad(a_lat)) * std::cos(to_rad(b_lat)) * so * so;
	return 2 * kEarthRadiusM * std::asin(js_min_one(std::sqrt(h)));
}

}
