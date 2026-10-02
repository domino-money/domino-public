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
  "contractVersion": "1.0.0-rc.2";
  "chainId": 99801;
  "protocol": "uniswap-v3";
  "registryId": "elysium-v3-unqualified";
  "deployment": Identity | null;
  "status": "unqualified" | "configured-read-only";
  "financialExecutionAvailable": false;
  "walletAuthenticationAvailable": false;
  "providerConfigured": boolean;
  "ledgerConfigured": boolean;
};

export type Coverage = {
  "fromBlock": number;
  "toBlock": number;
  "complete": boolean;
  "basis": "canonical-vault-events";
  "reason": "complete" | "missing-history" | "unclassified-owner-exit-fees";
};

export type CurrencyTotals = {
  "currency": string;
  "collectedFeesRaw": string | null;
  "serviceFeesRaw": string | null;
  "reinvestedRaw": string | null;
  "withdrawnFeesRaw": string | null;
  "principalWithdrawnRaw": string | null;
  "manualAddedRaw": string | null;
  "originalAwaitingRaw": string | null;
  "chargedAwaitingRaw": string | null;
};

export type Cursor = {
  "blockNumber": number;
  "blockHash": string;
  "transactionIndex": number;
  "logIndex": number;
};

export type DiscoverRequest = {
  "chainId": 99801;
  "protocol": "uniswap-v3";
  "deploymentId": string;
  "positionManager": string;
  "anchor"?: AnchorModel | null;
  "tokenA": string;
  "tokenB": string;
  "fee": number;
};

export type DiscoverResponse = {
  "chainId": 99801;
  "protocol": "uniswap-v3";
  "deploymentId": string;
  "positionManager": string;
  "contractVersion": "1.0.0-rc.2";
  "qualification": "local-fixture" | "unqualified" | "testnet-rehearsal";
  "anchor": AnchorModel;
  "financialExecutionAvailable": false;
  "pool": PoolData | null;
  "status": "found" | "not-found";
};

export type HistoryItem = {
  "blockNumber": number;
  "blockHash": string;
  "transactionIndex": number;
  "logIndex": number;
  "timestamp": number;
  "transactionHash": string;
  "vault": string;
  "kind": string;
  "tokenId": string | null;
  "sourceId": string | null;
  "currency": string | null;
  "amount0Raw": string | null;
  "amount1Raw": string | null;
  "originalRaw": string | null;
  "chargedRaw": string | null;
  "serviceFeeRaw": string | null;
  "liquidityRaw": string | null;
  "basis": "capital" | "earned-fees" | "conversion" | "custody" | "policy" | "unclassified";
};

export type HistoryRequest = {
  "chainId": 99801;
  "protocol": "uniswap-v3";
  "deploymentId": string;
  "positionManager": string;
  "vault": string;
  "anchor"?: AnchorModel | null;
  "after"?: Cursor | null;
  "limit"?: number;
};

export type HistoryResponse = {
  "chainId": 99801;
  "protocol": "uniswap-v3";
  "deploymentId": string;
  "positionManager": string;
  "contractVersion": "1.0.0-rc.2";
  "qualification": "local-fixture" | "unqualified" | "testnet-rehearsal";
  "anchor": AnchorModel;
  "financialExecutionAvailable": false;
  "vault": string;
  "coverage": Coverage;
  "items": Array<HistoryItem>;
  "nextAfter": Cursor | null;
};

export type Identity = {
  "chainId": 99801;
  "protocol": "uniswap-v3";
  "deploymentId": string;
  "positionManager": string;
};

export type LedgerRequest = {
  "chainId": 99801;
  "protocol": "uniswap-v3";
  "deploymentId": string;
  "positionManager": string;
  "vault": string;
};

export type LedgerResponse = {
  "chainId": 99801;
  "protocol": "uniswap-v3";
  "deploymentId": string;
  "positionManager": string;
  "contractVersion": "1.0.0-rc.2";
  "qualification": "local-fixture" | "unqualified" | "testnet-rehearsal";
  "anchor": AnchorModel;
  "financialExecutionAvailable": false;
  "vault": string;
  "coverage": Coverage;
  "currencies": Array<CurrencyTotals>;
  "feeApr": null;
  "incomeUsd": null;
  "valuationStatus": "unavailable";
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

export type PoolRequest = {
  "chainId": 99801;
  "protocol": "uniswap-v3";
  "deploymentId": string;
  "positionManager": string;
  "anchor"?: AnchorModel | null;
  "pool": string;
};

export type PoolResponse = {
  "chainId": 99801;
  "protocol": "uniswap-v3";
  "deploymentId": string;
  "positionManager": string;
  "contractVersion": "1.0.0-rc.2";
  "qualification": "local-fixture" | "unqualified" | "testnet-rehearsal";
  "anchor": AnchorModel;
  "financialExecutionAvailable": false;
  "pool": PoolData;
};

export type PositionData = {
  "tokenId": string;
  "owner": string;
  "pool": string;
  "token0": string;
  "token1": string;
  "fee": number;
  "tickLower": number;
  "tickUpper": number;
  "liquidityRaw": string;
  "accruedSinceCheckpoint0Raw": string;
  "accruedSinceCheckpoint1Raw": string;
  "tokensOwed0Raw": string;
  "tokensOwed1Raw": string;
  "owedClassification": "unclassified";
  "inRange": boolean;
};

export type PositionRequest = {
  "chainId": 99801;
  "protocol": "uniswap-v3";
  "deploymentId": string;
  "positionManager": string;
  "anchor"?: AnchorModel | null;
  "tokenId": string;
};

export type PositionResponse = {
  "chainId": 99801;
  "protocol": "uniswap-v3";
  "deploymentId": string;
  "positionManager": string;
  "contractVersion": "1.0.0-rc.2";
  "qualification": "local-fixture" | "unqualified" | "testnet-rehearsal";
  "anchor": AnchorModel;
  "financialExecutionAvailable": false;
  "position": PositionData;
};

export type TokenData = {
  "address": string;
  "decimals": number | null;
  "symbol": string | null;
};

export interface Requests {
  "capabilities": CapabilitiesRequest;
  "discover-pool": DiscoverRequest;
  "history": HistoryRequest;
  "ledger": LedgerRequest;
  "pool": PoolRequest;
  "position": PositionRequest;
}

export interface Responses {
  "capabilities": CapabilitiesResponse;
  "discover-pool": DiscoverResponse;
  "history": HistoryResponse;
  "ledger": LedgerResponse;
  "pool": PoolResponse;
  "position": PositionResponse;
}

export type Route = keyof Requests;

export type ErrorCode = "body_too_large" | "canonical_state_changed" | "capacity_exceeded" | "contract_mismatch" | "deployment_unqualified" | "historical_state_unavailable" | "identity_mismatch" | "invalid_request" | "ledger_unavailable" | "loopback_required" | "origin_forbidden" | "provider_unavailable" | "route_not_found" | "service_disabled" | "unsupported_media_type" | "upstream_invalid_response";

export type ContractError = {error: ErrorCode};
