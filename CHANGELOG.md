# Changelog — @k9o/core

## 1.5.2

### Changed

- `K9O_TIER_FEATURE_GATED` is no longer documented as an error to expect: the platform no longer gates features by plan.
- The LLM model type no longer has `tierGate`, which the gateway does not send.
- The `tierGating` option is removed from sign-in provider creation; the platform no longer gates features by plan.
- README: Architecture at a glance, illustrations, and the package table lists only the packages for that SDK.

## 1.5.0

### Added

- `approvals.comments.add(id, { body, visibility })` (`POST /@<project>/pending-approvals/<id>/comments`) and `approvals.comments.list(id, { limit?, cursor? })` (`GET` on the same path): comments on a pending change. `body` is plain text of 1 to 4,000 characters and `visibility` (`everyone` or `approvers_only`) is required and fixed when posted; a bad value is refused with `K9O_INVALID_FIELD_VALUE` before sending. `list` is oldest first and returns `{ data, nextCursor, meta }`. Posting needs a session. `ApprovalComment`, `ApprovalCommentVisibility`, `ApprovalCommentPage`, `AddApprovalCommentInput` and `ListApprovalCommentsOptions` are exported.
- `realtime.replay(topic, options?)` (`POST /@<project>/realtime/replay`): one call of a topic's ledger catch-up, next to `realtime.subscribe`. The topic is required; options `fromSequence`, `untilSequence`, `limit` (1 to 10000) and `afterAuditEventId` (audit topics). Returns `{ topic, events, nextCursor, hasMore, resync? }` with events in the realtime shape plus `sequence`. `RealtimeReplayOptions`, `RealtimeReplayPage` and `RealtimeReplayEvent` are exported. `audit.replay` is unchanged.
- `schema.collections.get(name)` (`GET /@<project>/schema/collections/<name>`): one collection with its columns, indexes and relationships. `CollectionDetail`, `CollectionColumn`, `CollectionIndex` and `CollectionRelationship` are exported.
- `crypto.mode()` and `crypto.mode(crypt)` return the gateway's `route` (`"client"` or `"server"`) on the result as `CryptoMode.route`, absent on older gateways or for an unknown value; follow it, not `custodyMode`.
- The custody check before each `encrypt` names the crypt (`GET /crypto/mode?crypt=<crypt>`), so a personal access token or workload policy scoped to named crypts can encrypt; `crypto.mode()` still sends no query.
- `crypto.mode(crypt?)` takes an optional crypt and sends `?crypt=<crypt>`; a bad crypt is refused with `K9O_INVALID_FIELD_VALUE` before sending. With none it is unchanged.
- `crypto.encrypt` follows the `route` field of the project's mode answer (`GET /crypto/mode`). For BYOK and HYOK only an explicit `route: "server"` sends plaintext to the platform (it needs an `epoch`, otherwise `K9O_CRYPTO_CUSTODY_UNKNOWN`); a missing `route` or `"client"` uses the client core. A `route` that is neither `"server"` nor `"client"` is refused with `K9O_CRYPTO_CUSTODY_UNKNOWN` in every custody mode, and nothing is sent. The mode is still read fresh before every encrypt.
- `crypto.federatedToken({ crypt, op })` (`POST /crypto/federated-token`): a short-lived identity token (RS256 JWT, at most 15 minutes) to present to your own cloud's token exchange for BYOK and HYOK keys. Returns `{ token, expiresAt, issuer, subject, audience, kid }` (`FederatedToken`). A crypt that does not match `[a-z0-9-]{1,64}` or an `op` other than `encrypt`, `decrypt` or `rewrap` is refused before sending (`K9O_INVALID_FIELD_VALUE`). 409 `K9O_CUSTODY_SERVER_ROUTE`, 429 `K9O_RATE_LIMITED` and 503 `K9O_KEY_SERVICE_UNAVAILABLE` are raised as they come and never retried. `FederatedToken` and `FederatedTokenRequest` are exported.
- `expectedKeyRefs` client option: the identifiers of your own KMS or HSM keys, for BYOK and HYOK. The SDK passes the list to the client core as `{ expectedKeyRefs }` on every `encrypt`, `decrypt` and `rewrap`, and the core refuses a key that is not in it before it uses any token or makes any network call (the key version is ignored). A client built with an empty list, a `*` or a blank entry is refused with `K9O_INVALID_FIELD_VALUE`. `ClientCryptoCore` methods take the options as a third argument, and a core declares that it enforces the pin with `enforcesExpectedKeyRefs: true`; with the option set and no declaration the call is refused with `K9O_CRYPTO_KEY_PIN_UNENFORCED` before the core is called. `keyRefMatches(keyRef, expected, provider)` compares by the named provider's rule (the provider is required, never inferred from the reference) (AWS whole reference; GCP without the version; Azure the first five parts in lower case; Vault `<path>/<key>` without `:<version>`). `keyRefMatches`, `ClientCoreOptions` and `KeyRefProvider` are exported.
- `k9o.rampart`: `classify(input, { label })`, `jwks()` and `verifyReceipt(result, input, options)`. `classify` returns the verdict (`classification`, `riskScore` and `confidence` in basis points,
  `categories`, `calibrationVersion`), `classificationReceipt` and `projectId` as received; while the classifier is unavailable it throws `K9O_RAMPART_CLASSIFIER_UNAVAILABLE` (503), never a default pass. Rampart is advisory: the caller blocks.
  `verifyReceipt` takes the classify result or a bare receipt string and checks the key by `kid`, `alg` EdDSA, `typ`, the signature, the issuer (from the key feed, which `jwks()` returns as `{ keys, issuer }`, or the `issuer` option),
  the project (the signed `project_id` against the `projectId` option or the one the classify result carries), the time window (60 s clock skew) and the SHA-256 of the canonical input, and returns the verified claims or throws
  `RampartReceiptError` with a `reason` (`malformed`, `key_unavailable`, `key_unknown`, `alg`, `typ`, `signature`, `issuer`, `project`, `project_unknown`, `expired`, `not_yet_valid`, `input_hash`). It fetches `/rampart/jwks` itself unless you pass `keys`,
  keeps the keys for the life of the client and refetches once on an unknown `kid`. The input is canonicalised with the platform's JSON profile (keys sorted by UTF-8 byte order, integers only up to 2^53-1), so an input with a fractional number cannot be classified or verified; send such values as strings.
  `jcsCanonicalize` and SHA-256 are in the package; no new dependency.
  A long input is scored in overlapping windows and the highest injection score decides; past 16 windows (about 6,000 tokens) the answer is 413 `K9O_RAMPART_INPUT_TOO_LONG` with no verdict, and 503 `K9O_RAMPART_CLASSIFIER_UNAVAILABLE` still means the classifier could not answer.
  The thresholds (calibration `rampart-launch-v1`) are a starting calibration and may move; a change is a new `calibrationVersion`.
  `verifyReceipt` returns `windows`, the number of windows the receipt says were scored (a receipt without the claim reads as 1; a `windows` that is not a positive integer is refused as `malformed`), and ignores claims it does not know.
  `RAMPART_ERROR_CODES` and `isRampartInputTooLong(e)` name the two no-verdict errors.
