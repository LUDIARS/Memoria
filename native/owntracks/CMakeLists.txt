#memoria-owntracks — server/owntracks-server.ts の C++ 版 (MQTT で OwnTracks の位置を受けて gps_locations へ書く)

#main() 以外はすべて静的ライブラリに入れる (テストが同じコードをリンクできるように)
add_library(memoria_owntracks_core STATIC
	src/config.cpp
	src/db_path.cpp
	src/js_number.cpp
	src/js_date.cpp
	src/utf8_decode.cpp
	src/payload.cpp
	src/haversine.cpp
	src/gps_schema.cpp
	src/gps_store.cpp
	src/location_handler.cpp
	src/shutdown_signal.cpp
	src/app.cpp
)
target_include_directories(memoria_owntracks_core PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/src)
target_link_libraries(memoria_owntracks_core PUBLIC portus::portus lapilli::sqlite)
memoria_native_target_defaults(memoria_owntracks_core)

add_executable(memoria-owntracks src/main.cpp)
target_link_libraries(memoria-owntracks PRIVATE memoria_owntracks_core)
memoria_native_target_defaults(memoria-owntracks)

if(MEMORIA_NATIVE_BUILD_TESTS)
	add_executable(memoria_owntracks_tests
		tests/main.cpp
		tests/config_test.cpp
		tests/db_path_test.cpp
		tests/js_number_test.cpp
		tests/js_date_test.cpp
		tests/utf8_decode_test.cpp
		tests/payload_test.cpp
		tests/haversine_test.cpp
		tests/gps_store_test.cpp
		tests/gps_schema_test.cpp
		tests/location_handler_test.cpp
	)
	target_link_libraries(memoria_owntracks_tests PRIVATE memoria_owntracks_core)
	memoria_native_target_defaults(memoria_owntracks_tests)
	add_test(NAME memoria_owntracks_tests COMMAND memoria_owntracks_tests)

	#実際の mosquitto と組み上げた実行ファイルを使う結合テスト。POSIX だけ (プロセスの起動に fork/exec を使う)
	#  mosquitto が無ければ 77 で終わり、ctest では「スキップ」と数える (通過とは数えない)
	if(UNIX)
		find_program(MEMORIA_MOSQUITTO_EXECUTABLE mosquitto PATHS /usr/sbin /usr/local/sbin)
		find_program(MEMORIA_MOSQUITTO_PUB_EXECUTABLE mosquitto_pub)
		find_program(MEMORIA_MOSQUITTO_PASSWD_EXECUTABLE mosquitto_passwd)
		add_executable(memoria_owntracks_e2e tests/e2e_test.cpp tests/e2e_process.cpp tests/e2e_diagnostics.cpp)
		target_link_libraries(memoria_owntracks_e2e PRIVATE lapilli::sqlite)
		memoria_native_target_defaults(memoria_owntracks_e2e)
		add_test(NAME memoria_owntracks_e2e COMMAND memoria_owntracks_e2e
			$<TARGET_FILE:memoria-owntracks>
			"${MEMORIA_MOSQUITTO_EXECUTABLE}"
			"${MEMORIA_MOSQUITTO_PUB_EXECUTABLE}"
			"${MEMORIA_MOSQUITTO_PASSWD_EXECUTABLE}"
			#作業ファイル (設定・passwd・DB・ログ) はビルドディレクトリの下に置く。システムの /tmp は
			#  ブローカーの実体によっては見えないことがある (snap の私有 /tmp など)
			"${CMAKE_CURRENT_BINARY_DIR}/e2e-work")
		set_tests_properties(memoria_owntracks_e2e PROPERTIES SKIP_RETURN_CODE 77 TIMEOUT 120)
	endif()
endif()
