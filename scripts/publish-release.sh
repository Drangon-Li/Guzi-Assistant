#!/bin/bash
# 发布更新到 Supabase Storage releases 桶（应用内「检查更新」的数据源）。
# 前置（一次性）：用 supabase db query --linked -f scripts/releases-bucket.sql 建公共桶。
# 用法：./scripts/publish-release.sh "这个版本改了什么（更新说明）"
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION=$(node -p "require('./package.json').version")
NOTES=${1:-"版本 ${VERSION}"}
DMG_LOCAL="release/谷子助手-${VERSION}-arm64.dmg"
DMG_KEY="谷子助手-${VERSION}-arm64.dmg"
BASE="https://rtgypddrknuylecqejmp.supabase.co/storage/v1/object/public/releases"

[ -f "$DMG_LOCAL" ] || { echo "未找到 ${DMG_LOCAL}，先跑 npm run pack:mac"; exit 1; }

echo "上传 dmg（${VERSION}）…"
supabase storage cp "$DMG_LOCAL" "ss:///releases/${DMG_KEY}" --linked --experimental

echo "更新版本清单…"
MANIFEST=$(mktemp)/latest-mac.json
mkdir -p "$(dirname "$MANIFEST")"
node -e "console.log(JSON.stringify({version: '${VERSION}', notes: process.argv[1], url: '${BASE}/${DMG_KEY}'}, null, 2))" "$NOTES" > "$MANIFEST"
supabase storage cp "$MANIFEST" "ss:///releases/latest-mac.json" --linked --experimental

echo "完成：${BASE}/latest-mac.json → ${VERSION}"
