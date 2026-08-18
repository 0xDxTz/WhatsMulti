# Algorithms

Every algorithm here is normative and covered by fixtures in `vectors/`.

## 1. Deterministic PRNG

Reconnect jitter must be testable across languages, so the spec fixes a PRNG:
**mulberry32**. All arithmetic is on unsigned 32-bit integers with wraparound;
multiplication truncates to 32 bits (`Math.imul` in JavaScript, plain `uint32`
multiplication in Go).

```
state: uint32   // seeded once per session

next() -> float64 in [0, 1)
    state = uint32(state + 0x6D2B79F5)
    t = state
    t = imul32(t ^ (t >> 15), t | 1)
    t = t ^ uint32(t + imul32(t ^ (t >> 7), t | 61))
    t = t ^ (t >> 14)
    return float64(t) / 4294967296.0

// `>>` is a logical (zero-filling) shift on uint32.
// imul32(a, b) is a * b truncated to the low 32 bits.
//   JavaScript: Math.imul(a, b) >>> 0
//   Go:         uint32(a) * uint32(b)
// Every intermediate is reduced to uint32 before the next step.
```

Production code seeds from a cryptographic source. Tests seed from the fixture.

## 2. Reconnect backoff

Exponential with full jitter and a floor.

```
backoff(attempt, cfg) -> int    // attempt is 1-based
    shift  = min(attempt - 1, 30)              // guards against overflow
    expMs  = min(cfg.cap_ms, cfg.base_ms << shift)
    if expMs <= cfg.floor_ms:
        return cfg.floor_ms
    return cfg.floor_ms + floor(rand() * (expMs - cfg.floor_ms))
```

- `attempt` resets to 0 on every successful transition into `open`.
- A cause whose action is `reconnect_immediate` does **not** increment `attempt` and
  does not consume a delay.
- `max_attempts` of 0 means unlimited. When a finite cap is exhausted the session
  moves to `closed` and stays there; it does **not** become `logged_out`.

Fixtures: `vectors/backoff.json`.

## 3. Storage key encoding

```
storageKey(sessionId, key) = "whatsmulti" + SEP + sessionId + SEP + encode(key)
SEP = ":"
```

`sessionId` is validated against `config.yaml#session_id.pattern` and therefore never
needs encoding. `key` is attacker-adjacent -- Signal key ids are base64 and contain
`/` and `+`, and app-state keys contain `:` -- so it is percent-encoded:

```
encode(s):  for each byte b in UTF-8(s)
              if b is one of '%', ':', '/'  ->  '%' + uppercase hex(b)
              else                          ->  b

decode(s):  reverse; '%' followed by two hex digits -> that byte
```

Percent-encoding is used because it is exactly invertible. v1 used
`replace('/', '__')` plus `replace(':', '-')`, which is not: `pre-key-5` and
`pre:key:5` collapsed to the same string.

Signal key entries are stored under `<type>-<id>`, where `<type>` is one of the ten
`SignalDataTypeMap` keys of Baileys v7:

```
pre-key   session   sender-key   sender-key-memory   app-state-sync-key
app-state-sync-version   lid-mapping   device-list   tctoken   identity-key
```

Two reserved keys sit alongside them: `creds` and `meta`.

Adapters treat values as opaque. Encoding happens above the adapter, which is why the
three key types v7 added need no adapter change.

Fixtures: `vectors/storage-keys.json`.

## 4. JID normalisation

```
normalizeJid(input) -> string | error INVALID_JID

if input already contains '@':
    split into user and server
    lowercase the server
    if server is not one of the known servers -> INVALID_JID
    strip the device suffix from user: everything from the first ':' onward
    if user is empty -> INVALID_JID
    return user + '@' + server

otherwise treat input as a phone number:
    strip every character that is not a digit (this removes '+', spaces, '-', '(', ')')
    if length <= 6            -> INVALID_PHONE_NUMBER  (too short)
    if it starts with '0'     -> INVALID_PHONE_NUMBER  (national format, not international)
    return digits + '@s.whatsapp.net'
```

Known servers: `s.whatsapp.net`, `g.us`, `lid`, `broadcast`, `newsletter`, `call`.

The two phone-number rules mirror whatsmeow's `PairPhone` validation exactly, so the
TypeScript build cannot accept an input the Go build would reject.

Fixtures: `vectors/jid.json`.

## 5. Webhook signature

See `webhook.md`. Fixtures: `vectors/webhook-signature.json`.
