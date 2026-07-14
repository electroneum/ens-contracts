// Post-deployment verification for the Electroneum ENS pipeline.
//
// Reads contract addresses and ABIs from the rocketh deployment records and
// checks the deployed system in three phases:
//
//   1. Read-only wiring checks          — always run, free
//   2. Full user round-trip             — needs a funded registrant wallet:
//      commit -> register -> resolve -> reverse -> renew (+ negative checks)
//   3. Operational drills               — needs the owner wallet:
//      oracle price adjustment round-trip, controller fee withdrawal
//
// Preferred usage (network, RPC and keystore accounts come from hardhat):
//
//   bunx hardhat verify-deployment --network electroneumTestnet
//   bunx hardhat verify-deployment --network electroneumTestnet --read-only
//
// The registrant for phase 2 defaults to the deployer account; set TEST_KEY
// to use a throwaway wallet instead. The script clears the reverse record it
// creates, so running with the deployer leaves no residue (besides the
// expiring verifyNNN.etn name itself).
//
// Standalone usage (no hardhat):
//
//   NETWORK=electroneumTestnet RPC_URL=http://localhost:8545 \
//   TEST_KEY=0x... OWNER_KEY=0x... bun ./scripts/verify-deployment.ts
//
// Phase 2 waits out the controller's minCommitmentAge (60s), so a full run
// takes a little over a minute. Fails (non-zero exit / thrown error) if any
// check fails.

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
  type PublicClient,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { RESERVED_NAMES } from './reserved_names.js'

const MIN_REGISTRATION_DURATION = 2419200n // 28 days
const CANONICAL_MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11'
const CANONICAL_USV = '0x164af34fAF9879394370C7f09064127C043A35E9'

/// Minimal structural type so both hardhat-viem wallet clients and manually
/// created ones fit without generic friction.
export type VerifyWallet = {
  account: { address: Address }
  writeContract: (args: any) => Promise<Hex>
}

export type VerifyOptions = {
  networkName: string
  publicClient: PublicClient
  testWallet?: VerifyWallet
  ownerWallet?: VerifyWallet
}

