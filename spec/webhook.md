# Webhook contract

A receiver must not be able to tell which runtime sent the request.

## Request

```
POST <configured url>
Content-Type: application/json
User-Agent: WhatsMulti/<spec-version>
X-WhatsMulti-Instance: <instanceId>
X-WhatsMulti-Delivery: <uuid v4, stable across retries>
X-WhatsMulti-Signature: t=<unix-seconds>,v1=<hex hmac-sha256>
```

## Body

```jsonc
{
    "specVersion": "0.2.12",
    "instanceId": "host:1234:a1b2c3",
    "events": [
        {
            "event": "message.received", // canonical name, see events.yaml
            "sessionId": "session-1",
            "ts": 1755500000000, // unix milliseconds
            "data": {}, // event payload
        },
    ],
}
```

`events` is always an array, even for a single event. Batching is a delivery
optimisation and must never change the shape.

### Which events cross the wire

Lifecycle events go out under the names in `events.yaml#lifecycle`. Driver-native
events go out under the canonical name in `events.yaml#wire_mapping` -- never under the
driver's own name, which is the one place the two runtimes would otherwise be
distinguishable. Anything not named in either list is in-process only and is never
forwarded, whatever the allow-list says.

### Binary values

`data` is whatever the driver produced, and driver payloads carry binary. JSON has no
binary type, so a byte string is encoded as:

```json
{ "type": "Buffer", "data": "<standard base64>" }
```

This is the same shape WhatsMulti uses at rest, and it is self-describing: a receiver
can tell a byte string from a text field without knowing the schema of every event.
Go's default `[]byte` marshalling produces a bare base64 string and must be overridden
to match.

A payload that cannot be serialised at all -- a cycle, a `BigInt` -- is not sent. It
goes to the dead letter with the encoding failure attached, because silently posting a
truncated event is worse than not posting it.

## Signature

```
signedPayload = <t> + "." + <raw request body bytes>
signature     = lowercase_hex( HMAC_SHA256(secret, signedPayload) )
header        = "t=" + <t> + ",v1=" + signature
```

`t` is unix **seconds** at the moment of signing and is reused unchanged across
retries of the same delivery, so a receiver's replay window applies to the original
send rather than to the last retry.

### Receiver obligations

1. Recompute the signature over the **raw** body. Re-serialising JSON changes bytes
   and breaks verification.
2. Compare in constant time.
3. Reject when `now - t` exceeds the tolerance (300 seconds is the recommended
   default).
4. Treat `X-WhatsMulti-Delivery` as an idempotency key.

### Verifying, in Node

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

function verify(rawBody, header, secret, toleranceSec = 300) {
    const parts = Object.fromEntries(header.split(',').map((p) => p.split('=')));
    if (Math.abs(Date.now() / 1000 - Number(parts.t)) > toleranceSec) return false;
    const expected = createHmac('sha256', secret).update(`${parts.t}.${rawBody}`).digest();
    const actual = Buffer.from(parts.v1, 'hex');
    return expected.length === actual.length && timingSafeEqual(expected, actual);
}
```

## Delivery

- Retry on a transport error or on any 5xx / 408 / 429 response.
- Do not retry on any other 4xx: the receiver rejected the content and will keep
  rejecting it.
- Backoff uses the same algorithm as reconnect (`algorithms.md` §2) with its own
  config block.
- Honour `Retry-After` when present; it overrides the computed delay.
- A bounded in-memory buffer holds pending deliveries. Overflow and permanent failure
  both go to the `onDeadLetter` callback rather than being dropped silently.
- Deliveries are posted one at a time, in order. Events reach the receiver in the order
  the driver produced them, and a retry never overtakes the delivery behind it.
- Config keys and defaults: `config.yaml#webhook`.

Fixtures: `vectors/webhook-signature.json`.
