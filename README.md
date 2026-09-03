# memoryos-email-guardian-proof

> GC-06 — **blind fourth-domain validation** of Guardian Core v0.1
> Domain: **OUTBOUND EMAIL / `sendMessage`** · Date: 2026-09-03

**Blind protocol honored.** The Guardian was understood exclusively from
`memoryos-guardian-core/src/guardianCore.ts`, `test/guardianCore.test.ts` and
`README.md`. No adapter source (`filesystemAdapter.ts`, `githubAdapter.ts`,
`vpsAdapter.ts`) and no prior proof repository were read. The Core was not
modified, copied or adapted.

**Scope:** no Gmail, no SMTP, no network, no real sending. The backend is a
deterministic in-process fake (`FakeEmailProvider`) whose only mutating
primitive is `send` and whose read primitive is `findMessage`.

## Derivation (from the Core alone)

| Core concept | OUTBOUND EMAIL / sendMessage instantiation |
| --- | --- |
| Intent (data-only) | `{ messageId, to, subject, body }` — one message; no credential/transport/URL/payload |
| Authority boundary | Operator-closed: provider + recipient allowlist live inside `createEmailGuardianAdapter`; guardian surface stays `(intent, adapter)` |
| Eligibility (fail-closed) | Well-formed intent · recipient inside allowlist · messageId not already sent · observation machinery reachable — else `NOT_EXECUTED(ELIGIBILITY)` or `NOT_EXECUTED(OBSERVATION)`, zero dispatch |
| Relevant state | The provider outbox: "has this messageId already been sent?" |
| Bound proposal | Frozen decision + observation `{ messageIdAbsentFromOutbox: true, observedAt }`, opaque to the Core |
| Compatibility check | `apply` re-proves the observation against the **current** outbox; mismatch/unavailable → `NOT_EXECUTED(COMPATIBILITY)`, zero dispatch |
| Effect boundary | Exactly ONE `provider.send` call — single call site, nothing retries it |
| Postcondition | Message durably registered in the outbox, proven by an **independent post-read** (acceptance alone is never proof) |
| Evidence | The outbox entry itself (`providerId`, `queuedAt`, content) |
| Indeterminate outcome | Acceptance without registration proof · timeout after possible dispatch · unavailable postcondition read — honest `INDETERMINATE`, never promoted |

No fingerprint, SHA, CAS or snapshot hash was invented: none exists naturally
in email. The state token is the semantic precondition "not already sent",
re-proven with the domain's own primitive (outbox lookup by messageId).

## Mandatory tests → results (14 passed)

| # | Requirement | Result |
| --- | --- | --- |
| 1 | Eligible `bind` sends nothing | `BOUND`, `sendCalls=0`, outbox empty, `readCalls=1` |
| 2 | Recipient outside authority → zero dispatch | `NOT_EXECUTED/ELIGIBILITY/BLOCKED`, `sendCalls=0` |
| 3 | Bind → state changes → apply | stale decision **naturally blocked**: `NOT_EXECUTED/COMPATIBILITY/BLOCKED`, `dispatched=true, NONE_PROVEN`, `sendCalls=0` |
| 4 | Valid send → exactly 1 dispatch | `sendCalls=1`, 1 outbox entry, observation chain 3 reads |
| 5 | Acceptance without proof → never `SUCCESS_PROVEN` | `INDETERMINATE{dispatched=true, UNDETERMINED}` (accept-and-drop) |
| 6 | Proven postcondition → `SUCCESS_PROVEN` | evidence `outbox-post-read` (providerId, queuedAt, content match) |
| 7 | Proven-failed postcondition → `FAILURE_PROVEN` | only with definitive provider rejection + corroborating absent post-read; `state=NONE_PROVEN` |
| 8 | Timeout after possible dispatch → `INDETERMINATE` | Core-native path: `APPLY_FAILED/PROVIDER_SEND_TIMEOUT`, `dispatched=true, UNDETERMINED` |
| 9 | No automatic retry that could duplicate | timeout / rejection / stale paths: ≤1 send per run, never re-sent |
| 10 | Caller cannot supply authority | type-level: forbidden fields are compile errors; runtime: `INTENT_CARRIES_FORBIDDEN_AUTHORITY` refused before any provider interaction; surface = `(intent, adapter)`, adapter = `{bind, apply}` only |

Supporting: duplicate messageId at bind (BLOCKED), unavailable observation
(OBSERVATION/UNDETERMINED), postcondition read unavailable (INDETERMINATE),
malformed intents (fail-closed).

## Refutation attempts

| Invariant | Attack attempted | Verdict |
| --- | --- | --- |
| 1. NON-EXPANDABLE AUTHORITY | inject credential/transport/providerUrl/providerPayload via intent (type + runtime); smuggle authority through the guardian surface | **SUPPORTED** — types cannot express it; runtime bind refuses before any provider interaction; surface is structurally `(intent, adapter)` |
| 2. FAIL-CLOSED ELIGIBILITY | malformed intent, out-of-scope recipient, already-sent messageId, dead observation | **SUPPORTED** — every path terminates `NOT_EXECUTED`, `dispatched=false`, `sendCalls=0`; `apply` reachable only after `BOUND` |
| 3. STATE-BOUND EXECUTION | invalidate the bind decision between bind and apply (concurrent send of the same messageId); re-proof machinery unavailable | **SUPPORTED** — apply re-proves the observation against current state and refuses with zero mutation; unavailable re-proof also refuses (no blind send) |
| 4. INTENT-CONFINED CONTROLLED EFFECTS | find any second mutating path or caller machinery | **SUPPORTED** — exactly one `provider.send` call site; no caller machinery exists anywhere on the surface |
| 5. EPISTEMIC HONESTY WITH INDETERMINACY | acceptance without registration; timeout after dispatch; unreadable postcondition | **SUPPORTED** — all remain `INDETERMINATE` (never `SUCCESS_PROVEN`, never fabricated `NONE_PROVEN` after dispatch); `FAILURE_PROVEN` only on definitive, corroborated rejection |

## Verdict

- `STATE_BOUND_EXECUTION_NATURAL=yes` — the stale decision dies by a natural
  domain precondition ("this message has not already been sent"), re-proven
  inside the controlled operation; nothing was imported from other domains.
- `CORE_CHANGE_REQUIRED=no` · `ARTIFICIAL_ADAPTATION_REQUIRED=no`
- `GENERALIZATION_PASS=yes`

## Concurrency (same adapter instance — GC-08A)

1. **Stale decisions** are protected by state re-validation inside `apply`: a
   decision bound to "messageId absent from outbox" is refused with zero
   dispatch when the outbox already contains the message.
2. **Simultaneous same-`messageId` executions** on the same adapter instance
   are serialized by a per-messageId single-flight reservation: exactly one
   execution may dispatch; the other returns `NOT_EXECUTED`
   (`COMPATIBILITY`, zero own dispatch — it never calls `provider.send`).
3. The reservation is in-memory and **adapter-instance-local**: cross-process
   and cross-machine coordination are **NOT** provided.
4. **Exactly-once is NOT guaranteed**: after a crash/restart, after an
   ambiguous outcome (e.g. timeout after possible dispatch), or across
   separate adapter instances, a later run may still dispatch the same
   `messageId`.
5. **Provider-native idempotency** (atomic accept semantics / idempotency
   keys) remains the preferable protection when the real backend offers it.
   Different `messageId`s are never serialized against each other (no global
   lock).

## Run

```bash
npm install
npm test         # 14 tests
npm run typecheck
```
