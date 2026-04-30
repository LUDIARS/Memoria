#!/usr/bin/env bash
# Memoria mosquitto: passwd + acl を初期生成する。
#
# 用途:
#   1. OwnTracks (publisher) 用ユーザを 1 つ作る (既定 'me')
#   2. Memoria subscriber 用ユーザを 1 つ作る (既定 'memoria-sub')
#
# 使い方:
#   ./setup-passwd.sh                      # 対話式で password を聞く
#   ./setup-passwd.sh me PASS1 sub PASS2   # 直接渡す (CI 等)
#
# 既存の passwd / acl を上書きする (バックアップは取らない)。
#
# Cygwin / Git Bash でも動く想定。 docker 経由で mosquitto_passwd を呼ぶので
# ホストに mosquitto をインストールしていなくても動く。

set -euo pipefail

cd "$(dirname "$0")"

PUB_USER="${1:-me}"
PUB_PASS="${2:-}"
SUB_USER="${3:-memoria-sub}"
SUB_PASS="${4:-}"

if [ -z "$PUB_PASS" ]; then
  read -srp "Publisher (${PUB_USER}) のパスワード: " PUB_PASS; echo
fi
if [ -z "$SUB_PASS" ]; then
  read -srp "Subscriber (${SUB_USER}) のパスワード: " SUB_PASS; echo
fi

# mosquitto_passwd 内蔵のため eclipse-mosquitto コンテナを使う
docker run --rm -i --entrypoint sh \
  -v "$PWD:/work" \
  eclipse-mosquitto:2.0 -c "
    : > /work/passwd
    mosquitto_passwd -b /work/passwd '${PUB_USER}' '${PUB_PASS}'
    mosquitto_passwd -b /work/passwd '${SUB_USER}' '${SUB_PASS}'
  "

cat > acl <<EOF
# Memoria mosquitto ACL
# Publisher (端末): 自分の topic prefix に publish のみ
user ${PUB_USER}
topic readwrite owntracks/${PUB_USER}/#

# Subscriber (Memoria server): 全 owntracks 配下 read
user ${SUB_USER}
topic read owntracks/+/+
topic read owntracks/+/+/+
EOF

echo "✅ passwd / acl を生成しました。"
echo "   - publisher:  ${PUB_USER}"
echo "   - subscriber: ${SUB_USER}"
echo "   docker compose restart mosquitto で反映してください。"
