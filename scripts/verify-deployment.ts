// Post-deployment verification for the Electroneum ENS pipeline.
//
// Reads contract addresses and ABIs from the rocketh deployment records and
// checks the deployed system in three phases:
//
//   1. Read-only wiring checks          — always run, free
//   2. Full user round-trip             — needs TEST_KEY (throwaway funded wallet):
//      commit -> register -> resolve -> reverse -> renew (+ negative checks)
//   3. Operational drills               — needs OWNER_KEY (the owner wallet):
//      oracle price adjustment round-trip, controller fee withdrawal
//
// Usage:
//   NETWORK=electroneumTestnet RPC_URL=http://localhost:8545 \
//   TEST_KEY=0x... OWNER_KEY=0x... bun ./scripts/verify-deployment.ts
//
// Phase 2 waits out the controller's minCommitmentAge (60s), so the full run
// takes a little over a minute. Exits non-zero if any check fails.

import fs from 'node:fs'
import path from 'node:path'
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  labelhash,
  namehash,
  toHex,
  zeroHash,
  type Abi,
  type Address,
  type Hex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

const NETWORK = process.env.NETWORK ?? 'electroneumTestnet'
const RPC_URL = process.env.RPC_URL ?? 'http://localhost:8545'
const TEST_KEY = process.env.TEST_KEY as Hex | undefined
const OWNER_KEY = process.env.OWNER_KEY as Hex | undefined

const MIN_REGISTRATION_DURATION = 2419200n // 28 days
const CANONICAL_MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11'
const CANONICAL_USV = '0x164af34fAF9879394370C7f09064127C043A35E9'

const deploymentsDir = path.join('deployments', NETWORK)
function load(name: string): { address: Address; abi: Abi } {
  const file = path.join(deploymentsDir, `${name}.json`)
  const record = JSON.parse(fs.readFileSync(file, 'utf-8'))
  return { address: record.address, abi: record.abi }
}
function loadOrNull(name: string): { address: Address; abi: Abi } | null {
  try {
    return load(name)
  } catch {
    return null
  }
}

