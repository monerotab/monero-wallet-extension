export type Page = 'overview' | 'send' | 'receive' | 'history' | 'contacts' | 'accounts' | 'settings';
export type Network = 'mainnet' | 'stagenet' | 'testnet' | 'unknown';
export type WalletNetwork = Exclude<Network, 'unknown'>;
export interface SyncProgress { height: number; startHeight: number; endHeight: number; percentDone: number; message: string }
export interface Status {
  engineReady: boolean; walletOpen: boolean; network: Network; height: number; synced: boolean | null;
  version?: string; walletName?: string; vaultId?: string; nodeId?: string | null;
  syncing: boolean; syncProgress?: SyncProgress; lastSyncAt?: number; syncError?: string;
  /** Present while a wallet is open. */
  restoreHeight?: number; autoLockMinutes?: AutoLockMinutes; confirmWithPassword?: boolean;
  /** Display name and URL of the selected node (bundled or custom). */
  nodeName?: string; nodeUrl?: string;
  /** True while a rescan (not an ordinary sync) is running. */
  rescanning?: boolean;
}
export type AutoLockMinutes = 1 | 5 | 15 | 30 | 60;
export interface WalletSettings { autoLockMinutes: AutoLockMinutes; confirmWithPassword: boolean }
export interface WalletKeys { primaryAddress: string; publicViewKey: string; privateViewKey: string; publicSpendKey: string }
export interface IntegratedAddress { integratedAddress: string; paymentId: string }
export interface VaultMeta { id: string; name: string; network: WalletNetwork; createdAt: number; updatedAt: number; revision: number; schemaVersion: 1 }
export interface Account { index: number; label: string; balance: string; unlockedBalance: string; baseAddress: string }
export interface Address { index: number; address: string; label: string; used: boolean; balance: string; unlockedBalance: string; numUnspentOutputs: number }
export interface Destination { address: string; amount: string }
export interface Transaction {
  txid: string; type: 'in' | 'out' | 'pending' | 'failed' | 'pool'; amount: string; fee: string; timestamp: number; height: number;
  confirmations: number; address: string; note: string;
  /** Subaddress indices of the selected account that received (incoming) or funded (outgoing) this transaction. */
  subaddressIndices: number[];
  /** Outgoing destinations recorded by this wallet. Empty for incoming transactions. */
  destinations: Destination[];
  /** Incoming funds that are not spendable yet (Monero's 10-block lock). */
  locked: boolean;
}
export interface Contact { index: number; address: string; description: string }
export interface Snapshot {
  balance: string; unlockedBalance: string; blocksToUnlock: number; height: number; synced: boolean | null; address: string;
  accounts: Account[]; addresses: Address[]; transactions: Transaction[]; contacts: Contact[]; network: Network;
  historyError?: string; historyNotice?: string;
}
export interface Draft { draftId: string; amount: string; fee: string; address: string; expiresAt: number; txHash: string; subtractFee?: boolean }
/** Custom nodes belong to the open wallet (stored encrypted), always use its network and have source ''. */
export interface NodePreset { id: string; name: string; url: string; network: WalletNetwork; kind: 'public' | 'local' | 'custom'; source: string }
export interface NodeCheck { nodeId: string; reachable: boolean; network: Network; height: number | null; targetHeight: number | null; synchronized: boolean | null; latencyMs: number | null; checkedAt: number; error?: string }
export interface NodeSelection { nodes: NodePreset[]; selectedNodeId: string | null; appliedAt: number | null }
export interface NodeApplied extends NodeSelection { check: NodeCheck }
export interface MessageVerification { good: boolean; old: boolean; signatureType: 'spend' | 'view' | null; version: number | null }
