import type { NewTaskActionFunction } from 'hardhat/types/tasks'
import { createWalletClient, custom, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

import { verifyDeployment } from '../scripts/verify-deployment.js'

type VerifyDeploymentArgs = {
  readOnly: boolean
}

const taskVerifyDeployment: NewTaskActionFunction<VerifyDeploymentArgs> = async (
  { readOnly },
  hre,
) => {
  const connection = await hre.network.connect()
  const { viem, networkName } = connection
  const publicClient = await viem.getPublicClient()

  if (readOnly) {
    // Phase 1 only — no accounts resolved, so no keystore password prompt.
    const { fail } = await verifyDeployment({
      networkName,
      publicClient: publicClient as any,
    })
    if (fail > 0) throw new Error(`${fail} verification check(s) failed`)
    return
  }

  // Configured accounts: index 0 = DEPLOYER_KEY, index 1 = OWNER_KEY.
  const walletClients = await viem.getWalletClients()
  const [deployerWallet, maybeOwnerWallet] = walletClients
  const ownerWallet = maybeOwnerWallet ?? deployerWallet

  // Registrant for the phase-2 round-trip: a throwaway wallet via TEST_KEY if
  // provided, otherwise the deployer account (the script cleans up the
  // reverse record it sets, so this leaves no residue).
  const testWallet = process.env.TEST_KEY
    ? createWalletClient({
        account: privateKeyToAccount(process.env.TEST_KEY as Hex),
        chain: publicClient.chain,
        transport: custom(connection.provider),
      })
    : deployerWallet

  const { fail } = await verifyDeployment({
    networkName,
    publicClient: publicClient as any,
    testWallet: testWallet as any,
    ownerWallet: ownerWallet as any,
  })
  if (fail > 0) throw new Error(`${fail} verification check(s) failed`)
}

export default taskVerifyDeployment
