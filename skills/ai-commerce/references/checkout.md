# MegaMarket purchase flow

This flow permits new carts, orders and payments only for MegaMarket. Establish
the user's buying intent, item/quantity and budget including delivery. Do not
add repeated approvals for technical steps already covered by that mandate.
Ask only about missing material choices or a price/terms change outside it.

The following are decision checkpoints, NOT a fixed sequence of API calls. The
current tool schemas, descriptions and returned state determine which operation
is needed next. Skip a checkpoint already satisfied by reliable returned data;
never invent a required lookup, update, payment, completion or order-read step.
Never use array position (such as the first delivery/payment option), remembered
tool names, status enums or field paths as a substitute for their meaning.

1. Select the relevant current tool schemas locally from this operation's retained
   full discovery response. Fetch it if absent or stale. Keep the exact selected offer's
   item/store/sku identifiers. Product lookup is useful when needed and supported
   for that ID format, not a mandatory extra call before every checkout.
2. Create a checkout only once buying intent is established. This can change a
   merchant cart/profile even before an order exists. Inspect the resulting cart
   for exactly the intended items/quantities; do not include unexpected contents.
3. Follow the returned fulfillment requirements. If the contract requires a
   destination before delivery options, select it and inspect the new options;
   otherwise use the already returned options. A destination is not itself a
   delivery option; selection may produce refreshed options.
   An empty shipping group is not an available courier service. Do not invent
   option identifiers or fields. Use only schema-supported calls to obtain the
   next options; if none is available, stop before creating/paying an order.
4. Present the actual choices for this offer/location: courier, pickup point
   (ПВЗ), or store pickup. Store pickup is not ПВЗ. Show returned delivery fee,
   address and date/window; no returned date means no promised date. Use existing
   user preferences to select within the mandate, otherwise ask one focused question.
5. Send provided apartment, entrance, floor, intercom and comment through their
   supported fields. Check the final order details; a local echo alone is not
   merchant confirmation. Never silently omit required address details. If they
   cannot be confirmed, clarify or choose an explicitly approved alternative.
6. Check final items, quantity, full total, delivery and payment method BEFORE
   selecting payment in an update: that operation may already create an order
   and invoice. Do not assume `complete_checkout` is the first committing step.
7. Use the actual returned payment handler/configuration (including handlers
   without a separate links array). Pay only with an available authorized payment
   tool and according to its instructions, or give the returned payment link for
   the user to pay. A separate SberPay CLI is not required for search/checkout.
8. Verify the payment outcome. `ok:true`, a readiness status, an invoice or a
   created order does not mean paid. Check JSON-RPC/tool isError too. Complete
   only after confirmed payment when the schema calls for it. Read the order when
   needed to establish the outcome; do not call completion or order-read merely
   because they appear in this list.
9. Report the known final state, actual total, destination and returned order
   number/link/date. Never fabricate a paid confirmation or collection readiness.

Use a documented idempotency key for the exact mutation payload. After a timeout
or uncertain update/pay outcome, read the existing order/payment state; do not
create a replacement order or automatically pay again. A definitive DECLINED
means payment was refused, not permission to retry. Report an unpaid order as
unpaid. Do not cancel earlier orders or clear other cart contents for recovery.

For status, tracking or cancellation, discover the corresponding current schema
and use it only as requested. A read of stored checkout data need not refresh
merchant availability: do not imply it does unless the operation guarantees it.
Do not update the local skill/CLI in the middle of this flow. If a user requests
an update, finish or safely suspend the flow first; it never authorizes a replay.