- `k9o.analytics` (datasets): `list`, `query` (read-only SQL over `dataset.<slug>` tables), `create`, `get`, `delete`, `materialize`, `read` (cursor pages in `meta.cursor.next`), `write` (an array or newline-delimited JSON, with `onError`),
  `upload` (multipart CSV or JSON, with `dryRun` and a creating `manifest`) and `downloadOriginal` (the stored file as bytes), plus `analytics.rollups` and `analytics.schedules` (`create`, `list`, `delete`, `reattest`).
  `k9o.rollups`: `list`, `read` (`from`, `to`, `dims`; suppressed cells arrive as `{ status: "suppressed", reason: "cohort_below_k" }`) and `subscribe` (one `cell` event per closed cell, `payload` being the cell with `cellKey`, `bucket`, `dims`, `measures`, `final`; a suppressed cell sets `suppressed: true`; frames are deduped on `eventId` and resumed from the frame's `id:`, with `fromSequence` on the first connection; `onResync` is called with action `reread-source`).
  A rollup or schedule pauses once its `reattestIntervalDays` (7, 30, 90 or 365) pass without a re-attestation. `reattest` is for people only: a service, workload or extension token gets 403 `K9O_RBAC_DENY` with `context.reason` `human_only` (a personal access token acts as its person).
- `k9o.keys`: `list` (`status: "all"` adds rotating and revoked versions), `get` and `rotate` for the project's encryption keys. Keys are metadata only (`id`, `version`, `status`, `custodyMode`, `createdAt`, `rotatedAt`, `byokRef`, `hyokRef`); no key material.
  Reading needs the project-admin or project-auditor role; `rotate(keyId, { stepUp })` needs project admin plus a step-up proof: 401 `K9O_STEP_UP_REQUIRED` carries the challenge at `context.stepUp` (also `stepUpChallengeOf(error)`), and an optional `stepUp` hook receives it with the HTTP method and URL and returns `{ method, proof }`; the SDK sends `x-k9o-step-up-proof` and retries exactly once (a second 401 is thrown, never looped). `list` is not paged and returns `{ items }`. `rotate` also answers 409 `K9O_STATE_CONFLICT` (`rotation_in_flight`, `key_not_active`) or 429 `K9O_RATE_LIMITED` (`rotation_rate_cap`: 3 per rolling 24 hours; `key_service_busy`).
- `k9o.audit.tail(options)`: follow the project's audit log live (`types`, `signal`, `onResync`, `idleTimeoutMs`, `retryDelayMs`). Events are `{ auditEventId, type, actorType, occurredAt, outcome, eventId }` (`outcome` is `null` when there is none, `eventId` is the stream frame's own id); read the full row with `audit.query`.
  The five fields are unwrapped from the gateway's `payload`. The stream's `id:` and `eventId` belong to the frame, not to the audit event: the reader dedupes on `eventId` and resumes with `Last-Event-ID` set to the frame's `id:`. On a `replay-ledger` resync it calls `onResync`, replays the audit log after the last `auditEventId` received (pages while `hasMore`), yields the catch-up once, and continues live. `warden.checkpoint` is not in the live tail.
  `k9o.audit.replay({ afterAuditEventId | fromSequence })` returns one page `{ events, nextCursor, hasMore }` from the audit log in order; each event is flattened the same way and carries its `sequence` (a string).
  After a `resync` the tail now connects fresh first, buffers its frames, replays from the last delivered `auditEventId`, then merges replay, buffer and live once each (nothing published in between is lost; two resyncs in a row back off); `audit.replay` sends `limit: 1000` when none is given and refuses a limit below 1 or above 10000 with `K9O_INVALID_FIELD_VALUE`.
