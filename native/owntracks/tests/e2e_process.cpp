#include "e2e_process.hpp"

#include <arpa/inet.h>
#include <cerrno>
#include <chrono>
#include <csignal>
#include <cstdint>
#include <fcntl.h>
#include <fstream>
#include <netinet/in.h>
#include <sstream>
#include <sys/socket.h>
#include <sys/wait.h>
#include <thread>
#include <unistd.h>

namespace e2e {

pid_t spawn(const SpawnOptions& options) {
	std::vector<char*> argv;
	for (const std::string& a : options.argv) argv.push_back(const_cast<char*>(a.c_str()));
	argv.push_back(nullptr);
	std::vector<char*> envp;
	for (const std::string& e : options.env) envp.push_back(const_cast<char*>(e.c_str()));
	envp.push_back(nullptr);

	const pid_t pid = fork();
	if (pid < 0) return -1;
	if (pid == 0) {
		//子: ここでは async-signal-safe な呼び出しだけを使う
		const char* out = options.output_file.empty() ? "/dev/null" : options.output_file.c_str();
		const int fd = open(out, O_WRONLY | O_CREAT | O_APPEND, 0600);
		if (fd >= 0) {
			dup2(fd, 1);
			dup2(fd, 2);
			close(fd);
		}
		if (!options.cwd.empty() && chdir(options.cwd.c_str()) != 0) _exit(126);
		execve(argv[0], argv.data(), envp.data());
		_exit(127);
	}
	return pid;
}

int wait_exit(pid_t pid, int timeout_ms) {
	const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(timeout_ms);
	for (;;) {
		int status = 0;
		const pid_t r = waitpid(pid, &status, WNOHANG);
		if (r == pid) {
			if (WIFEXITED(status)) return WEXITSTATUS(status);
			if (WIFSIGNALED(status)) return 128 + WTERMSIG(status);
			return -1;
		}
		if (r < 0 && errno != EINTR) return -1;
		if (std::chrono::steady_clock::now() >= deadline) return -1;
		sleep_ms(20);
	}
}

void stop(pid_t pid, int sig, int timeout_ms) {
	if (pid <= 0) return;
	kill(pid, sig);
	if (wait_exit(pid, timeout_ms) == -1) {
		kill(pid, SIGKILL);
		wait_exit(pid, 5000);
	}
}

int free_port() {
	const int fd = socket(AF_INET, SOCK_STREAM, 0);
	if (fd < 0) return -1;
	sockaddr_in addr{};
	addr.sin_family = AF_INET;
	addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
	addr.sin_port = 0;
	int port = -1;
	if (bind(fd, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) == 0) {
		socklen_t len = sizeof(addr);
		if (getsockname(fd, reinterpret_cast<sockaddr*>(&addr), &len) == 0) port = ntohs(addr.sin_port);
	}
	close(fd);
	return port;
}

bool port_open(int port) {
	const int fd = socket(AF_INET, SOCK_STREAM, 0);
	if (fd < 0) return false;
	sockaddr_in addr{};
	addr.sin_family = AF_INET;
	addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
	addr.sin_port = htons(static_cast<std::uint16_t>(port));
	const bool ok = connect(fd, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) == 0;
	close(fd);
	return ok;
}

std::string read_file(const std::string& path) {
	std::ifstream in(path, std::ios::binary);
	std::stringstream ss;
	ss << in.rdbuf();
	return ss.str();
}

void sleep_ms(int ms) {
	std::this_thread::sleep_for(std::chrono::milliseconds(ms));
}

}
