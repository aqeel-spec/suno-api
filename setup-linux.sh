#!/bin/bash
set -e

echo "=== Suno API — Linux VPS Setup ==="
echo ""

# 1. Install system dependencies for Chromium
echo "[1/4] Installing system dependencies for Chromium..."
if command -v apt-get &>/dev/null; then
    sudo apt-get update
    sudo DEBIAN_FRONTEND=noninteractive apt-get install -y \
        libnss3 libdbus-1-3 libatk1.0-0 libatk-bridge2.0-0 \
        libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
        libgbm1 libxkbcommon0 libasound2 libcups2 \
        libpango-1.0-0 libcairo2 libdrm2 libxshmfence1 \
        fonts-liberation fonts-noto-color-emoji \
        xvfb
elif command -v yum &>/dev/null; then
    sudo yum install -y \
        nss dbus-libs atk at-spi2-atk \
        libXcomposite libXdamage libXfixes libXrandr \
        mesa-libgbm libxkbcommon alsa-lib cups-libs \
        pango cairo libdrm libXshmfence \
        liberation-fonts xorg-x11-server-Xvfb
else
    echo "WARNING: Could not detect package manager (apt/yum). Install Chromium deps manually."
fi

# 2. Install npm dependencies
echo ""
echo "[2/4] Installing npm dependencies..."
npm install

# 3. Install Playwright Chromium browser
echo ""
echo "[3/4] Installing Playwright Chromium browser..."
npx playwright install chromium

# 4. Verify installation
echo ""
echo "[4/4] Verifying Chromium installation..."
CHROMIUM_PATH=$(npx playwright install --dry-run chromium 2>&1 | grep -oP '/.*chromium.*' | head -1 || true)
if [ -z "$CHROMIUM_PATH" ]; then
    echo "Checking default Playwright cache..."
    CACHE_DIR="${HOME}/.cache/ms-playwright"
    if [ -d "$CACHE_DIR" ]; then
        echo "Playwright cache found at: $CACHE_DIR"
        ls -la "$CACHE_DIR/" 2>/dev/null || true
    fi
fi

echo ""
echo "=== Setup complete! ==="
echo ""
echo "Make sure your .env has these settings for headless VPS:"
echo "  BROWSER_HEADLESS=true"
echo "  BROWSER_DISABLE_GPU=true"
echo "  BROWSER_KEEP_OPEN=false"
echo ""
echo "Start with: npm run build && npm run start"
echo "Or with PM2: pm2 start npm --name suno-api -- run start"
