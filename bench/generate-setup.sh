#!/bin/bash
# Regenerates bench/pi-setup.sh.j2: builds pi, bundles it into one file, and embeds
# it base64 in the container setup script (no npm registry needed at task time).
set -euo pipefail
cd "$(dirname "$0")/.."

npm run build > /dev/null
npx esbuild packages/cli/dist/main.js --bundle --platform=node --format=esm \
  --outfile=bench/pi-bundle.mjs --log-level=warning

# Bake a pricing table so in-container runs report real USD (ADR 0020) instead
# of unpriced rows: containers have no pricing cache and benchmark runs should
# not depend on a network fetch at task time. Filter the host cache to exact
# unprefixed model keys to keep the embed small; the adapter passes the file
# via --pricing-path, which is the loader's explicit source.
PRICES_CACHE="${HOME}/.config/pi/model-prices-cache.json"
if [ ! -f "$PRICES_CACHE" ]; then
  echo "missing $PRICES_CACHE; run any priced pi command once to populate it" >&2
  exit 1
fi
node -e '
  const { readFileSync, writeFileSync } = require("node:fs");
  const envelope = JSON.parse(readFileSync(process.argv[1], "utf8"));
  const body = envelope.body;
  const keep = {};
  for (const [key, value] of Object.entries(body)) {
    if (!key.includes("/") && /^(gpt-|o1|o3|o4|claude-)/.test(key)) keep[key] = value;
  }
  if (!keep["gpt-5.5"]) throw new Error("filtered table lost gpt-5.5; check the cache");
  writeFileSync("bench/model-prices.json", JSON.stringify(keep));
  console.log(`pricing table: ${Object.keys(keep).length} models, fetched ${envelope.fetchedAt}`);
' "$PRICES_CACHE"

{
  cat << 'HEAD'
#!/bin/bash
set -e
export DEBIAN_FRONTEND=noninteractive
command -v curl > /dev/null 2>&1 || (apt-get update && apt-get install -y curl ca-certificates) > /dev/null 2>&1 || true

# Use one pinned, checksum-verified Node archive. Install time counts against the
# task's agent timeout, and an unpinned fallback would make benchmark runs harder
# to reproduce.
NODE_VERSION=v22.12.0
case "$(uname -m)" in
  x86_64) NODE_ARCH=x64 ;;
  aarch64 | arm64) NODE_ARCH=arm64 ;;
  *) NODE_ARCH="" ;;
esac
NODE_BIN=""
if [ -n "$NODE_ARCH" ]; then
  mkdir -p /opt/node
  NODE_ARCHIVE="node-${NODE_VERSION}-linux-${NODE_ARCH}.tar.gz"
  if curl -fsSLO "https://nodejs.org/dist/${NODE_VERSION}/${NODE_ARCHIVE}" &&
      curl -fsSLO "https://nodejs.org/dist/${NODE_VERSION}/SHASUMS256.txt" &&
      grep "  ${NODE_ARCHIVE}$" SHASUMS256.txt | sha256sum -c - > /dev/null &&
      tar -xzf "$NODE_ARCHIVE" -C /opt/node --strip-components=1 2> /dev/null; then
    if /opt/node/bin/node --version > /dev/null 2>&1; then
      NODE_BIN=/opt/node/bin/node
    fi
  fi
  rm -f "$NODE_ARCHIVE" SHASUMS256.txt
fi
if [ -z "$NODE_BIN" ]; then
  echo "unable to install checksum-verified Node ${NODE_VERSION} for $(uname -m)" >&2
  exit 1
fi

mkdir -p /opt/pi
cat > /tmp/pi.b64 << 'PI_B64'
HEAD
  base64 -i bench/pi-bundle.mjs
  cat << 'TAIL'
PI_B64
base64 -d /tmp/pi.b64 > /opt/pi/pi.mjs
rm /tmp/pi.b64
cat > /tmp/prices.b64 << 'PRICES_B64'
TAIL
  base64 -i bench/model-prices.json
  cat << 'TAIL'
PRICES_B64
base64 -d /tmp/prices.b64 > /opt/pi/model-prices.json
rm /tmp/prices.b64
printf '#!/bin/bash\nexec %s /opt/pi/pi.mjs "$@"\n' "$NODE_BIN" > /usr/local/bin/pi
chmod +x /usr/local/bin/pi
pi --help > /dev/null && echo "pi installed"
TAIL
} > bench/pi-setup.sh.j2

echo "wrote bench/pi-setup.sh.j2 ($(wc -c < bench/pi-setup.sh.j2 | tr -d ' ') bytes)"
