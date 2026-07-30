# HORECA voucher pivot — deferred work

Everything here was **deliberately** cut from the demo build. This is not a
backlog of oversights; each line was scoped out on purpose to keep the build
inside its time box. Read this before "fixing" anything below — the shortcut is
intentional, and in several cases the demo depends on it.

## Cut from the demo

- **`PointsLedger` audit table.** `User.score_points` is a bare int with no
  history, so there's no record of which scan earned what or which redemption
  spent it. A ledger is the right model once points have real value.
- **HMAC-signed voucher codes.** Codes are random 8-char strings with a unique
  constraint. They're guessable at scale and carry no integrity proof — a
  signed code (or a server-side check digit) is what stops someone walking in
  with an invented one.
- **Partner authentication on `/partner`.** The redemption screen is wide open:
  anyone who reaches the URL can burn a voucher and increment a partner's bulk
  credit. Needs at minimum a per-partner token in the URL or a device pairing
  step.
- **Distance-based sorting on `/rewards`.** Offers render in seed order.
  `Partner.latitude/longitude` are already populated, so this is a sort away —
  but it needs the consumer's location, and the geolocation path is already the
  flakiest part of the scan flow.
- **Stock caps.** An offer can be redeemed an unlimited number of times. No
  `max_redemptions` / `redemptions_used` columns.
- **Expiry cron.** Nothing ever writes `status = 'expired'`. Both
  `/api/partner/redeem` and `/wallet` therefore compare `expires_at` to the
  current time at read time instead of trusting the enum. **If you add the
  cron, leave those runtime checks in place** — they're the actual guard.
- **Redemption rate limits.** No throttle on `/api/rewards/redeem` or
  `/api/partner/redeem`.
- **Anti-abuse on point earning.** No scan dedupe, no image hashing, no GPS
  requirement. The same photo re-uploaded ten times earns ten times. This is
  the single biggest hole in the model and is being addressed verbally in the
  pitch rather than in code.

## Known non-atomic writes

Both inherited from the existing `incrementCustomerScore` pattern — PostgREST
has no atomic increment without a custom RPC:

- **Point spend on redeem** is read-then-write. Two concurrent redeems by the
  same user can both pass the balance check and overdraw the account.
- **`Partner.bulk_credit_issued_pkr`** is read-then-write on redemption, so
  concurrent redemptions at one partner can lose an increment.

Neither can happen with one person demoing. Both need a Postgres RPC
(`increment_partner_credit`, `spend_points`) before this sees real traffic.
