# drop-late-precancel-shipment

## Mechanism

A shipment event that originated before the cancellation was accepted but arrives after it must still be applied, because the warehouse had already shipped it. The candidate rejects every shipment on a canceled order with 409, so the stock and receivables never reflect goods that left the building.

## Marked line

`demo/candidate-service/src/app.ts`, in the shipments handler, the line marked `DEFECT drop-late-precancel-shipment`: the `preCancel` check is short circuited so a canceled order rejects every shipment.

## Expected catch

- Invariant 4, `remaining-arithmetic`: a shipment whose `originated_at` precedes the cancellation and fits the unshipped canceled quantity was rejected. The rule expects it accepted.
- The diff shows the shipment answered 409 on the candidate and 201 on the reference, and the later order read differs on `shipped` and `canceled_unshipped`.

## Demo scenario

`ship-cancel-race`: create an order for five, cancel it with an origination time of ten seconds, deliver a shipment of two that originated at five seconds, then a shipment that originated at twenty seconds.
