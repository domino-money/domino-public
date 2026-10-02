// Generated; read-only, raw token units never use JavaScript number.

export type ContractVersion = "1.0.0-rc.2";

export type AnchorModel = {
  "number": number;
  "hash": string;
  "timestamp": number;
};

export type CapabilitiesRequest = {
  "chainId": 99801;
  "protocol": "uniswap-v3";
};

export type CapabilitiesResponse = {
  "chainId": 99801;
  "protocol": "uniswap-v3";
  "contractVersion": "1.0.0-rc.2";
  "deployment": Identity | null;
  "qualification": "unqualified" | "local-fixture" | "testnet-rehearsal";
  "localWalletActionsAvailable": boolean;
  "rehearsalWalletActionsAvailable"?: boolean;
  "publicFinancialExecutionAvailable": false;
  "walletAuthenticationAvailable": false;
  "vaults": Array<string>;
};

export type CapitalBalance = {
  "currency": string;
  "amountRaw": string;
};

export type ContractPin = {
  "address": string;
  "codeHash": string;
};

export type Draft = {
  "id": string;
  "owner": string;
  "vault": string;
  "action": OpenAction | PolicyAction | PauseAction | ReduceAction | ReleaseAction | WithdrawFeesAction | WithdrawCapitalAction;
  "expiresAt": number;
  "stateNonce": string;
  "policyVersion": string;
  "stateHash": string;
  "contractPins": Array<ContractPin>;
  "transaction": OwnerTransaction;
  "step": "approve-reset" | "approve-token0" | "approve-token1" | "open" | "set-policy" | "pause" | "reduce" | "release" | "withdraw-fees" | "withdraw-capital";
  "readyForAction": boolean;
};

export type FeeBalance = {
  "sourceId": string;
  "currency": string;
  "originalRaw": string;
  "chargedRaw": string;
};

export type Identity = {
  "chainId": 99801;
  "protocol": "uniswap-v3";
  "deploymentId": string;
  "positionManager": string;
};

export type InspectRequest = {
  "chainId": 99801;
  "protocol": "uniswap-v3";
  "deploymentId": string;
  "positionManager": string;
  "vault": string;
};

export type InspectResponse = {
  "chainId": 99801;
  "protocol": "uniswap-v3";
  "deploymentId": string;
  "positionManager": string;
  "contractVersion": "1.0.0-rc.2";
  "qualification": "unqualified" | "local-fixture" | "testnet-rehearsal";
  "anchor": AnchorModel;
  "vault": string;
  "owner": string;
  "pool": PoolData;
  "vaultDeploymentId": string;
  "stateNonce": string;
  "policyVersion": string;
  "stateHash": string;
  "paused": boolean;
  "operator": string;
  "policy": Policy | null;
  "positions": Array<VaultPosition>;
  "feeBalances": Array<FeeBalance>;
  "capital": Array<CapitalBalance>;
  "contractPins": Array<ContractPin>;
};

export type OpenAction = {
  "kind": "open";
  "tickLower": number;
  "tickUpper": number;
  "amount0Raw": string;
  "amount1Raw": string;
  "slippageBps": number;
};

export type OwnerTransaction = {
  "chainId": 99801;
  "from": string;
  "to": string;
  "data": string;
  "valueRaw": "0";
  "gasLimitRaw": string;
  "maxFeePerGasWeiRaw": string;
  "maxPriorityFeePerGasWeiRaw": string;
  "nonce": number;
};

export type PauseAction = {
  "kind": "pause";
  "paused": boolean;
};

export type Policy = {
  "serviceFeeBps": 200 | 400;
  "maxPositions": number;
  "maxSlippageBps": number;
  "maxDeviationBps": number;
  "maxObservationAge": number;
  "minInterval": number;
  "validUntil": number;
  "allowSwap": boolean;
  "allowSuccessor": boolean;
  "successorTickLower": number;
  "successorTickUpper": number;
};

