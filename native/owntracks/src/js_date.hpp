#pragma once
//`new Date(tst * 1000).toISOString()` を写す (gps_locations.recorded_at の字面を TS 版と揃えるため)
//
//  - tst * 1000 を double で計算し、0 の方向へ切り捨ててミリ秒にする (Date の TimeClip)。端数は丸めない
//  - |ミリ秒| > 8.64e15 と、有限でない値は Date が Invalid Date になり toISOString が RangeError
//    ("Invalid time value") を投げる。ここでは nullopt を返す
//  - 年が 0..9999 なら 4 桁、それ以外は符号付き 6 桁 (+010000 / -000001)
#include <optional>
#include <string>

namespace memoria::owntracks {

std::optional<std::string> js_iso_string_from_epoch_seconds(double tst);

//ミリ秒 (TimeClip 済みの整数値) から。範囲外は nullopt
std::optional<std::string> js_iso_string_from_epoch_ms(double ms);

}
