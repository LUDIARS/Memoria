#pragma once
//OwnTracks 購読プロセスの設定。環境変数から読む (server/owntracks/config.ts と同じ名前・既定値)
#include <functional>
#include <optional>
#include <string>

namespace memoria::owntracks {

struct MqttSettings {
	std::string url;
	std::string username;	//空なら送らない
	std::string password;	//空なら送らない。ログには出さない
	std::string topic;
	std::string client_id;
};

struct OwntracksConfig {
	MqttSettings mqtt;
	std::string user_id;	//単一ユーザ前提。全レコードにこの user_id を付ける
	std::string db_path;	//解決前のまま (相対パスの基準は db_path.hpp)
};

//環境変数を 1 つ読む関数。設定されていなければ nullopt
//  TS の `??` と同じく、空文字列で設定されていれば既定値ではなく空文字列を使う
using EnvLookup = std::function<std::optional<std::string>(const char* name)>;

//プロセスの環境変数を読む EnvLookup
std::optional<std::string> process_env(const char* name);

//pid は MEMORIA_MQTT_CLIENT_ID の既定値 (memoria-owntracks-<pid>) に使う
OwntracksConfig load_owntracks_config(const EnvLookup& env, long pid);

//このプロセスの pid
long current_pid();

}