- `k9o.rampart.classify` refuses an `input` that is not a JSON object before sending, with `KError` `K9O_INVALID_FIELD_VALUE` (the gateway reads a bare string wrongly).
- `k9o.crypto` (server-side encryption): `encrypt`, `decrypt`, `rewrap` on `POST /crypto/{encrypt,decrypt,rewrap}` with `{ crypt, items }`, 1 to 100 items, bytes or UTF-8 strings in and out (the SDK does the base64), 64 KiB per item and 1 MiB per call, context up to 256 bytes; limits are checked before sending with `K9O_INVALID_FIELD_VALUE` and `K9O_PAYLOAD_TOO_LARGE`. Each batch item carries its own result or code; the item shape follows the gateway. Machine calls (encrypt needs a crypt grant; decrypt and rewrap need a service token created with the crypt, a workload policy that names it, a scoped personal access token created with step-up, or a session with a fresh step-up; extensions, end users and mobile cannot call it; IAM on the crypt decides, default floor `PROJECT_EDITOR`). The calls route by custody: `encrypt` reads the project's custody mode (`crypto.mode()`, never cached) on every call and sends plaintext to the platform only for platform-held keys, with the epoch as `custodyEpoch`, re-routing once on 409 `K9O_ZK_STORE_FLOW_REQUIRED`; an unknown, missing or malformed mode answer raises `K9O_CRYPTO_CUSTODY_UNKNOWN` (no HTTP status; `context.custodyMode` is the value seen) and a failed mode call rethrows its own error unchanged; neither sends anything. `decrypt` and `rewrap` try the platform first and open the ciphertext through the client core (`crypto.useClientCore(core)`, filled by the Kibo binding) when the platform answers 409 with `context.route` `client`. With no client core, a BYOK or HYOK project gets 501 `K9O_ZK_CLIENT_CORE_UNAVAILABLE` and nothing is sent. Ciphertext follows the project KEK's lifecycle only (a zeroize or purge makes it unreadable; per-subject erasure does not reach it). It is a different construction from client-side Kibo and from `k9o.kibo.encrypt`, with its own AAD domain; none opens another's ciphertext. Give the same crypt and context on decrypt. Never retried after a 5xx. The gateway route is not live yet; a 404 is expected today.
- A `Retry-After` header on an error answer now sets `KError.retryAfterSec` when the error body gives no wait of its own.
- `Moat` (also `@k9o/core/moat`): a local guard for a model call, with no network access. `messages(input)` pins your prompt as the only `system` message and refuses input carrying a role or system marker;
  `checkOutput(output)` enforces an output schema and an optional PII filter; input and output schemas use a documented JSON Schema subset (other keywords are rejected at construction); `promptSha256()` hashes the pinned prompt.
  Refusals are `MoatRefusal` with `reason` `role_marker`, `input_schema`, `output_schema` or `pii`. The pin is structural: it stops injected text from becoming the system prompt, not from reaching the model.
  Role markers are matched after NFKC, removal of combining marks, removal of default-ignorable and format characters, mapping of a small set of Cyrillic and Greek look-alikes of the marker letters to the Latin letter (not general homoglyph detection), case-folding and horizontal-whitespace collapsing, and the shared marker vectors run as a test.
