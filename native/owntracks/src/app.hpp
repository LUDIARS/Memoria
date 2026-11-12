#pragma once
//プロセス全体の組み立て: 設定 → DB → MQTT クライアント → イベントループ → 終了処理
//  (server/owntracks-server.ts の main と、server/owntracks/client.ts の接続まわり)
#include "config.hpp"
#include "portus/log.hpp"

namespace memoria::owntracks {

//SIGINT / SIGTERM で正常に終われば 0。設定・DB の不備で始められなければ 1
//  cwd は相対の MEMORIA_DB_PATH の基準 (db_path.hpp)
int run_owntracks(const OwntracksConfig& config, const std::string& cwd, portus::Logger log);

}
