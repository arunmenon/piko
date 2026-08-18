#!/bin/bash
# Regenerates bench/pi-setup.sh.j2: builds pi, bundles it into one file, and embeds
# it base64 in the container setup script (no npm registry needed at task time).
set -euo pipefail
cd "$(dirname "$0")/.."

npm run build > /dev/null
npx esbuild packages/cli/dist/main.js --bundle --platform=node --format=esm \
  --outfile=bench/pi-bundle.mjs --log-level=warning

{
  cat << 'HEAD'
#!/bin/bash
set -e
export DEBIAN_FRONTEND=noninteractive
command -v curl > /dev/null 2>&1 || (apt-get update && apt-get install -y curl ca-certificates) > /dev/null 2>&1 || true

# Direct node tarball (~15s) instead of nvm (~90s) — install time counts against the
# task's agent timeout. Fall back to nvm if the tarball route fails (musl, odd arch).
NODE_VERSION=v22.12.0
case "$(uname -m)" in
  x86_64) NODE_ARCH=x64 ;;
  aarch64 | arm64) NODE_ARCH=arm64 ;;
  *) NODE_ARCH="" ;;
esac
NODE_BIN=""
if [ -n "$NODE_ARCH" ]; then
  mkdir -p /opt/node
  if curl -fsSL "https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-linux-${NODE_ARCH}.tar.gz" \
      | tar -xz -C /opt/node --strip-components=1 2> /dev/null; then
    if /opt/node/bin/node --version > /dev/null 2>&1; then
      NODE_BIN=/opt/node/bin/node
    fi
  fi
fi
if [ -z "$NODE_BIN" ]; then
  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.2/install.sh | bash
  source "$HOME/.nvm/nvm.sh"
  nvm install 22 > /dev/null
  NODE_BIN="$(command -v node)"
fi

mkdir -p /opt/pi
cat > /tmp/pi.b64 << 'PI_B64'
HEAD
  base64 -i bench/pi-bundle.mjs
  cat << 'TAIL'
PI_B64
base64 -d /tmp/pi.b64 > /opt/pi/pi.mjs
rm /tmp/pi.b64
printf '#!/bin/bash\nexec %s /opt/pi/pi.mjs "$@"\n' "$NODE_BIN" > /usr/local/bin/pi
chmod +x /usr/local/bin/pi
pi --help > /dev/null && echo "pi installed"
TAIL
} > bench/pi-setup.sh.j2

echo "wrote bench/pi-setup.sh.j2 ($(wc -c < bench/pi-setup.sh.j2 | tr -d ' ') bytes)"
