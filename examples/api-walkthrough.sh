#!/usr/bin/env bash
# End-to-end walkthrough of the HTTP API with curl.
# Requires: a running server (npm start) and `node` (used to parse JSON).
# Usage: BASE_URL=http://127.0.0.1:4000 ./examples/api-walkthrough.sh
set -euo pipefail

BASE_URL="${BASE_URL:-http://127.0.0.1:4000}"
SUFFIX="$(date +%s)"
json() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const v=JSON.parse(s);console.log(eval('v.'+process.argv[1]))})" "$1"; }

echo "== health"
curl -sf "$BASE_URL/healthz"; echo

echo "== register"
REGISTER=$(curl -sf -X POST "$BASE_URL/api/auth/register" -H 'Content-Type: application/json' \
  -d "{\"email\":\"walker$SUFFIX@example.test\",\"username\":\"walker$SUFFIX\",\"displayName\":\"Walker\",\"password\":\"walkthrough-pass-1\"}")
TOKEN=$(echo "$REGISTER" | json data.accessToken)
REFRESH=$(echo "$REGISTER" | json data.refreshToken)
echo "access token: ${TOKEN:0:24}…"

echo "== login"
curl -sf -X POST "$BASE_URL/api/auth/login" -H 'Content-Type: application/json' \
  -d "{\"login\":\"walker$SUFFIX\",\"password\":\"walkthrough-pass-1\"}" | json data.user.username

echo "== create workspace"
WS=$(curl -sf -X POST "$BASE_URL/api/workspaces" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"Walkthrough","description":"created by api-walkthrough.sh"}' | json data.id)
echo "workspace: $WS"

echo "== create document"
DOC=$(curl -sf -X POST "$BASE_URL/api/workspaces/$WS/documents" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"title":"Walkthrough notes","content":"Searchable walkthrough content."}' | json data.id)
echo "document: $DOC"

echo "== comment, task, version"
curl -sf -X POST "$BASE_URL/api/documents/$DOC/comments" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"body":"First comment"}' | json data.id
curl -sf -X POST "$BASE_URL/api/workspaces/$WS/tasks" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"title\":\"Review walkthrough\",\"priority\":\"high\",\"labels\":[\"docs\"],\"documentId\":\"$DOC\"}" | json data.status
curl -sf -X POST "$BASE_URL/api/documents/$DOC/versions" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"label":"Initial"}' | json data.label

echo "== search"
curl -sf "$BASE_URL/api/search?q=walkthrough" -H "Authorization: Bearer $TOKEN" | json 'data.map(h=>h.type+":"+h.title).join(", ")'

echo "== activity"
curl -sf "$BASE_URL/api/workspaces/$WS/activity?limit=5" -H "Authorization: Bearer $TOKEN" | json 'data.items.map(a=>a.verb).join(", ")'

echo "== error envelope (validation)"
curl -s -X POST "$BASE_URL/api/workspaces" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"name":""}'; echo

echo "== refresh + logout"
NEW_TOKEN=$(curl -sf -X POST "$BASE_URL/api/auth/refresh" -H 'Content-Type: application/json' -d "{\"refreshToken\":\"$REFRESH\"}" | json data.accessToken)
curl -sf -o /dev/null -w "logout status %{http_code}\n" -X POST "$BASE_URL/api/auth/logout" -H "Authorization: Bearer $NEW_TOKEN" -H 'Content-Type: application/json' -d '{}'
curl -s -o /dev/null -w "after logout /me -> %{http_code}\n" "$BASE_URL/api/auth/me" -H "Authorization: Bearer $NEW_TOKEN"
