#pragma once
//バイト列を UTF-8 として読み、不正な並びを U+FFFD に置き換える (Node の Buffer#toString('utf8') と同じ)
//
//  TS 版は payload.toString('utf8') した文字列を JSON.parse し、その文字列を raw_json に保存する。
//  置き換え方 (不正な並びのどこまでを 1 文字の U+FFFD にするか) は WHATWG Encoding の UTF-8 decoder に従う。
//  先頭の BOM は落とさない (Buffer#toString は残し、JSON.parse はそれを受け付けない)
#include <string>
#include <string_view>

namespace memoria::owntracks {

std::string decode_utf8_lossy(std::string_view bytes);

}
