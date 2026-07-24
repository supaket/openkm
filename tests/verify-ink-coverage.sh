#!/usr/bin/env bash
# ตรวจว่าทุกหน้าติวใน books/utcc มีปากกา (ink-tool.js) ครบ 100%
# ใช้: bash tests/verify-ink-coverage.sh   (คืน exit 1 ถ้ามีหน้าไหนขาด)
set -euo pipefail
cd "$(dirname "$0")/.."

miss=0 total=0
while IFS= read -r f; do
  total=$((total+1))
  if ! grep -q 'assets/ink-tool.js' "$f"; then
    echo "MISSING ink-tool: $f"
    miss=$((miss+1))
  fi
done < <(find books/utcc -name '*.html' ! -name 'index.html')

if [ "$miss" -eq 0 ]; then
  echo "✓ ครบ $total/$total หน้า utcc มีปากกา"
else
  echo "✗ ขาด $miss หน้า"
  exit 1
fi
