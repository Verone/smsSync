#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────
# Constants
# ─────────────────────────────────────────────
APP_NAME="sms-sync"
APP_USER="sms-sync"
INSTALL_DIR="/opt/sms-sync"
LOG_DIR="/var/log/sms-sync"
SERVICE_FILE="/etc/systemd/system/sms-sync.service"
LOGROTATE_FILE="/etc/logrotate.d/sms-sync"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ─────────────────────────────────────────────
# Phase 1: Guard checks
# ─────────────────────────────────────────────
echo "==> [1/10] Checking prerequisites..."

if [ "$EUID" -ne 0 ]; then
    echo "ERROR: This script must be run as root. Use: sudo ./install.sh"
    exit 1
fi

if command -v apt-get &>/dev/null; then
    PKG_MANAGER="apt"
elif command -v dnf &>/dev/null; then
    PKG_MANAGER="dnf"
elif command -v yum &>/dev/null; then
    PKG_MANAGER="yum"
else
    echo "ERROR: No supported package manager found (apt-get, dnf, or yum required)."
    exit 1
fi

echo "    OS package manager: $PKG_MANAGER"

# ─────────────────────────────────────────────
# Phase 2: Install Node.js and npm
# ─────────────────────────────────────────────
echo "==> [2/10] Checking Node.js..."

if command -v node &>/dev/null && command -v npm &>/dev/null; then
    echo "    Node.js $(node -v) and npm $(npm -v) already installed. Skipping."
else
    echo "    Installing Node.js LTS via NodeSource..."
    if [ "$PKG_MANAGER" = "apt" ]; then
        apt-get update -y -q
        apt-get install -y -q curl ca-certificates gnupg
        curl -fsSL https://deb.nodesource.com/setup_lts.x | bash -
        apt-get install -y -q nodejs
    else
        $PKG_MANAGER install -y curl ca-certificates
        curl -fsSL https://rpm.nodesource.com/setup_lts.x | bash -
        $PKG_MANAGER install -y nodejs
    fi
    echo "    Installed Node.js $(node -v) and npm $(npm -v)."
fi

NODE_BIN="$(command -v node)"

# ─────────────────────────────────────────────
# Phase 3: Create system user
# ─────────────────────────────────────────────
echo "==> [3/10] Setting up system user '$APP_USER'..."

if id "$APP_USER" &>/dev/null; then
    echo "    User '$APP_USER' already exists. Skipping."
else
    useradd \
        --system \
        --no-create-home \
        --shell /usr/sbin/nologin \
        --comment "sms-sync service account" \
        "$APP_USER"
    echo "    Created system user '$APP_USER'."
fi

# ─────────────────────────────────────────────
# Phase 4: Copy project files
# ─────────────────────────────────────────────
echo "==> [4/10] Deploying application to $INSTALL_DIR..."

mkdir -p "$INSTALL_DIR"

if command -v rsync &>/dev/null; then
    rsync -a \
        --exclude='.env' \
        --exclude='node_modules/' \
        --exclude='.git/' \
        --exclude='*.log' \
        --exclude='install.sh' \
        "$SCRIPT_DIR/" "$INSTALL_DIR/"
else
    echo "    rsync not found, using cp fallback..."
    cp "$SCRIPT_DIR/server.js"    "$INSTALL_DIR/server.js"
    cp "$SCRIPT_DIR/package.json" "$INSTALL_DIR/package.json"
    [ -f "$SCRIPT_DIR/package-lock.json" ] && cp "$SCRIPT_DIR/package-lock.json" "$INSTALL_DIR/package-lock.json"
    [ -f "$SCRIPT_DIR/sms-sync-client.js" ] && cp "$SCRIPT_DIR/sms-sync-client.js" "$INSTALL_DIR/sms-sync-client.js"
    [ -f "$SCRIPT_DIR/test.html" ] && cp "$SCRIPT_DIR/test.html" "$INSTALL_DIR/test.html"
fi

echo "    Files deployed to $INSTALL_DIR."

# ─────────────────────────────────────────────
# Phase 5: Handle .env file
# ─────────────────────────────────────────────
echo "==> [5/10] Configuring environment (.env)..."

ENV_SOURCE="$SCRIPT_DIR/.env"

if [ -f "$INSTALL_DIR/.env" ]; then
    echo "    .env already exists at $INSTALL_DIR/.env — NOT overwriting to protect existing secrets."
    echo "    To update: sudo nano $INSTALL_DIR/.env, then: sudo systemctl restart $APP_NAME"
else
    if [ -f "$ENV_SOURCE" ]; then
        cp "$ENV_SOURCE" "$INSTALL_DIR/.env"
        echo "    Copied .env from source directory."
    else
        echo "    WARNING: No .env found. Creating template — you MUST set API_SECRET before using the service!"
        cat > "$INSTALL_DIR/.env" <<'ENVEOF'
PORT=3000
API_SECRET=CHANGE_ME
ENVEOF
    fi
fi

# Always enforce tight permissions on .env
chown root:"$APP_USER" "$INSTALL_DIR/.env"
chmod 640 "$INSTALL_DIR/.env"
echo "    .env permissions: root:$APP_USER 640 (owner read/write, group read-only)."

