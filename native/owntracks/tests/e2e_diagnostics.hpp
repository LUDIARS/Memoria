#pragma once
//結合テスト: ブローカーが起動しなかったときに、原因を CI の 1 回のログで絞れるだけの情報を stderr へ出す (POSIX だけ)
//  秘匿値は出さない (ファイルは中身ではなく大きさと権限だけを出す)
#include <string>
#include <vector>

namespace e2e {

//broker: 起動したブローカーの実行ファイル、dir: 作業ディレクトリ、files: ブローカーが読むはずのファイル
void print_broker_diagnostics(const std::string& broker, const std::string& dir, const std::vector<std::string>& files);

}
