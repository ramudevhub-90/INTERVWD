#!/usr/bin/env bash
# Run the test suite inside AWS against the real services (Nova, Chime, Polly), with in-memory
# storage: a temporary Lambda with the app's own role, deleted afterwards. No production data is touched.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/infra/build/live-check"
NAME="intervwd-live-check"
REGION="${AWS_REGION:-us-east-1}"
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
PIP="${PIP:-$ROOT/server/.venv/bin/pip}"

rm -rf "$OUT" && mkdir -p "$OUT"
$PIP install --quiet --target "$OUT" --platform manylinux2014_aarch64 --implementation cp --python-version 3.13 --only-binary=:all: \
  "mcp==2.3.0" "starlette>=1.7" "python-multipart>=0.0.20" "httpx" "pytest"
cp -R "$ROOT/server/intervwd" "$ROOT/server/tests" "$OUT/"
cat > "$OUT/check.py" <<'PY'
import contextlib, io, os, sys
import pytest

def handler(event, context):
    os.environ["LIVE"] = "1"
    os.chdir("/tmp")
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(buf):
        code = pytest.main(["-q", "-s", "-p", "no:cacheprovider", "--rootdir", "/tmp", os.path.join(os.path.dirname(__file__), "tests")])
    return {"exit": int(code), "output": buf.getvalue()[-60000:]}
PY
(cd "$OUT" && find . -name __pycache__ -prune -exec rm -rf {} + && zip -qr ../live-check.zip .)

aws lambda delete-function --function-name "$NAME" --region "$REGION" >/dev/null 2>&1 || true
aws lambda create-function --function-name "$NAME" --region "$REGION" --runtime python3.13 --architectures arm64 \
  --role "arn:aws:iam::$ACCOUNT:role/intervwd-server" --handler check.handler --timeout 900 --memory-size 1024 \
  --zip-file "fileb://$ROOT/infra/build/live-check.zip" \
  --environment "Variables={NOVA_MODE=bedrock,NOVA_MODEL=global.amazon.nova-2-lite-v1:0,NOVA_ROLE_ARN=arn:aws:iam::234951664889:role/PantryPilotBedrockAccess,POLLY_VOICE=Kajal,APP_URL=https://intervwd.com}" >/dev/null
aws lambda wait function-active-v2 --function-name "$NAME" --region "$REGION"
aws lambda invoke --function-name "$NAME" --region "$REGION" --cli-read-timeout 960 "$OUT/result.json" >/dev/null || true
aws lambda delete-function --function-name "$NAME" --region "$REGION"
python3 -c "import json,sys; r=json.load(open(sys.argv[1])); print(r.get('output') or r); sys.exit(r.get('exit', 1))" "$OUT/result.json"