# ─────────────────────────────────────────────
# Phase 6: Install npm dependencies (production)
# ─────────────────────────────────────────────
echo "==> [6/10] Installing npm dependencies (production only)..."

chown -R "$APP_USER":"$APP_USER" "$INSTALL_DIR"
sudo -u "$APP_USER" bash -c "cd '$INSTALL_DIR' && npm install --omit=dev --no-fund --no-audit 2>&1"

# Re-apply correct ownership after npm install
chown -R "$APP_USER":"$APP_USER" "$INSTALL_DIR"
# Re-apply .env permissions (chown -R above resets it)
chown root:"$APP_USER" "$INSTALL_DIR/.env"
chmod 640 "$INSTALL_DIR/.env"

echo "    Dependencies installed."

# ─────────────────────────────────────────────
# Phase 7: Create log directory
# ─────────────────────────────────────────────
echo "==> [7/10] Setting up log directory $LOG_DIR..."

mkdir -p "$LOG_DIR"
chown "$APP_USER":"$APP_USER" "$LOG_DIR"
chmod 750 "$LOG_DIR"

# Pre-create log files (required by systemd's StandardOutput=append:)
touch "$LOG_DIR/app.log" "$LOG_DIR/error.log"
chown "$APP_USER":"$APP_USER" "$LOG_DIR/app.log" "$LOG_DIR/error.log"
chmod 640 "$LOG_DIR/app.log" "$LOG_DIR/error.log"

echo "    Log directory ready: $LOG_DIR"

# ─────────────────────────────────────────────
# Phase 8: Write systemd unit file
# ─────────────────────────────────────────────
echo "==> [8/10] Writing systemd unit file to $SERVICE_FILE..."

cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=SMS Sync Backend Server
Documentation=file://${INSTALL_DIR}/README.md
After=network.target network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${APP_USER}
Group=${APP_USER}
WorkingDirectory=${INSTALL_DIR}
EnvironmentFile=${INSTALL_DIR}/.env
ExecStart=${NODE_BIN} server.js
Restart=on-failure
RestartSec=5s
StartLimitIntervalSec=60s
StartLimitBurst=3

# Logging
StandardOutput=append:${LOG_DIR}/app.log
StandardError=append:${LOG_DIR}/error.log
SyslogIdentifier=${APP_NAME}

# Security hardening
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=${LOG_DIR} ${INSTALL_DIR}
PrivateTmp=true
PrivateDevices=true

[Install]
WantedBy=multi-user.target
EOF

echo "    Unit file written."

# ─────────────────────────────────────────────
# Phase 9: Write logrotate config
# ─────────────────────────────────────────────
echo "==> [9/10] Writing logrotate config to $LOGROTATE_FILE..."

cat > "$LOGROTATE_FILE" <<LREOF
${LOG_DIR}/*.log {
    daily
    rotate 14
    compress
    delaycompress
    missingok
    notifempty
    copytruncate
    su ${APP_USER} ${APP_USER}
}
LREOF

echo "    logrotate config written (daily, 14-day retention, copytruncate)."

# ─────────────────────────────────────────────
# Phase 10: Enable and start service
# ─────────────────────────────────────────────
echo "==> [10/10] Enabling and starting $APP_NAME service..."

systemctl daemon-reload
systemctl enable "${APP_NAME}.service"
systemctl restart "${APP_NAME}.service"

sleep 2

echo ""
echo "══════════════════════════════════════════════"
echo "  Service Status"
echo "══════════════════════════════════════════════"
systemctl status "${APP_NAME}.service" --no-pager -l || true

echo ""
echo "══════════════════════════════════════════════"
echo "  Recent Logs"
echo "══════════════════════════════════════════════"
journalctl -u "${APP_NAME}.service" --no-pager -n 20 || true

echo ""
echo "══════════════════════════════════════════════"
echo "  Installation Complete"
echo "══════════════════════════════════════════════"
echo "  Service name:   $APP_NAME"
echo "  Install dir:    $INSTALL_DIR"
echo "  Log dir:        $LOG_DIR"
echo "  .env file:      $INSTALL_DIR/.env"
echo ""
echo "  Manage service:"
echo "    sudo systemctl start   $APP_NAME"
echo "    sudo systemctl stop    $APP_NAME"
echo "    sudo systemctl restart $APP_NAME"
echo "    sudo systemctl status  $APP_NAME"
echo ""
echo "  View logs:"
echo "    tail -f $LOG_DIR/app.log"
echo "    tail -f $LOG_DIR/error.log"
echo "    journalctl -u $APP_NAME -f"
echo ""
if grep -q "CHANGE_ME" "$INSTALL_DIR/.env" 2>/dev/null; then
    echo "  ⚠  WARNING: API_SECRET is still set to 'CHANGE_ME'!"
    echo "     Edit $INSTALL_DIR/.env and restart the service."
    echo "     sudo nano $INSTALL_DIR/.env"
    echo "     sudo systemctl restart $APP_NAME"
    echo ""
fi