- `k9o.metadata`: `filter`, `set`, `search`, `vectors.nearest`, `subscribe`, and `index.get` / `index.declare` for the columns you declare on a collection.
  Column names in `where`, `search` and `nearest` get the `metadata.` prefix when you leave it out; `set` writes declared columns only. `subscribe` uses the same reconnecting reader as
  `realtime.subscribe` (events carry the record id only) and takes `fromSequence`. The SDK checks the surface grammar, limits, cursor rule and the 64-column limit before sending.
  Gateway codes such as `K9O_METADATA_FIELD_NOT_INDEXED`, `K9O_UNKNOWN_SURFACE` and `K9O_QUERY_RESULT_TOO_LARGE` arrive as `KError`.
- `k9o.realtime.subscribe` resumes by itself: when the stream ends or the network drops it reconnects with `Last-Event-ID`, drops events it already delivered,
  and treats a 45 second silence as a dead connection. Events gain `eventId`. The new `onResync` option is called when the server loses the position
  (a `resync` notice, no longer silently skipped); the subscription then continues on a fresh connection. A 4xx answer is thrown once; 5xx and network errors are retried.
  Options `idleTimeoutMs` and `retryDelayMs` tune the timers. `streams.subscribe` is unchanged.
- `approvals.list` takes `cursor` and pages like the other lists: the next cursor is `meta.cursor.next` (`null` on the last page; the result is typed `PaginatedEnvelope`).
  An invalid cursor is a 400 `K9O_INVALID_CURSOR` (`KError`). `approvals.bulk` results gain `failed`, a list of `{ id, code, reason }` for matched rows that were not decided (empty when none);
  the HTTP status stays 200, so compare `affectedIds` with what you intended.
- `requireApproval()` on single-record `insert`, `update` and `delete` (`k9o.from("orders").insert({...}).requireApproval()`): the write is queued for approval (HTTP 202) instead of applied.
  The result is the queued change (`QueuedChange`) or, when an `auto_approve` policy applies the write at once, the normal result; `isQueuedWrite(result)` tells them apart.
  Upserts and bulk writes do not take it.
- `k9o.functions.triggers`: `list`, `create`, `update` and `delete` for a function's event triggers (`collection`, `events`, `filter`, `enabled`, `logOkInvocations`). `delete` answers 204, so `data` is `undefined`.
  The SDK checks `events` (1 to 4 of `insert`, `update`, `delete`, `upsert`) and the collection name before sending.
- `k9o.schedules`: `list`, `get`, `create`, `update`, `delete`, `runs` and `runNow` for scheduled triggers. `list` takes `status`, `functionName`, `limit` and `cursor`.
  A schedule interval under 5 minutes is rejected with 400 `K9O_INVALID_FIELD_VALUE` (field `schedule_expression`), on every plan.
