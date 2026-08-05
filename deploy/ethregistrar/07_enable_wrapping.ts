import { artifacts, deployScript } from '@rocketh'

// Enables safe name wrapping on Electroneum by deploying the
// UniversalRegistrarRenewalWithReferrer (single + bulk renewals routed through
// NameWrapper.renew, which keeps wrapper expiry in sync for wrapped names and
// no-ops wrapper state for unwrapped ones) and adding it as a controller on
// the NameWrapper. This is the missing piece that made the dapp disable
// wrapping (getChainSupportsNameWrapping): without a wrapper-aware renewal
// path, renewing a wrapped name would desync wrapper expiry permanently.
export default deployScript(
  async ({ deploy, get, read, execute: write, namedAccounts }) => {
    const { deployer, owner } = namedAccounts

    const controller =
      get<(typeof artifacts.ETHRegistrarController)['abi']>(
        'ETHRegistrarController',
      )
    const nameWrapper =
      get<(typeof artifacts.NameWrapper)['abi']>('NameWrapper')

    const renewal = await deploy('UniversalRegistrarRenewalWithReferrer', {
      account: deployer,
      artifact: artifacts.UniversalRegistrarRenewalWithReferrer,
      args: [controller.address, nameWrapper.address],
    })

    // Renewal fees accrue in this contract and withdraw() pays owner();
    // hand ownership to the owner account rather than leaving the deploy key
    // as the fee recipient.
    const renewalOwner = (await read(renewal, {
      functionName: 'owner',
    })) as string
    if (
      owner !== deployer &&
      renewalOwner.toLowerCase() === deployer.toLowerCase()
    ) {
      console.log(
        `  - Transferring ownership of UniversalRegistrarRenewalWithReferrer to ${owner}`,
      )
      await write(renewal, {
        functionName: 'transferOwnership',
        args: [owner],
        account: deployer,
      })
    }

    const isController = (await read(nameWrapper, {
      functionName: 'controllers',
      args: [renewal.address],
    })) as boolean
    if (isController) {
      console.log(
        `  - ${renewal.address} already a NameWrapper controller, nothing to do`,
      )
      return true
    }

    const nameWrapperOwner = (await read(nameWrapper, {
      functionName: 'owner',
    })) as string
    if (nameWrapperOwner.toLowerCase() !== owner.toLowerCase()) {
      throw new Error(
        `NameWrapper owner is ${nameWrapperOwner}; the configured 'owner' ` +
          `account is ${owner} — cannot call setController`,
      )
    }

    console.log(
      `  - Adding UniversalRegistrarRenewalWithReferrer (${renewal.address}) as NameWrapper controller`,
    )
    await write(nameWrapper, {
      functionName: 'setController',
      args: [renewal.address, true],
      account: owner,
    })

    return true
  },
  {
    id: 'EnableWrapping v1.0.0',
    tags: ['category:ethregistrar', 'EnableWrapping'],
    dependencies: ['ETHRegistrarController', 'NameWrapper'],
  },
)
