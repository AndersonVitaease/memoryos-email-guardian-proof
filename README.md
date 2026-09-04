# Email Guardian

**Safe email sending for AI agents — bounded authority, stale-state protection, same-instance duplicate suppression, evidence-based outcomes.**

An AI agent may need to send an email. That does not mean it should receive
unrestricted messaging authority — or that concurrent executions should
silently send the same message twice.

Email Guardian is an experimental domain proof for **outbound email
(`sendMessage`)** built on the Guardian model: data-only intents, authority
closed inside an adapter, decisions revalidated against current state before
acting, and results that must be **proven**, not assumed.

> Give AI agents capabilities. Not unrestricted authority.

**Status: experimental proof — not a production library, not a security
certification.** The backend is a deterministic in-process fake provider:
no Gmail, no SMTP, no network, no real sending. No LICENSE file is included
yet; all rights reserved by the author — public visibility does not make
this open source.

## The problem

Sending an email is an **external effect**. Once a message leaves, it cannot
be treated like a reversible local change: there is no undo, and a duplicate
is a real, visible event for another person.

That makes a "simple" send dangerous for an agent:

- The agent **decides** to send message `M` — but between decision and action, state can change: the same message may already have been sent by another run.
- **Concurrent executions** may arrive: two runs on the same task can both observe "message not yet sent" before either send becomes visible.
- **Provider acceptance is not the outcome that matters** — a provider can accept a request and still lose, delay or drop the message.
- **Blindly retrying** after a timeout or unclear error can create a second external effect — a duplicate email — in the name of reliability.

So the real questions are: how does send authority stay bounded? How do you
avoid acting on a stale decision? How do two concurrent runs avoid sending
the same message? And when can you honestly claim "the email was sent"?

## What Email Guardian does

Every execution follows the same guarded flow:

```
Intent
→ Bound authority
→ Observe relevant outbox state
→ Fresh compatibility check
→ Same-instance keyed reservation
→ Controlled send
→ Independent post-read
→ Evidence-based result
```

- **Intent** — data-only: `{ messageId, to, subject, body }`. Credentials, transports, provider URLs and raw payloads are structurally inexpressible on the intent — and refused at runtime if smuggled in.
- **Bound authority** — the provider and the recipient allowlist are closed inside the adapter by the operator. The caller receives no provider credentials and no arbitrary transport; the guardian surface stays exactly `(intent, adapter)`.
- **Observe relevant outbox state** — the domain's natural state question: *"has this `messageId` already been sent?"*, answered by an outbox lookup. No fingerprints, SHAs or snapshot hashes are invented here.
- **Fresh compatibility check** — inside the controlled operation, the bind-time observation is re-proven against the **current** outbox. If the state moved, the stale decision dies with zero dispatch; if re-proof is unavailable, the send is refused — no blind send.
- **Same-instance keyed reservation** — a per-`messageId` single-flight reservation closes the simultaneous-decision window (see below).
- **Controlled send** — exactly **one** `provider.send` call site exists; nothing retries it.
- **Independent post-read** — success is established by reading the outbox back and matching the registered message against what was sent.
- **Evidence-based result** — `SUCCESS_PROVEN`, `FAILURE_PROVEN`, `NOT_EXECUTED` (refused, with stage and reasons) or `INDETERMINATE` (e.g. acceptance without registration proof, timeout after a possible dispatch). Ambiguous outcomes are reported honestly, never promoted.

These steps are coordinated pieces, not one atomically unified transaction — their honest composition is the point.

## Concurrent duplicate example

This failure was found by an external red-team pass against this proof.
Before the fix, two executions of the same message could both send.

**Before — two simultaneous calls, same `messageId`:** run A observes the
outbox: message absent. Run B observes it too: also absent — A's send is not
visible yet. Both pass their fresh compatibility checks, each against
genuinely current state. Both send: `sendCalls=2`, two outbox entries — and
**both executions reported success**.

Each run did nothing wrong individually: each revalidated state immediately
before acting. The race lives in the gap between revalidation and send —
fresh revalidation alone does not close the simultaneous-decision window.

**After (GC-08A) — same adapter instance, same `messageId`:**

1. The adapter holds a same-instance, in-memory reservation keyed by `messageId`; acquiring it is a synchronous *check + add* before the first `await` — atomic within the adapter instance.
2. Exactly one execution crosses the send; the other is refused before dispatching anything (`NOT_EXECUTED`, zero send of its own).
3. Result: `sendCalls=1`, `outbox=1` — one `SUCCESS_PROVEN`, one refusal.
4. The reservation is released in a `finally` block, so it never leaks — not on success, not on failure, not on refusal.

An additional attack — 10 simultaneous executions of the same `messageId` —
produced **exactly one** send crossing the boundary in the tested scope.

**This protection is same-instance only**: an in-memory reservation inside
one adapter instance — not a cross-process or cross-machine lock.

## Different messages remain concurrent

The reservation is *keyed* by `messageId`, so it serializes only what it
should: messages A, B and C proceed independently and in parallel; two
simultaneous executions of message A contend with each other — and only with
each other. There is **no global mutex**: closing the duplicate-send window
did not serialize all email sending.

