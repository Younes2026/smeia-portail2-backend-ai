# Booking confirmation concurrency scope

The current booking confirmation is designed for the SMEIA single-instance
prototype. A process-local keyed lock serializes confirmations for the same
workshop/date/time slot. A bounded process-local idempotency store prevents
duplicate creation for the same client request.

The slot is always read again from Directus while holding the keyed lock,
immediately before the appointment POST. A signed slot offer is not a
reservation and never guarantees that the slot is still available.

These safeguards do not provide atomicity across multiple Express instances.
A production multi-instance deployment will additionally require:

- a Directus or SQL Server transaction/shared lock;
- a shared persistent idempotency store;
- a database constraint or equivalent invariant preventing overbooking.