- `k9o.endUsers`: `list` and `get` for the project's end users, and `roleGrants.list`, `grant` and `revoke` for the roles they hold.
  `role` is any string; `roleGrants.list` returns the grants array; revoking an unknown or already revoked grant answers `{ revoked: false, revokedAt: null }`.
- `k9o.vectors`: `nearest(collection, { queryVector, topK, minScore, metric, filters })` and `upsert(collection, rows)` for collections of your own embeddings.
  The vector is sent in the request body (up to 16000 numbers, 1 to 1000 rows per upsert). A collection name must start with `_`.
  The SDK checks the name, the vector length and numbers, `topK`, `metric` and the row count before sending.
- `k9o.custody.status()`: the project's key custody (`mode`, `attached`, `provider`, `lastJob`, `hsm`). Read-only; needs the project-admin or project-auditor role.
- README sections for writes that wait for approval, function triggers, schedules, vector search and end-user role grants.
- README: what an event-trigger function receives (the JSON payload, redaction, `triggeredAt`, and deduping on `eventId`).
- `KError.requestId` is filled from the gateway's `x-k9o-request-id` response header on every non-2xx answer when the error body carries no `requestId`; a body value wins. `requestId` is the gateway's request id; log it and give it to support.

### Changed

- The cursor-paged lists `functions.list`, `schedules.list`, `schedules.runs`, `endUsers.list` and `schema.collections.list` resolve to `PaginatedEnvelope`, so `page.meta.cursor.next` is typed and needs no cast. This is a type change only; the response is unchanged.
- **Breaking:** `audit.tail` is now the live audit feed (an async iterable). It was a one-shot read of the last minutes (`{ sinceMinutes, limit }`); use `audit.query({ after, limit })` for that.
- `vectorSearch` on the select builder sends the embedding in the request body (`POST data/<collection>/search`) instead of the URL, so real embeddings work. It cannot be combined with `textSearch`.
- `insert()` returns a builder that you can `await` as before (it also has `catch` and `finally`); chain `requireApproval()` to queue the write.

### Fixed

- `realtime.subscribe` and `metadata.subscribe` (and `rollups.subscribe`) no longer loop on the `resync` frame the gateway sends when a connection opens without `Last-Event-ID`. That frame only reports the head of the stream and the events follow on the same connection, so it is now skipped: `onResync` is not called and the connection is not closed. A `resync` after an event was received, or on a connection that sent `Last-Event-ID`, is still a real resync. Before, such a subscription reconnected for ever and delivered nothing. `audit.tail` is unchanged.
- A gateway error whose `recommendation` is an object (`{ action }` or `{ retryAfterSec, note }`) now gives the action text (or note) as `recommendation`; before, the object was passed through although the type is `string | null`.
  Any other JSON type gives `null`. The new `retryAfterSec` field holds the wait the gateway asked for, or `null`. It does not change retries.

## 1.4.0 — 2026-10-26

### Added

- `client.ai.generate(prompt, options)`: generate text from a prompt (`model`, `maxTokens`, `temperature`, `usageType`). Same result as `compute.llms.invoke`.
- `client.streams`: `create`, `list`, `get`, `delete`, `publish`, `replay` and `subscribe` for a project's data streams.
- `streams.subscribe` is an async iterable of events (`{ sequence, subject, data, publishedAt }`) with `close()`. It reopens the
  connection from the last sequence when the server closes it, and ends on `signal` or `close()`.
- `client.approvals`: `list`, `get`, `approve`, `reject` and `bulk` for the pending-change queue. `approve` can answer with a change that is
  still `pending_approval`: the approval was recorded and more approvers are needed. `bulk` returns `{ attestationId, action, affectedCount, affectedIds, reason }`;
  compare `affectedIds` with what you intended. `reject` and bulk `reject` need a `reason`; the SDK checks it.
- `client.approvalPolicies`: `list`, `create` and `delete` for the rules that queue or auto-approve writes. `delete` returns `{ id }`.
- `client.schema.collections.list({ limit, cursor })`: the project's collections with row, column and index counts and the last migration, one cursor page at a time.
- README sections for raw SQL (`client.query`) and search (`client.search`, `textSearch`, `vectorSearch`), approvals, approval policies and schema collections.
- `K9O_STREAM_UNAVAILABLE` and `K9O_STREAM_INVALID` reach you as `KError`, with the gateway's message.
- Streaming requests accept an abort `signal`.

