# Electroneum ENS deployment guide

Step-by-step instructions for deploying the ENS contracts to the Electroneum Smart Chain using the repo's hardhat/rocketh pipeline (`deploy/**`). This is the single supported deployment path.

Two networks are configured in `hardhat.config.ts` / `rocketh.ts`:

| Network | Chain ID | RPC | Explorer |
|---|---|---|---|
| `electroneum` (mainnet) | 52014 | https://rpc.electroneum.com | https://blockexplorer.electroneum.com |
| `electroneumTestnet` | 5201420 | https://rpc.ankr.com/electroneum_testnet | https://testnet-blockexplorer.electroneum.com |

Deployment records for each network land in `deployments/electroneum/` and `deployments/electroneumTestnet/` respectively (this folder doubles as the mainnet record directory — the rocketh loader only reads `*.json`, so this README does not interfere).

## 1. Install and compile

```bash
bun install
bun run compile   # also regenerates generated/artifacts.ts used by the deploy scripts
```

## 2. Provide the deployment keys

The pipeline uses two named accounts:

| Account    | Source key     | Role |
|------------|----------------|------|
| `deployer` | `DEPLOYER_KEY` | Sends all contract-creation transactions |
| `owner`    | `OWNER_KEY`    | Ends up owning everything: root controller, registrar security controller, NameWrapper, OwnedResolver, ETHRegistrarController, OwnedUsdOracle |

