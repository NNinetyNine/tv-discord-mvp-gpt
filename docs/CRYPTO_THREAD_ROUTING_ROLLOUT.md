# Crypto Pack Discord thread rollout

This is the controlled operator map for completing the Crypto Pack's persistent
Discord destinations. It does not authorize chart publication.

At the Step 531 baseline, Crypto routing coverage is **1 of 16**. `btc` is bound
to thread `1529335112293027860`. The table shows all 16 members in canonical
order and identifies the remaining 15 decisions:

| Order | Asset | Current state | Required operator decision |
|---:|---|---|---|
| 1 | `akt` | Missing | Adopt an inspected existing post, or approve exact provisioning inputs |
| 2 | `zec` | Missing | Adopt an inspected existing post, or approve exact provisioning inputs |
| 3 | `pepe` | Missing | Adopt an inspected existing post, or approve exact provisioning inputs |
| 4 | `doge` | Missing | Adopt an inspected existing post, or approve exact provisioning inputs |
| 5 | `fet` | Missing | Adopt an inspected existing post, or approve exact provisioning inputs |
| 6 | `xlm` | Missing | Adopt an inspected existing post, or approve exact provisioning inputs |
| 7 | `xrp` | Missing | Adopt an inspected existing post, or approve exact provisioning inputs |
| 8 | `sui` | Missing | Adopt an inspected existing post, or approve exact provisioning inputs |
| 9 | `tao` | Missing | Adopt an inspected existing post, or approve exact provisioning inputs |
| 10 | `trx` | Missing | Adopt an inspected existing post, or approve exact provisioning inputs |
| 11 | `link` | Missing | Adopt an inspected existing post, or approve exact provisioning inputs |
| 12 | `sol` | Missing | Adopt an inspected existing post, or approve exact provisioning inputs |
| 13 | `hype` | Missing | Adopt an inspected existing post, or approve exact provisioning inputs |
| 14 | `eth` | Missing | Adopt an inspected existing post, or approve exact provisioning inputs |
| 15 | `btc` | Bound | Preserve the existing binding; verify with the full Pack |
| 16 | `total3` | Missing | Adopt an inspected existing post, or approve exact provisioning inputs |

For every missing destination, the operator records one decision before acting:

- route mode: `adopt` or `provision`;
- for adoption: the exact existing Discord thread ID;
- for provisioning: the exact post title, current inspected tag IDs, and the
  approved PNG logo SHA-256; transparent and rectangular PNGs are supported;
- confirmation that the selected forum is the configured Crypto forum;
- resulting persistent thread ID and binding-file SHA-256.

VisionX does not infer or approve post titles, tags, logos, or existing thread
identities. Provisioning inputs must come from current operator evidence. The
UI reinspects live forum tags, displays the staged logo hash, and repeats the
complete request at confirmation time.

Stop the rollout immediately if a Discord session does not close cleanly, a
provisional post is retained after binding failure, a conflicting binding
appears, an inspected thread belongs to another forum, the approved logo is
missing or replaced, or the inspected tag set becomes stale. Resolve the
reported state before another Discord mutation.

After coverage reaches 16 of 16, run **Verify Pack Routing** once. Completion
requires all 16 destinations to be returned in canonical order, in the
configured Crypto forum, active, unlocked, and with a clean session close. This
gate remains read-only and leaves Pack publication disabled.
