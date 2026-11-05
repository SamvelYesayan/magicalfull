# Magical Pioneer Card — Integration API (v1, with points)

Server-to-server API that lets a partner system (first user: the **Christmas Store** backend) verify Pioneer Cards,
link a card to one of its customer accounts, read that card's balance, history and rewards, and — with separately
granted permissions — credit or debit its points through the Pioneer ledger.

Implementation: `server/integration.js` (routes), `server/integration-cli.js` (key management),
`server/migrations-postgres/005_integration_api.sql` and `006_partner_points.sql` (tables), tests in
`tests/integration-api.test.js` and `tests/integration-points.test.js`.

- [Base URLs](#base-urls)
- [Security model](#security-model)
- [API keys: creating, rotating, revoking](#api-keys-creating-rotating-revoking)
- [Common conventions](#common-conventions)
- [Endpoints](#endpoints)
- [Error codes](#error-codes)
- [Connecting the Christmas Store backend](#connecting-the-christmas-store-backend)
- [Not included in v1](#not-included-in-v1)

---

## Base URLs

| Environment | Base URL | Notes |
|---|---|---|
| Production | `https://magical.am/api/integration/v1` | Available once this code is deployed to the production server (it is **not** deployed yet). HTTPS only. |
| Development | `http://127.0.0.1:3000/api/integration/v1` | `npm run server` on a developer machine. Plain HTTP is allowed outside production. |

Every path below is relative to the base URL.

## Security model

| Concern | How it is handled |
|---|---|
| Who may call | Only holders of an API key, sent as `Authorization: Bearer <key>`. Keys are 256-bit random (`mgpc_` + 43 characters); the server stores only their SHA-256. |
| What a key may do | Each key has scopes: `cards:verify`, `cards:link`, `cards:read`, `rewards:read` (default for new keys) and, only when an administrator grants them, `points:credit` and `points:debit`. |
| Whose card data | Card data is only readable for a card that the partner **linked** to one of its customers, which requires the card number **and** the 3-digit verification code (CVV). A key alone cannot read any card. |
| Brute force on CVVs | Verification uses the **same per-card lockout as the website login**: 3 wrong codes → temporary lock (30 s, growing), 10 → hard lock until Magical unlocks it. API and website share one failure budget, so the API cannot be used to guess more codes. Unknown card numbers behave exactly like wrong codes. |
| Secrets in responses | The CVV, its hash and the cardholder's phone number are never returned. Card numbers are returned masked (`•••• 5678` + `last4`). Transaction history does not reveal other cardholders. |
| Transport | In production, plain-HTTP requests are refused (`403 https_required`). Behind nginx/Caddy set `TRUST_PROXY=true` so `X-Forwarded-Proto: https` is honoured. |
| Browsers | Server-to-server only. Any request carrying an `Origin` header (i.e. from a browser) is refused with `403 browser_requests_not_allowed`, and integration routes never send CORS headers. The API key must never reach a browser or mobile app. |
| Rate limits | Per key: 120 credential checks (`verify`, `links`) per 10 minutes; 300 credit/debit requests per 10 minutes; 600 other requests per minute. Per IP: 30 requests with a missing/invalid key per 15 minutes. `429` responses carry `Retry-After` (seconds). |
| Logging | One row per request in `integration_request_log` (client, method, route pattern, status, error code, IP, duration). Never API keys, card numbers, CVVs or request bodies. The server console logs only method, route pattern, status and duration. |
| Points | Credits/debits only for linked customers, mandatory idempotency keys, unique references, per-partner limits, row locks and the ledger's own non-negative balance guard. See [Points](#points-credit-and-debit). |
| Data safety | Migration 005 only **adds** three tables (`integration_clients`, `pioneer_card_links`, `integration_request_log`); migration 006 adds `partner_point_operations`, two ledger types and partner limit columns. Existing Pioneer tables and rows are not changed. Unlinking never deletes a row. v1 never changes balances. |

## API keys: creating, rotating, revoking

Run these **on the server that runs the Magical backend** (same `.env`, same database). The key is shown **once**.

```bash
# create a key for the Christmas Store and write it straight into a file (nothing printed to the terminal):
npm run integration -- create-key --name christmas-store --out /secure/path/christmas-store.env
```

The file then contains one line `MAGICAL_PIONEER_API_KEY=mgpc_...`. Move that value into the Christmas Store's
secret configuration (environment variable / secrets manager) and delete the file. Without `--out` the key is
printed once to the terminal instead.

| Command | Purpose |
|---|---|
| `npm run integration -- create-key --name <name> [--scopes a,b] [--out <path>]` | New key. Default scopes: the four read/link scopes (never points). After `revoke-key` it gives the **same** partner a new key (links, operations, scopes, limits kept). Only one active key per name. |
| `npm run integration -- rotate-key --name <name> [--out <path>]` | Replaces the key on the same partner record in one step; the old key stops working at once (same scopes, links kept). |
| `npm run integration -- revoke-key --name <name>` | Key stops working immediately. Links are kept. |
| `npm run integration -- grant-scope --name <name> --scope points:credit[,points:debit]` | Adds scopes; the key is unchanged and never printed. |
| `npm run integration -- revoke-scope --name <name> --scope <scope>[,…]` | Removes scopes immediately. |
| `npm run integration -- set-limits --name <name> [--credit-per-operation N] [--credit-per-card-per-day N] [--credit-per-day N] [--debit-per-operation N]` | Partner limits for points. |
| `npm run integration -- set-display-name --name <name> --display-name "Christmas Store"` | Name shown in cardholder history. |
| `npm run integration -- list-keys` | Names, display names, key prefixes (`mgpc_xxxxxxx…`), scopes, limits, status, last use. Never full keys. |
| `npm run integration -- list-operations [--name <name>] [--card <8 digits>]` | Audit of partner credits/debits (masked card, reference, reason, idempotency key, ledger id, balance after). |
| `npm run integration -- list-links [--name <name>]` | Linked cards (masked) and customer ids. |
| `npm run integration -- unlink --card <8 digits>` | Magical-side unlink (e.g. lost card). |

Never put a key in source code, Git, chat or tickets. If a key leaks: `rotate-key`.

## Common conventions

- **Headers** on every request: `Authorization: Bearer <MAGICAL_PIONEER_API_KEY>`. Requests with a body also need
  `Content-Type: application/json` (otherwise `415`). Bodies are limited to 2 KB.
- **Responses** are JSON with `Cache-Control: no-store`. Timestamps are ISO-8601 UTC (`2026-11-04T10:15:00.000Z`).
  Points are integers.
- **`customerId`** is the Christmas Store's own, stable, non-secret id of the logged-in customer: 1-128 characters
  from `A-Z a-z 0-9 . _ : @ -`. It must come from the store's own session, never from user input.
- **Card numbers** are 8 digits; spaces/dashes are accepted (`"1234 5678"`). **CVV**: exactly 3 digits.
- **Errors** always look like:
  ```json
  { "error": { "code": "validation_failed", "message": "The request has invalid fields.", "fields": { "cvv": "Must be the 3-digit verification code." } } }
  ```
  `fields` is present only for field-level problems. Switch on `code`, not on `message`.

## Endpoints

| Method | Path | Scope | Rate bucket |
|---|---|---|---|
| GET | `/me` | any valid key | read |
| POST | `/cards/verify` | `cards:verify` | credentials |
| POST | `/links` | `cards:link` | credentials |
| GET | `/customers/{customerId}/card` | `cards:read` | read |
| GET | `/customers/{customerId}/transactions` | `cards:read` | read |
| GET | `/customers/{customerId}/rewards` | `rewards:read` | read |
| GET | `/customers/{customerId}/rewards/{rewardId}/eligibility` | `rewards:read` | read |
| DELETE | `/customers/{customerId}/link` | `cards:link` | read |
| GET | `/rewards` | `rewards:read` | read |
| POST | `/points/credit` | `points:credit` | points |
| POST | `/points/debit` | `points:debit` | points |

Errors that every endpoint can return: `401 invalid_api_key`, `403 insufficient_scope`,
`403 browser_requests_not_allowed`, `403 https_required`, `429 rate_limited`, `500 server_error`.

---

### GET `/me` — check the API key

**Auth:** Bearer key (any scope). **Rate limit:** read bucket.

```http
GET /api/integration/v1/me
Authorization: Bearer mgpc_...
```

**200**
```json
{ "client": { "name": "christmas-store", "scopes": ["cards:verify", "cards:link", "cards:read", "rewards:read"] } }
```

**401**
```json
{ "error": { "code": "invalid_api_key", "message": "Missing or invalid API key. Send it as \"Authorization: Bearer <key>\"." } }
```

---

### POST `/cards/verify` — check a card number + verification code

Tells whether the credentials are valid, without linking anything. Counts against the card's lockout like a website login.

**Auth:** Bearer key with `cards:verify`. **Rate limit:** credentials bucket (120 / 10 min per key) + per-card lockout.

**Request**
```http
POST /api/integration/v1/cards/verify
Authorization: Bearer mgpc_...
Content-Type: application/json

{ "cardNumber": "1234 5678", "cvv": "123" }
```

**200 — valid**
```json
{
  "valid": true,
  "card": {
    "number": "•••• 5678", "last4": "5678",
    "firstName": "Աննա", "lastName": "Գրիգորյան", "displayName": "Աննա Գրիգորյան",
    "status": "active", "memberSince": "2026-10-31T09:12:44.120Z",
    "linked": false
  }
}
```
`status` can be `active` or `inactive` (a deactivated card still verifies, but cannot be linked). `linked` tells
whether the card is already linked to some external account. Unnamed cards have `firstName`/`lastName` `null` and
`displayName` `"Pioneer Member"`.

**200 — invalid** (wrong code *or* unknown card number — deliberately indistinguishable)
```json
{ "valid": false, "reason": "invalid_credentials", "attemptsBeforeLock": 2 }
```

**422** — malformed input
```json
{ "error": { "code": "validation_failed", "message": "The request has invalid fields.", "fields": { "cardNumber": "Must be the 8-digit card number.", "cvv": "Must be the 3-digit verification code." } } }
```

**429** — card number temporarily locked (`Retry-After: <seconds>` header) or hard-locked
```json
{ "error": { "code": "too_many_attempts", "message": "Too many failed attempts for this card number. Retry later." } }
```
```json
{ "error": { "code": "card_locked", "message": "This card number is locked after repeated failed attempts. The cardholder must contact Magical to unlock it." } }
```

---

### POST `/links` — link a card to a customer (proof of ownership)

The customer types the card number and CVV into the store; the store backend sends them here together with the
customer's id. Possession of the CVV is the ownership proof (same as the website login).

Rules: a card can be actively linked to **one** external account in total (across all partners); a customer can
have **one** card per partner. Repeating an existing link is idempotent.

**Auth:** Bearer key with `cards:link`. **Rate limit:** credentials bucket + per-card lockout.

**Request**
```http
POST /api/integration/v1/links
Authorization: Bearer mgpc_...
Content-Type: application/json

{ "customerId": "cust_8412", "cardNumber": "12345678", "cvv": "123" }
```

**201 — linked** (**200** with the same body when this exact link already existed)
```json
{
  "link": {
    "customerId": "cust_8412",
    "linkedAt": "2026-11-04T10:15:00.000Z",
    "card": { "number": "•••• 5678", "last4": "5678", "firstName": "Աննա", "lastName": "Գրիգորյան", "displayName": "Աննա Գրիգորյան", "status": "active", "memberSince": "2026-10-31T09:12:44.120Z" },
    "balance": 200
  }
}
```

**Errors**
| Status | code | When |
|---|---|---|
| 422 | `validation_failed` | bad `customerId`, card number or CVV format |
| 422 | `invalid_card_credentials` | wrong CVV or unknown card; `fields.attemptsBeforeLock` tells how many tries remain |
| 403 | `card_inactive` | card is deactivated |
| 409 | `card_already_linked` | card is linked to another account (which one is not revealed) |
| 409 | `customer_already_linked` | this customer already has a different card; unlink first |
| 429 | `too_many_attempts` / `card_locked` | lockout, as in `/cards/verify` |

```json
{ "error": { "code": "invalid_card_credentials", "message": "The card number or verification code is incorrect.", "fields": { "attemptsBeforeLock": 1 } } }
```

---

### GET `/customers/{customerId}/card` — card info, status and balance

**Auth:** Bearer key with `cards:read`. **Rate limit:** read bucket.

```http
GET /api/integration/v1/customers/cust_8412/card
Authorization: Bearer mgpc_...
```

**200**
```json
{
  "link": {
    "customerId": "cust_8412",
    "linkedAt": "2026-11-04T10:15:00.000Z",
    "card": { "number": "•••• 5678", "last4": "5678", "firstName": "Աննա", "lastName": "Գրիգորյան", "displayName": "Աննա Գրիգորյան", "status": "active", "memberSince": "2026-10-31T09:12:44.120Z" },
    "balance": 220
  }
}
```

**404**
```json
{ "error": { "code": "link_not_found", "message": "No Pioneer Card is linked to this customer." } }
```
**422** `validation_failed` when `customerId` has invalid characters.

---

### GET `/customers/{customerId}/transactions` — balance and points history

Newest first. Query: `page` (default 1), `pageSize` (1-50, default 20).

**Auth:** Bearer key with `cards:read`. **Rate limit:** read bucket.

```http
GET /api/integration/v1/customers/cust_8412/transactions?page=1&pageSize=20
Authorization: Bearer mgpc_...
```

**200**
```json
{
  "balance": 220,
  "items": [
    { "id": "41", "type": "transfer_out", "label": "Ուղարկված փոխանցում", "description": "", "amount": -30, "balanceAfter": 220, "createdAt": "2026-11-04T10:20:11.004Z" },
    { "id": "40", "type": "admin_credit", "label": "Ադմինիստրատիվ հավելում", "description": "Christmas gift", "amount": 55, "balanceAfter": 250, "createdAt": "2026-11-04T10:18:02.511Z" },
    { "id": "12", "type": "initial_bonus", "label": "Մեկնարկային բոնուս", "description": "Pioneer Card-ի մեկնարկային բոնուս", "amount": 200, "balanceAfter": 200, "createdAt": "2026-10-31T09:12:44.150Z" }
  ],
  "total": 3, "page": 1, "pageSize": 20
}
```
`type` is one of `initial_bonus`, `transfer_out`, `transfer_in`, `redemption`, `redemption_refund`, `admin_credit`,
`admin_debit`. `label` is the Armenian label for the type; `description` is the text stored with the entry (the reward title for
redemptions, the admin's reason for adjustments, a fixed text for the initial bonus, empty for transfers). `amount` is the signed change, `balanceAfter` the balance right after it.

**404** `link_not_found`.

---

### GET `/rewards` — reward catalog

Rewards visible to cardholders: published and not ended (upcoming ones included, flagged `upcoming: true`).

**Auth:** Bearer key with `rewards:read`. **Rate limit:** read bucket.

**200**
```json
{
  "items": [
    {
      "id": 3, "kind": "course_discount", "title": "Web Programming", "description": "10% off the next course",
      "icon": "code", "pointsCost": 100, "discountPercent": 10, "discountAmount": null,
      "availableFrom": null, "availableUntil": "2026-12-31T20:00:00.000Z", "availabilityNote": "",
      "perCardLimit": 1, "upcoming": false, "soldOut": false
    }
  ]
}
```

---

### GET `/customers/{customerId}/rewards` — rewards with this card's eligibility

Same items as `/rewards`, plus per-card fields.

**Auth:** Bearer key with `rewards:read`. **Rate limit:** read bucket.

**200**
```json
{
  "balance": 190,
  "cardStatus": "active",
  "items": [
    { "id": 3, "title": "Web Programming", "pointsCost": 100, "...": "catalog fields as above",
      "redeemedByCard": 0, "limitReached": false, "affordable": true, "shortfall": 0, "eligible": true, "reasons": [] },
    { "id": 7, "title": "Laptop", "pointsCost": 5000, "...": "catalog fields as above",
      "redeemedByCard": 0, "limitReached": false, "affordable": false, "shortfall": 4810, "eligible": false, "reasons": ["insufficient_points"] }
  ]
}
```
`reasons` (empty when eligible): `card_inactive`, `not_yet_available`, `sold_out`, `per_card_limit_reached`,
`insufficient_points`. **404** `link_not_found`.

---

### GET `/customers/{customerId}/rewards/{rewardId}/eligibility` — can this card get this reward?

**Auth:** Bearer key with `rewards:read`. **Rate limit:** read bucket.

**200**
```json
{ "rewardId": 7, "title": "Laptop", "pointsCost": 5000, "balance": 190, "eligible": false, "affordable": false, "shortfall": 4810, "reasons": ["insufficient_points"] }
```
**404** `link_not_found`, or `reward_not_found` (unknown, draft, archived or ended reward):
```json
{ "error": { "code": "reward_not_found", "message": "Reward not found or not available." } }
```

---

### DELETE `/customers/{customerId}/link` — unlink

Ends the link (the row is kept as history). The card can then be linked again, to any account.

**Auth:** Bearer key with `cards:link`. **Rate limit:** read bucket.

**200**
```json
{ "unlinked": true, "customerId": "cust_8412" }
```
**404** `link_not_found`.

---

## Points: credit and debit

Partners change a linked customer's **real** Pioneer balance. Every operation is one row in the Pioneer ledger
(`pioneer_transactions`, types `partner_credit` / `partner_redemption`); the ledger's own trigger updates the balance
and refuses anything that would make it negative. There is no separate partner balance: magical.am stays the single
source of truth and the customer sees the entry in their Pioneer history.

**Permissions.** `points:credit` and `points:debit` are separate scopes, never included in a new or existing key by
default. A Magical administrator grants them explicitly (the key itself does not change):
```bash
npm run integration -- grant-scope --name christmas-store --scope points:credit,points:debit
npm run integration -- revoke-scope --name christmas-store --scope points:debit
```

**Who can be credited/debited.** Only a customer the partner has linked (`POST /links`, with card number + CVV).
There is no way to address a card by number or id; another partner's customers are `404 link_not_found`.

### Idempotency (mandatory)

Every credit/debit request needs an `Idempotency-Key` header: 8-200 characters from `A-Z a-z 0-9 . _ : -`, unique
per operation, chosen by the partner (e.g. `christmas-store:game:987`). Keys are scoped to the partner, so partners
never collide with each other.

| Situation | Result |
|---|---|
| First request | operation executed, `201` |
| Same key, same request (retry, timeout, double click, parallel duplicates) | **not executed again**; `200` with the **original** response body and header `Idempotent-Replayed: true` |
| Same key, any field different | `409 idempotency_conflict`, nothing executed |
| New key but a `reference` this partner already used | `409 duplicate_reference`, nothing executed (prevents the same game reward or order twice) |
| Missing / malformed key | `400 idempotency_key_required` / `400 invalid_idempotency_key` |

"Same request" = same endpoint, `customerId`, `points`, `reference`, `reason` and `description` (a SHA-256 fingerprint
is stored). Uniqueness of `(partner, key)` and `(partner, reference)` is enforced by the database, so concurrent
duplicates are safe too. A request that failed (e.g. `409 insufficient_points`, `422`, `500`) stores nothing: the
same key can be retried.

### Limits (per partner, configurable)

| Limit | Default | Applies to |
|---|---|---|
| `credit-per-operation` | 500 points | one credit |
| `credit-per-card-per-day` | 1 000 points | credits by this partner to one card in the last 24 h (rolling) |
| `credit-per-day` | 20 000 points | all credits by this partner in the last 24 h (rolling) |
| `debit-per-operation` | 10 000 points | one debit (debits are also limited by the card balance) |

Defaults are deliberately small compared with the existing 200-point welcome bonus. Change them per partner:
```bash
npm run integration -- set-limits --name christmas-store --credit-per-operation 200 --credit-per-card-per-day 600
```
Hard ceiling for any single operation: 1 000 000 points (the ledger's own limit).

**Rate limit:** 300 credit/debit requests per 10 minutes per key (separate bucket from reads and card checks).

**History text.** The ledger entry reads `<partner> — <description>` (or the humanised `reason` when no description
is given), e.g. `Christmas Store — Christmas game reward`. The partner name comes from
`npm run integration -- set-display-name --name christmas-store --display-name "Christmas Store"` (default: derived
from the key name). Keys, idempotency keys and internal ids are never shown to the cardholder.

### POST `/points/credit` — add points

**Auth:** Bearer key with `points:credit`. **Headers:** `Authorization`, `Content-Type: application/json`,
`Idempotency-Key`. **Rate limit:** points bucket + partner limits.

```http
POST /api/integration/v1/points/credit
Authorization: Bearer mgpc_...
Content-Type: application/json
Idempotency-Key: christmas-store:game:987

{ "customerId": "cust_8412", "points": 100, "reference": "christmas-game-987", "reason": "game_reward", "description": "Christmas game reward" }
```

| Field | Rules |
|---|---|
| `customerId` | the linked customer (same rules as elsewhere) |
| `points` | JSON **number**, whole, 1 – 1 000 000 (strings, decimals, 0 and negatives are `422 invalid_points_amount`) |
| `reference` | required, 3-100 characters `A-Z a-z 0-9 . _ : -`, unique per partner (your game round / order id) |
| `reason` | required, 2-40 characters, lower-case letters, digits, `_`, starts with a letter (e.g. `game_reward`) |
| `description` | optional, up to 200 characters, shown to the cardholder |

**201**
```json
{
  "success": true,
  "transaction": {
    "id": "1043", "type": "partner_credit", "points": 100, "amount": 100, "balanceAfter": 650,
    "customerId": "cust_8412", "reference": "christmas-game-987", "reason": "game_reward",
    "description": "Christmas game reward", "createdAt": "2026-12-20T15:02:11.208Z"
  }
}
```
`id` is the Pioneer ledger transaction id. `balanceAfter` is the balance written by that committed ledger row.
A replay returns the same body with `200`.

**Errors:** `404 link_not_found`, `403 card_inactive`, `422 invalid_points_amount`, `422 validation_failed`,
`422 partner_limit_exceeded`, `409 duplicate_reference`, `409 idempotency_conflict`, `400 idempotency_key_required`,
plus the common errors.
```json
{ "error": { "code": "partner_limit_exceeded", "message": "This operation exceeds a limit configured for this partner.", "fields": { "limit": "max_credit_per_card_per_day", "max": 1000, "usedLast24h": 950 } } }
```

### POST `/points/debit` — deduct points (partner reward / redemption)

**Auth:** Bearer key with `points:debit`. Same headers and body fields as credit.

```http
POST /api/integration/v1/points/debit
Authorization: Bearer mgpc_...
Content-Type: application/json
Idempotency-Key: christmas-store:gift:451

{ "customerId": "cust_8412", "points": 250, "reference": "christmas-gift-451", "reason": "partner_redemption", "description": "Christmas Store gift redemption" }
```

**201**
```json
{
  "success": true,
  "transaction": {
    "id": "1044", "type": "partner_redemption", "points": 250, "amount": -250, "balanceAfter": 400,
    "customerId": "cust_8412", "reference": "christmas-gift-451", "reason": "partner_redemption",
    "description": "Christmas Store gift redemption", "createdAt": "2026-12-20T15:04:40.551Z"
  }
}
```

**409 — not enough points** (nothing is deducted; there are no partial debits)
```json
{ "error": { "code": "insufficient_points", "message": "The card does not have enough points.", "fields": { "balance": 120, "points": 250 } } }
```
Other errors as for credit. Check `GET /customers/{id}/card` (balance) before offering a redemption, but always rely
on this endpoint's answer: it is the only check made under a lock.

**Reversals.** v1 has no "undo" endpoint. If a store order is cancelled after a debit, credit the points back with a
new `reference` (e.g. `christmas-gift-451-refund`, `reason: "partner_refund"`); it counts towards the credit limits.

## Error codes

| HTTP | code | Meaning |
|---|---|---|
| 400 | `bad_json` | body is not a JSON object |
| 400 | `idempotency_key_required` / `invalid_idempotency_key` | credit/debit without a valid `Idempotency-Key` |
| 401 | `invalid_api_key` | missing, malformed, unknown or revoked key |
| 403 | `insufficient_scope` | key lacks the endpoint's scope |
| 403 | `browser_requests_not_allowed` | request had an `Origin` header |
| 403 | `https_required` | plain HTTP in production |
| 403 | `card_inactive` | card deactivated (linking, credit, debit) |
| 404 | `link_not_found` / `reward_not_found` / `not_found` | nothing linked / no such reward / unknown path |
| 405 | `method_not_allowed` | wrong HTTP method for an existing path |
| 409 | `card_already_linked` / `customer_already_linked` | link conflicts |
| 409 | `insufficient_points` | debit larger than the balance (nothing deducted) |
| 409 | `duplicate_reference` / `idempotency_conflict` | reference already used / key reused with different data |
| 413 | `too_large` | body over 2 KB |
| 415 | `unsupported_media_type` | missing `Content-Type: application/json` |
| 422 | `validation_failed` / `invalid_card_credentials` | bad input / wrong card number or CVV |
| 422 | `invalid_points_amount` / `partner_limit_exceeded` | points not a whole number 1-1 000 000 / partner limit (see `fields.limit`) |
| 429 | `rate_limited` / `too_many_attempts` / `card_locked` | rate limit / temporary card lock / hard card lock |
| 500 | `server_error` | unexpected error (no details are exposed) |

(`405`, `413`, `415`, `400` and `404 not_found` come from the shared server layer and carry Armenian messages; the
`code` is what matters.)

## Connecting the Christmas Store backend

1. **Get a key.** A Magical administrator runs, on the Magical server:
   `npm run integration -- create-key --name christmas-store --out /secure/path/christmas-store.env`
   and hands the value over through a secret channel (password manager / secrets manager), never chat or email.
2. **Configure the store backend** (environment variables, never committed):
   ```bash
   MAGICAL_PIONEER_API_URL=https://magical.am/api/integration/v1     # development: http://127.0.0.1:3000/api/integration/v1
   MAGICAL_PIONEER_API_KEY=mgpc_...                                   # secret
   ```
3. **Call only from the store's backend.** The browser talks to the store backend; the store backend talks to Magical.
4. **Linking flow:** logged-in customer enters card number + CVV → store backend calls `POST /links` with the
   customer's id from its own session → on `201`/`200` show the card; on `422 invalid_card_credentials` show
   "incorrect card number or code"; on `409` explain the card/customer is already linked; on `429` show "try later".
   Never store the CVV — after linking it is not needed again.
5. **Show points:** `GET /customers/{id}/card` (balance), `/transactions`, `/rewards` — cache for at most a few
   seconds; Magical is the source of truth.
6. **Check `GET /me`** once at startup to fail fast on a wrong key or URL.
7. **Points** (after Magical grants `points:credit` / `points:debit`): give every operation its own stable
   `Idempotency-Key` and `reference` (store them with your game round / order *before* calling), and on a timeout or
   `5xx` retry with the **same** key: it can never execute twice. On `409 insufficient_points` refuse the
   redemption; on `422 partner_limit_exceeded` do not retry automatically.

### JavaScript (Node 18+, built-in fetch)

```js
// pioneer-client.js — server side only
const BASE = process.env.MAGICAL_PIONEER_API_URL;
const KEY = process.env.MAGICAL_PIONEER_API_KEY;

async function pioneer(path, { method = 'GET', body, headers = {} } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { Authorization: `Bearer ${KEY}`, ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10_000),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(data?.error?.message || `Pioneer API ${res.status}`);
    Object.assign(err, { status: res.status, code: data?.error?.code, fields: data?.error?.fields, retryAfter: res.headers.get('retry-after') });
    throw err;
  }
  return data;
}

export const checkKey = () => pioneer('/me');
export const verifyCard = (cardNumber, cvv) => pioneer('/cards/verify', { method: 'POST', body: { cardNumber, cvv } });
export const linkCard = (customerId, cardNumber, cvv) => pioneer('/links', { method: 'POST', body: { customerId, cardNumber, cvv } });
export const unlinkCard = (customerId) => pioneer(`/customers/${encodeURIComponent(customerId)}/link`, { method: 'DELETE' });
export const getCard = (customerId) => pioneer(`/customers/${encodeURIComponent(customerId)}/card`);
export const getTransactions = (customerId, page = 1, pageSize = 20) => pioneer(`/customers/${encodeURIComponent(customerId)}/transactions?page=${page}&pageSize=${pageSize}`);
export const getRewards = () => pioneer('/rewards');
export const getCustomerRewards = (customerId) => pioneer(`/customers/${encodeURIComponent(customerId)}/rewards`);
export const checkEligibility = (customerId, rewardId) => pioneer(`/customers/${encodeURIComponent(customerId)}/rewards/${rewardId}/eligibility`);

// Points. The idempotency key must stay the same for every retry of ONE operation: derive it from your own ids.
async function pointsOp(kind, idempotencyKey, body) {
  for (let attempt = 1; ; attempt++) {
    try { return await pioneer(`/points/${kind}`, { method: 'POST', body, headers: { 'Idempotency-Key': idempotencyKey } }); }
    catch (e) { if (attempt >= 3 || (e.status && e.status < 500 && e.status !== 429)) throw e; await new Promise((r) => setTimeout(r, 500 * attempt)); }
  }
}
export const creditPoints = (customerId, points, reference, reason, description) => pointsOp('credit', `christmas-store:credit:${reference}`, { customerId, points, reference, reason, description });
export const debitPoints = (customerId, points, reference, reason, description) => pointsOp('debit', `christmas-store:debit:${reference}`, { customerId, points, reference, reason, description });
```

Example (Express route in the store):
```js
app.post('/account/pioneer-card', requireLogin, async (req, res) => {
  try {
    const { link } = await linkCard(req.user.id, req.body.cardNumber, req.body.cvv);
    res.json({ card: link.card, balance: link.balance });
  } catch (e) {
    const map = { invalid_card_credentials: 422, card_already_linked: 409, customer_already_linked: 409, card_inactive: 403, too_many_attempts: 429, card_locked: 429, validation_failed: 422 };
    res.status(map[e.code] || 502).json({ error: e.code || 'pioneer_unavailable' });
  }
});
```

### Postman

Import `docs/pioneer-card-api.postman_collection.json`. Set the collection variables `baseUrl` and `apiKey`
(keep `apiKey` as a secret/current value, never in the exported collection).

## Not included

- **Undoing a points operation.** There is no reversal endpoint; a refund is a new credit with its own reference.
- **Partner operations in the admin panel UI.** They appear in the admin ledger (types «Գործընկերոջ բոնուս» /
  «Փոխանակում գործընկերոջ մոտ»); the full audit is `npm run integration -- list-operations`.
- **Cardholder-visible list of linked accounts** on magical.am, and unlinking from the admin panel UI. Today Magical
  unlinks with `npm run integration -- unlink --card <number>`.
- **Request-log retention.** `integration_request_log` grows by one row per request; prune old rows periodically if
  needed (`DELETE FROM integration_request_log WHERE created_at < now() - interval '90 days'`).
- **Multiple server processes:** rate limits are in memory per process (like the rest of the site); the per-card
  lockout is in the database and therefore global.
