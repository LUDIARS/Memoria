#Memoria のネイティブ (C++17) プロセス群。Node のプロセスを 1 つずつ置き換えるための置き場
#  cmake -S native -B <build> && cmake --build <build> && ctest --test-dir <build>
#  依存は git サブモジュール (lib/portus, lib/lapilli) と、OS が配る OpenSSL / SQLite3 だけ
cmake_minimum_required(VERSION 3.16)
project(memoria_native VERSION 0.1.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

#自分がトップのときだけテストを既定で作る (取り込む側のビルドにテストを混ぜない)
if(CMAKE_SOURCE_DIR STREQUAL CMAKE_CURRENT_SOURCE_DIR)
	set(memoria_native_is_top_level ON)
else()
	set(memoria_native_is_top_level OFF)
endif()
option(MEMORIA_NATIVE_BUILD_TESTS "Build the Memoria native tests" ${memoria_native_is_top_level})

#サブモジュールの場所。別の checkout を使うときは上書きする
set(MEMORIA_PORTUS_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../lib/portus" CACHE PATH "Path to a Portus checkout (default: the lib/portus submodule)")
set(MEMORIA_LAPILLI_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../lib/lapilli" CACHE PATH "Path to a Lapilli checkout (default: the lib/lapilli submodule)")
#Lorica (社内のハードニング) は任意。パスを渡したときだけ使う (private リポなのでサブモジュールにはしない)
set(MEMORIA_LORICA_DIR "" CACHE PATH "Path to a Lorica checkout; when set, lorica_harden_target is applied to the Memoria and Lapilli targets")

#未初期化のサブモジュールは空のディレクトリとして残るので、中身の CMakeLists.txt で確かめる
foreach(dep_check IN ITEMS "MEMORIA_PORTUS_DIR;cpp/CMakeLists.txt" "MEMORIA_LAPILLI_DIR;cpp/sqlite/CMakeLists.txt")
	list(GET dep_check 0 dep_var)
	list(GET dep_check 1 dep_file)
	if(NOT EXISTS "${${dep_var}}/${dep_file}")
		message(FATAL_ERROR
			"${dep_var} (${${dep_var}}) has no ${dep_file}.\n"
			"Run `git submodule update --init lib/portus lib/lapilli` in the Memoria repository, "
			"or pass -D${dep_var}=<checkout>.")
	endif()
endforeach()

if(MEMORIA_LORICA_DIR)
	#Lorica は CMake 3.24 以上を要る。使うときだけ求める (使わないなら 3.16 のまま)
	if(CMAKE_VERSION VERSION_LESS 3.24)
		message(FATAL_ERROR "MEMORIA_LORICA_DIR needs CMake 3.24 or newer (this is ${CMAKE_VERSION})")
	endif()
	if(NOT EXISTS "${MEMORIA_LORICA_DIR}/cmake/LoricaHardening.cmake")
		message(FATAL_ERROR "MEMORIA_LORICA_DIR (${MEMORIA_LORICA_DIR}) is not a Lorica checkout")
	endif()
	#Lapilli 側の設定にも渡す (lapilli/cpp を丸ごと取り込む構成になったときにそのまま効くように)
	set(LAPILLI_LORICA_DIR "${MEMORIA_LORICA_DIR}" CACHE PATH "Forwarded from MEMORIA_LORICA_DIR" FORCE)
endif()

#Portus のテストと例は作らない (ctest に他リポのテストを混ぜない)。CMP0077 により option より通常変数が優先される
set(PORTUS_BUILD_TESTS OFF)
set(PORTUS_BUILD_EXAMPLES OFF)
add_subdirectory("${MEMORIA_PORTUS_DIR}/cpp" "${CMAKE_CURRENT_BINARY_DIR}/_deps/portus")
#パーツ 1 つだけを取り込む。直接読んだときは Lapilli のテストは作られない
add_subdirectory("${MEMORIA_LAPILLI_DIR}/cpp/sqlite" "${CMAKE_CURRENT_BINARY_DIR}/_deps/lapilli_sqlite")

if(MEMORIA_NATIVE_BUILD_TESTS)
	enable_testing()
endif()

#Memoria のターゲットに共通の警告設定。浮動小数の縮約 (FMA) を止めて、Node (V8) と同じ順序・丸めで計算させる
function(memoria_native_target_defaults target)
	if(MSVC)
		target_compile_options(${target} PRIVATE /W4 /utf-8 /fp:precise)
	else()
		target_compile_options(${target} PRIVATE -Wall -Wextra -Wpedantic -ffp-contract=off)
	endif()
	set_property(GLOBAL APPEND PROPERTY MEMORIA_NATIVE_TARGETS ${target})
endfunction()

add_subdirectory(owntracks)

if(MEMORIA_LORICA_DIR)
	#取り込む側や別の部品が先に Lorica を読んでいれば、二重に add_subdirectory しない
	if(NOT COMMAND lorica_harden_target)
		if(TARGET lorica_boundary)
			include("${MEMORIA_LORICA_DIR}/cmake/LoricaHardening.cmake")
		else()
			add_subdirectory("${MEMORIA_LORICA_DIR}" "${CMAKE_CURRENT_BINARY_DIR}/_deps/lorica")
		endif()
	endif()
	#lapilli/cpp/sqlite を直接読んだときは Lapilli 側で当たらないので、ここで当てる (Lapilli の README の手順)
	lorica_harden_target(lapilli_sqlite)
	get_property(memoria_targets GLOBAL PROPERTY MEMORIA_NATIVE_TARGETS)
	foreach(target IN LISTS memoria_targets)
		lorica_harden_target(${target})
	endforeach()
endif()