Since Electroneum has no multisig, `OWNER_KEY` should be the single well-secured wallet. It may be the same key as `DEPLOYER_KEY` (the pipeline's ownership-transfer steps simply no-op when `owner === deployer`). Both accounts need ETN for gas.

Preferred: store the keys in Hardhat's encrypted keystore (prompts for the value, never lands in shell history):

```bash
bunx hardhat keystore set DEPLOYER_KEY
bunx hardhat keystore set OWNER_KEY
```

Alternative: export them as plain environment variables of the same names.

## 3. Set the deployment environment variables

```bash
export BATCH_GATEWAY_URLS='["x-batch-gateway:true"]'   # required
export ETN_USD_ORACLE_VALUE=86000                      # optional; USD per ETN, 8 decimals: 86000 = $0.00086
```

- `BATCH_GATEWAY_URLS` (**required**, the pipeline aborts without it): the CCIP-Read batch-gateway URL list stored in the on-chain `BatchGatewayProvider` and served to clients by `UniversalResolver`. `x-batch-gateway:true` tells modern clients (viem ≥2.x) to run the batch gateway locally instead of calling an external service — the right choice for Electroneum since it avoids depending on ENS Labs' hosted gateway. The list is owner-updatable later via `BatchGatewayProvider.setGateways()`.
- `ETN_USD_ORACLE_VALUE` defaults to `86000` if unset. This is only the *initial* value — you update it later with `OwnedUsdOracle.set()` (step 7), so a rough value is fine.

## 4. Sanity-check the pipeline locally

```bash
bun run test:deploy
```

Spins up an in-memory anvil node and runs the full pipeline end-to-end; prints the deployed-contract table in ~2s. Nothing touches a real network.

## 5. Deploy to Electroneum testnet

```bash
bunx hardhat deploy --network electroneumTestnet
```

- The task shows what it's about to execute and asks for confirmation before sending transactions (`--skip-prompts` to run unattended).
- Deployment records are written to `deployments/electroneumTestnet/` — **commit this directory** so addresses and ABIs are tracked, exactly like upstream tracks `deployments/mainnet/`.
- The run is resumable/idempotent: if it fails partway (e.g. RPC hiccup), rerun the same command — already-deployed contracts are read from the records and skipped.

Expected result: ~33 contracts including `ENSRegistry` (plain, no legacy fallback), `Root`, `BaseRegistrarImplementation`, `OwnedUsdOracle`, `ExponentialPremiumPriceOracle`, `ETHRegistrarController`, `ReverseRegistrar`, `DefaultReverseRegistrar`, `NameWrapper`, `PublicResolver`, `UniversalResolver`. `LegacyENSRegistry`, `LegacyETHRegistrarController`, `WrappedETHRegistrarController` and `LegacyPublicResolver` must **not** appear (they are gated behind the `legacy` rocketh network tag, which Electroneum networks don't carry).

## 6. Verify the deployment

Run the automated verification script against the deployed network:

```bash
NETWORK=electroneumTestnet RPC_URL=<your RPC> \
TEST_KEY=<throwaway funded wallet key> \
OWNER_KEY=<owner wallet key> \
bun ./scripts/verify-deployment.ts
```

It reads addresses and ABIs from the deployment records and runs three phases (each key is optional — omitting it skips that phase):

1. **Wiring checks** (read-only, free): `.etn`/`.reverse` node ownership and resolvers, registrar security-controller ownership, oracle value, canonical Multicall3/UniversalSigValidator code, reserved names, pricing sanity.
2. **User round-trip** (`TEST_KEY`, costs testnet ETN and waits out the 60s commitment age): commit → register with reverse record → forward + reverse resolution → excess-payment refund → re-registration revert → renewal.
3. **Operational drills** (`OWNER_KEY`): oracle ownership, price-adjustment round-trip (double the value, watch rent halve, restore), controller fee withdrawal.

The script exits non-zero if any check fails. For mainnet, run the same command with `NETWORK=electroneum`.

## 7. Operate the price oracle

Electroneum has no on-chain ETN/USD feed, so pricing uses the manually-maintained `OwnedUsdOracle`. Registration/renewal pricing follows it directly: the rent tiers are set in USD terms inside `ExponentialPremiumPriceOracle` ($5/yr for 5+ characters, $160/yr for 4, $640/yr for 3, 21-day exponential premium after expiry) and converted to ETN at payment time using the oracle value.

Update the value from the owner wallet whenever the ETN price moves materially:

```bash
cast send <OwnedUsdOracle> 'set(int256)' <newValue> --private-key $OWNER_KEY -r $RPC
# e.g. ETN at $0.00100 → newValue 100000
```

`set()` is `onlyOwner`; the `DummyOracle` used on Ethereum test networks (publicly settable) is never deployed on Electroneum networks.

## 8. Deploy to Electroneum mainnet

Same as step 5 with `--network electroneum` (records land in this directory). Upstream's scripts skip the direct wiring steps on Ethereum mainnet because a multisig has to execute them; that special case keys off the network name `mainnet`, so on `electroneum` all wiring runs automatically from the single owner wallet — no manual follow-up transactions needed.

## Reserved names

`deploy/ethregistrar/06_register_reserved_names.ts` registers the names listed in its `RESERVED_NAMES` constant (currently `wallet.etn` and `pay.etn`) to the **owner account** for 100 years, as part of the pipeline. It registers directly on the base registrar (controller-only, no payment) by temporarily authorising the owner as a registrar controller and revoking it afterwards. The names are ordinary registrar NFTs — renewable, transferable, reclaimable — and can have resolver records set by the owner like any other name. Edit the constant to change the list; the script skips names that are already registered.

## Notes

- The repo carries two rocketh patches in `patches/` (applied automatically by `bun install`):
  - `@rocketh/read-execute`: Electroneum's node (etn-sc, a go-ethereum fork) requires the block parameter for `eth_call`, which rocketh 0.14 omits (fixed upstream in 0.19). Without it, the pipeline fails at the first on-chain read with `missing value for required argument 1`.
  - `rocketh`: rocketh (even 0.19) never checks transaction receipt status, so transactions that revert on-chain were treated as successful and the pipeline continued with broken state. The patch makes any reverted transaction abort the run loudly.
- The pipeline is safe to rerun after an interruption: deployments are skipped via the saved records, and the setup steps check on-chain state before writing (already-transferred ownership, already-set resolvers/algorithms are skipped instead of reverting).
- **Pre-EIP-155 deployments (Multicall3, create2 factory, UniversalSigValidator):** two canonical cross-chain contracts are normally installed via pre-signed, pre-EIP-155 transactions (Nick's method), which etn-sc rejects over RPC. The pipeline probes first (so no funding is stranded at the keyless deployer addresses) and falls back to regular deployments at **non-canonical addresses**, recorded in the deployment files:
  - `Multicall3` — `20_set_tlds` uses the recorded address automatically. If you configure viem/wagmi clients with a custom Electroneum chain definition, point their `multicall3` contract entry at the recorded address.
  - `UniversalSigValidator` — caveat: `SignatureUtils.sol` hardcodes the canonical address (`0x164af34…`), so with a non-canonical deployment, **ERC-6492 signatures (from not-yet-deployed smart wallets) will not validate** in `DefaultReverseRegistrar`/`L2ReverseRegistrar` signature claims. EOA and deployed ERC-1271 wallet signatures are unaffected.
  - To get the **canonical** deployments instead (full upstream parity, ERC-6492 included): run the deploy through your own etn-sc node started with `--rpc.allow-unprotected-txs`. The pre-signed transactions are consensus-valid; the flag only relaxes the node's RPC submission policy. The scripts self-heal — on a rerun they notice the canonical addresses are still empty, probe again, and take the canonical path.
- The DNSSEC/DNS-registrar contracts deploy as part of the upstream pipeline; they are inert on Electroneum (no real DNS `.etn` TLD) and were kept to stay close to upstream.
- To change rent tiers later, deploy a new price oracle contract and point the controller at it; day-to-day price adjustments should only need `OwnedUsdOracle.set()`.
