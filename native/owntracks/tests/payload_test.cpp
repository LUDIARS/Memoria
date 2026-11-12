#include <cmath>
#include <limits>

#include "payload.hpp"
#include "test.hpp"

using namespace memoria::owntracks;

//期待値は server/owntracks/payload.ts の parseOwntracksTopic / JSON.parse + parseOwntracksLocation を
//tsx で同じ入力に通した結果

TEST(payload_topic_table, "payload: topic の受け入れ / 拒否が TS (split('/')) と同じ") {
	struct V {
		const char* topic;
		const char* user;	//nullptr は拒否
		const char* device;
	};
	const V vs[] = {
		{ "owntracks/u/d", "u", "d" },
		{ "owntracks/u/d/extra", "u", "d" },	//4 段目以降は無視
		{ "owntracks//d", nullptr, nullptr },
		{ "owntracks/u/", nullptr, nullptr },
		{ "owntracks/u", nullptr, nullptr },
		{ "/owntracks/u/d", nullptr, nullptr },
		{ "Owntracks/u/d", nullptr, nullptr },
		{ "owntracks/u/d/", "u", "d" },
		{ "x/u/d", nullptr, nullptr },
		{ u8"owntracks/日本/端末", u8"日本", u8"端末" },
		{ "", nullptr, nullptr },
	};
	for (const V& v : vs) {
		const std::optional<OwntracksTopic> t = parse_owntracks_topic(v.topic);
		if (!v.user) {
			if (t) testing::report_failure(__FILE__, __LINE__, std::string("expected reject: ") + v.topic);
			continue;
		}
		if (!t) {
			testing::report_failure(__FILE__, __LINE__, std::string("expected accept: ") + v.topic);
			continue;
		}
		CHECK_STR(t->user, v.user);
		CHECK_STR(t->device, v.device);
	}
}

namespace {

enum class Want { parse_error, reject, accept };

std::optional<OwntracksLocation> run(const std::string& payload, Want want, int line) {
	const std::optional<DecodedPayload> d = decode_owntracks_payload(payload);
	if (!d) {
		if (want != Want::parse_error) testing::report_failure(__FILE__, line, "unexpected parse error: " + payload);
		return std::nullopt;
	}
	if (want == Want::parse_error) testing::report_failure(__FILE__, line, "expected parse error: " + payload);
	std::optional<OwntracksLocation> loc = parse_owntracks_location(d->json);
	if (want == Want::accept && !loc) testing::report_failure(__FILE__, line, "expected accept: " + payload);
	if (want == Want::reject && loc) testing::report_failure(__FILE__, line, "expected reject: " + payload);
	return loc;
}

#define RUN(payload, want) run(payload, Want::want, __LINE__)

}

TEST(payload_location_table, "payload: 位置 payload の受け入れ / 拒否が TS と同じ") {
	RUN(R"({"_type":"location","lat":35.1,"lon":139.2,"tst":1700000000})", accept);
	RUN(R"({"_type":"location","lat":"35.1","lon":139.2,"tst":1700000000})", reject);
	RUN(R"({"_type":"location","lat":35.1,"lon":139.2})", reject);
	RUN(R"({"_type":"transition","lat":35.1,"lon":139.2,"tst":1700000000})", reject);
	RUN(R"({"lat":35.1,"lon":139.2,"tst":1700000000})", reject);
	RUN(R"({"_type":"location","lat":90,"lon":180,"tst":0})", accept);
	RUN(R"({"_type":"location","lat":-90,"lon":-180,"tst":-1})", accept);
	RUN(R"({"_type":"location","lat":90.0000001,"lon":0,"tst":1})", reject);
	RUN(R"({"_type":"location","lat":0,"lon":-180.0000001,"tst":1})", reject);
	//JSON.parse は桁あふれを Infinity にし、Number.isFinite で弾かれる。Portus の Json も inf になり同じく弾く
	RUN(R"({"_type":"location","lat":1e999,"lon":0,"tst":1})", reject);
	RUN(R"({"_type":"location","lat":0,"lon":0,"tst":1e999})", reject);
	RUN(R"({"_type":"location","lat":0,"lon":0,"tst":-1e400})", reject);
	//tst が Date の範囲外でも、ここでは受ける (TS も同じ。DB へ書くところで Invalid time value)
	RUN(R"({"_type":"location","lat":0,"lon":0,"tst":1e300})", accept);
	RUN(R"([{"_type":"location","lat":1,"lon":2,"tst":3}])", reject);
	RUN(R"("location")", reject);
	RUN("null", reject);
	//同じキーは後勝ち (JSON.parse と同じ)
	RUN(R"({"_type":"location","lat":1,"lon":2,"tst":3,"_type":"other"})", reject);
	RUN(R"({"_type":"other","lat":1,"lon":2,"tst":3,"_type":"location"})", accept);
	RUN(" \n{\"_type\":\"location\",\"lat\":1,\"lon\":2,\"tst\":3}\t ", accept);
	//JSON.parse が受けない字面
	RUN(R"({"_type":"location","lat":1,"lon":2,"tst":3,})", parse_error);
	RUN("\xEF\xBB\xBF{\"_type\":\"location\",\"lat\":1,\"lon\":2,\"tst\":3}", parse_error);	//BOM
	RUN(R"({"_type":"location","lat":01,"lon":2,"tst":3})", parse_error);
	RUN(R"({"_type":"location","lat":1.,"lon":2,"tst":3})", parse_error);
	RUN(R"({"_type":"location","lat":NaN,"lon":2,"tst":3})", parse_error);
	RUN("", parse_error);
}

