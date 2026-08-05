import hre from 'hardhat'
import { labelhash, namehash, zeroAddress, zeroHash } from 'viem'

import { getAccounts, toLabelId, toNameId } from '../fixtures/utils.js'

const connection = await hre.network.connect()
const accounts = await getAccounts(connection)

const GRACE_PERIOD = 90n * 24n * 60n * 60n
const DURATION = 86400n
const REFERRER =
  '0x1234567890123456789012345678901234567890123456789012345678901234' as const

async function fixture() {
  // Create a registry
  const ensRegistry = await connection.viem.deployContract('ENSRegistry', [])
  // Create a base registrar rooted at .etn (must match the NameWrapper's
  // hardcoded ETN_NODE for the wrap path to work)
  const baseRegistrar = await connection.viem.deployContract(
    'BaseRegistrarImplementation',
    [ensRegistry.address, namehash('etn')],
  )

  // Setup reverse registrar
  const reverseRegistrar = await connection.viem.deployContract(
    'ReverseRegistrar',
    [ensRegistry.address],
  )

  await ensRegistry.write.setSubnodeOwner([
    zeroHash,
    labelhash('reverse'),
    accounts[0].address,
  ])
  await ensRegistry.write.setSubnodeOwner([
    namehash('reverse'),
    labelhash('addr'),
    reverseRegistrar.address,
  ])

  // Create a name wrapper
  const nameWrapper = await connection.viem.deployContract('NameWrapper', [
    ensRegistry.address,
    baseRegistrar.address,
    accounts[0].address,
  ])
  // Create a public resolver
  const publicResolver = await connection.viem.deployContract(
    'PublicResolver',
    [ensRegistry.address, nameWrapper.address, zeroAddress, zeroAddress],
  )

  // Set up a dummy price oracle and a controller
  const dummyOracle = await connection.viem.deployContract('DummyOracle', [
    100000000n,
  ])
  const priceOracle = await connection.viem.deployContract(
    'StablePriceOracle',
    [dummyOracle.address, [0n, 0n, 4n, 2n, 1n]],
  )
  const controller = await connection.viem.deployContract(
    'ETHRegistrarController',
    [
      baseRegistrar.address,
      priceOracle.address,
      600n,
      86400n,
      reverseRegistrar.address,
      zeroAddress,
      ensRegistry.address,
    ],
  )

  await baseRegistrar.write.addController([controller.address])
  await baseRegistrar.write.addController([accounts[0].address])
  // The NameWrapper renews via the registrar, so it must be a controller
  await baseRegistrar.write.addController([nameWrapper.address])

  // Create the universal renewal contract and authorise it on the NameWrapper
  const renewal = await connection.viem.deployContract(
    'UniversalRegistrarRenewalWithReferrer',
    [controller.address, nameWrapper.address],
  )
  await nameWrapper.write.setController([renewal.address, true])

  // Transfer .etn node to base registrar
  await ensRegistry.write.setSubnodeRecord([
    zeroHash,
    labelhash('etn'),
    accounts[0].address,
    publicResolver.address,
    0n,
  ])
  await ensRegistry.write.setOwner([namehash('etn'), baseRegistrar.address])

  // Register names owned by accounts[1]
  for (const name of ['unwrapped1', 'unwrapped2', 'wrapped1']) {
    await baseRegistrar.write.register([
      toLabelId(name),
      accounts[1].address,
      31536000n,
    ])
  }

  // Wrap wrapped1.etn
  await baseRegistrar.write.setApprovalForAll([nameWrapper.address, true], {
    account: accounts[1],
  })
  await nameWrapper.write.wrapETH2LD(
    ['wrapped1', accounts[1].address, 0, publicResolver.address],
    { account: accounts[1] },
  )

  return { ensRegistry, baseRegistrar, nameWrapper, controller, renewal }
}
const loadFixture = async () => connection.networkHelpers.loadFixture(fixture)

