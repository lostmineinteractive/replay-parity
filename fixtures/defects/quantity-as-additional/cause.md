# quantity-as-additional

## Mechanism

`POST /v1/orders/:id/quantity` sets the total quantity. The candidate adds the submitted value to the current quantity instead. A command that should have been rejected for going below the shipped amount is accepted, because the sum is never below it.

## Marked line

`demo/candidate-service/src/app.ts`, in the quantity handler, the line marked `DEFECT quantity-as-additional`: `const nextQuantity = order.quantity + quantity` instead of `quantity`.

## Expected catch

- Invariant 4, `remaining-arithmetic`: the order view's `quantity` differs from the value of the last accepted quantity command.
- Invariant 2, `shipped-within-quantity`: a quantity command with a value below the shipped amount was accepted.
- The diff shows the order view differing on `quantity`, `total`, and `remaining`.

## Demo scenario

`partial-then-quantity-change`: create an order for six, ship two, set the quantity to four, then try to set it to one.
