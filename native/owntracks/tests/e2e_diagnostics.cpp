#include "e2e_diagnostics.hpp"

#include <climits>
#include <csignal>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <sys/stat.h>
#include <unistd.h>

#include "e2e_process.hpp"

namespace e2e {

namespace {

namespace fs = std::filesystem;

void print_stat(const std::string& path) {
	struct stat st {};
	if (lstat(path.c_str(), &st) != 0) {
		std::fprintf(stderr, "    %s: lstat failed\n", path.c_str());
		return;
	}
	std::fprintf(stderr, "    %s: mode %o uid %u gid %u size %lld readable %s\n", path.c_str(), static_cast<unsigned>(st.st_mode),
		static_cast<unsigned>(st.st_uid), static_cast<unsigned>(st.st_gid), static_cast<long long>(st.st_size),
		access(path.c_str(), R_OK) == 0 ? "yes" : "no");
}

std::string first_line(const std::string& text) {
	return text.substr(0, text.find('\n'));
}

//needle を含む行だけを出す (AppArmor のプロファイル名など)。needle が空なら全部 (1 行だけのファイル向け)
void print_matching_lines(const char* path, const std::string& needle) {
	std::ifstream in(path);
	if (!in) {
		std::fprintf(stderr, "    %s: not readable\n", path);
		return;
	}
	std::string line;
	bool any = false;
	while (std::getline(in, line)) {
		if (needle.empty() || line.find(needle) != std::string::npos) {
			std::fprintf(stderr, "    %s: %s\n", path, line.c_str());
			any = true;
		}
	}
	if (!any && needle.empty()) std::fprintf(stderr, "    %s: (empty or not readable)\n", path);
	if (!any && !needle.empty()) std::fprintf(stderr, "    %s: no line with '%s'\n", path, needle.c_str());
}

//ブローカーが実際に受ける LSM のラベル。設定ファイル無しで起動すると loopback だけで待ち受けて
//  何も読まずに動き続けるので、exec が済んだ (/proc/<pid>/exe が変わった) ところで attr/current を読む
std::string confinement_label(const std::string& broker, const std::string& dir) {
	const pid_t p = spawn({ { broker, "-p", std::to_string(free_port()) }, {}, dir, "" });
	if (p <= 0) return "(cannot spawn)";
	std::string label = "(not available)";
	const std::string proc = "/proc/" + std::to_string(p);
	for (int i = 0; i < 50; ++i) {
		char exe[PATH_MAX];
		const ssize_t n = readlink((proc + "/exe").c_str(), exe, sizeof(exe) - 1);
		char real[PATH_MAX];
		if (n > 0 && realpath(broker.c_str(), real) && std::string(exe, static_cast<std::size_t>(n)) == real) {
			const std::string text = first_line(read_file(proc + "/attr/current"));
			if (!text.empty()) label = text;
			break;
		}
		sleep_ms(20);
	}
	stop(p, SIGTERM, 2000);
	return label;
}

}

void print_broker_diagnostics(const std::vector<std::string>& brokers, const std::string& dir, const std::vector<std::string>& files) {
	std::fprintf(stderr, "--- diagnostics (broker did not start) ---\n");

	//テストのプロセス自身: 権限と umask (root では DAC を越えて読めるので、非 root の CI だけで落ちる形を見分ける)
	const mode_t mask = umask(0);
	umask(mask);
	std::fprintf(stderr, "  process: uid %u euid %u gid %u egid %u umask %03o\n", static_cast<unsigned>(getuid()),
		static_cast<unsigned>(geteuid()), static_cast<unsigned>(getgid()), static_cast<unsigned>(getegid()), static_cast<unsigned>(mask));

	//ブローカー: 実体の場所 (snap の wrapper なら /tmp は私有になる)、版、実際に掛かる LSM のラベル
	for (const std::string& broker : brokers) {
		std::fprintf(stderr, "  broker: %s\n", broker.c_str());
		print_stat(broker);
		char real[PATH_MAX];
		if (realpath(broker.c_str(), real)) {
			const std::string r = real;
			std::fprintf(stderr, "    realpath %s%s\n", real, r.find("/snap") != std::string::npos ? "  <- snap" : "");
		}
		const std::string out = (fs::path(dir) / "broker-version.txt").string();
		std::remove(out.c_str());
		const pid_t p = spawn({ { broker, "-h" }, {}, dir, out });
		if (p > 0) wait_exit(p, 5000);
		std::fprintf(stderr, "    version: %s\n", first_line(read_file(out)).c_str());
		std::fprintf(stderr, "    label: %s\n", confinement_label(broker, dir).c_str());
	}

	//作業ディレクトリとその上 (どこかが辿れなければ、ブローカーからは開けない)
	std::fprintf(stderr, "  directory and its ancestors:\n");
	for (fs::path p = fs::path(dir); ; p = p.parent_path()) {
		print_stat(p.string());
		if (p == p.root_path() || p.parent_path() == p) break;
	}

	//ブローカーが読むファイル。テスト自身と、同じ起動手順 (空の環境、同じ cwd) の別の実行ファイルで読めるかも見る。
	//  それで読めてブローカーだけが読めないなら、ブローカーに掛かった制限 (AppArmor / 名前空間) を疑う
	std::fprintf(stderr, "  files:\n");
	for (const std::string& f : files) {
		print_stat(f);
		std::fprintf(stderr, "      test process reads %zu bytes\n", read_file(f).size());
		if (access("/bin/cat", X_OK) == 0) {
			const std::string out = (fs::path(dir) / "cat-check.out").string();
			std::remove(out.c_str());
			const pid_t p = spawn({ { "/bin/cat", f }, {}, dir, out });
			const int code = p > 0 ? wait_exit(p, 5000) : -1;
			std::fprintf(stderr, "      /bin/cat (spawned like the broker) exit %d, %zu bytes\n", code, read_file(out).size());
		}
	}

	//LSM: テストのプロセスのラベルと、読み込まれている AppArmor のプロファイルのうち mosquitto に関わるもの
	std::fprintf(stderr, "  lsm:\n");
	print_matching_lines("/proc/self/attr/current", "");
	print_matching_lines("/sys/module/apparmor/parameters/enabled", "");
	print_matching_lines("/sys/kernel/security/apparmor/profiles", "mosquitto");
	//プロファイルのファイル (名前だけ)
	std::error_code ec;
	bool any = false;
	//範囲 for の ++ は失敗で例外を投げるので、error_code を取る increment で回す
	for (fs::directory_iterator it("/etc/apparmor.d", ec); !ec && it != fs::directory_iterator(); it.increment(ec)) {
		const std::string name = it->path().filename().string();
		if (name.find("mosquitto") == std::string::npos) continue;
		std::fprintf(stderr, "    /etc/apparmor.d/%s\n", name.c_str());
		any = true;
	}
	if (!any) std::fprintf(stderr, "    /etc/apparmor.d: %s\n", ec ? "not readable" : "no file with 'mosquitto'");
	std::fprintf(stderr, "--- end of diagnostics ---\n");
}

}
