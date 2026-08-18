# Metrics contract

`GET /metrics` answers with the Prometheus text exposition format, version 0.0.4,
`Content-Type: text/plain; version=0.0.4; charset=utf-8`. No authentication: a scraper
is not an API client, and putting a bearer token in a Prometheus job config is how the
token ends up in a config repository.

Names are identical in both runtimes. A dashboard built against one build must not
break against the other, which is the whole reason this file exists rather than each
server naming its own metrics.

## Series

| Name                              | Type    | Labels                                              | Meaning                                                                      |
| --------------------------------- | ------- | --------------------------------------------------- | ---------------------------------------------------------------------------- |
| `whatsmulti_build_info`           | gauge   | `version`, `spec_version`, `runtime`, `instance_id` | Always 1. Carries the build identity in its labels.                          |
| `whatsmulti_sessions`             | gauge   | —                                                   | Sessions registered in this process.                                         |
| `whatsmulti_sessions_state`       | gauge   | `state`                                             | Sessions per state. Every state in states.yaml is emitted, including zeros.  |
| `whatsmulti_send_queue_depth`     | gauge   | `session`                                           | Sends waiting for a slot, per session.                                       |
| `whatsmulti_event_stream_clients` | gauge   | —                                                   | Open SSE connections.                                                        |
| `whatsmulti_http_requests_total`  | counter | `method`, `route`, `status`                         | Requests served, by templated route (`/sessions/{id}`, never the id itself). |

## Rules

1. **Every state is emitted, including the zeros.** A gauge that disappears when it
   reaches zero makes `rate()` and alerting lie, because the series simply stops
   rather than reporting nothing happening.
2. **The `route` label is the template, not the path.** One series per route, not one
   per session id -- a label whose cardinality follows user data is how a Prometheus
   server runs out of memory.
3. **`whatsmulti_build_info` is the only place a version appears.** Version numbers as
   metric values are useless for arithmetic; as labels on a constant gauge they join
   cleanly against everything else.
4. No metric carries a phone number, a JID or a message id.
