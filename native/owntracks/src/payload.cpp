#include "payload.hpp"

#include <cmath>
#include <utility>

#include "utf8_decode.hpp"

namespace memoria::owntracks {

namespace {

//JSON.parse は入れ子の深さに実用上の上限を持たない。Portus の既定 (64) より深くしておく
//  (OwnTracks の payload は平らなので、これを超えるのは壊れた / 悪意のある入力だけ)
constexpr std::size_t kMaxJsonDepth = 256;

std::optional<double> finite_number(const portus::Json* v) {
	if (!v || !v->is_number()) return std::nullopt;
	const double d = v->as_number();
	if (!std::isfinite(d)) return std::nullopt;
	return d;
}

std::optional<double> any_number(const portus::Json* v) {
	if (!v || !v->is_number()) return std::nullopt;
	return v->as_number();
}

std::optional<std::string> any_string(const portus::Json* v) {
	if (!v || !v->is_string()) return std::nullopt;
	return v->as_string();
}

}

std::optional<OwntracksTopic> parse_owntracks_topic(std::string_view topic) {
	//String#split('/') と同じく空の段も数える ("owntracks//d" は user が空)
	std::string_view parts[3];
	std::size_t count = 0;
	std::size_t from = 0;
	for (;;) {
		const std::size_t slash = topic.find('/', from);
		const std::string_view part = topic.substr(from, slash == std::string_view::npos ? std::string_view::npos : slash - from);
		if (count < 3) parts[count] = part;
		++count;
		if (slash == std::string_view::npos) break;
		from = slash + 1;
	}
	if (count < 3) return std::nullopt;
	if (parts[0] != "owntracks") return std::nullopt;
	if (parts[1].empty() || parts[2].empty()) return std::nullopt;
	return OwntracksTopic{ std::string(parts[1]), std::string(parts[2]) };
}

std::optional<OwntracksLocation> parse_owntracks_location(const portus::Json& input) {
	if (!input.is_object()) return std::nullopt;
	const portus::Json* type = input.find("_type");
	if (!type || !type->is_string() || type->as_string() != "location") return std::nullopt;

	const std::optional<double> lat = finite_number(input.find("lat"));
	const std::optional<double> lon = finite_number(input.find("lon"));
	const std::optional<double> tst = finite_number(input.find("tst"));
	if (!lat || !lon || !tst) return std::nullopt;
	if (*lat < -90 || *lat > 90) return std::nullopt;
	if (*lon < -180 || *lon > 180) return std::nullopt;

	OwntracksLocation loc;
	loc.lat = *lat;
	loc.lon = *lon;
	loc.tst = *tst;
	loc.acc = any_number(input.find("acc"));
	loc.alt = any_number(input.find("alt"));
	loc.batt = any_number(input.find("batt"));
	loc.vel = any_number(input.find("vel"));
	loc.cog = any_number(input.find("cog"));
	loc.tid = any_string(input.find("tid"));
	loc.conn = any_string(input.find("conn"));
	return loc;
}

std::optional<DecodedPayload> decode_owntracks_payload(std::string_view payload) {
	DecodedPayload out;
	out.text = decode_utf8_lossy(payload);
	try {
		out.json = portus::Json::parse(out.text, kMaxJsonDepth);
	} catch (const portus::JsonError&) {
		return std::nullopt;
	}
	return out;
}

GpsLocationInput location_to_db_record(const OwntracksTopic& topic, const OwntracksLocation& loc, const std::string& user_id, std::optional<std::string> raw_json) {
	GpsLocationInput rec;
	rec.user_id = user_id;
	rec.device_id = topic.device;
	rec.tst = loc.tst;
	rec.lat = loc.lat;
	rec.lon = loc.lon;
	rec.accuracy = loc.acc;
	rec.altitude = loc.alt;
	rec.velocity = loc.vel;
	rec.course = loc.cog;
	rec.battery = loc.batt;
	rec.conn = loc.conn;
	rec.raw_json = std::move(raw_json);
	return rec;
}

}
