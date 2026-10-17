# Mapping the harness onto an order management system

The harness is domain agnostic. It records HTTP or bus traffic, replays it against a candidate, diffs the responses under rules that are data, gates on latency and correctness, checks each system against its own invariants, and reduces a failure to a reduced reproduction. The demo speaks the language of an inventory and fulfillment service so the repository stays free of market vocabulary. This document, and only this document, maps the demo onto an order management system migration, where the reference is the incumbent OMS and the candidate is its replacement. The vocabulary below is permitted in this file alone, and `scripts/check-prose.sh` exempts it by exact path.

## The twelve demo scenarios

| Demo scenario                | What the demo does                                                                                           | OMS equivalent                                                                                                                                                                                      |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| full shipment                | Create an order for three units, ship three, read the order.                                                 | A parent order filled in one execution. Position and cash move once.                                                                                                                                |
| multiple partial shipments   | Create for five, ship two then three.                                                                        | A parent order filled in two child executions. Cumulative filled quantity reaches the order quantity.                                                                                               |
| duplicate shipment delivery  | Deliver the same shipment id twice.                                                                          | A duplicate execution report from the venue or the drop copy. The second report must not move position or cash.                                                                                     |
| cancel before shipment       | Cancel, then a shipment event arrives that originated after the cancel.                                      | A cancel acknowledged, then a late fill that originated after the cancel. The late fill is rejected.                                                                                                |
| partial then cancel          | Ship two, then cancel the rest.                                                                              | A partial fill followed by a cancel of the remaining quantity. Filled quantity stays, open quantity goes to zero, and the unfilled canceled quantity is tracked.                                    |
| partial then quantity change | Ship two, set the quantity to four, then try to set it to one.                                               | A cancel replace that changes order quantity above the filled amount, then one that would go below it. The second is rejected.                                                                      |
| ship cancel race             | Cancel with origination time ten, then a shipment that originated at five, then one at twenty.               | A fill and a cancel racing. A fill that originated before the cancel took effect still counts. A fill after it does not.                                                                            |
| shipments out of order       | Deliver a later shipment before an earlier one.                                                              | Execution reports arriving out of sequence. Cumulative quantity and average price must not depend on arrival order.                                                                                 |
| stock rejection              | Create an order for more than the stock on hand.                                                             | A pre trade check rejects an order that exceeds the available limit. The order exists in a rejected state and never trades.                                                                         |
| disconnect and replay        | Retry a create with the same idempotency key, then once more with a different payload.                       | A session disconnect followed by a resend. The resend with the same client order id and the same terms is the same order. A resend with different terms is rejected as a duplicate client order id. |
| timed out submit retried     | Submit, see no answer, resend the same key later, then ship.                                                 | A new order single that timed out at the client and was resent. One order exists and the fills attach to it.                                                                                        |
| restart around ledger commit | Read the ledger, create with a key, restart the service, resend the same key, read the ledger and the order. | An OMS restart between a persisted order and a resend. Recovery must restore the client order id table along with positions and cash.                                                               |

## The ten invariants, restated

The harness evaluates these for each system from its own recording alone. Agreement between the two systems is not evidence that either is right.

1. An accepted execution changes position and cash exactly once, including after a resend or a restart.
2. Filled quantity never exceeds the effective order quantity, after any cancel replace.
3. Cumulative filled quantity never decreases.
4. Open quantity equals order quantity minus filled quantity for a live order and is zero after a cancel. The canceled unfilled quantity is tracked separately. A fill that originated before the cancel took effect is applied and a later one is rejected.
5. Position equals the starting position plus manual adjustments minus the unique accepted executions.
6. Cash equals the sum of the unique execution notionals, computed in decimal, never in binary floating point.
7. A rejected order produces no executions.
8. The same client order id with the same terms has one effect. The same client order id with different terms is rejected.
9. A resent message cannot reset state or create a second order.
10. Pre trade acceptance is deterministic given the order and the limit snapshot in the recording.

## What carries over

The capture proxy sits in front of the incumbent and records client traffic with tags per message type. The replay sends the same traffic to the replacement at the recorded pace, with substitutions for the identifiers each system assigns, barriers around snapshot reads, and restarts replayed as harness controls. The thresholds gate on latency per message type and on mismatch rate. The invariants check each system's own log. The shrinker turns a failing run into the few messages that reproduce it. The agent proposes messages the recording did not contain. The report is one file a reviewer can read offline.
