#!/usr/bin/env bash
set -Eeuo pipefail

mkdir -p artifacts
log_file=artifacts/android-upgrade.log
exec > >(tee "$log_file") 2>&1

report_failure() {
  status=$?
  set +e
  echo "::error title=Android upgrade failed::$(tail -n 80 "$log_file" | tr '\n' ' ' | cut -c1-5000)"
  exit "$status"
}
trap report_failure ERR

adb install artifacts/WorkPivot-android-1.9.apk
adb shell am start -W -n com.workpivot.mobile/.MainActivity
sleep 3

# Google APIs 模拟器允许 root；应用是 release 包，不能使用 run-as。
adb root >/dev/null 2>&1 || true
adb wait-for-device
adb shell 'mkdir -p /data/user/0/com.workpivot.mobile/files && printf "ota-preserved-1.9-to-1.11" > /data/user/0/com.workpivot.mobile/files/ota-preserved.txt'
adb shell 'cat /data/user/0/com.workpivot.mobile/files/ota-preserved.txt' > artifacts/android-marker-before.txt

adb install -r artifacts/WorkPivot-android-1.11.apk
adb shell am force-stop com.workpivot.mobile
adb shell am start -W -n com.workpivot.mobile/.MainActivity
sleep 3
adb shell 'cat /data/user/0/com.workpivot.mobile/files/ota-preserved.txt' > artifacts/android-marker-after.txt
diff -u artifacts/android-marker-before.txt artifacts/android-marker-after.txt

adb shell dumpsys package com.workpivot.mobile > artifacts/android-package.txt
grep -q 'versionName=1.11' artifacts/android-package.txt
grep -q 'versionCode=12' artifacts/android-package.txt
adb exec-out screencap -p > artifacts/android-after-upgrade.png
adb logcat -d -b crash > artifacts/android-crash.log
if grep -q 'FATAL EXCEPTION' artifacts/android-crash.log; then
  echo 'FATAL EXCEPTION detected after upgrade'
  exit 1
fi

echo 'ANDROID_UPGRADE_OK'
exit 0
