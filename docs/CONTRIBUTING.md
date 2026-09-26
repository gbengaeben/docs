# Contributing

Thanks for helping improve the Wraith Protocol docs.

## Snippet checks

All TypeScript and JavaScript code fences in `.mdx` files are checked by:

```bash
npm run check:snippets
```

The checker extracts each `ts`, `tsx`, `typescript`, `js`, and `javascript` fence,
writes it to a temporary file, and runs `tsc --noEmit` against that snippet. The
initial gate is intentionally syntax-focused because many current docs snippets
are fragments meant to illustrate API shapes rather than complete programs. It
still catches malformed TypeScript and keeps the docs ready for stricter runtime
validation over time.

Use `no-check` only for intentionally illustrative pseudocode:

````mdx
```typescript no-check
// Pseudocode that is not copy-paste runnable.
```
````

Prefer making snippets compile over opting them out.

## Navigation coverage

Every `.mdx` page in the shipped taxonomy (root pages plus `architecture/`,
`api-reference/`, `contracts/`, `guides/`, `reference/`, and `sdk/`) must be
registered in the `docs.json` navigation tree, and every navigation entry must
resolve to a real file. This is enforced by:

```bash
npm run check:nav-coverage
```

The checker (`scripts/check-nav-coverage.mjs`) scans for `.mdx` files that are
missing from `docs.json` and for nav entries that point at files that no longer
exist. Run it after adding, renaming, or removing a page:

```bash
node scripts/check-nav-coverage.mjs
```

Note: `docs.json` is strict JSON — do not add `//` comments to it, the Mintlify
CLI rejects them. Keep this file comment-free.

## Contract registry

[`reference/contract-registry.mdx`](/reference/contract-registry) is the canonical
source for deployed contract addresses, versions, artifact hashes, and deployment
ledgers. Its machine-readable copy lives at `scripts/contract-registry.json`.

```bash
npm run check:contract-registry
```

The checker (`scripts/check-contract-registry.mjs`) validates the registry shape,
rejects stale contract placeholders anywhere in the shipped `.mdx` pages, confirms
every deployed address is documented, and verifies that the network guide, SDK,
quickstart, and contracts pages link back to the registry.

When a deployment lands, update `scripts/contract-registry.json` first, then update
the pages that quote it. Never ship a placeholder contract id such as
`CPLACEHOLDER_*` or `C[TBD]` — CI fails on those patterns.

## CI

Every pull request runs the snippet checker, the nav coverage check, and the
contract registry check through GitHub Actions. A separate non-blocking Stellar
testnet job is reserved for end-to-end snippet validation that depends on network
availability.