export async function verifyDeployment({
  networkName,
  publicClient,
  testWallet,
  ownerWallet,
}: VerifyOptions): Promise<{ pass: number; fail: number }> {
  const deploymentsDir = path.join('deployments', networkName)
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

  const read = (
    c: { address: Address; abi: Abi },
    functionName: string,
    args: unknown[] = [],
  ) => publicClient.readContract({ address: c.address, abi: c.abi, functionName, args })

  const sendAs = async (
    wallet: VerifyWallet,
    c: { address: Address; abi: Abi },
    functionName: string,
    args: unknown[] = [],
    value?: bigint,
  ) => {
    const hash = await wallet.writeContract({
      address: c.address,
      abi: c.abi,
      functionName,
      args,
      value,
      account: wallet.account,
    })
    const receipt = await publicClient.waitForTransactionReceipt({ hash })
    if (receipt.status !== 'success') throw new Error(`${functionName} reverted (${hash})`)
    return receipt
  }

  // ---------------------------------------------------------------- Phase 1
  const chainId = await publicClient.getChainId()
  console.log(`\n=== Phase 1: wiring checks (${networkName}, chain ${chainId}) ===`)

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

  for (const reserved of RESERVED_NAMES) {
    check(`reserved name ${reserved}.etn is taken`, !(await read(controller, 'available', [reserved])))
    const reservedOwner = (await read(registrar, 'ownerOf', [BigInt(labelhash(reserved))])) as Address
    console.log(`    (${reserved}.etn registrar owner: ${reservedOwner})`)
  }

  // legacy resolver-discovery convention: resolver.etn points at PublicResolver
  eqAddr('resolver.etn resolver is PublicResolver', await read(registry, 'resolver', [namehash('resolver.etn')]), publicResolver.address)
  eqAddr('resolver.etn addr() is PublicResolver', await read(publicResolver, 'addr', [namehash('resolver.etn')]), publicResolver.address)

  const probePrice = (await read(controller, 'rentPrice', ['testname12345', 31536000n])) as
    | { base: bigint; premium: bigint }
    | [bigint, bigint]
  const probeBase = Array.isArray(probePrice) ? probePrice[0] : probePrice.base
  check(`rentPrice(1y, 5+ chars) positive (${probeBase / 10n ** 18n} ETN)`, probeBase > 0n)

  // ---------------------------------------------------------------- Phase 2
  if (!testWallet) {
    console.log('\n=== Phase 2: SKIPPED (no registrant wallet provided) ===')
  } else {
    console.log('\n=== Phase 2: registration round-trip ===')
    const tester = testWallet.account
    const send = (c: { address: Address; abi: Abi }, fn: string, args: unknown[], value?: bigint) =>
      sendAs(testWallet, c, fn, args, value)
    const balance = await publicClient.getBalance({ address: tester.address })
    console.log(`  registrant ${tester.address}, balance ${balance / 10n ** 18n} ETN`)

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

    eqAddr(`${name} registry owner is registrant`, await read(registry, 'owner', [namehash(name)]), tester.address)
    eqAddr(`${name} registrar NFT owner is registrant`, await read(registrar, 'ownerOf', [BigInt(labelhash(label))]), tester.address)
    eqAddr(`${name} resolver is PublicResolver`, await read(registry, 'resolver', [namehash(name)]), publicResolver.address)
    check(`${name} no longer available`, !(await read(controller, 'available', [label])))
    const spent = balanceBefore - (await publicClient.getBalance({ address: tester.address }))
    check(`excess payment refunded (spent ${spent} <= price + gas margin)`, spent < (total * 102n) / 100n)

    // forward resolution
    await send(publicResolver, 'setAddr', [namehash(name), tester.address])
    eqAddr('forward resolution: addr() returns registrant', await read(publicResolver, 'addr', [namehash(name)]), tester.address)

    // reverse resolution (set via reverseRecord bit during registration)
    const reverseNode = (await read(reverseRegistrar, 'node', [tester.address])) as Hex
    const reverseName = (await read(publicResolver, 'name', [reverseNode])) as string
    check(`reverse resolution: name(node) == ${name}`, reverseName === name, `got "${reverseName}"`)

    // clean up the reverse record so the registrant wallet keeps no residue
    await send(reverseRegistrar, 'setName', [''])
    check('reverse record cleared after test', ((await read(publicResolver, 'name', [reverseNode])) as string) === '')

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
  if (!ownerWallet) {
    console.log('\n=== Phase 3: SKIPPED (no owner wallet provided) ===')
  } else {
    console.log('\n=== Phase 3: operational drills (owner wallet) ===')
    const owner = ownerWallet.account
    const ownerSend = (c: { address: Address; abi: Abi }, fn: string, args: unknown[] = []) =>
      sendAs(ownerWallet, c, fn, args)

    eqAddr('oracle owned by owner wallet', await read(oracle, 'owner'), owner.address)
    eqAddr('RegistrarSecurityController owned by owner wallet', await read(securityController, 'owner'), owner.address)

    // oracle adjustment round-trip: doubling the ETN/USD value should halve prices
    const oracleHasSet = oracle.abi.some((f: any) => f.type === 'function' && f.name === 'set')
    if (oracleHasSet) {
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
  return { pass, fail }
}

// ---------------------------------------------------------------- Standalone
const isMain = process.argv[1]?.endsWith('verify-deployment.ts')
if (isMain) {
  const networkName = process.env.NETWORK ?? 'electroneumTestnet'
  const rpcUrl = process.env.RPC_URL ?? 'http://localhost:8545'
  const publicClient = createPublicClient({ transport: http(rpcUrl) })
  const chain = defineChain({
    id: await publicClient.getChainId(),
    name: networkName,
    nativeCurrency: { name: 'ETN', symbol: 'ETN', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  })
  const makeWallet = (key: Hex) =>
    createWalletClient({ account: privateKeyToAccount(key), chain, transport: http(rpcUrl) })

  const { fail } = await verifyDeployment({
    networkName,
    publicClient,
    testWallet: process.env.TEST_KEY ? makeWallet(process.env.TEST_KEY as Hex) : undefined,
    ownerWallet: process.env.OWNER_KEY ? makeWallet(process.env.OWNER_KEY as Hex) : undefined,
  })
  process.exit(fail ? 1 : 0)
}
