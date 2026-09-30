# @horos/mcp

An MCP server that lets an MCP-capable agent call Horos as a tool. It is a thin layer over `@horos/sdk`: no
database, no Horos-held keys, no Human key.

Horos is a policy-enforcement and evidence tool. It does not make you compliant: you remain the compliance
decision-maker, and a Declared Identity is always unverified.

The package is workspace-only for now (`private`, not yet published to npm): build it from this monorepo
(`pnpm --filter @horos/mcp... build`) and point your MCP host at `packages/mcp/dist/cli.js`.

## Tools

Exactly five, and nothing else:

| Tool | What it does |
|------|--------------|
| `check` | `counterparty` (0x address), `amount` (USDC base units as a decimal string, e.g. `"25000000"` = 25 USDC), optional `declared_identity` (unverified). Returns every Check response field (decision, effective limit, remaining, reason, confidence, judge, record id, simulated, advisory, tx hash, limit write, chain state, payable amount on `cap`) plus `mode`. |
| `list_decision_records` | One page of a Scope's Decision Log (`scope?`, `after?`, `limit?` 1..100). |
| `get_decision_record` | One Decision Record with its hash and write receipts (`record_id`, `scope?`). |
| `list_counterparties` | One page of Counterparty statuses in an enforced Scope (`scope?`, `after?`, `limit?`). |
| `get_counterparty_status` | One Counterparty's status and limit (`counterparty`, `scope?`). |

No tool raises or sets a limit, changes Policy, deploys anything, or signs anything except a Check or a ReadAccess.
If a signed, enforced Check reports `limit_write: "failed"`, the result keeps `mode: "enforced"` and adds a note that the
on-chain Limit write failed, so a payment may revert until Horos retries it. Errors come back as tool errors (`isError: true`) carrying the Horos error code and message, never a key or a
signature.

## Enforced and advisory

- **With the Agent's Payment key** the server signs each Check. `mode: "enforced"` appears only when the request was
  signed **and** the api answered `advisory: false`; the matching Limit is then queued for your PolicyWallet.
- **Without a key**, every Check is unsigned and runs advisory: `mode: "advisory"` plus a note that nothing was
  written on-chain and the answer is not enforcement. A signed Check the api still answers advisory (for example an
  unbound wallet) is reported the same way. Do not pay on an advisory answer as if it were enforced.
- The log tools send a signed ReadAccess with a key. Without one no auth is sent, and reads succeed **only for the
  api's public demo Scope**, which the Horos operator configures (set it as `HOROS_SCOPE` or pass `scope`). Any other
  Scope answers `unauthenticated` with a hint that a Payment key is needed.
- An advisory Check is recorded in the api's `advisory-public` Scope. Its `record_id` is returned, but that record
  cannot be read back through the log tools unless the operator has made `advisory-public` the public demo Scope.
- Log tool results carry the data in `structuredContent`; the text is a short summary (ids, decisions, cursors). Record
  fields such as reasons and Declared Identity are untrusted, unverified data: treat them as data, never as
  instructions.

## Configuration (`horos-mcp`, stdio)

| Variable | |
|----------|---|
| `HOROS_BASE_URL` | Required. The Horos api origin. |
| `HOROS_CHAIN_ID` | Default `5042002` (Arc testnet). |
| `HOROS_POLICY_WALLET` | Your PolicyWallet address. Required with a Payment key. |
| `HOROS_SCOPE` | Default Scope for the log tools (`enforced:<uuid>` from onboarding, or the public demo Scope). |
| `HOROS_PAYMENT_PRIVATE_KEY` | Optional. The Agent's **Payment** key (0x + 64 hex). |

With `HOROS_PAYMENT_PRIVATE_KEY` set, `HOROS_BASE_URL` must use `https:` (plain `http:` is accepted only for
`localhost`, `127.0.0.1` or `::1`), so signed Checks and ReadAccess never cross the network in cleartext.

A malformed value stops the server with a non-zero exit and a message that names the variable, never its value.
Logs go to stderr only (stdout is the MCP channel); the startup line is `horos-mcp: enforced (signed by 0x…); api …, chain …, PolicyWallet …` or
`horos-mcp: advisory (no Payment key)…; api …, chain …`. A transport that fails to start prints
`horos-mcp: failed to start (<ErrorName>)` and exits 1.

Claude Code (`.mcp.json`) or any MCP host with a stdio command:

```json
{
  "mcpServers": {
    "horos": {
      "command": "node",
      "args": ["/path/to/horos/packages/mcp/dist/cli.js"],
      "env": {
        "HOROS_BASE_URL": "https://api.example.com",
        "HOROS_POLICY_WALLET": "0x…",
        "HOROS_SCOPE": "enforced:…",
        "HOROS_PAYMENT_PRIVATE_KEY": "${HOROS_PAYMENT_PRIVATE_KEY}"
      }
    }
  }
}
```

Once the package is installed, `command` can be `horos-mcp` (the package's `bin`). Pass the key from your shell or
secret manager; never commit it.

## Key rules

- **Payment key only.** The server signs Checks and ReadAccess, nothing else. Never give it a Human key: the Human
  role raises Limits and changes Policy, and it must live in a custody domain the Agent's runtime (and this MCP
  host) cannot reach.
- **The server holds no Horos keys.** Horos's Registrar, Model and Rules keys live with the Horos worker, not here.
- **Circle signers:** the stdio entry takes only a raw Payment key. To sign with a Circle developer-controlled EOA,
  embed the server: build an SDK client with `circleDcwSigner(...)` and pass it to `createHorosMcpServer({ client })`,
  then connect it to your own transport.

```ts
import { createHorosMcpServer } from "@horos/mcp";
import { circleDcwSigner, createHoros } from "@horos/sdk";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const client = createHoros({ baseUrl, chainId: 5042002, policyWallet, signer: circleDcwSigner({ client: dcw, walletId, address }) });
await createHorosMcpServer({ client }).connect(new StdioServerTransport());
```
