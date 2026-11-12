#pragma once
//JS の数値の文字列化を写す。ログの 1 行を TS 版と同じ字面にするため
//  (printf の %g / %.5f とは、指数表記へ切り替わる桁や、ちょうど中間の値の丸め方が違う)
#include <string>

namespace memoria::owntracks {

//String(x) / `${x}` (Number::toString)。最短で元に戻る桁、21 桁以上・1e-7 未満は指数表記
std::string js_number_to_string(double x);

//x.toFixed(digits) (digits は 0..100)。ちょうど中間は大きい方へ丸める (printf は偶数へ丸める)
//  -0 は "0.00..."、|x| >= 1e21 は String(x)
std::string js_to_fixed(double x, int digits);

}
