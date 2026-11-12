#include "gps_schema.hpp"

#include <algorithm>

namespace memoria::owntracks {

const std::vector<std::string>& gps_required_columns() {
	static const std::vector<std::string> columns = {
		"id", "user_id", "device_id", "recorded_at", "lat", "lon",
		"accuracy_m", "altitude_m", "velocity_kmh", "course_deg", "battery_pct", "conn", "raw_json",
		"samples_count", "samples_first_at",
	};
	return columns;
}

std::vector<std::string> missing_gps_columns(lapilli::sqlite::Database& db) {
	const std::vector<std::string> have = db.table_columns("gps_locations");
	std::vector<std::string> missing;
	for (const std::string& c : gps_required_columns()) {
		if (std::find(have.begin(), have.end(), c) == have.end()) missing.push_back(c);
	}
	return missing;
}

void verify_gps_schema(lapilli::sqlite::Database& db) {
	const std::vector<std::string> missing = missing_gps_columns(db);
	if (missing.empty()) return;
	const std::string hint = " Start the Memoria server (server/: npm start) once so that it creates and migrates the database, then start memoria-owntracks again.";
	if (missing.size() == gps_required_columns().size()) {
		throw GpsSchemaError("table gps_locations does not exist." + hint);
	}
	std::string list;
	for (const std::string& c : missing) list += (list.empty() ? "" : ", ") + c;
	throw GpsSchemaError("table gps_locations lacks column(s): " + list + "." + hint);
}

}