TEST(payload_optional_fields, "payload: 任意の項目は型が合うときだけ拾う (Infinity の数値も拾う)") {
	{
		const auto loc = RUN(R"({"_type":"location","lat":35.1,"lon":139.2,"tst":1700000000,"acc":5,"alt":40.5,"batt":85,"vel":0,"cog":270,"tid":"iP","conn":"w"})", accept);
		CHECK(loc && loc->acc == 5.0 && loc->alt == 40.5 && loc->batt == 85.0 && loc->vel == 0.0 && loc->cog == 270.0);
		CHECK(loc && loc->tid == std::string("iP") && loc->conn == std::string("w"));
	}
	{
		const auto loc = RUN(R"({"_type":"location","lat":0,"lon":0,"tst":1,"acc":1e999})", accept);
		CHECK(loc && loc->acc && std::isinf(*loc->acc));
	}
	{
		const auto loc = RUN(R"({"_type":"location","lat":0,"lon":0,"tst":1,"acc":"5","batt":null,"vel":true,"tid":5,"conn":["w"]})", accept);
		CHECK(loc && !loc->acc && !loc->batt && !loc->vel && !loc->tid && !loc->conn && !loc->alt && !loc->cog);
	}
	{
		const auto loc = RUN(R"({"_type":"location","lat":-0,"lon":-0,"tst":1.5})", accept);
		CHECK(loc && loc->lat == 0 && std::signbit(loc->lat) && loc->tst == 1.5);
	}
	{
		const auto loc = RUN(R"({"_type":"location","lat":1e-400,"lon":2,"tst":3})", accept);	//下にあふれて 0
		CHECK(loc && loc->lat == 0);
	}
	{
		//対にならないサロゲートは U+FFFD (JS の文字列は D800 を持つが、better-sqlite3 が UTF-8 にするときに U+FFFD になる)
		const auto loc = RUN(R"({"_type":"location","lat":1,"lon":2,"tst":3,"conn":"\ud800"})", accept);
		CHECK(loc && loc->conn == std::string("\xEF\xBF\xBD"));
	}
}

TEST(payload_invalid_utf8, "payload: 不正な UTF-8 は U+FFFD に置き換えてから解析し、置き換え後を raw_json にする") {
	const std::string raw = "{\"_type\":\"location\",\"lat\":1,\"lon\":2,\"tst\":3,\"desc\":\"a\xFF\"}";
	const std::optional<DecodedPayload> d = decode_owntracks_payload(raw);
	CHECK(d.has_value());
	if (!d) return;
	CHECK_STR(d->text, "{\"_type\":\"location\",\"lat\":1,\"lon\":2,\"tst\":3,\"desc\":\"a\xEF\xBF\xBD\"}");
	CHECK(parse_owntracks_location(d->json).has_value());
}

TEST(payload_to_db_record, "payload: DB の 1 点へ写す (device は topic の 3 段目、user_id は設定値)") {
	OwntracksLocation loc;
	loc.lat = 35;
	loc.lon = 139;
	loc.tst = 1700000000;
	loc.acc = 5;
	loc.batt = 80;
	loc.tid = std::string("iP");
	loc.conn = std::string("m");
	const GpsLocationInput rec = location_to_db_record(OwntracksTopic{ "u", "phone" }, loc, "me", std::string("{}"));
	CHECK_STR(rec.user_id, "me");
	CHECK(rec.device_id == std::string("phone"));
	CHECK(rec.tst == 1700000000.0);
	CHECK(!rec.recorded_at);
	CHECK(rec.accuracy == 5.0 && rec.battery == 80.0 && !rec.altitude && !rec.velocity && !rec.course);
	CHECK(rec.conn == std::string("m"));
	CHECK(rec.raw_json == std::string("{}"));
}
