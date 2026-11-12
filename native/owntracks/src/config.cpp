#include "config.hpp"

#include <cstdlib>

#ifdef _WIN32
#include <process.h>
#else
#include <unistd.h>
#endif

namespace memoria::owntracks {

std::optional<std::string> process_env(const char* name) {
	const char* v = std::getenv(name);
	if (!v) return std::nullopt;
	return std::string(v);
}

long current_pid() {
#ifdef _WIN32
	return static_cast<long>(_getpid());
#else
	return static_cast<long>(getpid());
#endif
}

OwntracksConfig load_owntracks_config(const EnvLookup& env, long pid) {
	const auto get = [&](const char* name, std::string fallback) {
		std::optional<std::string> v = env(name);
		return v ? std::move(*v) : std::move(fallback);
	};
	OwntracksConfig c;
	c.mqtt.url = get("MEMORIA_MQTT_URL", "mqtt://localhost:1884");
	c.mqtt.username = get("MEMORIA_MQTT_USERNAME", "");
	c.mqtt.password = get("MEMORIA_MQTT_PASSWORD", "");
	c.mqtt.topic = get("MEMORIA_MQTT_TOPIC", "owntracks/+/+");
	c.mqtt.client_id = get("MEMORIA_MQTT_CLIENT_ID", "memoria-owntracks-" + std::to_string(pid));
	c.user_id = get("MEMORIA_USER_ID", "me");
	c.db_path = get("MEMORIA_DB_PATH", "./data/memoria.db");
	return c;
}

}
