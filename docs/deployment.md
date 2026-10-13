# Deployment

Keeparr listens on port 6767 inside the container (`PORT`). This page covers putting it behind a reverse proxy and the access setups that need extra care. See the README for the basic Docker install and the full environment variable table.

## Reverse proxy and HTTPS

Use HTTPS for public access, PWA installs, OAuth redirects and push notifications. Point your proxy at `127.0.0.1:6767`.

Realtime presence and collaborative editing use WebSockets at `/api/realtime`, so proxy that path with WebSocket upgrade support.

Keeparr trusts one proxy hop for `X-Forwarded-For` by default, which is what the login rate limit uses to tell clients apart. Set `KEEPARR_TRUST_PROXY=0` if you publish port 6767 directly without a proxy (otherwise a client can spoof its address), or a larger number or a comma-separated list of proxy addresses if there is more than one proxy in front.

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

A backup is one `.zip` file in `data/backups`. It holds a consistent snapshot of the database (taken while Keeparr runs), every uploaded image and attachment, the web-push key (`vapid.json`) and a small manifest. Admins can schedule daily, weekly or monthly backups from User Management, or create one manually, and download any of them from there.

- **Retention.** Keeparr keeps the newest 7 automated backups (change this in User Management, 1 to 60). Manual backups are never deleted automatically.
- **Same disk.** Backups live on the same volume as the data, so they do not protect against losing the disk. Copy `data/backups` somewhere else on a schedule.
- **Sessions.** Logins are stored as one-way hashes, so a backup does not contain usable session tokens.

To restore a backup onto a fresh instance (during setup, before any account exists):

1. Set `KEEPARR_ALLOW_RESTORE=1`.
2. Restart Keeparr.
3. Upload the backup (`.zip`, or a database-only `.sqlite` from an older version) from the setup screen.
4. Remove `KEEPARR_ALLOW_RESTORE` and restart again.

The archive is unpacked and checked (database integrity, only the expected file names) before anything is replaced, and a failed restore leaves the instance as it was. Restoring a database-only `.sqlite` backup brings back notes but not their images; use the `.zip` backups from this version on.

The flag is opt-in so the restore endpoint is never left open on a public instance. `KEEPARR_RESTORE_MAX_BYTES` raises the upload limit (default 2 GB).

## Sign-in security

- Session, MCP and OAuth tokens are never sent in URLs. Images and the live-update connection use short-lived tickets instead of the session token, so reverse-proxy logs do not hold a login.
- Changing a password signs out every other device and revokes the MCP token and all OAuth apps (re-enable and re-authorize them afterwards). An administrator resetting a password does the same for all of that user's devices.
- After 10 failed password attempts for one account, that account is locked for 15 minutes, whatever address the attempts come from.
- `KEEPARR_SETUP_TOKEN` (optional) is required on the first-administrator form, so nobody who reaches a new instance before you can claim it.
