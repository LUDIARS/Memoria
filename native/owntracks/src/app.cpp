#include "app.hpp"

#include <cstdint>
#include <exception>
#include <memory>
#include <optional>

#include "db_path.hpp"
#include "gps_schema.hpp"
#include "gps_store.hpp"
#include "location_handler.hpp"
#include "portus/event_loop.hpp"
#include "portus/mqtt.hpp"
#include "shutdown_signal.hpp"

namespace memoria::owntracks {

namespace {

constexpr int kReconnectMs = 5000;	//TS: reconnectPeriod
constexpr int kConnectTimeoutMs = 10000;	//TS: connectTimeout
constexpr int kSignalPollMs = 100;	//シグナルを見に行く間隔 (ハンドラの中ではループを触らないため)
constexpr int kSubscribeQos = 1;

}

int run_owntracks(const OwntracksConfig& config, const std::string& cwd, portus::Logger log) {
	const std::string db_path = resolve_db_path(cwd, config.db_path);
	log.info("starting (user_id=" + config.user_id + ", db=" + db_path + ")");

	//TS 版 (openDb) と違い、DB とスキーマは作らない。無ければ Memoria サーバに作らせる
	std::optional<GpsStore> store;
	try {
		store.emplace(GpsStore::open(db_path));
	} catch (const GpsSchemaError& ex) {
		log.error(std::string("cannot use the database: ") + ex.what());	//何が足りないかと、どうすればよいかを含む
		return 1;
	} catch (const std::exception& ex) {
		log.error(std::string("cannot use the database: ") + ex.what() +
			" (memoria-owntracks does not create or migrate the schema; start the Memoria server once so that it creates " + db_path + ")");
		return 1;
	}

	portus::EventLoop loop;
	LocationHandler handler(*store, config.user_id, log);

	portus::MqttOptions mqtt_options;
	mqtt_options.url = config.mqtt.url;
	mqtt_options.client_id = config.mqtt.client_id;
	mqtt_options.username = config.mqtt.username;
	mqtt_options.password = config.mqtt.password;
	mqtt_options.reconnect_ms = kReconnectMs;
	mqtt_options.connect_timeout_ms = kConnectTimeoutMs;

	std::shared_ptr<portus::MqttClient> client;
	try {
		client = portus::MqttClient::create(loop, mqtt_options);
	} catch (const std::exception& ex) {
		//URL の誤り・password だけの指定など。パスワードの値は出さない
		log.error(std::string("invalid mqtt settings: ") + ex.what());
		return 1;
	}

	const std::string url = config.mqtt.url;
	const std::string topic = config.mqtt.topic;
	std::weak_ptr<portus::MqttClient> weak = client;
	client->on_connect = [weak, log, url, topic] {
		log.info("mqtt connected to " + url);
		std::shared_ptr<portus::MqttClient> c = weak.lock();
		if (!c) return;
		//購読は接続をまたいで残らないので、接続のたびに張り直す
		try {
			c->subscribe(topic, kSubscribeQos, [log, topic](bool ok) {
				if (ok) log.info("subscribed to " + topic);
				else log.error("subscribe failed: " + topic);
			});
		} catch (const std::exception& ex) {
			log.error(std::string("subscribe failed: ") + ex.what());
		}
	};
	client->on_reconnect = [log] { log.info("mqtt reconnecting..."); };
	client->on_close = [log] { log.info("mqtt connection closed"); };
	client->on_error = [log](const std::string& message) { log.error("mqtt error: " + message); };
	//QoS 1 の PUBACK は、この呼び出しが戻ってから送られる (TS 版と同じく、書き込みに失敗しても受領は返す)
	client->on_message = [&handler](std::string_view t, std::string_view payload) { handler.on_message(t, payload); };

	install_shutdown_signals();
	bool shutting_down = false;
	std::uint64_t signal_timer = 0;
	signal_timer = loop.set_timer(kSignalPollMs, [&] {
		const int sig = pending_shutdown_signal();
		if (sig == 0 || shutting_down) return;
		shutting_down = true;
		loop.cancel_timer(signal_timer);
		log.info(std::string("received ") + shutdown_signal_name(sig) + ", shutting down");
		//接続中なら DISCONNECT を送って閉じ、再接続をやめる。待たずに戻るので、ブローカーに届かなくても止まらない
		client->end();
		//end が積んだ後始末 (コールバックの解放) を済ませてからループを止める
		loop.post([&loop] { loop.stop(); });
	}, true);

	client->start();
	loop.run();

	client.reset();
	store->close();
	log.flush();
	return 0;
}

}
