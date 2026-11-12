#pragma once
//OwnTracks の topic / payload を読む (server/owntracks/payload.ts の写し)
//
//  topic: owntracks/<user>/<device> (4 段目以降は無視する。TS の split('/') と同じ)
//  payload (_type = "location"): { lat, lon, tst, acc?, alt?, batt?, vel?, cog?, tid?, conn? }
#include <optional>
#include <string>
#include <string_view>

#include "gps_location.hpp"
#include "portus/json.hpp"

namespace memoria::owntracks {

struct OwntracksTopic {
	std::string user;
	std::string device;
};

struct OwntracksLocation {
	double lat = 0;
	double lon = 0;
	double tst = 0;	//epoch 秒
	std::optional<double> acc;	//精度 (m)
	std::optional<double> alt;	//標高 (m)
	std::optional<double> batt;	//バッテリー (%)
	std::optional<double> vel;	//速度 (km/h)
	std::optional<double> cog;	//方位 (deg)
	std::optional<std::string> tid;
	std::optional<std::string> conn;
};

//prefix 違い・段が足りない・user か device が空なら nullopt
std::optional<OwntracksTopic> parse_owntracks_topic(std::string_view topic);

//_type が "location" で、lat / lon / tst が有限の数値 (lat は -90..90、lon は -180..180) のときだけ受ける
//  任意の項目は型が合うときだけ拾う (数値なら有限でなくても拾う。JSON.parse は 1e999 を Infinity にする)
std::optional<OwntracksLocation> parse_owntracks_location(const portus::Json& input);

//JSON.parse(payload.toString('utf8')) の写し。不正な UTF-8 は U+FFFD に置き換えてから解析し、
//  置き換え後の文字列を raw_json に入れる。JSON として読めなければ nullopt
struct DecodedPayload {
	std::string text;	//置き換え後の UTF-8
	portus::Json json;
};
std::optional<DecodedPayload> decode_owntracks_payload(std::string_view payload);

//DB に書く 1 点にする
GpsLocationInput location_to_db_record(const OwntracksTopic& topic, const OwntracksLocation& loc, const std::string& user_id, std::optional<std::string> raw_json);

}
