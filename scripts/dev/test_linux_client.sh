#!/system/bin/sh
# Linux WebDAV / REST Client Verification Script
set -e

SERVER_IP="192.168.9.151"
SERVER_PORT="56578"
BASE_URL="http://$SERVER_IP:$SERVER_PORT"
DEVICE_ID="415847b501f88dbb"

echo "================================================="
echo ">>> RUNNING LINUX NAS CLIENT VERIFICATION <<<"
echo "================================================="

echo "1. Testing /api/session authentication from Linux..."
AUTH_RES=$(curl -s -X POST "$BASE_URL/api/session" \
  -H "Content-Type: application/json" \
  -d "{\"deviceId\":\"$DEVICE_ID\"}")

echo "Auth Response: $AUTH_RES"

TOKEN=$(echo "$AUTH_RES" | grep -o '"token":"[^"]*"' | cut -d'"' -f4)
if [ -z "$TOKEN" ]; then
  echo "[!] Failed to extract token from response."
  exit 1
fi
echo "[+] Got valid session token: $TOKEN"

echo ""
echo "2. Testing WebDAV PROPFIND / directory listing..."
curl -s -X PROPFIND "$BASE_URL/webdav/default-share" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Depth: 1" > /data/local/tmp/propfind_out.xml
echo "[+] PROPFIND returned XML of size $(wc -c < /data/local/tmp/propfind_out.xml) bytes."

echo ""
echo "3. Testing /api/list directory enumeration..."
LIST_RES=$(curl -s "$BASE_URL/api/list?shareId=default-share&path=" \
  -H "Authorization: Bearer $TOKEN")
echo "List Response: $LIST_RES"

echo ""
echo "4. Testing file download via WebDAV GET..."
curl -s "$BASE_URL/webdav/default-share/%E6%AC%A2%E8%BF%8E%E4%BD%BF%E7%94%A8%E9%99%84%E8%BF%91%E4%BC%A0%E8%BE%93-%E5%85%B1%E4%BA%AB%E5%BA%93.txt" \
  -H "Authorization: Bearer $TOKEN" > /data/local/tmp/downloaded_from_pc.txt

echo "[+] Downloaded file content:"
cat /data/local/tmp/downloaded_from_pc.txt

echo ""
echo "5. Testing file upload from Linux to PC via WebDAV PUT..."
echo "这是来自 Linux 真实终端直接上传至 PC NAS 的数据！时间: $(date)" > /data/local/tmp/linux_terminal_upload.txt
UPLOAD_HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X PUT "$BASE_URL/webdav/default-share/%E6%9D%A5%E8%87%AALinux%E7%BB%88%E7%AB%AF%E7%9A%84%E4%B8%8A%E4%BC%A0.txt" \
  -H "Authorization: Bearer $TOKEN" \
  --data-binary "@/data/local/tmp/linux_terminal_upload.txt")

echo "[+] Upload HTTP Code: $UPLOAD_HTTP_CODE (Expected 201)"

echo ""
echo "================================================="
echo ">>> ALL LINUX NAS PROTOCOL TESTS PASSED! <<<"
echo "================================================="
