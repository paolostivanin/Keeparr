# Deployment

Keeparr listens on port 6767 inside the container (`PORT`). This page covers putting it behind a reverse proxy and the access setups that need extra care. See the README for the basic Docker install and the full environment variable table.

## Reverse proxy and HTTPS

Use HTTPS for public access, PWA installs, OAuth redirects and push notifications. Point your proxy at `127.0.0.1:6767`.

Realtime presence and collaborative editing use WebSockets at `/api/realtime`, so proxy that path with WebSocket upgrade support.

### Apache

```apache
# Required once:
# sudo a2enmod proxy proxy_http proxy_wstunnel rewrite ssl
# sudo systemctl reload apache2

<VirtualHost *:80>
    ServerName keeparr.example.com
    Redirect permanent / https://keeparr.example.com/
</VirtualHost>

<IfModule mod_ssl.c>
<VirtualHost *:443>
    ServerName keeparr.example.com
    ProxyRequests Off
    ProxyPreserveHost On

    ProxyPass /api/realtime ws://127.0.0.1:6767/api/realtime
    ProxyPassReverse /api/realtime ws://127.0.0.1:6767/api/realtime

    ProxyPass / http://127.0.0.1:6767/
    ProxyPassReverse / http://127.0.0.1:6767/

    SSLEngine on
    SSLCertificateFile /etc/letsencrypt/live/keeparr.example.com/fullchain.pem
    SSLCertificateKeyFile /etc/letsencrypt/live/keeparr.example.com/privkey.pem
</VirtualHost>
</IfModule>
```

### Nginx

```nginx
server {
    listen 80;
    server_name keeparr.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name keeparr.example.com;

    ssl_certificate /etc/letsencrypt/live/keeparr.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/keeparr.example.com/privkey.pem;

    location /api/realtime {
        proxy_pass http://127.0.0.1:6767/api/realtime;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location / {
        proxy_pass http://127.0.0.1:6767;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

## VPN, Tailscale, WireGuard and multiple domains

If you reach Keeparr through Tailscale, WireGuard, another VPN, a LAN hostname/IP, or more than one reverse-proxy domain, the CORS settings may be relevant. These setups do not need special CORS settings by themselves. CORS only matters when the browser page and the Keeparr API are reached through different origins, or when you restrict origins with `KEEPARR_CORS_ORIGINS`.

If you use `KEEPARR_CORS_ORIGINS`, include each exact browser origin you use (Tailnet name, VPN-only domain, LAN IP, public domain), with scheme and port where applicable. For the simplest personal setup leave `KEEPARR_CORS_ALLOW_ALL=1` enabled. Same-origin access needs no CORS configuration.

## Custom connection headers (Android app)

The Android app supports optional custom connection headers for reverse proxies or access gateways that require them, such as Cloudflare Access service tokens or shared-secret proxy headers. Configure them only if your proxy setup needs them.

Custom headers let normal HTTP requests (login, loading and saving notes, attachments, settings) pass through a header-auth gateway. They are not a replacement for Keeparr login; users still need an account and session.

Custom headers do not apply to the realtime WebSocket connection, because WebSockets cannot attach arbitrary headers. Behind a gateway that requires header auth on WebSocket upgrades, reads and writes still work, but live updates may only appear after refocusing the app or refreshing.

## Single sign-on, OAuth and MCP

- OpenID Connect: [oidc.md](oidc.md)
- OAuth 2.1 for third-party apps: [oauth.md](oauth.md)
- Local and remote MCP: [mcp.md](mcp.md)

These need `BASE_URL` set to the public origin.

## Backups and restore

Keeparr creates consistent SQLite backups while running. Admins can schedule daily, weekly or monthly backups from User Management, or create one manually.

To restore from a backup during setup:

1. Set `KEEPARR_ALLOW_RESTORE=1`.
2. Restart Keeparr.
3. Upload the backup file from the setup screen.
4. Remove `KEEPARR_ALLOW_RESTORE` and restart again.

The flag is opt-in so the restore endpoint is never left open on a public instance.
