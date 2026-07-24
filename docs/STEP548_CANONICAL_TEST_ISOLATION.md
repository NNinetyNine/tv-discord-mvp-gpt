# Step 548 Canonical Test Isolation

## Purpose

Step 548 preserves the reconciled operator data while removing test-suite dependence on the repository's mutable production canonical files.

Administration and Pack promotion tests previously loaded `definitions/` and `config/` directly from the active repository. Their behavioural expectations were intentionally based on the accepted Step 547 state: 132 Registry Assets, five Packs, 131 Pack memberships, and one persistent BTC thread binding. After normal website use changed the live canonical data, those tests failed even though the application and administration validation remained correct.

## Deterministic fixture

`fixtures/admin-canonical/` contains the exact accepted Step 547 test state:

- Registry source SHA-256: `46725b45068b2603f6550035b09c59d225f170436dcc82b4a173f077f7de4a96`
- Packs source SHA-256: `29a8284033f1c67466f7a50b54a64d208e72e8dcce25e1cd897a650bdbc3c0b4`
- Channel source SHA-256: `11bda2d95b9a93497c673f400bd78fd0215df18a02b2915089e397c13e5b0aad`
- Thread-binding source SHA-256: `3de68833989081cf86e2c808cd45ed3038880a88fcfecb3c5b0332a36582f15e`

The fixture also carries the exact branding files and canonical BTC logo required by rendering and thread-management tests.

## Test boundary

`src/test-support/admin-canonical-fixture.ts` exposes the fixture root and a copy helper for tests that mutate canonical state. The affected suites now either read the fixture or copy it into a temporary repository before exercising writes.

This keeps two contracts separate:

1. Behavioural tests run against deterministic source custody.
2. `validate:admin` continues to inspect the current real repository and proves that live canonical sources are coherent and unchanged by read-only validation.

## Non-effects

- No production application code changed.
- No reconciled Registry, Pack, channel, thread-binding, or logo data changed.
- No Discord operation was introduced.
- No publication or release authority changed.
