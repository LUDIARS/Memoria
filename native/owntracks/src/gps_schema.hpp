#pragma once
//gps_locations が、このプロセスの SQL が触る列をすべて持っているかを確かめる
//
//  スキーマの作成と移行は Memoria の Node サーバ (server/db.ts の openDb) が持つ。このプロセスは
//  テーブルを作らず、足りなければ起動をやめる (勝手に作ると Node 側の移行と食い違うため)
#include <stdexcept>
#include <string>
#include <vector>

#include <lapilli/sqlite.hpp>

namespace memoria::owntracks {

//SQL で使う列 (gps_store.cpp の文と揃える)
const std::vector<std::string>& gps_required_columns();

//無い列 (テーブル自体が無ければ全列)
std::vector<std::string> missing_gps_columns(lapilli::sqlite::Database& db);

class GpsSchemaError : public std::runtime_error {
public:
	using std::runtime_error::runtime_error;
};

//足りなければ GpsSchemaError (何が足りないかと、Memoria サーバを一度起動して作らせるよう促す文)
void verify_gps_schema(lapilli::sqlite::Database& db);

}
