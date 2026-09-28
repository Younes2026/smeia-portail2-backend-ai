# CRC appointment actions

CRC appointment actions are authorized with the human Agent CRC Bearer token.
That token is used only for `/users/me` identity and role authorization.
Persistent idempotency lookups, appointment reads and updates, availability
revalidation, and immutable event creation use the dedicated
`DIRECTUS_CRC_WRITE_TOKEN`. Neither credential may be returned or logged.

## Confirmation modes

The historical confirmation body (`internal_note` only) remains compatible and
confirms the appointment's current slot. A confirmation containing a signed
`selection.slot_token` additionally requires `agreement_channel: telephone`.
The server verifies the existing HMAC slot token and never trusts separate
date/time values from the request.

Callback, reject, and historical confirmation keep their minimal `id,status`
appointment read. The related vehicle/service/workshop/showroom fields are read
only for a selected-slot confirmation.

Selected-slot confirmation performs these steps:

1. verify the signed token and acquire the process-local shared booking lock;
2. read the appointment and require `pending` or `callback_pending`;
3. compare vehicle, service, showroom, and workshop identifiers exactly;
4. reload the existing availability snapshot with the current appointment
   excluded and run the existing domain availability check;
5. conditionally update that same appointment's date, time, and status;
6. create the existing minimal immutable CRC event.

The Directus transition uses the documented update-many `{ query, data }`
contract. Its query selects the observed appointment by ID, status, requested
date/time, and workshop. An empty Directus result is treated as
`CRC_APPOINTMENT_CONFLICT`; no unconditional fallback is used. This contract
must still be exercised in a controlled live test against the deployed
Directus version.

The client and CRC confirmation paths share one keyed lock in a single Express
process. The conditional Directus transition protects the appointment itself,
but the capacity check and update are not one SQL transaction. Multiple backend
instances therefore still require a shared transaction or distributed lock for
strict capacity serialization.

## History and idempotency limitations

The PATCH and event creation remain two Directus requests. If event creation
fails, the appointment (including its date/time for a selected confirmation)
may already have changed and the API returns `CRC_HISTORY_WRITE_FAILED`.
Operators must reconcile the appointment using Directus Activity/Revisions.

`appointment_crc_events` has no existing metadata field, so this phase does not
invent one. The event stores the existing confirmation fields and the request
fingerprint only. It never stores the slot token. Successful responses are
cached in a bounded process-local map so an immediate identical retry returns
the same enriched result even after the offer expires. After a process restart,
the persisted event can still deduplicate the request and detect a different
body, but it can reconstruct only the historical minimal response because the
previous slot is not persisted.

The availability adapter excludes the current appointment from occupying-slot
queries. The existing schedule `remaining_capacity_hours` value is consumed as
provided by Directus; if that aggregate already includes the current pending
appointment, the engine cannot add its duration back without a stronger
capacity contract. This can conservatively reject a saturated-day move and is
a known limitation of the current engine data.
