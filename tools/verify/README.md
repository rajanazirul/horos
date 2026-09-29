# @horos/verify

`horos-verify` recomputes every record hash of an exported Scope chain (`{recordHash, record}` JSON Lines,
ordered by seq) with `@horos/schema` and reports the first break: a record that does not parse or is not in
canonical form, a hash mismatch, a seq gap, a broken `prevHash` link, or a Scope change.

```sh
horos-verify scope-chain.jsonl   # exit 0 ok, 1 on a break, 2 on usage or read errors
```

## Record types

Since **0.2.0** a Scope chain may mix two record types (the `ScopeRecord` union):

- `DecisionRecord` v1: a Decision Horos made (golden hashes unchanged since 0.0.0).
- `ExternalRecord` v1 (`recordType: "external"`): an on-chain PolicyWallet change Horos observed but did not
  originate or evaluate (a Human action, or an unrecognised write).

**Verifiers older than 0.2.0 reject chains that contain external records** (the record does not parse).
Upgrade the verifier before verifying an export from a Scope that has seen on-chain changes Horos did not make.