const publicClient = createPublicClient({ transport: http(RPC_URL) })
const chain = defineChain({
  id: await publicClient.getChainId(),
  name: NETWORK,
  nativeCurrency: { name: 'ETN', symbol: 'ETN', decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
})

let pass = 0
let fail = 0
function check(label: string, ok: boolean, detail?: string) {
  if (ok) {
    pass++
    console.log(`  ✓ ${label}`)
  } else {
    fail++
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`)
  }
}
function eqAddr(label: string, actual: unknown, expected: string) {
  const a = String(actual).toLowerCase()
  const e = expected.toLowerCase()
  check(label, a === e, `got ${actual}, expected ${expected}`)
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const registry = load('ENSRegistry')
const registrar = load('BaseRegistrarImplementation')
const securityController = load('RegistrarSecurityController')
const controller = load('ETHRegistrarController')
const publicResolver = load('PublicResolver')
const ownedResolver = load('OwnedResolver')
const reverseRegistrar = load('ReverseRegistrar')
const defaultReverseResolver = load('DefaultReverseResolver')
const oracle = loadOrNull('OwnedUsdOracle') ?? load('DummyOracle')

const read = (c: { address: Address; abi: Abi }, functionName: string, args: unknown[] = []) =>
  publicClient.readContract({ address: c.address, abi: c.abi, functionName, args })

// ---------------------------------------------------------------- Phase 1
console.log(`\n=== Phase 1: wiring checks (${NETWORK} @ ${RPC_URL}, chain ${chain.id}) ===`)

eqAddr('.etn node owned by BaseRegistrar', await read(registry, 'owner', [namehash('etn')]), registrar.address)
eqAddr('.etn resolver is OwnedResolver', await read(registry, 'resolver', [namehash('etn')]), ownedResolver.address)
eqAddr('registrar owned by RegistrarSecurityController', await read(registrar, 'owner'), securityController.address)
eqAddr('.reverse resolver is DefaultReverseResolver', await read(registry, 'resolver', [namehash('reverse')]), defaultReverseResolver.address)
eqAddr('addr.reverse owned by ReverseRegistrar', await read(registry, 'owner', [namehash('addr.reverse')]), reverseRegistrar.address)
eqAddr('ReverseRegistrar default resolver is PublicResolver', await read(reverseRegistrar, 'defaultResolver'), publicResolver.address)

const oracleValue = (await read(oracle, 'latestAnswer')) as bigint
check(`oracle value positive (${oracleValue})`, oracleValue > 0n)

const multicall = loadOrNull('Multicall3')
const multicallAddress = multicall?.address ?? CANONICAL_MULTICALL3
const multicallCode = await publicClient.getCode({ address: multicallAddress })
check(
  `Multicall3 has code at ${multicallAddress}${multicallAddress.toLowerCase() === CANONICAL_MULTICALL3.toLowerCase() ? ' (canonical)' : ' (non-canonical)'}`,
  !!multicallCode && multicallCode !== '0x',
)
const usvRecord = loadOrNull('UniversalSigValidator')
const usvAddress = usvRecord?.address ?? CANONICAL_USV
const usvCode = await publicClient.getCode({ address: usvAddress })
check(
  `UniversalSigValidator has code at ${usvAddress}${usvAddress.toLowerCase() === CANONICAL_USV.toLowerCase() ? ' (canonical, ERC-6492 supported)' : ' (non-canonical, ERC-6492 unsupported)'}`,
  !!usvCode && usvCode !== '0x',
)

for (const reserved of ['wallet', 'pay']) {
  check(`reserved name ${reserved}.etn is taken`, !(await read(controller, 'available', [reserved])))
  const reservedOwner = (await read(registrar, 'ownerOf', [BigInt(labelhash(reserved))])) as Address
  console.log(`    (${reserved}.etn registrar owner: ${reservedOwner})`)
}

const probePrice = (await read(controller, 'rentPrice', ['testname12345', 31536000n])) as
  | { base: bigint; premium: bigint }
  | [bigint, bigint]
const probeBase = Array.isArray(probePrice) ? probePrice[0] : probePrice.base
check(`rentPrice(1y, 5+ chars) positive (${probeBase / 10n ** 18n} ETN)`, probeBase > 0n)

// ---------------------------------------------------------------- Phase 2
if (!TEST_KEY) {
  console.log('\n=== Phase 2: SKIPPED (set TEST_KEY to a funded throwaway wallet) ===')
} else {
  console.log('\n=== Phase 2: registration round-trip ===')
  const tester = privateKeyToAccount(TEST_KEY)
  const wallet = createWalletClient({ account: tester, chain, transport: http(RPC_URL) })
  const balance = await publicClient.getBalance({ address: tester.address })
  console.log(`  test wallet ${tester.address}, balance ${balance / 10n ** 18n} ETN`)

  const send = async (
    c: { address: Address; abi: Abi },
    functionName: string,
    args: unknown[],
    value?: bigint,
  ) => {
    const hash = await wallet.writeContract({
      address: c.address,
      abi: c.abi,
      functionName,
      args,
      value,
    } as any)
    const receipt = await publicClient.waitForTransactionReceipt({ hash })
    if (receipt.status !== 'success')
      throw new Error(`${functionName} reverted (${hash})`)
    return receipt
  }

  const label = `verify${Date.now()}`
  const name = `${label}.etn`
  const registration = {
    label,
    owner: tester.address,
    duration: MIN_REGISTRATION_DURATION,
    secret: toHex(crypto.getRandomValues(new Uint8Array(32))),
    resolver: publicResolver.address,
    data: [] as Hex[],
    reverseRecord: 1, // set the reverse record during registration
    referrer: zeroHash,
  }

  check(`${name} available before registration`, (await read(controller, 'available', [label])) as boolean)

  const commitment = await read(controller, 'makeCommitment', [registration])
  await send(controller, 'commit', [commitment])
  const minAge = (await read(controller, 'minCommitmentAge')) as bigint
  console.log(`  committed; waiting ${minAge + 5n}s for minCommitmentAge...`)
  await sleep(Number(minAge + 5n) * 1000)

  const price = (await read(controller, 'rentPrice', [label, MIN_REGISTRATION_DURATION])) as
    | { base: bigint; premium: bigint }
    | [bigint, bigint]
  const total = Array.isArray(price) ? price[0] + price[1] : price.base + price.premium
  const balanceBefore = await publicClient.getBalance({ address: tester.address })
  await send(controller, 'register', [registration], (total * 102n) / 100n) // 2% margin, excess refunded
  console.log(`  registered ${name} for ${total / 10n ** 18n} ETN`)

  eqAddr(`${name} registry owner is test wallet`, await read(registry, 'owner', [namehash(name)]), tester.address)
  eqAddr(`${name} registrar NFT owner is test wallet`, await read(registrar, 'ownerOf', [BigInt(labelhash(label))]), tester.address)
  eqAddr(`${name} resolver is PublicResolver`, await read(registry, 'resolver', [namehash(name)]), publicResolver.address)
  check(`${name} no longer available`, !(await read(controller, 'available', [label])))
  const spent = balanceBefore - (await publicClient.getBalance({ address: tester.address }))
  check(`excess payment refunded (spent ${spent} <= price + gas margin)`, spent < (total * 102n) / 100n)

  // forward resolution
  await send(publicResolver, 'setAddr', [namehash(name), tester.address])
  eqAddr('forward resolution: addr() returns test wallet', await read(publicResolver, 'addr', [namehash(name)]), tester.address)

  // reverse resolution (set via reverseRecord bit during registration)
  const reverseNode = (await read(reverseRegistrar, 'node', [tester.address])) as Hex
  const reverseName = (await read(publicResolver, 'name', [reverseNode])) as string
  check(`reverse resolution: name(node) == ${name}`, reverseName === name, `got "${reverseName}"`)

  // negative check: registering the same name again must revert
  const rereg = { ...registration, secret: toHex(crypto.getRandomValues(new Uint8Array(32))) }
  const reregFailed = await publicClient
    .simulateContract({
      account: tester.address,
      address: controller.address,
      abi: controller.abi,
      functionName: 'register',
      args: [rereg],
      value: total,
    } as any)
    .then(() => false)
    .catch(() => true)
  check('re-registering a taken name reverts', reregFailed)

  // renewal
  const expiryBefore = (await read(registrar, 'nameExpires', [BigInt(labelhash(label))])) as bigint
  await send(controller, 'renew', [label, MIN_REGISTRATION_DURATION, zeroHash], (total * 102n) / 100n)
  const expiryAfter = (await read(registrar, 'nameExpires', [BigInt(labelhash(label))])) as bigint
  check(
    `renewal extends expiry by ${MIN_REGISTRATION_DURATION}s`,
    expiryAfter - expiryBefore === MIN_REGISTRATION_DURATION,
    `delta ${expiryAfter - expiryBefore}`,
  )
}

// ---------------------------------------------------------------- Phase 3
if (!OWNER_KEY) {
  console.log('\n=== Phase 3: SKIPPED (set OWNER_KEY to run owner drills) ===')
} else {
  console.log('\n=== Phase 3: operational drills (owner wallet) ===')
  const owner = privateKeyToAccount(OWNER_KEY)
  const ownerWallet = createWalletClient({ account: owner, chain, transport: http(RPC_URL) })
  const ownerSend = async (
    c: { address: Address; abi: Abi },
    functionName: string,
    args: unknown[] = [],
  ) => {
    const hash = await ownerWallet.writeContract({
      address: c.address,
      abi: c.abi,
      functionName,
      args,
    } as any)
    const receipt = await publicClient.waitForTransactionReceipt({ hash })
    if (receipt.status !== 'success')
      throw new Error(`${functionName} reverted (${hash})`)
  }

  eqAddr('oracle owned by owner wallet', await read(oracle, 'owner'), owner.address)
  eqAddr('RegistrarSecurityController owned by owner wallet', await read(securityController, 'owner'), owner.address)

  // oracle adjustment round-trip: doubling the ETN/USD value should halve prices
  if ('set' in Object.fromEntries(oracle.abi.filter((f: any) => f.type === 'function').map((f: any) => [f.name, f]))) {
    const before = (await read(oracle, 'latestAnswer')) as bigint
    const priceBefore = (await read(controller, 'rentPrice', ['oracledrill', 31536000n])) as any
    const baseBefore = Array.isArray(priceBefore) ? priceBefore[0] : priceBefore.base
    await ownerSend(oracle, 'set', [before * 2n])
    const priceAfter = (await read(controller, 'rentPrice', ['oracledrill', 31536000n])) as any
    const baseAfter = Array.isArray(priceAfter) ? priceAfter[0] : priceAfter.base
    check(
      'doubling oracle value halves rent price',
      baseAfter > (baseBefore * 49n) / 100n && baseAfter < (baseBefore * 51n) / 100n,
      `before ${baseBefore}, after ${baseAfter}`,
    )
    await ownerSend(oracle, 'set', [before])
    check('oracle value restored', ((await read(oracle, 'latestAnswer')) as bigint) === before)
  }

  // fee withdrawal (phase 2 left registration fees in the controller)
  const controllerBalance = await publicClient.getBalance({ address: controller.address })
  if (controllerBalance > 0n) {
    await ownerSend(controller, 'withdraw')
    check(
      `controller fees withdrawn (${controllerBalance / 10n ** 18n} ETN)`,
      (await publicClient.getBalance({ address: controller.address })) === 0n,
    )
  } else {
    console.log('  (controller balance is 0, skipping withdraw drill)')
  }
}

// ---------------------------------------------------------------- Summary
console.log(`\n=== ${pass} passed, ${fail} failed ===`)
process.exit(fail ? 1 : 0)
