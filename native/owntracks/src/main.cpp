//memoria-owntracks: OwnTracks の位置を MQTT で受けて Memoria の SQLite (gps_locations) へ書く常駐プロセス
//  server/owntracks-server.ts の C++ 版。server/ を作業ディレクトリにして起動する (`npm run owntracks` と同じ)
#include "app.hpp"
#include "config.hpp"
#include "db_path.hpp"
#include "portus/env.hpp"
#include "portus/log.hpp"

int main() {
	//`node --env-file-if-exists=.env.secrets` と同じファイル (作業ディレクトリの .env.secrets)。
	//  既に設定されている環境変数は上書きしない (Node と同じ)。無ければ何もしない
	portus::load_env(".env.secrets");
	portus::Logger log = portus::logger_from_env("owntracks");
	portus::install_terminate_handler(log);

	using namespace memoria::owntracks;
	const OwntracksConfig config = load_owntracks_config(process_env, current_pid());
	const int code = run_owntracks(config, current_directory(), log);
	log.flush();
	return code;
}
