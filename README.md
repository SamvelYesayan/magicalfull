# MAGICAL website

Vite + vanilla JavaScript (no framework). English and Armenian.

    npm install
    npm run dev       # http://localhost:5173
    npm run build     # output in dist/
    npm run preview

## Structure
- `index.html` — all page markup and the SVG icon sprite
- `src/styles.css` — all styling, animations, responsive rules, reduced-motion rules
- `src/main.js` — entry point (fonts, CSS, modules in order)
- `src/modules/content.js` — services, principles and process-step copy (English)
- `src/modules/translations.js` — Armenian translations, keyed by the English text
- `src/modules/render.js` — builds the cards from content.js
- `src/modules/terminal.js` — typed code window in the hero
- `src/modules/reveal.js` — scroll reveals, process line, card spotlight, contact form
- `src/modules/i18n.js` — EN / Armenian switcher (choice saved in localStorage)
- `src/modules/motion.js` — star field, parallax, card tilt, magnetic buttons, cursor glow, scroll progress
- `public/assets/` — `magical-m.png` (logo, white on transparent), `hero-network.jpg`, `brand/Magical-02.original.jpg` (your original logo file)

## Notes
- Fonts (Outfit, Inter, Noto Sans Armenian) are installed from npm (@fontsource) and bundled.
- To add or change text: edit `content.js` or `index.html`, then add/update the matching key in `translations.js`.
- The contact form does not send anything yet (see `reveal.js`, last lines). Connect it to a real email/backend before launch.
- Contact details shown: magical.am, Instagram @official_magical_company, "Armenia". No email/phone is shown because none was confirmed.

## Responsive notes
- No element may exceed the viewport width. The hero/CTA glow (`.orb`) is sized in `vw`, sections use `overflow-x: clip`, grid/flex children have `min-width: 0`, and long text uses `overflow-wrap`.
- Mobile rules (≤640 / ≤480 / ≤360px) are at the end of `src/styles.css`.

