#pragma once
//gps_locations へ書く 1 点分の入力 (server/db.ts の GpsLocationInput と同じ形)
#include <optional>
#include <string>

namespace memoria::owntracks {

struct GpsLocationInput {
	std::string user_id;	//空なら "me" (TS の `loc.userId || 'me'`)
	std::optional<std::string> device_id;	//nullopt は NULL。重複判定では NULL と '' を同じに扱う (IFNULL)
	std::optional<std::string> recorded_at;	//ISO 8601。空でなければこれを使い、無ければ tst から作る
	std::optional<double> tst;	//OwnTracks の epoch 秒
	double lat = 0;
	double lon = 0;
	//数値はすべて double で持ち、REAL として bind する (better-sqlite3 が JS の number を bind するのと同じ)
	//  battery_pct は INTEGER 列なので、整数値なら列の型親和性で INTEGER として格納される
	std::optional<double> accuracy;
	std::optional<double> altitude;
	std::optional<double> velocity;
	std::optional<double> course;
	std::optional<double> battery;
	std::optional<std::string> conn;
	std::optional<std::string> raw_json;
};

}