describe('UniversalRegistrarRenewalWithReferrer', () => {
  it('should price a single renewal identically to the controller', async () => {
    const { renewal, controller } = await loadFixture()

    const [fromRenewal, fromController] = await Promise.all([
      renewal.read.rentPrice(['unwrapped1', DURATION]),
      controller.read.rentPrice(['unwrapped1', DURATION]),
    ])
    expect(fromRenewal).toEqual(fromController)
  })

  it('should return the total cost of a bulk renewal', async () => {
    const { renewal } = await loadFixture()

    await expect(
      renewal.read.rentPrice([['unwrapped1', 'unwrapped2'], DURATION]),
    ).resolves.toEqual(DURATION * 2n)
  })

  it('should renew an unwrapped name without touching wrapper state', async () => {
    const { baseRegistrar, nameWrapper, renewal } = await loadFixture()

    const oldExpiry = await baseRegistrar.read.nameExpires([
      toLabelId('unwrapped1'),
    ])

    await renewal.write.renew(['unwrapped1', DURATION, REFERRER], {
      value: DURATION,
    })

    const newExpiry = await baseRegistrar.read.nameExpires([
      toLabelId('unwrapped1'),
    ])
    expect(newExpiry - oldExpiry).toBe(DURATION)

    // Name was never wrapped: wrapper must have no record of it
    const [wrappedOwner] = await nameWrapper.read.getData([
      toNameId('unwrapped1.etn'),
    ])
    expect(wrappedOwner).toEqualAddress(zeroAddress)
  })

  it('should renew a wrapped name and keep wrapper expiry in sync', async () => {
    const { baseRegistrar, nameWrapper, renewal } = await loadFixture()

    await renewal.write.renew(['wrapped1', DURATION, REFERRER], {
      value: DURATION,
    })

    const registrarExpiry = await baseRegistrar.read.nameExpires([
      toLabelId('wrapped1'),
    ])
    const [, , wrapperExpiry] = await nameWrapper.read.getData([
      toNameId('wrapped1.etn'),
    ])
    expect(wrapperExpiry).toBe(registrarExpiry + GRACE_PERIOD)
  })

  it('should emit NameRenewed with the referrer', async () => {
    const { baseRegistrar, renewal } = await loadFixture()

    const oldExpiry = await baseRegistrar.read.nameExpires([
      toLabelId('wrapped1'),
    ])

    await expect(
      renewal.write.renew(['wrapped1', DURATION, REFERRER], {
        value: DURATION,
      }),
    )
      .toEmitEvent('NameRenewed')
      .withArgs({
        label: 'wrapped1',
        labelhash: labelhash('wrapped1'),
        cost: DURATION,
        expires: oldExpiry + DURATION,
        referrer: REFERRER,
      })
  })

  it('should refund excess payment on single renewal', async () => {
    const { renewal } = await loadFixture()
    const publicClient = await connection.viem.getPublicClient()

    await renewal.write.renew(['unwrapped1', DURATION, REFERRER], {
      value: DURATION * 3n,
    })

    // Contract keeps only the cost; excess was refunded to the caller
    await expect(
      publicClient.getBalance({ address: renewal.address }),
    ).resolves.toEqual(DURATION)
  })

  it('should revert on insufficient value', async () => {
    const { renewal } = await loadFixture()

    await expect(
      renewal.write.renew(['unwrapped1', DURATION, REFERRER], {
        value: DURATION - 1n,
      }),
    ).toBeRevertedWithCustomError('InsufficientValue')
  })

  it('should bulk-renew a mix of wrapped and unwrapped names', async () => {
    const { baseRegistrar, nameWrapper, renewal } = await loadFixture()
    const publicClient = await connection.viem.getPublicClient()

    const oldUnwrappedExpiry = await baseRegistrar.read.nameExpires([
      toLabelId('unwrapped2'),
    ])

    await renewal.write.renewAll(
      [['unwrapped2', 'wrapped1'], DURATION, REFERRER],
      { value: DURATION * 4n },
    )

    const newUnwrappedExpiry = await baseRegistrar.read.nameExpires([
      toLabelId('unwrapped2'),
    ])
    expect(newUnwrappedExpiry - oldUnwrappedExpiry).toBe(DURATION)

    const wrappedRegistrarExpiry = await baseRegistrar.read.nameExpires([
      toLabelId('wrapped1'),
    ])
    const [, , wrapperExpiry] = await nameWrapper.read.getData([
      toNameId('wrapped1.etn'),
    ])
    expect(wrapperExpiry).toBe(wrappedRegistrarExpiry + GRACE_PERIOD)

    // Excess (2x overpayment) refunded; contract retains the 2-name cost
    await expect(
      publicClient.getBalance({ address: renewal.address }),
    ).resolves.toEqual(DURATION * 2n)
  })

  it('should revert bulk renewal on insufficient value', async () => {
    const { renewal } = await loadFixture()

    await expect(
      renewal.write.renewAll([['unwrapped1', 'unwrapped2'], DURATION, REFERRER], {
        value: DURATION,
      }),
    ).toBeRevertedWithCustomError('InsufficientValue')
  })

  it('should raise an error trying to renew a nonexistent name', async () => {
    const { renewal } = await loadFixture()

    await expect(
      renewal.write.renew(['doesnotexist', DURATION, REFERRER], {
        value: DURATION,
      }),
    ).toBeReverted()
  })

  it('should send withdrawn funds to the owner', async () => {
    const { renewal } = await loadFixture()
    const publicClient = await connection.viem.getPublicClient()

    await renewal.write.renew(['unwrapped1', DURATION, REFERRER], {
      value: DURATION,
    })

    const ownerBalanceBefore = await publicClient.getBalance({
      address: accounts[0].address,
    })
    // Callable by anyone; funds always go to the owner
    await renewal.write.withdraw({ account: accounts[2] })
    const ownerBalanceAfter = await publicClient.getBalance({
      address: accounts[0].address,
    })

    expect(ownerBalanceAfter - ownerBalanceBefore).toBe(DURATION)
    await expect(
      publicClient.getBalance({ address: renewal.address }),
    ).resolves.toEqual(0n)
  })
})
