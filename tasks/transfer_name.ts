import { readFile } from 'node:fs/promises'
import type { NewTaskActionFunction } from 'hardhat/types/tasks'
import { getAddress, labelhash, namehash, zeroAddress, type Address } from 'viem'

// Transfers full ownership of an unwrapped .etn 2LD — both the registrar NFT
// (registrant) and the registry node (manager) — to a recipient, using the
// keystore accounts (same password prompt as deploys). The recipient needs no
// action; records/primary-name setup is theirs to do afterwards in the dapp.
//
// Usage:
//   bunx hardhat transfer-name planetzephyros 0xRecipient --network electroneum

type TransferArgs = {
  label: string
  to: string
}

const deploymentsDirByNetwork: Record<string, string> = {
  electroneum: 'electroneum',
  electroneumTestnet: 'electroneumTestnet',
}

async function deployedAddress(dir: string, name: string): Promise<Address> {
  const json = JSON.parse(
    await readFile(`./deployments/${dir}/${name}.json`, 'utf8'),
  )
  return getAddress(json.address)
}

const taskTransferName: NewTaskActionFunction<TransferArgs> = async (
  { label, to },
  hre,
) => {
  const connection = await hre.network.connect()
  const { viem, networkName } = connection

  const deploymentsDir = deploymentsDirByNetwork[networkName]
  if (!deploymentsDir) {
    throw new Error(
      `No deployments mapping for network '${networkName}' — use --network electroneum or electroneumTestnet`,
    )
  }

  // getAddress validates the checksum and throws on a mistyped address
  const recipient = getAddress(to)
  if (label.includes('.')) {
    throw new Error(`Pass the bare label (got '${label}'), eg. planetzephyros`)
  }

  const registryAddress = await deployedAddress(deploymentsDir, 'ENSRegistry')
  const registrarAddress = await deployedAddress(
    deploymentsDir,
    'BaseRegistrarImplementation',
  )
  const wrapperAddress = await deployedAddress(deploymentsDir, 'NameWrapper')

  const registry = await viem.getContractAt('ENSRegistry', registryAddress)
  const registrar = await viem.getContractAt(
    'BaseRegistrarImplementation',
    registrarAddress,
  )

  const tokenId = BigInt(labelhash(label))
  const node = namehash(`${label}.etn`)

  const registrant = getAddress(await registrar.read.ownerOf([tokenId]))
  const manager = getAddress(await registry.read.owner([node]))

  console.log(`${label}.etn`)
  console.log(`  registrant: ${registrant}`)
  console.log(`  manager:    ${manager}`)
  console.log(`  recipient:  ${recipient}`)

  if (registrant === getAddress(wrapperAddress)) {
    throw new Error(
      `${label}.etn is wrapped — transfer it via the NameWrapper (dapp), not this task`,
    )
  }

  const walletClients = await viem.getWalletClients()
  const registrantClient = walletClients.find(
    (c) => getAddress(c.account.address) === registrant,
  )

  if (registrant === recipient) {
    console.log('  - registrant already the recipient, skipping transfer')
  } else {
    if (!registrantClient) {
      throw new Error(
        `Registrant ${registrant} is not among the configured accounts (${walletClients
          .map((c) => c.account.address)
          .join(', ')})`,
      )
    }
    console.log(`  - Transferring registrant to ${recipient}`)
    const hash = await registrar.write.safeTransferFrom(
      [registrant, recipient, tokenId],
      { account: registrantClient.account },
    )
    // write returns at submission; wait for mining before verification
    // (anvil auto-mine hides this, live 5s blocks do not)
    const publicClient = await viem.getPublicClient()
    await publicClient.waitForTransactionReceipt({ hash })
  }

  if (manager === recipient) {
    console.log('  - manager already the recipient, skipping setOwner')
  } else {
    const managerClient = walletClients.find(
      (c) => getAddress(c.account.address) === manager,
    )
    if (!managerClient) {
      throw new Error(
        `Manager ${manager} is not among the configured accounts; the new registrant can claim it later via registrar.reclaim`,
      )
    }
    console.log(`  - Transferring manager (registry node) to ${recipient}`)
    const hash = await registry.write.setOwner([node, recipient], {
      account: managerClient.account,
    })
    const publicClient = await viem.getPublicClient()
    await publicClient.waitForTransactionReceipt({ hash })
  }

  const newRegistrant = getAddress(await registrar.read.ownerOf([tokenId]))
  const newManager = getAddress(await registry.read.owner([node]))
  console.log('Done:')
  console.log(`  registrant: ${newRegistrant}`)
  console.log(`  manager:    ${newManager}`)
  if (newRegistrant !== recipient || newManager !== recipient) {
    throw new Error('Post-transfer verification failed — inspect manually')
  }

  const resolver = await registry.read.resolver([node])
  if (resolver === zeroAddress) {
    console.log(
      '  note: no resolver set — the recipient sets one (and records) in the dapp',
    )
  }
}

export default taskTransferName
