#pragma once
//受信した MQTT メッセージ 1 件の処理 (server/owntracks/client.ts の 'message' と owntracks-server.ts の
//onLocation をまとめた流れ)
//
//  topic / payload が OwnTracks の位置でなければ黙って捨てる。位置なら DB へ書き、挿入・圧縮した
//  ときだけ 1 行ログを出す (重複で書かなかったときは出さない)。書き込みの失敗はログに残して続ける
//  (例外をイベントループへ漏らさない)。payload そのものはログに出さない
#include <string>
#include <string_view>

#include "gps_store.hpp"
#include "portus/log.hpp"

namespace memoria::owntracks {

class LocationHandler {
public:
	LocationHandler(GpsStore& store, std::string user_id, portus::Logger log);

	//MqttClient::on_message から呼ぶ。例外は投げない
	void on_message(std::string_view topic, std::string_view payload) noexcept;

private:
	GpsStore& store_;
	std::string user_id_;
	portus::Logger log_;
};

}
