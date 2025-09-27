# HTTP API

`src/server/httpServer.js` exposes a minimal REST API that other services can use for automated verification checks.
Authentication is handled with a shared bearer token (`http.authToken`). When the token is empty the API is public.

## Endpoints

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/health` | Returns `{ status: "ok", timestamp }` to confirm the service is running. |
| `GET` | `/api/exchanges` | Lists all configured exchanges and their minimum volume thresholds. |
| `POST` | `/api/verify` | Triggers a verification for a UID. |

### POST `/api/verify`

**Headers**

- `Authorization: Bearer <token>` (optional when `http.authToken` is empty)
- `Content-Type: application/json`

**Body**

```json
{
  "uid": "trader-123",
  "exchangeId": "mock",
  "minimumVolume": 2000
}
```

- `uid` (required) &ndash; UID to verify.
- `exchangeId` (optional) &ndash; Exchange identifier. Defaults to `verification.defaultExchange`.
- `minimumVolume` (optional) &ndash; Custom threshold for this request. The value must be a finite number; otherwise the API
  responds with `400 Bad Request`.

**Responses**

- `200 OK` &ndash; Returns the verification result `{ uid, exchangeId, volume, minimumVolume, passed, timestamp }`.
- `400 Bad Request` &ndash; Validation or verification error.
- `401 Unauthorized` &ndash; Missing or incorrect bearer token.
