# CRC appointment actions

CRC appointment actions are authorized with the human Agent CRC Bearer token.
The authenticated Agent CRC Bearer token is used only for identity and role
authorization. Persistent idempotency lookups, the appointment PATCH, and
immutable event CREATE use the dedicated
`DIRECTUS_CRC_WRITE_TOKEN`; that secret must never be returned or logged.

Phase 1B first reads and validates the appointment status, then updates the
single item by ID. Directus does not provide compare-and-set semantics for this
demo path, so another writer can change the appointment between those two
requests. This concurrency risk is accepted temporarily and requires a
transactional or revision-aware solution before production.

The PATCH and event creation are two separate Directus requests in Phase 1B.
If event creation fails, the appointment may already have changed and the API
returns `CRC_HISTORY_WRITE_FAILED`; operators must reconcile it using Directus
Activity/Revisions.

Event creation requests only the created item ID. Any successful Directus HTTP
response records the history even when its response body is empty or omits
system and relation fields. The CRC API reconstructs its minimal action result
from already validated application data and includes `event_id` only when
Directus returns a usable scalar ID.

Confirmation availability revalidation is intentionally deferred for the local
demo. The confirmation endpoint must not be considered production-ready until
the current appointment is excluded from a fresh availability check before its
PATCH.
