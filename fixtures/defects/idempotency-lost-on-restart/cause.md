# idempotency-lost-on-restart

## Mechanism

Idempotency keys are kept in memory and never written to the durable store. After a restart the same key and payload are unknown, so a retried create makes a second order and allocates stock twice.

## Marked line

`demo/candidate-service/src/app.ts`, in the store construction, the line marked `DEFECT idempotency-lost-on-restart`: `persistIdempotency: false` leaves the key table out of the durable copy that `restart` reloads.

## Expected catch

- Invariant 8, `idempotency-key`: the same key and payload produced two order ids.
- Invariant 9, `retry-no-reset`: more orders exist than distinct create commands.
- The diff shows the retried create answering with a new order id instead of the original one, and the ledger read after it differs.

## Demo scenario

`restart-around-ledger-commit`: read the ledger, create an order with an idempotency key, restart, retry the same create, read the ledger, read the order.