export type PolicyAction = {
  "kind": "set-policy";
  "policy": Policy;
  "operator": string;
};

export type PoolData = {
  "address": string;
  "factory": string;
  "token0": TokenData;
  "token1": TokenData;
  "fee": number;
  "tickSpacing": number;
  "tick": number;
  "sqrtPriceX96Raw": string;
  "liquidityRaw": string;
  "unlocked": boolean;
};

export type PrepareRequest = {
  "chainId": 99801;
  "protocol": "uniswap-v3";
  "deploymentId": string;
  "positionManager": string;
  "vault": string;
  "owner": string;
  "action": OpenAction | PolicyAction | PauseAction | ReduceAction | ReleaseAction | WithdrawFeesAction | WithdrawCapitalAction;
};

export type PrepareResponse = {
  "chainId": 99801;
  "protocol": "uniswap-v3";
  "deploymentId": string;
  "positionManager": string;
  "contractVersion": "1.0.0-rc.2";
  "qualification": "unqualified" | "local-fixture" | "testnet-rehearsal";
  "anchor": AnchorModel;
  "vault": string;
  "owner": string;
  "draft": Draft;
};

export type ReceiptRequest = {
  "chainId": 99801;
  "protocol": "uniswap-v3";
  "deploymentId": string;
  "positionManager": string;
  "vault": string;
  "owner": string;
  "transactionHash": string;
};

export type ReceiptResponse = {
  "chainId": 99801;
  "protocol": "uniswap-v3";
  "deploymentId": string;
  "positionManager": string;
  "contractVersion": "1.0.0-rc.2";
  "qualification": "unqualified" | "local-fixture" | "testnet-rehearsal";
  "vault": string;
  "owner": string;
  "transactionHash": string;
  "state": "pending" | "confirmed" | "reverted";
  "anchor": AnchorModel | null;
  "transaction": ReceiptTransaction | null;
  "gasUsedRaw": string | null;
};

export type ReceiptTransaction = {
  "from": string;
  "to": string;
  "data": string;
  "valueRaw": string;
  "nonce": number;
};

export type ReduceAction = {
  "kind": "reduce";
  "tokenId": string;
  "liquidityRaw": string;
  "slippageBps": number;
  "keepFees": boolean;
};

export type ReleaseAction = {
  "kind": "release";
  "tokenId": string;
};

export type TokenData = {
  "address": string;
  "decimals": number | null;
  "symbol": string | null;
};

export type VaultPosition = {
  "tokenId": string;
  "active": boolean;
  "custodyOwner"?: string | null;
  "tickLower": number;
  "tickUpper": number;
  "liquidityRaw": string;
  "parentTokenId": string;
  "source0": string;
  "source1": string;
};

export type WithdrawCapitalAction = {
  "kind": "withdraw-capital";
  "currency": string;
  "amountRaw": string;
};

export type WithdrawFeesAction = {
  "kind": "withdraw-fees";
  "sourceId": string;
  "currency": string;
  "originalRaw": string;
  "chargedRaw": string;
};

export interface Requests {
  "capabilities": CapabilitiesRequest;
  "inspect": InspectRequest;
  "prepare": PrepareRequest;
  "receipt": ReceiptRequest;
}

export interface Responses {
  "capabilities": CapabilitiesResponse;
  "inspect": InspectResponse;
  "prepare": PrepareResponse;
  "receipt": ReceiptResponse;
}

export type Route = keyof Requests;

export type ErrorCode = "action_unavailable" | "body_too_large" | "bridge_forbidden" | "canonical_state_changed" | "capacity_exceeded" | "contract_mismatch" | "deployment_unqualified" | "gas_unavailable" | "identity_mismatch" | "invalid_request" | "loopback_required" | "origin_forbidden" | "owner_mismatch" | "provider_unavailable" | "route_not_found" | "service_disabled" | "state_changed" | "transaction_mismatch" | "unsupported_media_type" | "upstream_invalid_response" | "vault_not_admitted";

export type ContractError = {error: ErrorCode};