## Mobile navigation (<=960px)
- `index.html` — `#mb` (the "M" portal button, inside the header) and `#mm` (full-screen layer). Both are `display:none` above 960px, so desktop is unchanged.
- `src/mobile-menu.css` — all menu styling and animation. `src/modules/menu.js` — open/close, scroll-spy, particles, link handling.
- Menu items use the same English text keys as the desktop nav, so `translations.js` translates them automatically. Links point to the existing sections (#services, #why, #work, #process, #about, #contact).

---

# Event registration, invitations, contact form & admin panel

This section documents the backend added on top of the (unchanged) Magical website.

## Architecture

| Part | Technology | Notes |
|---|---|---|
| Frontend | Existing vanilla JS + Vite site (**not React**) | Existing sections untouched. Added pages `invitation.html`, `admin.html`; popup in `src/modules/announce.js`. |
| Backend | Node.js (see `engines` in `package.json`) | `server/` - plain `node:http` + `node:crypto`; the only runtime dependency is the `pg` driver. |
| Database | **PostgreSQL 13+** (only supported database) | `server/migrations-postgres/*.sql`, applied transactionally at start-up (advisory-locked) or with `npm run migrate`. |
| PDF | Own dependency-free PDF writer (`server/pdf/`) | Embeds Noto Sans Armenian, Inter (Latin/Latin-Ext/Cyrillic) and Outfit (all SIL OFL, licences in `server/assets/fonts/`). Streams, so a bundle of thousands of tickets uses little memory. |
| Shared code | `shared/` | Event text (`event.js`), validation (`validation.js`), barcode (`code39.js`) used by browser *and* server. |

**Database note.** Searching is case-insensitive for any script because the app stores a lower-cased `search_text`. Sorting by name uses `lower()`, so create the database with a UTF-8 locale that knows Armenian/Cyrillic case folding (e.g. `en_US.UTF-8` / an ICU locale; on Windows the default is fine). A database created with the `C` locale will not fold non-ASCII case when sorting.

## Change the event

Edit **`shared/event.js`** (title, date text, time, location, popup text). No year is stored or displayed.

## PostgreSQL setup

Requirements: **PostgreSQL 13 or newer**, **Node.js 20.19+ / 22.12+** (Vite 8 requirement), npm.

1. Create a role and two empty databases (the second one is used only by the tests and is wiped by them):
```sql
-- psql -U postgres
CREATE ROLE magical_user LOGIN PASSWORD 'choose-a-strong-password';
CREATE DATABASE magical_web      OWNER magical_user ENCODING 'UTF8';
CREATE DATABASE magical_web_test OWNER magical_user ENCODING 'UTF8';
```
2. Copy `.env.example` to `.env` and set `DATABASE_URL` (or `PGHOST`/`PGPORT`/`PGDATABASE`/`PGUSER`/`PGPASSWORD`), `APP_SECRET` and `TEST_DATABASE_URL`. There is no SQLite fallback: the server refuses to start without a valid PostgreSQL configuration. Percent-encode special characters in the URL password.

## Install & run (development)

Linux/macOS (bash) and Windows (PowerShell) use the same commands:
```
npm install                      # installs pg and updates package-lock.json
npm run migrate                  # creates/updates the tables (also done automatically at server start)
```
Create the administrator explicitly (the credentials come only from the environment; nothing is created automatically):
```
# bash:        ADMIN_USERNAME=magical ADMIN_PASSWORD='<password>' npm run seed:admin
# PowerShell:  $env:ADMIN_USERNAME='magical'; $env:ADMIN_PASSWORD='<password>'; npm run seed:admin
```
Safe to repeat: an existing admin is left untouched unless you add `-- --reset`.
```
npm run server                   # backend (API) on http://127.0.0.1:3000
npm run dev                      # frontend (Vite) on http://localhost:5173, proxies /api to :3000
```
Pages: `/` (site + popup), `/invitation`, `/admin`, `/pioneer-card` (see "Magical Pioneer Card" below).

## Production deployment

```
npm ci && npm run build          # builds dist/ (3 pages)
# .env: NODE_ENV=production, APP_SECRET (32+ chars), DATABASE_URL, TRUST_PROXY=true behind nginx/Caddy
npm run migrate                  # optional: the server also migrates at start (set DB_AUTO_MIGRATE=false to disable)
# create the admin once (see above), then remove ADMIN_PASSWORD from the environment/.env
npm start                        # production mode; same command on Windows and Linux
```
- Put it behind HTTPS (nginx/Caddy) and proxy everything (`/`, `/api`, `/admin`, `/invitation`) to the Node process; set `TRUST_PROXY=true` so rate limits use the real client IP. The admin cookie is `Secure`, so HTTPS is required in production.
- Back up the PostgreSQL database (`pg_dump`). Keep `.env` out of git (already in `.gitignore`). Use `DATABASE_SSL=true` for managed databases that require TLS.
- Several app instances may share one database (migrations are serialised by an advisory lock), but the rate limiter is in memory per process.

## Security design (summary)

- Passwords: scrypt (N=32768), constant-time verify, dummy hash for unknown users. Sessions: random 256-bit cookie, only its SHA-256 is stored; `HttpOnly; SameSite=Strict; Secure`.
- CSRF: per-session token (`X-CSRF-Token`) on every state-changing admin call + Origin check on all non-GET requests.
- Rate limits: login (5/15 min per username, 20 per IP), registration (8/10 min, 40/h per IP), contact (6/h), invitation lookup.
- Invitations are reachable only through a 256-bit secret link token (`/invitation#t=...`; only its hash is stored). Numeric IDs and invitation numbers cannot be used to read tickets. Public responses contain name + invitation number only (no phone/age).
- Duplicate submits: client disables the button and sends an `Idempotency-Key`; the server replays the same invitation for the same key, and returns 409 for the same first name + last name + phone.
- Contact spam: honeypot field, minimum fill time, link-count limit, rate limit. No CAPTCHA.
- CSP, `X-Frame-Options: DENY`, `nosniff`, HSTS (when secure), `no-store` on admin/PDF responses; parameterised SQL only; admin UI renders data with `textContent`; CSV cells starting with `= + - @` are neutralised; errors never include stack traces.

## API

| Method & path | Auth | Purpose |
|---|---|---|
| `GET /api/health` | - | Liveness |
| `GET /api/event` | - | Public event info |
| `POST /api/registrations` | - | Register `{firstName,lastName,age,phone}` (optional `Idempotency-Key`) -> `201 {invitation:{number,firstName,lastName,token,...}}` |
| `GET /api/invitations/:token` | secret token | Own invitation JSON |
| `GET /api/invitations/:token/pdf` | secret token | Own invitation PDF |
| `POST /api/contact` | - | Contact form `{name,email,phone?,service?,message?,website,ts}` |
| `POST /api/admin/login`, `POST /api/admin/logout`, `GET /api/admin/me`, `POST /api/admin/password` | login / session | Admin session |
| `GET /api/admin/stats` | session | Counts |
| `GET /api/admin/registrations?q&sort&dir&page&pageSize` | session | List/search/sort/paginate |
| `GET /api/admin/registrations/:id` and `/:id/pdf` | session | One registration / its PDF |
| `GET /api/admin/registrations/export.csv?q` | session | CSV (UTF-8 BOM, opens correctly in Excel) |
| `GET /api/admin/registrations/pdf?q` | session | One PDF, one ticket per page (streamed) |
| `GET /api/admin/messages?q&status&page` , `GET /api/admin/messages/:id` | session | Contact messages |
| `PATCH /api/admin/messages/:id` `{status: new\|read\|processed}` | session + CSRF | Update status |

Errors are always `{ "error": { "code", "message" (Armenian), "fields"? } }`.

## Tests

Tests need the isolated database `magical_web_test` from the setup above:
```
# bash:        TEST_DATABASE_URL=postgresql://magical_user:PASSWORD@127.0.0.1:5432/magical_web_test npm test
# PowerShell:  $env:TEST_DATABASE_URL='postgresql://magical_user:PASSWORD@127.0.0.1:5432/magical_web_test'; npm test
```
(or put `TEST_DATABASE_URL` in `.env`). The suite **refuses to run** unless the database name ends in `_test` and differs from `DATABASE_URL`/`PGDATABASE`, and it verifies `current_database()` before touching anything. It wipes its own tables; it never reads the normal database.



---

# Magical Pioneer Card

Loyalty / membership card system added on top of the existing site, backend and admin panel. Nothing existing was removed; the admin login, sessions and CSRF are reused.

## Pages and where the code lives

| What | Where |
|---|---|
| Public pages `/pioneer-card`, `/pioneer-card/login`, `/pioneer-card/account` | `pioneer.html`, `src/pages/pioneer.js`, `src/pioneer.css` |
| Admin section "Pioneer Cards" (tab in `/admin`) | `src/pages/admin-pioneer.js` (receives the admin page's helpers from `src/pages/admin.js`) |
| Card design (screen + print) | `src/modules/pioneer-card-view.js`, `src/pioneer.css` (`.pc`, `@media print`) |
| Card PDF at exact ID-1 size 85.60 x 53.98 mm | `server/pdf/pioneer-card.js` (uses the existing PDF writer, fonts and logo) |
| A4 print sheet, 1-8 cards, one page, fronts with CVV | `server/pdf/pioneer-sheet.js`, route `POST /api/admin/pioneer/cards/print-sheet` |
| API | `server/pioneer.js`, registered from `server/app.js` |
| Shared validation | `shared/pioneer.js` |
| Schema | `server/migrations-postgres/002_pioneer.sql` |
| Tests | `tests/pioneer.test.js`, `tests/pioneer-print.test.js` |

The footer of the main site has a "Pioneer Card" link. The single-card print ("Տպել" / "PDF") shows the logo, "PIONEER CARD", the 8-digit number and the name, or a blank line for a handwritten name. It never shows the CVV or the phone number, and it does not present itself as a payment card. The CVV is printed only by the A4 print sheet below, and only after the admin has entered it.

## Printing cards on A4 (1-8 per sheet)

Admin -> Pioneer Cards -> Քարտեր: tick cards in the first column (any combination, across pages and searches; inactive cards cannot be ticked). The bar above the table shows «Ընտրված է՝ N / 8 քարտ» and has «Ընտրել բոլորը» (adds active cards matching the current search, up to 8, and says so when more exist), «Չեղարկել ընտրությունը» and «Տպել ընտրված քարտերը». A ninth card is refused with a message.

The print dialog lists the cards in selection order (= slot order). **Where the CVV comes from** (migration `004_pioneer_cvv_escrow.sql`):
- When the server issues a code (card creation, CVV reset) it also stores it in `pioneer_cards.cvv_enc`: AES-256-GCM, key derived (HKDF) from `PIONEER_CVV_PEPPER`, so the key is never in the database; the card number is the authenticated data, so a value cannot be moved to another card. Such cards show «✓ CVV՝ ավտոմատ» and the server fills the code in itself; the browser sends only card ids and never receives the code (the API only exposes `cvvOnFile: true|false`).
- Cards issued **before** migration 004 have only the scrypt hash. The hash is not reversed, so their codes are not available automatically: the admin types the code once. With «Պահել ստուգված CVV-ները» (on by default; API `keepEntered: true`) a typed code that matched the hash is stored the same way, so the card prints automatically from then on. That is the cardholder's existing code: no CVV change, no sign-out (audit `card.cvv_stored`). The alternative, a CVV reset, issues a *new* code and signs the cardholder out, because the credential their sessions were opened with is replaced. The same applies when no pepper is configured (nothing is stored then).
- Every code, stored or typed, is checked against the card's own hash before printing; if any card has no usable code or a wrong one, nothing is printed and only those cards are flagged.

Typed codes live only in page memory and are wiped when the dialog closes. Changing `PIONEER_CVV_PEPPER` already invalidates every CVV (hashes); it also makes the stored copies unreadable (they are then treated as unavailable).

The PDF (**one** A4 portrait page, single-sided, served with `Cache-Control: no-store`, generated in memory, never written to disk):
- card fronts only, 2 columns x 4 rows, unused slots blank; each front shows its own **CVV**, small, right-aligned on the card-number row under a «CVV» label;
- cards 90 x 56.75 mm (the ID-1 design scaled uniformly, never stretched), 8 mm gaps, 2 mm bleed, crop marks for used slots, at least 5 mm from every sheet edge;
- there is no back page and no duplex, tray or copies instruction in the PDF; the only viewer preference is `/PrintScaling /None` (100 %, no fit-to-page). `tests/pioneer-sheet.test.js` checks one page for 1–8 cards, the card size, and that every CVV sits on its own card without overlapping anything.

Print at **A4, 100% / Actual size** (never "Fit to page"), one-sided, and cut on the crop marks.

Every admin print button (card list, card window, after creating a card / resetting a CVV) opens this same dialog; there is no other admin print template. `GET /api/admin/pioneer/cards/:id/pdf` (single ID-1 front, no CVV) still exists for API compatibility but the admin page no longer uses it.

Audit: each printed card gets a `card.print` entry (position, batch size, `cvv: stored|entered`); each wrong code a `card.print_cvv_mismatch` entry. Codes are never logged. Five wrong codes for one card within an hour block that card in this dialog for an hour (per server process), so it cannot be used to guess a CVV.

## Database (migration `002_pioneer.sql`)

Purely additive. No existing table or row is changed. It is applied automatically at server start (or `npm run migrate`), inside one transaction.

| Table | Purpose |
|---|---|
| `pioneer_settings` | single row; `initial_bonus` (default **200**), editable in Admin -> Pioneer Cards -> Settings |
| `pioneer_cards` | `card_no` (8 digits, `UNIQUE`), `cvv_hash` (scrypt), optional name/phone, `balance`, `status` |
| `pioneer_transactions` | **the ledger**: every balance change, with `balance_after`, type, reason, admin, transfer/redemption link |
| `pioneer_transfers` | one row per transfer, unique reference `TR-...`, idempotency key per sender |
| `pioneer_rewards` | admin-managed courses/discounts/rewards (points cost, % / AMD discount, window, quotas, status) |
| `pioneer_redemptions` | redemption requests `RD-...` that staff verify and mark fulfilled / cancel (refund) |
| `pioneer_sessions`, `pioneer_login_guard` | cardholder sessions; failed-login counters per card number |
| `pioneer_announcements`, `pioneer_audit_log` | member news; admin actions (never contains CVVs) |

Integrity is enforced **in the database**, not just in the app:
- A trigger applies each ledger row to `pioneer_cards.balance` under a row lock. `CHECK (balance >= 0)` makes overdrafts impossible. A direct `UPDATE ... SET balance` (or inserting a card with a balance) is rejected, and ledger rows cannot be updated or deleted.
- A partial unique index allows only **one `initial_bonus` per card**, so logging in never awards points.
- Transfers and redemptions run in one transaction: cards are locked in id order (no deadlocks), and an `Idempotency-Key` per request makes double clicks and retries replay instead of repeating.

**Rollback.** This destroys Pioneer data only; take a `pg_dump` first:
```sql
BEGIN;
DROP TABLE pioneer_transactions, pioneer_redemptions, pioneer_transfers, pioneer_sessions, pioneer_login_guard,
           pioneer_audit_log, pioneer_announcements, pioneer_rewards, pioneer_cards, pioneer_settings CASCADE;
DROP FUNCTION pioneer_apply_transaction(), pioneer_ledger_immutable(), pioneer_cards_guard_balance();
DELETE FROM schema_migrations WHERE version = '002_pioneer.sql';
COMMIT;
```
Then remove `002_pioneer.sql` and the code, or it will be re-applied at the next start.

## Environment variables (new, both optional)

| Variable | Default | Meaning |
|---|---|---|
| `PIONEER_SESSION_TTL_HOURS` | `4` | cardholder session lifetime (1-72 h) |
| `PIONEER_CVV_PEPPER` | empty | secret mixed into CVV hashes. **Recommended in production.** Set it before creating cards: changing it invalidates all CVVs (use "Reset CVV"). |

## Security design and known limitation

- Login is card number + 3-digit CVV. **A 3-digit code has only 1000 values, so this credential is weak by nature.** The mitigations:
  - **Per-card-number lockout stored in PostgreSQL** (survives restarts, shared by all instances). After 3 failures the number is locked for 30 s, then 2 min, 10 min, 30 min, 2 h, 6 h, 24 h. After 10 failures it is **hard-locked until an admin unlocks it**. An attacker therefore gets at most 10 guesses per card, about 1%. Attempts are counted atomically *before* the CVV is checked, so parallel requests cannot slip past the lock. A locked number rejects even the correct CVV.
  - Unknown card numbers go through the identical path: same counter, same scrypt cost (dummy hash), same 401 body. Responses do not reveal whether a card exists.
  - Per-IP limits: 15 login attempts / 15 min and 60 / day (in memory, per process, like the existing limits).
  - Trade-off: someone who knows a card number can deliberately lock it. The owner then asks Magical. Admins see the lock state on the card and can unlock it or reset the CVV.
- The CVV is hashed with scrypt (the existing password hashing), bound to the card number and optionally peppered. It is never stored or logged in plain text and never returned except **once** to the admin at creation/reset. Since migration 004 an encrypted copy is kept for the A4 print sheet only (see "Printing cards on A4"); login still uses only the hash.
- Sessions: random 256-bit cookie `mg_pioneer` (only its SHA-256 is stored), `HttpOnly; SameSite=Strict; Secure` (in production). A new id is issued on every login, and the old one is revoked. Every protected request re-checks that the card is active. Deactivating a card or resetting its CVV ends all its sessions.
- CSRF: per-session token in `X-CSRF-Token` plus the existing Origin check. Login and the API accept only `application/json`.
- The server is authoritative for balances, costs, eligibility and transfer amounts. Phone numbers are visible only to admins. Cardholders see other members only as name (or "Pioneer Member") plus the last 4 digits of their card number.
- Admin endpoints use the existing admin session + CSRF middleware. Every point adjustment needs a reason and is recorded with the admin, timestamp and ledger row. All admin actions go to `pioneer_audit_log`.
- Possible later hardening (not implemented, because no free service is available in the stack): a second factor such as an SMS/e-mail code for new devices.

## Gift cards for approved requests (migration `003_pioneer_gift_card.sql`)

A redemption request now goes through these statuses:

| Status | Admin label | Cardholder sees |
|---|---|---|
| `pending` | Սպասող | «Սպասում է հաստատման», no gift card |
| `approved` | Հաստատված · սպասում է ստացման | «Նվերի ստացման քարտ» with code `MG-XXXX-XXXX-XXXX`, approval date, pickup instructions and both phone numbers |
| `fulfilled` | Տրամադրված | the same card marked «Տրամադրված է» (handed over) |
| `cancelled` | Չեղարկված | no gift card; points refunded once |

- **Approval is not hand-over.** «Հաստատել» issues the gift card; «Տրամադրված է» is a separate action staff take when the gift is physically given out. Both are recorded with the admin and in the activity log.
- **The code is issued on the server, once.** It is 60 random bits from `crypto.randomBytes` and is unique in the database. Repeated or parallel approvals return the same card. Approving never touches points; cancelling refunds only once.
- **Visibility.** A gift card is only returned by `GET /api/pioneer/redemptions` for the signed-in card. There is no by-id route, and the code is not put in URLs or browser storage. Admins can search requests by gift code (with or without dashes).
- **Older data.** Existing requests are unchanged. Requests that were already `fulfilled` before this migration have no gift code. The old admin call `pending -> fulfilled` still works and issues a code in the same step.
- **No QR code.** There is no public verification route, so no QR code is shown. Staff verify a code in Admin -> Pioneer Cards -> Հայտեր.

**Restart the server together with the new build.** `npm run build` replaces the files the running server serves immediately, but Node keeps running the old server code until it is restarted. An old server rejects «Հաստատել» (`status: approved`) with «Անվավեր կարգավիճակ։». The admin page detects this, shows a warning and disables approval until the server is restarted.

**Applying it.** The server applies pending migrations at startup (`DB_AUTO_MIGRATE=true`, the default), so restarting the server applies 003 to its database. To apply it deliberately instead: back up with `pg_dump`, set `DB_AUTO_MIGRATE=false`, run `npm run migrate`, then restart.

**Rollback** (only if there are no `approved` rows; gift codes are lost):
```sql
BEGIN;
UPDATE pioneer_redemptions SET status = 'pending' WHERE status = 'approved'; -- or decide per row
ALTER TABLE pioneer_redemptions DROP CONSTRAINT pioneer_redemptions_approved_has_gift, DROP CONSTRAINT pioneer_redemptions_gift_issued,
  DROP CONSTRAINT pioneer_redemptions_gift_code_format, DROP CONSTRAINT pioneer_redemptions_gift_code_key,
  DROP COLUMN gift_code, DROP COLUMN approved_at, DROP COLUMN approved_by,
  DROP CONSTRAINT pioneer_redemptions_status_check, ADD CONSTRAINT pioneer_redemptions_status_check CHECK (status IN ('pending','fulfilled','cancelled'));
DELETE FROM schema_migrations WHERE version = '003_pioneer_gift_card.sql';
COMMIT;
```

## Bulk "delete" = retire (Admin -> Pioneer Cards -> Քարտեր -> «Կառավարում»)

Tick cards (any number, across pages; «Ընտրել բոլորը» takes every card matching the current search/filter) and use «Ջնջել ընտրվածները», or «Ջնջել բոլոր քարտերը». The server first returns a preview (`POST /api/admin/pioneer/cards/bulk-preview`, `{ids}` or `{all:true}`): cards, balances, ledger rows, transfers (and how many involve unselected cards), other cards' history that names them, redemptions by status, gift codes, audit entries, active sessions.

**Permanent deletion is blocked.** Every app-created card has an immutable ledger row (initial bonus) and a `card.create` audit entry, and ledger, transfers (sender and recipient), redemptions and the audit log reference `pioneer_cards` without `ON DELETE`. Deleting would destroy financial history, including other cards' transfer history. The operation therefore **retires** the cards: the existing deactivation (`status = 'inactive'`, the cardholder's sessions ended). Nothing else changes: balances, ledger, transfers, redemptions (pending/approved stay workable for staff), gift codes, CVV hash/copy, audit log. Reversible per card with «Ակտիվացնել».

Execution (`POST .../cards/bulk-retire`, `{ids|all, token, confirmCount}`) needs the preview's token (bound to the exact cards and their status, so a changed list or a repeated request gets 409) and the typed number of cards. It runs in one transaction with row locks (parallel duplicates run once) and writes `card.deactivate` per card plus one `cards.bulk_retire` summary (admin, scope, ids, counts, outcome); a failed attempt is rolled back and logged with `outcome: failed`.

## Course discounts

A redemption deducts points and creates a request with a code (`RD-...`). The discount is **not** applied to any payment or enrollment system automatically, because no such integration exists. Staff check the code in Admin -> Pioneer Cards -> Requests and mark it fulfilled, or cancel it (points are refunded through the ledger).

## API (summary)

Cardholder (cookie `mg_pioneer`; non-GET requests need `X-CSRF-Token`; transfers/redemptions need `Idempotency-Key`):
`POST /api/pioneer/login`, `POST /api/pioneer/logout`, `GET /api/pioneer/me`, `GET /api/pioneer/transactions`, `GET /api/pioneer/rewards`, `GET /api/pioneer/redemptions`, `POST /api/pioneer/redemptions`, `POST /api/pioneer/recipient`, `POST /api/pioneer/transfers`, `GET /api/pioneer/announcements`.

Admin (existing admin session + CSRF), under `/api/admin/pioneer`:
`GET stats`; `GET|POST cards`; `GET|PATCH cards/:id`; `POST cards/:id/status|cvv|unlock|adjust`; `GET cards/:id/transactions|pdf`; `POST cards/print-sheet` (`{cards:[{id,cvv?}] (1-8), keepEntered?}` -> one-page PDF); `GET transactions`; `GET redemptions` (filter `status=pending|approved|fulfilled|cancelled`, search by card, `RD-` reference or `MG-` gift code), `POST redemptions/:id/status` (`approved`, `fulfilled`, `cancelled`); `GET|POST rewards`, `PATCH|DELETE rewards/:id` (delete only if never redeemed; otherwise archive); `GET|POST announcements`, `PATCH announcements/:id`; `GET audit`; `GET|PUT settings`.

## Deploying the update

1. Back up the database (`pg_dump`).
2. Optionally set `PIONEER_CVV_PEPPER` (and `PIONEER_SESSION_TTL_HOURS`) in `.env` **before** creating the first card.
3. `npm ci && npm run build` (the build now has 4 pages), then `npm run migrate` (or let the server migrate at start), then restart the server.
4. The reverse proxy must also forward `/pioneer-card` (and its subpaths) to the Node process. The existing "proxy everything" setup already covers this.
