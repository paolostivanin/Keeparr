# Keeparr OAuth integration

Keeparr includes an OAuth 2.1 authorization server for third-party applications and integrations. It uses authorization code flow with PKCE S256, short-lived access tokens, rotating refresh tokens, dynamic client registration, protected-resource metadata, and token revocation.

OAuth access is disabled per user until they enable **OAuth app access** in Keeparr settings. A user signs in to Keeparr and explicitly approves each authorization request. Applications never receive the user's Keeparr password or dedicated local MCP token. Local MCP access is a separate setting and does not need to be enabled for OAuth.

After authorization, an application can call `GET /api/oauth/me` to identify the connected Keeparr user and use the standard supported note routes such as `GET /api/notes`, `GET /api/notes/search`, and the corresponding note, label, reminder, collaborator, image, and attachment routes allowed by its scopes.

## Discovery

Set `BASE_URL` to Keeparr's public HTTPS origin. OAuth metadata is available at:

```text
https://keeparr.example.com/.well-known/oauth-authorization-server
https://keeparr.example.com/.well-known/oauth-protected-resource/api
```

The authorization, token, registration, and revocation endpoint URLs are published in that metadata. Public clients are supported and must use PKCE S256; client secrets are not issued.

## Protected resources

Keeparr exposes two OAuth protected resources:

| Resource | Purpose |
| --- | --- |
| `https://keeparr.example.com/api` | Direct Keeparr API integrations |
| `https://keeparr.example.com/mcp` | Remote Model Context Protocol clients |

Pass the intended resource in both the authorization and token requests. If an authorization request omits `resource`, Keeparr defaults to the API resource.

## Scopes

| Scope | Access |
| --- | --- |
| `keeparr.read` | Search and read accessible notes, labels, reminders, collaborators, images, and attachments |
| `keeparr.write` | Create or change notes, labels, reminders, collaborators, images, and attachments |

Clients may request either scope or both. API requests made with an insufficient scope return HTTP 403. OAuth tokens cannot access account administration, user management, backups, restore, sync internals, or unrestricted server endpoints.

Locked notes remain redacted unless the user separately enables locked-note access and completes the browser unlock flow. Permanent deletion remains unavailable unless the user separately enables it.

## Dynamic client registration

Clients can register through the `registration_endpoint` from discovery:

```bash
curl -X POST https://keeparr.example.com/oauth/register \
  -H 'Content-Type: application/json' \
  -d '{
    "client_name": "My Keeparr integration",
    "redirect_uris": ["https://integration.example.com/oauth/callback"],
    "token_endpoint_auth_method": "none"
  }'
```

Use the returned `client_id` in the authorization-code flow. Web redirect URIs must use HTTPS, except loopback localhost URIs used during local development. Installed applications may register a private-use callback scheme and must follow the native-app guidance in RFC 8252.

## Revocation

Applications should send access or refresh tokens to `/oauth/revoke` when disconnected. Keeparr also lists authorized apps in **Settings > External Access**, where the user can revoke one connection or disable OAuth app access to revoke all OAuth grants. These actions do not change the separate local MCP token.

OAuth here authorizes access to Keeparr data. Keeparr's optional upstream OIDC configuration is separate: it lets users sign in to Keeparr through an identity provider.
