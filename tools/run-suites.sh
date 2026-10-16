#!/usr/bin/env bash
set -u
cd "D:/Projects/Projects/WizDeck"
CHROME="/c/Program Files/Google/Chrome/Application/chrome.exe"
port=9400
run_suite () {
  local name="$1"
  port=$((port+1))
  local udd="D:/Projects/Projects/WizDeck/.tmp-chrome-$name"
  rm -rf "$udd" 2>/dev/null
  "$CHROME" --headless=new --disable-gpu --no-first-run --no-default-browser-check \
    --remote-debugging-port="$port" --user-data-dir="$udd" --window-size=1600,950 \
    --allow-file-access-from-files about:blank >/dev/null 2>&1 &
  local cpid=$!
  for _ in $(seq 1 40); do curl -s "http://127.0.0.1:$port/json/list" >/dev/null 2>&1 && break; sleep 0.5; done
  echo "########## $name (port $port) ##########"
  node "tools/$name.mjs" "$CHROME" "$port" 2>&1 | grep -iE "通过|passed|失败|failed|✗|FAIL" | tail -6
  taskkill //PID "$cpid" //T //F >/dev/null 2>&1
  sleep 1
}
# latex 是纯 node，不开浏览器
echo "########## latex-test (pure node) ##########"
node tools/latex-test.mjs 2>&1 | grep -iE "通过|passed|失败|failed|✗|FAIL" | tail -6
echo
run_suite pattern-test
run_suite video-test
run_suite textpos-test
run_suite panel-test
run_suite topbar-test
run_suite ui-smoke
run_suite cursor-test
run_suite overlay-test
run_suite edit-test
run_suite edit-test2
run_suite elements-test
