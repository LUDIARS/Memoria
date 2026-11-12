#pragma once
//2 点間の大円距離 (m)。server/db.ts の gpsHaversine と同じ式・定数・演算順
//  停止区間の判定 (50m 未満か) を TS 版と同じにするため、式の形を変えない
namespace memoria::owntracks {

constexpr double kGpsStationaryThresholdM = 50;	//GPS_STATIONARY_THRESHOLD_M

double gps_haversine_m(double a_lat, double a_lon, double b_lat, double b_lon);

}
