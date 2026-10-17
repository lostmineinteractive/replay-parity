# shipment-applied-twice

## Mechanism

A repeated shipment event, same `shipment_id` delivered again, returns the original response as it should, but the candidate applies the shipment a second time. Shipped quantity, stock on hand, and receivables move twice for one event.

## Marked line

`demo/candidate-service/src/app.ts`, in the shipments handler, the line marked `DEFECT shipment-applied-twice`: `applyShipment(existing.order_id, existing.quantity)` runs on the duplicate path before the stored response is returned.

## Expected catch

- Invariant 1, `shipment-applied-once`: the order view shows `shipped` above the sum of its unique accepted shipments.
- Invariant 5, `stock-on-hand`: the stock delta between the ledger reads around the duplicate is one shipment quantity too large.
- Invariant 6, `receivables`: the receivables delta in the same interval is one line total too large.
- The diff also shows it on the order read after the duplicate, but only against the reference. The invariants show it from the candidate's own recording.

## Demo scenario

`duplicate-shipment-delivery`: create an order for four, deliver a shipment of two, deliver the same shipment id again, read the order.
