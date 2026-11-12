//結合テスト: 実際の mosquitto (パスワード認証付き) と、組み上げた memoria-owntracks を起動して、
//publish した位置が gps_locations に入ること、ブローカーを再起動しても繋ぎ直して入り続けること、
//SIGTERM で (ブローカーが落ちていても) すぐ 0 で終わることを確かめる
//
//  引数: <memoria-owntracks> <mosquitto> <mosquitto_pub> <mosquitto_passwd>
//  mosquitto が無ければ 77 (ctest の SKIP_RETURN_CODE) で終わる。通過とは数えない
#include <pwd.h>
#include <unistd.h>

#include <chrono>
#include <csignal>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <functional>
#include <random>
#include <string>
#include <system_error>

#include "e2e_process.hpp"
#include "gps_fixture.hpp"

namespace fs = std::filesystem;

namespace {

constexpr int kSkip = 77;
const char* kUser = "owntracks-e2e";
const char* kPassword = "e2e-Secret-Passw0rd";

int g_failures = 0;

void fail(const std::string& what) {
	++g_failures;
	std::fprintf(stderr, "    FAILED %s\n", what.c_str());
}

std::string current_user() {
	const passwd* pw = getpwuid(getuid());
	return pw && pw->pw_name ? pw->pw_name : "root";
}

bool executable(const std::string& path) {
	return !path.empty() && access(path.c_str(), X_OK) == 0;
}

bool wait_until(int timeout_ms, const std::function<bool()>& cond) {
	const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(timeout_ms);
	while (std::chrono::steady_clock::now() < deadline) {
		if (cond()) return true;
		e2e::sleep_ms(50);
	}
	return cond();
}

std::size_t count_of(const std::string& text, const std::string& needle) {
	std::size_t n = 0;
	for (std::size_t pos = text.find(needle); pos != std::string::npos; pos = text.find(needle, pos + 1)) ++n;
	return n;
}

std::int64_t rows(const std::string& db_path) {
	try {
		lapilli::sqlite::Database db = lapilli::sqlite::Database::open(db_path, lapilli::sqlite::OpenOptions());
		lapilli::sqlite::Statement s = db.prepare("SELECT count(*) FROM gps_locations");
		return s.first([](const lapilli::sqlite::Statement& r) { return r.column_int64(0); }).value_or(-1);
	} catch (const std::exception&) {
		return -1;
	}
}

struct Env {
	std::string binary, mosquitto, mosquitto_pub, mosquitto_passwd;
	fs::path dir;
	int port = 0;
	std::string conf;
	pid_t broker = -1;
};

bool start_broker(Env& env) {
	env.broker = e2e::spawn({ { env.mosquitto, "-c", env.conf }, {}, env.dir.string(), (env.dir / "mosquitto.log").string() });
	return env.broker > 0 && wait_until(5000, [&] { return e2e::port_open(env.port); });
}

void stop_broker(Env& env) {
	e2e::stop(env.broker, SIGTERM, 5000);
	env.broker = -1;
}

bool publish(const Env& env, const std::string& topic, const std::string& payload) {
	const pid_t p = e2e::spawn({ { env.mosquitto_pub, "-h", "127.0.0.1", "-p", std::to_string(env.port), "-u", kUser, "-P", kPassword,
		"-q", "1", "-i", "e2e-pub", "-t", topic, "-m", payload }, {}, "", "" });
	return p > 0 && e2e::wait_exit(p, 5000) == 0;
}

std::vector<std::string> binary_env(const Env& env, const std::string& db_path) {
	return {
		"MEMORIA_MQTT_URL=mqtt://127.0.0.1:" + std::to_string(env.port),
		std::string("MEMORIA_MQTT_USERNAME=") + kUser,
		std::string("MEMORIA_MQTT_PASSWORD=") + kPassword,
		"MEMORIA_MQTT_CLIENT_ID=memoria-owntracks-e2e",
		"MEMORIA_DB_PATH=" + db_path,
		"LOG_LEVEL=info",
	};
}

std::string location(double lat, double lon, long tst) {
	char buf[160];
	std::snprintf(buf, sizeof(buf), R"({"_type":"location","lat":%.6f,"lon":%.6f,"tst":%ld,"batt":77,"tid":"e2"})", lat, lon, tst);
	return buf;
}

void run(Env& env) {
	//1. DB が無ければ作らずに 1 で終わる
	{
		const fs::path missing = env.dir / "missing.db";
		const std::string log = (env.dir / "missing.log").string();
		const pid_t p = e2e::spawn({ { env.binary }, binary_env(env, missing.string()), env.dir.string(), log });
		const int code = e2e::wait_exit(p, 10000);
		if (code != 1) fail("missing DB: exit code " + std::to_string(code) + " (want 1)");
		if (fs::exists(missing)) fail("missing DB: the file was created");
		if (e2e::read_file(log).find("start the Memoria server once") == std::string::npos) fail("missing DB: no hint in the log");
	}

	const std::string db = (env.dir / "memoria.db").string();
	testing::create_gps_db(db);
	const std::string log_path = (env.dir / "owntracks.log").string();
	const pid_t sub = e2e::spawn({ { env.binary }, binary_env(env, db), env.dir.string(), log_path });
	const auto log = [&] { return e2e::read_file(log_path); };
	if (!wait_until(15000, [&] { return count_of(log(), "subscribed to owntracks/+/+") >= 1; })) {
		fail("no 'subscribed' line:\n" + log());
		e2e::stop(sub, SIGKILL, 1000);
		return;
	}

	//2. 動いている 3 点は 3 行、重複と位置でないものは増えない
	const long t0 = 1700000000;
	bool ok = publish(env, "owntracks/me/phone", location(35.0, 135.0, t0)) &&
		publish(env, "owntracks/me/phone", location(35.01, 135.0, t0 + 60)) &&
		publish(env, "owntracks/me/phone", location(35.02, 135.0, t0 + 120)) &&
		publish(env, "owntracks/me/phone", location(35.02, 135.0, t0 + 120)) &&
		publish(env, "owntracks/me/phone", R"({"_type":"transition"})") &&
		publish(env, "other/me/phone", location(36.0, 135.0, t0));
	if (!ok) fail("mosquitto_pub failed");
	if (!wait_until(10000, [&] { return rows(db) == 3; })) fail("want 3 rows, got " + std::to_string(rows(db)));
	e2e::sleep_ms(300);
	if (rows(db) != 3) fail("rows changed after the duplicate: " + std::to_string(rows(db)));
	if (count_of(log(), "insert id=") != 3) fail("want 3 insert lines:\n" + log());

	//3. ブローカーを再起動しても繋ぎ直し、購読し直して受け続ける
	stop_broker(env);
	if (!wait_until(10000, [&] { return log().find("mqtt connection closed") != std::string::npos; })) fail("no 'closed' line after the broker stopped");
	e2e::sleep_ms(500);
	if (!start_broker(env)) {
		fail("cannot restart mosquitto");
	} else {
		if (!wait_until(20000, [&] { return count_of(log(), "subscribed to owntracks/+/+") >= 2; })) fail("did not resubscribe after the broker restart:\n" + log());
		if (log().find("mqtt reconnecting...") == std::string::npos) fail("no 'reconnecting' line");
		if (!publish(env, "owntracks/me/phone", location(35.03, 135.0, t0 + 180))) fail("mosquitto_pub after restart failed");
		if (!wait_until(10000, [&] { return rows(db) == 4; })) fail("want 4 rows after the restart, got " + std::to_string(rows(db)));
	}

	//4. 接続中の SIGTERM: すぐ 0 で終わる
	const auto t_stop = std::chrono::steady_clock::now();
	kill(sub, SIGTERM);
	const int code = e2e::wait_exit(sub, 5000);
	const auto stop_ms = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - t_stop).count();
	if (code != 0) {
		fail("SIGTERM while connected: exit code " + std::to_string(code));
		if (code == -1) e2e::stop(sub, SIGKILL, 1000);
	}
	std::printf("shutdown while connected: %lld ms\n", static_cast<long long>(stop_ms));
	const std::string text = log();
	if (text.find("received SIGTERM, shutting down") == std::string::npos) fail("no shutdown line");
	if (text.find(kPassword) != std::string::npos) fail("the password appears in the log");
	if (text.find("\"_type\"") != std::string::npos) fail("a raw payload appears in the log");