## Success is evidence, not provider acceptance

A provider accepting a request is not the postcondition. In this proof:

- acceptance is followed by an **independent post-read** of the outbox;
- `SUCCESS_PROVEN` requires the outbox to contain the message matching the expected content and provider id;
- acceptance **without** registration proof stays `INDETERMINATE` (`UNDETERMINED`) — never promoted to success;
- a definitive, corroborated provider rejection is `FAILURE_PROVEN` (`state=NONE_PROVEN`);
- a timeout after a possible dispatch stays `INDETERMINATE` — the proof never guesses, never fabricates, and never auto-retries in a way that could duplicate.

## What was tested

16/16 tests pass and `typecheck` passes at the validated commit (the
original 14 requirements plus 2 concurrency-hardening tests). This is
evidence about tested paths — not a benchmark and not a universal safety
claim.

- **Stale sequential protection** — a decision bound to "message absent" is refused with zero dispatch when the outbox already contains it.
- **Same-instance same-message suppression** — two simultaneous executions of one `messageId`: `sendCalls=1`, `outbox=1`, honest loser.
- **10 simultaneous same-ID attack** — exactly 1 crosses the send.
- **Different IDs remain parallel** — the reservation is not a global lock.
- **Reservation release** — released in `finally`; nothing leaks.
- **Independent post-read** — acceptance alone is never success.
- **Fail-closed eligibility** — malformed intents, out-of-scope recipients, already-sent `messageId`s and unavailable observation machinery all refuse with zero dispatch.
- **Authority confinement** — forbidden intent fields (credential, transport, provider URL, raw payload) are compile errors and runtime refusals.
- **Fake provider / no real network** — a deterministic in-process provider is the only backend; no real email is ever sent.

```bash
npm install
npm test         # 16 tests
npm run typecheck
```

## Relationship to Guardian Core

Email Guardian was created as a **blind, independent fourth-domain proof**
of the Guardian Core model: the domain (outbound email) was chosen after the
Core was frozen, and the adapter was derived only from the Core's public
sources — without reading the other domain adapters. The Core itself was not
modified.

- [Guardian Core](https://github.com/AndersonVitaease/memoryos-guardian-core) — the domain-agnostic Safe Execution Core (bind → gate → apply, fail-closed) that this proof instantiates.

The email red-team also surfaced a lesson for the wider Guardian work:
**per-execution fresh revalidation does not by itself imply cross-execution
serialization**. The proof passed all of its sequential state-bound tests and
still allowed a simultaneous duplicate; the same-instance keyed reservation
(GC-08A) was added afterwards to close that window within one adapter
instance.

## Limitations

This is an experimental proof. Explicitly, it does **not** provide:

- production certification of any kind;
- real email delivery — the only backend is a fake provider, with no real email network;
- a fully bound email state — `EMAIL_STATE_BOUND` remains **PARTIAL**;
- cross-process protection — the reservation is same-instance only;
- cross-machine protection or any distributed lock;
- provider-native idempotency (idempotency keys, atomic accept) — when a real backend offers such primitives, they are the stronger protection;
- exactly-once delivery — not guaranteed, in any configuration;
- crash/restart safety for the reservation — a crash or restart can invalidate local reservation assumptions, and a later run may dispatch the same `messageId` again;
- resolution of ambiguous provider outcomes — acceptance-without-proof and timeout-after-possible-dispatch remain `INDETERMINATE`;
- protection against a malicious adapter implementation — the model assumes the adapter honors its contract;
- claims beyond the tested outbound email path — the evidence applies to what the tests actually exercise.

A known result-mapping deviation is documented in the next section.

## Known conformance note

Guardian Core later standardized `dispatched` to mean **"the Core invoked
`adapter.apply`"** — not "the external effect occurred"; the occurrence state
field carries the truth about the effect. In this independent proof, the
losing execution of the GC-08A concurrent race still reports
`dispatched=false` / `NONE_PROVEN`, even though its refusal happens inside
`apply`. Under the later Core vocabulary, the semantically aligned value
would be `dispatched=true` / `NONE_PROVEN`.

To be explicit: this is a mapping/vocabulary divergence, not a send — the
refused execution performs **zero** email send, and the same-instance
duplicate-suppression evidence is unaffected. The code is intentionally left
unchanged to preserve the validated proof state; alignment with the later
Core semantics is deferred.

## Guardian ecosystem

- [Guardian Core](https://github.com/AndersonVitaease/memoryos-guardian-core) — domain-agnostic Safe Execution Core (bind → gate → apply, fail-closed).
- [VPS Guardian](https://github.com/AndersonVitaease/memoryos-vps-guardian-pro) — governed VPS/Dokploy application redeploy with supervised rollback evidence.
- [GitHub Guardian](https://github.com/AndersonVitaease/memoryos-github-guardian-proof) — state-bound PR merge execution using GitHub's native SHA precondition and independent post-merge verification.
- [Filesystem Guardian](https://github.com/AndersonVitaease/memoryos-filesystem-guardian-proof) — stale-state-safe file changes with bounded filesystem authority and read-back verification.
