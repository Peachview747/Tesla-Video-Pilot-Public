#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p build/DownloadSmoke
openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 1 \
  -subj "/CN=MK8 Download Smoke $(uuidgen)" \
  -config scripts/download_tls.cnf \
  -keyout build/DownloadSmoke/key.pem -out build/DownloadSmoke/cert.pem >/dev/null 2>&1
cleanup() {
  rm -f build/DownloadSmoke/key.pem
}
trap cleanup EXIT
openssl x509 -in build/DownloadSmoke/cert.pem -outform DER -out build/DownloadSmoke/cert.der
xcrun swiftc -O -emit-library -emit-module -module-name MK8Core Core/*.swift \
  -emit-module-path build/DownloadSmoke/MK8Core.swiftmodule -o build/DownloadSmoke/libMK8Core.dylib
xcrun swiftc -O -parse-as-library -I build/DownloadSmoke -L build/DownloadSmoke -lMK8Core \
  -Xlinker -rpath -Xlinker "$PWD/build/DownloadSmoke" \
  App/MediaDownloader.swift scripts/DownloadSmoke.swift -o build/DownloadSmoke/downloader-smoke
python3 - <<'PYTHON'
import pathlib, subprocess, time
root = pathlib.Path('build/DownloadSmoke')
endpoint = root / 'url.txt'
endpoint.unlink(missing_ok=True)
fixture = subprocess.Popen(['python3', '-u', 'scripts/download_fixture.py', str(root / 'cert.pem'),
                            str(root / 'key.pem'), str(endpoint)])
try:
    deadline = time.monotonic() + 30
    while not endpoint.exists():
        if fixture.poll() is not None:
            raise RuntimeError('HTTPS fixture exited before becoming ready')
        if time.monotonic() >= deadline:
            raise TimeoutError('HTTPS fixture did not become ready')
        time.sleep(0.1)
    subprocess.run(['build/DownloadSmoke/downloader-smoke', endpoint.read_text(), str(root / 'cert.der')],
                   check=True, timeout=90)
finally:
    fixture.terminate()
    try:
        fixture.wait(timeout=5)
    except subprocess.TimeoutExpired:
        fixture.kill()
        fixture.wait(timeout=5)
PYTHON
