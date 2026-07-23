# Governed Discord Server Configuration and Migration

Status: Step 540 Administration workflow.

## Ownership boundary

VisionX treats Discord installation plumbing separately from domain definitions:

- `definitions/registry.json` owns Asset identity and classification.
- `definitions/packs.json` owns ordered publication batches and each Pack's
  logical route name.
- `config/channels.json` maps those logical route names to installation-owned
  Discord forum channel IDs.
- `config/asset-threads.json` maps Pack/Asset pairs to persistent forum threads
  inside the configured Pack destination.
- `DISCORD_BOT_TOKEN` remains a process-environment secret. Administration
  reports only whether a credential is configured; it never displays, writes,
  exports, or migrates the token.

The current publisher uses an authenticated Discord bot gateway. Webhooks are
not a hidden second configuration source and no webhook secret is stored.

## Live server test

**Test Current Server** opens one read-only Discord session and inspects every
configured logical route. It reports:

- bot identity without exposing the token;
- one resolved guild identity;
- forum channel identity and type;
- current available tags, including names and moderation status;
- bot role names;
- required route permissions for viewing, forum/thread creation, message and
  attachment delivery, thread management, and message-history access.

All configured routes must resolve to Discord forum channels in one guild and
must satisfy every required permission. The test does not create or edit a
channel, role, tag, webhook, thread, message, binding, Release, or Pack.

## Normal configuration change

A normal route change is reviewed against the exact current Registry, Pack,
channel, and thread-binding hashes. VisionX requires:

- every current logical route exactly once;
- normalized Discord snowflakes;
- no duplicate forum destination IDs;
- every Pack-owned logical route to remain configured;
- a successful live test of the complete candidate route map;
- no persistent thread binding to depend on a changed destination.

The final phrase is `APPLY SERVER CONFIGURATION`. Immediately before any
source write, VisionX repeats the complete live Discord test and refuses the
application if a forum, guild, role, or required permission changed. Application
then atomically replaces `config/channels.json` while proving that
`config/asset-threads.json` remains byte-for-byte unchanged. Discord content,
credentials, webhooks, Registry, Packs, staging, and Release custody are not
changed.

## Server migration

A migration uses the same candidate and live-validation gates but permits a
route change that invalidates persistent thread destinations. The preview
identifies every affected Pack and exact binding count. The final phrase is
`MIGRATE N ROUTE` or `MIGRATE N ROUTES`.

Before canonical files change, Administration preserves exact evidence under:

```text
<workspace-root>/server-configuration/migrations/<migrationId>/
```

Evidence includes channels and thread bindings before and after the reviewed
migration plus the preview. The rollback-protected source transaction then:

1. rechecks exact Registry, Pack, channel, and thread-binding hashes;
2. repeats the complete live Discord destination and permission test;
3. changes `config/channels.json`;
4. removes only bindings owned by Packs whose logical destination changed;
5. preserves every unaffected Pack binding;
6. validates and verifies both resulting files;
7. rolls both files back if the transaction cannot be proven.

The migration never deletes or edits Discord posts. Cleared Pack/Asset routes
must be adopted or provisioned again through **Threads** before publication.

## Deliberate non-effects

Server migration does not move historical Release custody. Administration
Releases remain under `<workspace-root>/publication/archive`; the preserved
legacy repository archive remains separate. Archive consolidation, historical
Release browsing, and export are later operator workflows and are not coupled
to a Discord destination change.
