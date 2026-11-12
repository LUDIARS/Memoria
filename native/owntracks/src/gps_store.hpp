#pragma once
//gps_locations への 1 点の書き込み (server/db.ts の insertGpsLocation の写し)
//
//  - 同じ (user_id, IFNULL(device_id,''), recorded_at) が既にあれば書かない (skipped)
//  - 同じ系列の直近 2 行 PREV, LAST と新しい点 NEW が互いに 50m 未満なら、停止区間の続きとして
//    LAST を NEW で上書きする (merged。samples_count + 1、samples_first_at は最初の圧縮時の時刻)
//  - それ以外は INSERT (inserted)
//
//  TS 版と違い、読みから書きまでを 1 つの BEGIN IMMEDIATE で包む。同じ表へ書く Node サーバとの
//  間で、読んでから書くまでの間に別の行が入る競合を無くすため (結果は 1 プロセスで書いたときと同じ)
#include <cstdint>
#include <memory>
#include <stdexcept>
#include <string>

#include <lapilli/sqlite.hpp>

#include "gps_location.hpp"

namespace memoria::owntracks {

enum class InsertKind { skipped, merged, inserted };

struct InsertResult {
	InsertKind kind = InsertKind::inserted;
	std::int64_t id = 0;
};

const char* insert_kind_name(InsertKind kind);

//tst が Date の範囲外 (toISOString が RangeError を投げる値)。メッセージは V8 と同じ "Invalid time value"
class InvalidTimeError : public std::range_error {
public:
	InvalidTimeError() : std::range_error("Invalid time value") {}
};

class GpsStore {
public:
	//既存の DB を開く (作らない)。WAL、busy timeout 5 秒、foreign_keys ON。列が足りなければ GpsSchemaError
	static GpsStore open(const std::string& path);

	//開いた DB を受け取る (テスト用にも使う)。列を確かめ、文を準備する
	explicit GpsStore(lapilli::sqlite::Database db);
	~GpsStore();
	GpsStore(GpsStore&&) noexcept;
	GpsStore& operator=(GpsStore&&) noexcept;
	GpsStore(const GpsStore&) = delete;
	GpsStore& operator=(const GpsStore&) = delete;

	//失敗は lapilli::sqlite::Error (BUSY など) / InvalidTimeError。失敗したときは何も書かない
	InsertResult insert(const GpsLocationInput& loc);

	void close() noexcept;

private:
	struct Impl;
	std::unique_ptr<Impl> impl_;
};

}
