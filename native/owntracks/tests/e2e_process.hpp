#pragma once
//結合テスト用の子プロセス操作 (POSIX だけ)
#include <string>
#include <sys/types.h>
#include <vector>

namespace e2e {

struct SpawnOptions {
	std::vector<std::string> argv;
	std::vector<std::string> env;	//"KEY=VALUE"。これだけを渡す (親の環境は引き継がない)
	std::string cwd;	//空なら親と同じ
	std::string output_file;	//空なら /dev/null。stdout と stderr の両方
};

//起動できなければ -1
pid_t spawn(const SpawnOptions& options);

//timeout_ms までに終われば終了コード (シグナルで終わったら 128 + 番号)。終わらなければ -1
int wait_exit(pid_t pid, int timeout_ms);

//シグナルを送り、終わるまで待つ。待ち切れなければ SIGKILL する
void stop(pid_t pid, int sig, int timeout_ms);

//空いている TCP ポート (127.0.0.1)
int free_port();

std::string read_file(const std::string& path);

//127.0.0.1:port へ TCP で繋がるか
bool port_open(int port);

void sleep_ms(int ms);

}