### Changed

- Function deploy examples use the sandbox tier.

## 1.3.0 — 2026-10-26

The SDK now matches the gateway. It passes the gateway's field names through, so some inputs and results change.

### Changed

- Inputs: `projects.create` takes `displayName`. `functions.deploy` takes `artifactKey`, `version` and `tier`.
- Inputs: policies and `policies.validate` take a `policy` document.
- Inputs: audit filters are `eventType`, `actorId`, `after` and `before`.
- Inputs: `policies.publish` takes an optional `acknowledgeSelfLockout`. `me.profile.update` takes `locale` and `timezone`.
- Inputs: `me.apiTokens.create` takes `label`, `scopeManifest` and `ttlSeconds`. `org.smtp.set` takes `passwordRef`, not a password.
- Inputs: `org.auditLog.query` takes `type` and `limit` only. `migrations.listPending` takes an optional `status`.
- Inputs: `org.members.list` filters by `userId`, `role`, `acceptanceStatus`, `status` and `state`.
- Inputs: `functions.list` also filters by `tier` and `source`.
- Project results: `displayName` replaces `name`. `custodyMode` is `PLATFORM_MANAGED`, `SKR`, `BYOK` or `HYOK`.
- Project results also carry `region`, `status`, `role` and `residencySet`.
- Policy results: bundles carry `policy`, `projectId` and a `status` of `draft`, `published` or `superseded`. `validate` answers `{ valid: true }`.
- `policies.publish` answers `{ pendingChangeId, bundleId, status }`: the publish waits for approval. `policies.delete` returns no data.
- Migration results: `apply` and `applyPending` answer `{ applied, skipped }` without `appliedAt`. Pending rows use `id`, `queuedAt` and `queuedBy`.
- Function results: records add `version`, `entryPoint`, `retiredAt` and `errorDetail`. The failed status is `error`.
- `functions.delete` returns the retired record.
- Org results: `org.get()` and the `orgs` methods return `displayName`. Members add `invitedAt`, `acceptedAt` and `state`.
- `org.members.invite` answers `{ invitation, delivery }` when the email has no account. `org.members.remove` returns no data.
- Org groups carry `source` and no `memberCount`. Org audit events carry `createdAt`. `org.smtp.set` and `org.smtp.unset` return the org.
- `org.smtp.test` answers `{ accepted, resolvedTier, to, dryRun }`.
- `me` results: profiles add `mfaEnabled` and `updatedAt`. Sessions use `issuedAt`, `expiresAt` and `isCurrentSession`.
- `compute.llms.invoke` results use `content` and `usage`. Inference parameters are sent flat in the request.
- Signed URLs: the gateway signs for 900 seconds at most. The answer's `expiresIn` is the lifetime it used.
- Host handling: the API host comes from the base URL. `orgSlug` builds `<orgSlug>.api.<apex>` on any platform host, not only the default one.
- The README is rewritten and checked against the source.

### Removed

- `client.metadata`.
- `client.realtime.replay`, the WebSocket transport and polling. `subscribe` (server-sent events) remains.
- `org.members.get` and `org.smtp.get`.
- `org.auditLog.tail`. The org audit log cannot filter by time.
- `org.groups.create` and `org.groups.delete`. Groups come from your identity provider, so only `list` and `get` remain.
- `me.notifications`, `me.auditLog` and `me.dataExport`.

### Added

- `functions.uploadArtifact(bytes, kind)` uploads a function's bytes and returns its `artifactKey`.
- A contract test checks 100 SDK calls against the gateway's published API description.

## 1.2.0 — 2026-10-25

- The README now introduces the Kilimanjaro building blocks (Keep, Pulse, Gate, Kibo). No change to the public API.

## 1.1.1 — 2026-10-25

- Documentation links corrected: the documentation hub is https://docs.kilimanjaro.dev, with the website, platform API and console listed in a Links section. Package metadata points at the same places.

## 1.1.0 — 2026-10-25

- Documentation rewritten with runnable examples and expected output; internal cross-references removed from the published sources. No change to the public API.
- Error text for `update()` / `delete()` without an `id` filter no longer mentions a version or a roadmap.

## 1.0.0 — 2026-10-23

First public release. See the README for the full API overview.
