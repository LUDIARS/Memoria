#include "location_handler.hpp"

#include <exception>
#include <utility>

#include "js_number.hpp"
#include "payload.hpp"

namespace memoria::owntracks {

LocationHandler::LocationHandler(GpsStore& store, std::string user_id, portus::Logger log)
	: store_(store), user_id_(std::move(user_id)), log_(std::move(log)) {}

void LocationHandler::on_message(std::string_view topic, std::string_view payload) noexcept {
	try {
		const std::optional<OwntracksTopic> t = parse_owntracks_topic(topic);
		if (!t) return;
		std::optional<DecodedPayload> decoded = decode_owntracks_payload(payload);
		if (!decoded) return;
		const std::optional<OwntracksLocation> loc = parse_owntracks_location(decoded->json);
		if (!loc) return;

		//ここから先の失敗は TS の "location handler threw" と同じ扱い
		try {
			const GpsLocationInput rec = location_to_db_record(*t, *loc, user_id_, std::move(decoded->text));
			const InsertResult result = store_.insert(rec);
			if (result.kind == InsertKind::skipped) return;
			//TS: `insert id=${id} ${device ?? '?'} (${lat.toFixed(5)}, ${lon.toFixed(5)}) tst=${tst}`
			log_.info("insert id=" + std::to_string(result.id) + " " + rec.device_id.value_or("?") +
				" (" + js_to_fixed(rec.lat, 5) + ", " + js_to_fixed(rec.lon, 5) + ") tst=" + js_number_to_string(loc->tst));
		} catch (const std::exception& ex) {
			log_.error(std::string("location handler threw: ") + ex.what());
		}
	} catch (const std::exception& ex) {
		//解析側の想定外 (メモリ不足など)。イベントループを止めない
		log_.error(std::string("message dropped: ") + ex.what());
	} catch (...) {
		log_.error("message dropped: unknown error");
	}
}

}
