#!/bin/sh
set -eu

# Caddy 负责 ACME 申请和续期；受限网络场景由 Nginx 使用第 80 端口提供 TLS。
source_dir=/var/lib/caddy/.local/share/caddy/certificates/acme-v02.api.letsencrypt.org-directory/115-191-1-188.sslip.io
target_dir=/etc/nginx/tls

[ -s "$source_dir/115-191-1-188.sslip.io.crt" ] || exit 0
[ -s "$source_dir/115-191-1-188.sslip.io.key" ] || exit 0

install -d -m 755 "$target_dir"
install -m 644 "$source_dir/115-191-1-188.sslip.io.crt" "$target_dir/fullchain.pem"
install -m 600 "$source_dir/115-191-1-188.sslip.io.key" "$target_dir/privkey.pem"
nginx -t >/dev/null
systemctl reload nginx
