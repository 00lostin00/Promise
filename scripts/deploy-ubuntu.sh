#!/usr/bin/env bash
# Promise · Ubuntu / Debian 一键部署脚本
# 适用：阿里云 ECS Ubuntu 24.04，全新空机
# 用途：装 Node.js + 启 systemd 服务，可选 nginx 反代

set -euo pipefail

APP_NAME="promise"
APP_USER="${SUDO_USER:-$USER}"
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE_BIN="$(command -v node || true)"
PORT="${PROMISE_PORT:-3000}"

require_root() {
  if [[ $EUID -ne 0 ]]; then
    echo "请用 root 或 sudo 执行: sudo bash $0"
    exit 1
  fi
}

install_node() {
  if [[ -n "$NODE_BIN" ]]; then
    echo "✔ Node 已安装: $($NODE_BIN -v)"
    return
  fi
  echo "▶ 安装 Node.js 20.x ..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
  NODE_BIN="$(command -v node)"
  echo "✔ Node 安装完成: $($NODE_BIN -v)"
}

setup_dirs() {
  echo "▶ 准备目录..."
  mkdir -p "$APP_DIR/data/uploads" "$APP_DIR/old_data"
  chown -R "$APP_USER":"$APP_USER" "$APP_DIR"
}

write_systemd() {
  echo "▶ 写入 systemd 服务..."
  cat > /etc/systemd/system/$APP_NAME.service <<EOF
[Unit]
Description=Promise · 双人学习打卡
After=network.target

[Service]
Type=simple
User=$APP_USER
WorkingDirectory=$APP_DIR
Environment=NODE_ENV=production
Environment=PORT=$PORT
ExecStart=$NODE_BIN $APP_DIR/server.js
Restart=always
RestartSec=3
StandardOutput=append:/var/log/$APP_NAME.log
StandardError=append:/var/log/$APP_NAME.err.log

[Install]
WantedBy=multi-user.target
EOF
  touch /var/log/$APP_NAME.log /var/log/$APP_NAME.err.log
  chown "$APP_USER":"$APP_USER" /var/log/$APP_NAME.log /var/log/$APP_NAME.err.log
  systemctl daemon-reload
  systemctl enable $APP_NAME
  systemctl restart $APP_NAME
  sleep 1
  systemctl status $APP_NAME --no-pager | head -n 12 || true
  echo "✔ 服务已启动 - 端口 $PORT"
}

setup_firewall() {
  if command -v ufw >/dev/null; then
    echo "▶ 开放端口（ufw）..."
    ufw allow $PORT/tcp || true
    ufw allow 80/tcp || true
    ufw allow 443/tcp || true
  fi
  echo "⚠ 阿里云：还需要在控制台「安全组」放行 $PORT / 80 / 443 的入方向"
}

setup_nginx() {
  read -r -p "是否安装 nginx 反代到 80 端口？(y/N) " yn
  if [[ "$yn" != "y" && "$yn" != "Y" ]]; then return; fi
  apt-get install -y nginx
  cat > /etc/nginx/sites-available/$APP_NAME <<EOF
server {
  listen 80;
  server_name _;
  client_max_body_size 30m;

  location / {
    proxy_pass http://127.0.0.1:$PORT;
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 1d;
  }

  # SSE 长连接
  location /api/events {
    proxy_pass http://127.0.0.1:$PORT;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 24h;
    chunked_transfer_encoding off;
  }
}
EOF
  ln -sf /etc/nginx/sites-available/$APP_NAME /etc/nginx/sites-enabled/$APP_NAME
  rm -f /etc/nginx/sites-enabled/default
  nginx -t && systemctl restart nginx
  echo "✔ nginx 已配置（80 端口反代到 $PORT）"
  echo "  下一步如需 HTTPS：sudo apt install certbot python3-certbot-nginx && sudo certbot --nginx -d 你的域名"
}

main() {
  require_root
  install_node
  setup_dirs
  write_systemd
  setup_firewall
  setup_nginx
  echo
  echo "✅ 部署完成"
  IP=$(hostname -I | awk '{print $1}')
  echo "  内网访问: http://$IP:$PORT"
  echo "  外网访问: 需阿里云安全组放行端口"
  echo
  echo "常用命令:"
  echo "  查看日志: sudo journalctl -u $APP_NAME -f"
  echo "  重启服务: sudo systemctl restart $APP_NAME"
  echo "  查看状态: sudo systemctl status $APP_NAME"
}

main "$@"
