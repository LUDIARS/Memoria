#pragma once
//SIGINT / SIGTERM を受けたことだけを記録する
//
//  シグナルハンドラの中では sig_atomic_t へ書くだけにする (ログやイベントループの操作は
//  async-signal-safe ではない)。イベントループ側がタイマーで見に来て、終了の手順を進める
namespace memoria::owntracks {

void install_shutdown_signals();

//受けたシグナル番号。まだなら 0
int pending_shutdown_signal();

//"SIGINT" / "SIGTERM" (それ以外は "signal")
const char* shutdown_signal_name(int sig);

}
