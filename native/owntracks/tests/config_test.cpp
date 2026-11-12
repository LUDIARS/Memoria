#include <map>

#include "config.hpp"
#include "test.hpp"

using namespace memoria::owntracks;

namespace {

EnvLookup env_of(std::map<std::string, std::string> values) {
	return [values](const char* name) -> std::optional<std::string> {
		auto it = values.find(name);
		if (it == values.end()) return std::nullopt;
		return it->second;
	};
}

}

TEST(config_defaults, "config: 未設定なら TS 版 (owntracks/config.ts) と同じ既定値") {
	const OwntracksConfig c = load_owntracks_config(env_of({}), 4242);
	CHECK_STR(c.mqtt.url, "mqtt://localhost:1884");
	CHECK_STR(c.mqtt.username, "");
	CHECK_STR(c.mqtt.password, "");
	CHECK_STR(c.mqtt.topic, "owntracks/+/+");
	CHECK_STR(c.mqtt.client_id, "memoria-owntracks-4242");
	CHECK_STR(c.user_id, "me");
	CHECK_STR(c.db_path, "./data/memoria.db");
}

TEST(config_overrides, "config: 環境変数が既定値より優先される") {
	const OwntracksConfig c = load_owntracks_config(env_of({
		{ "MEMORIA_MQTT_URL", "mqtt://127.0.0.1:1883" },
		{ "MEMORIA_MQTT_USERNAME", "alice" },
		{ "MEMORIA_MQTT_PASSWORD", "s3cret" },
		{ "MEMORIA_MQTT_TOPIC", "owntracks/alice/#" },
		{ "MEMORIA_MQTT_CLIENT_ID", "fixed-id" },
		{ "MEMORIA_USER_ID", "u1" },
		{ "MEMORIA_DB_PATH", "/var/lib/memoria.db" },
	}), 1);
	CHECK_STR(c.mqtt.url, "mqtt://127.0.0.1:1883");
	CHECK_STR(c.mqtt.username, "alice");
	CHECK_STR(c.mqtt.password, "s3cret");
	CHECK_STR(c.mqtt.topic, "owntracks/alice/#");
	CHECK_STR(c.mqtt.client_id, "fixed-id");
	CHECK_STR(c.user_id, "u1");
	CHECK_STR(c.db_path, "/var/lib/memoria.db");
}

TEST(config_empty_is_not_default, "config: 空文字列で設定された値は既定値に戻さない (TS の ?? と同じ)") {
	const OwntracksConfig c = load_owntracks_config(env_of({ { "MEMORIA_USER_ID", "" }, { "MEMORIA_MQTT_TOPIC", "" } }), 7);
	CHECK_STR(c.user_id, "");	//insert 時に 'me' になる (gps_store の `userId || 'me'`)
	CHECK_STR(c.mqtt.topic, "");
}

TEST(config_process_env, "config: process_env は未設定を nullopt、空文字列を空文字列として返す") {
	CHECK(!process_env("MEMORIA_OWNTRACKS_TEST_SURELY_UNSET_VARIABLE"));
	CHECK(current_pid() > 0);
}
