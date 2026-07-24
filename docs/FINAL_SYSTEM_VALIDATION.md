# VisionX Final System Validation and Operator Acceptance

Status: Step 544 final validation contract. This document records the automated
production-smoke boundary and the remaining human acceptance review. It does not
authorize cleanup, archive deletion, canonical-source mutation, or live Discord
writes.

## Automated production smoke

Run the validator against the current repository and a separate installation
workspace:

```bash
mkdir -p "$HOME/Library/Application Support/VisionX-final-validation"

DISCORD_BOT_TOKEN= npm run validate:admin -- \
  --repository-root "$PWD" \
  --workspace-root "$HOME/Library/Application Support/VisionX-final-validation" \
  --chart-downloads-root "$HOME/Downloads"
```

The command starts the real Administration HTTP composition on an ephemeral
loopback port, loads the static application shell, and exercises the read models
used by all seven operator workspaces:

1. Workspace: status, logical channels, and Pack Workspace;
2. Threads: persistent Pack/Asset route projection;
3. Server: installation configuration and read-only operator audits;
4. Packs: governed maintenance state;
5. Archive: historical Release projection;
6. Render: Registry Assets and supported timeframes; and
7. Registry: channel options and bounded canonical search.

It also verifies the Content Security Policy, loopback binding, security headers,
local-only presentation dependencies, exact canonical source hashes, credential
secrecy, and absence of publication authority in thread management.

A successful report has `outcome: "passed"`, seven workspace checks, zero failed
checks, and unchanged SHA-256 values for:

- `definitions/registry.json`;
- `definitions/packs.json`;
- `config/channels.json`; and
- `config/asset-threads.json`.

The validator performs GET-only HTTP inspection. It does not call a write route,
contact Discord, publish, stage, create a Release, migrate configuration, or
perform cleanup. The separate workspace may receive normal installation-owned
initialization directories.

## Manual operator acceptance

Automated smoke is necessary but does not replace human review. Start the normal
Administration website with Discord disabled and review each workspace at a
wide desktop viewport, approximately 200% zoom, tablet width, and narrow mobile
width.

For every workspace confirm:

- the visible title and navigation target agree with the URL hash;
- keyboard order, focus visibility, loading state, empty state, and recovery
  messaging are understandable;
- all controls and every table column remain reachable without widening the
  document;
- browser Back and Forward restore the prior workspace;
- reduced-motion and increased-contrast preferences preserve capability; and
- no routine task requires source editing, a terminal command, or a specialist
  recovery script.

For Registry dialogs confirm Escape, backdrop, Cancel, focus containment, and
focus return. For write previews, stop before Apply unless the review is an
explicit operator-authorized data change. For Server and Threads, token-free
mode must show live Discord actions as unavailable rather than failing or
exposing a credential.

## Live Discord acceptance boundary

Live guild, forum, role, permission, thread, and publication checks require the
operator's locally supplied `DISCORD_BOT_TOKEN`. The token must never be pasted
into review evidence, stored in canonical files, or entered in the browser.
Read-only live checks may be performed through Server and Threads. Any adoption,
provisioning, migration, or publishing action remains separately governed by
its existing preview and confirmation contract.

## Packaging gate

After automated and manual acceptance pass, stop the server and create the
review archive from a clean committed tree. Exclude repository internals,
installed browser/dependency caches, and secret-bearing local files:

```bash
zip -r tv-discord-mvp-gpt-<commit>.zip tv-discord-mvp-gpt \
  -x "tv-discord-mvp-gpt/.git/*" \
     "tv-discord-mvp-gpt/node_modules/*" \
     "tv-discord-mvp-gpt/.pw-profile/*" \
     "tv-discord-mvp-gpt/.env" \
     "tv-discord-mvp-gpt/.env.local"

unzip -t tv-discord-mvp-gpt-<commit>.zip
shasum -a 256 tv-discord-mvp-gpt-<commit>.zip
```

The final archive must not contain `.env`, `.env.local`, or `.pw-profile` because
they may hold Discord or TradingView credentials. `.env.example` remains source
documentation. Generated workspace and historical evidence are not silently
discarded. Any future cleanup proposal must identify each path, trace its consumers, pass the
Constitution deletion test, and receive explicit approval.

## Acceptance result language

Use one of these outcomes:

- **Accepted**: automated validation, full tests, typecheck, production startup,
  manual workspace review, and package integrity all pass with no unresolved
  blocker.
- **Accepted with documented limitations**: the product is operable, but a
  non-blocking limitation is recorded with exact reproduction and ownership.
- **Blocked**: a workflow, custody, security, accessibility, or recovery failure
  remains. Do not package or clean up until it is corrected and revalidated.