	//5. ブローカーが落ちているときの SIGTERM も待ち続けない
	stop_broker(env);
	{
		const std::string log2 = (env.dir / "owntracks-down.log").string();
		const pid_t p = e2e::spawn({ { env.binary }, binary_env(env, db), env.dir.string(), log2 });
		wait_until(3000, [&] { return e2e::read_file(log2).find("mqtt connection closed") != std::string::npos; });
		const auto t = std::chrono::steady_clock::now();
		kill(p, SIGTERM);
		const int c = e2e::wait_exit(p, 3000);
		const auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - t).count();
		if (c != 0) {
			fail("SIGTERM with the broker down: exit code " + std::to_string(c) + "\n" + e2e::read_file(log2));
			if (c == -1) e2e::stop(p, SIGKILL, 1000);
		}
		std::printf("shutdown with the broker down: %lld ms\n", static_cast<long long>(ms));
	}
}

}

int main(int argc, char** argv) {
	if (argc < 5) {
		std::fprintf(stderr, "usage: %s <memoria-owntracks> <mosquitto> <mosquitto_pub> <mosquitto_passwd>\n", argv[0]);
		return 2;
	}
	Env env;
	env.binary = argv[1];
	env.mosquitto = argv[2];
	env.mosquitto_pub = argv[3];
	env.mosquitto_passwd = argv[4];
	if (!executable(env.binary)) {
		std::fprintf(stderr, "memoria-owntracks not found: %s\n", env.binary.c_str());
		return 1;
	}
	for (const std::string* tool : { &env.mosquitto, &env.mosquitto_pub, &env.mosquitto_passwd }) {
		if (!executable(*tool)) {
			std::printf("SKIP: mosquitto tools are not installed (%s)\n", tool->c_str());
			return kSkip;
		}
	}

	std::random_device rd;
	char name[64];
	std::snprintf(name, sizeof(name), "memoria-owntracks-e2e-%08x%08x", rd(), rd());
	env.dir = fs::temp_directory_path() / name;
	fs::create_directories(env.dir);
	env.port = e2e::free_port();

	const std::string passwd = (env.dir / "passwd").string();
	const pid_t pw = e2e::spawn({ { env.mosquitto_passwd, "-b", "-c", passwd, kUser, kPassword }, {}, "", "" });
	if (pw <= 0 || e2e::wait_exit(pw, 10000) != 0) {
		std::fprintf(stderr, "mosquitto_passwd failed\n");
		return 1;
	}
	env.conf = (env.dir / "mosquitto.conf").string();
	{
		std::ofstream conf(env.conf);
		conf << "listener " << env.port << " 127.0.0.1\n"
			<< "allow_anonymous false\n"
			<< "password_file " << passwd << "\n"
			<< "persistence false\n"
			//root で起動すると mosquitto は既定で mosquitto ユーザへ権限を落とし、0600 の passwd を読めなくなる。
			//  起動したユーザのまま動かす
			<< "user " << current_user() << "\n";
	}
	if (!start_broker(env)) {
		std::fprintf(stderr, "mosquitto did not start:\n%s\n", e2e::read_file((env.dir / "mosquitto.log").string()).c_str());
		return 1;
	}

	run(env);
	stop_broker(env);

	if (g_failures == 0) {
		std::error_code ec;
		fs::remove_all(env.dir, ec);
		std::printf("e2e ok\n");
		return 0;
	}
	std::fprintf(stderr, "e2e failed (%d); files kept in %s\n", g_failures, env.dir.string().c_str());
	return 1;
}
