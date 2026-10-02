// Generated.
export const SCHEMAS = {
  "capabilities": {
    "request": {
      "additionalProperties": false,
      "properties": {
        "chainId": {
          "const": 99801,
          "title": "Chainid",
          "type": "integer"
        },
        "protocol": {
          "const": "uniswap-v3",
          "title": "Protocol",
          "type": "string"
        }
      },
      "required": [
        "chainId",
        "protocol"
      ],
      "title": "CapabilitiesRequest",
      "type": "object"
    },
    "response": {
      "$defs": {
        "Identity": {
          "additionalProperties": false,
          "properties": {
            "chainId": {
              "const": 99801,
              "title": "Chainid",
              "type": "integer"
            },
            "deploymentId": {
              "maxLength": 66,
              "minLength": 66,
              "pattern": "^0x[0-9a-f]*[1-9a-f][0-9a-f]*$",
              "title": "Deploymentid",
              "type": "string"
            },
            "positionManager": {
              "maxLength": 42,
              "minLength": 42,
              "pattern": "^0x[0-9a-f]*[1-9a-f][0-9a-f]*$",
              "title": "Positionmanager",
              "type": "string"
            },
            "protocol": {
              "const": "uniswap-v3",
              "title": "Protocol",
              "type": "string"
            }
          },
          "required": [
            "chainId",
            "protocol",
            "deploymentId",
            "positionManager"
          ],
          "title": "Identity",
          "type": "object"
        }
      },
      "additionalProperties": false,
      "properties": {
        "chainId": {
          "const": 99801,
          "title": "Chainid",
          "type": "integer"
        },
        "contractVersion": {
          "const": "1.0.0-rc.2",
          "title": "Contractversion",
          "type": "string"
        },
        "deployment": {
          "anyOf": [
            {
              "$ref": "#/$defs/Identity"
            },
            {
              "type": "null"
            }
          ]
        },
        "localWalletActionsAvailable": {
          "title": "Localwalletactionsavailable",
          "type": "boolean"
        },
        "protocol": {
          "const": "uniswap-v3",
          "title": "Protocol",
          "type": "string"
        },
        "publicFinancialExecutionAvailable": {
          "const": false,
          "title": "Publicfinancialexecutionavailable",
          "type": "boolean"
        },
        "qualification": {
          "enum": [
            "unqualified",
            "local-fixture",
            "testnet-rehearsal"
          ],
          "title": "Qualification",
          "type": "string"
        },
        "rehearsalWalletActionsAvailable": {
          "default": false,
          "title": "Rehearsalwalletactionsavailable",
          "type": "boolean"
        },
        "vaults": {
          "items": {
            "maxLength": 42,
            "minLength": 42,
            "pattern": "^0x[0-9a-f]*[1-9a-f][0-9a-f]*$",
            "type": "string"
          },
          "maxItems": 32,
          "title": "Vaults",
          "type": "array"
        },
        "walletAuthenticationAvailable": {
          "const": false,
          "title": "Walletauthenticationavailable",
          "type": "boolean"
        }
      },
      "required": [
        "chainId",
        "protocol",
        "contractVersion",
        "deployment",
        "qualification",
        "localWalletActionsAvailable",
        "publicFinancialExecutionAvailable",
        "walletAuthenticationAvailable",
        "vaults"
      ],
      "title": "CapabilitiesResponse",
      "type": "object"
    }
  },
  "inspect": {
    "request": {
      "additionalProperties": false,
      "properties": {
        "chainId": {
          "const": 99801,
          "title": "Chainid",
          "type": "integer"
        },
        "deploymentId": {
          "maxLength": 66,
          "minLength": 66,
          "pattern": "^0x[0-9a-f]*[1-9a-f][0-9a-f]*$",
          "title": "Deploymentid",
          "type": "string"
        },
        "positionManager": {
          "maxLength": 42,
          "minLength": 42,
          "pattern": "^0x[0-9a-f]*[1-9a-f][0-9a-f]*$",
          "title": "Positionmanager",
          "type": "string"
        },
        "protocol": {
          "const": "uniswap-v3",
          "title": "Protocol",
          "type": "string"
        },
        "vault": {
          "maxLength": 42,
          "minLength": 42,
          "pattern": "^0x[0-9a-f]*[1-9a-f][0-9a-f]*$",
          "title": "Vault",
          "type": "string"
        }
      },
      "required": [
        "chainId",
        "protocol",
        "deploymentId",
        "positionManager",
        "vault"
      ],
      "title": "InspectRequest",
      "type": "object"
    },
    "response": {
      "$defs": {
        "AnchorModel": {
          "additionalProperties": false,
          "properties": {
            "hash": {
              "maxLength": 66,
              "minLength": 66,
              "pattern": "^0x[0-9a-f]*[1-9a-f][0-9a-f]*$",
              "title": "Hash",
              "type": "string"
            },
            "number": {
              "maximum": 9007199254740991,
              "minimum": 0,
              "title": "Number",
              "type": "integer"
            },
            "timestamp": {
              "maximum": 9007199254740991,
              "minimum": 0,
              "title": "Timestamp",
              "type": "integer"
            }
          },
          "required": [
            "number",
            "hash",
            "timestamp"
          ],
          "title": "AnchorModel",
          "type": "object"
        },
        "CapitalBalance": {
          "additionalProperties": false,
          "properties": {
            "amountRaw": {
              "maxLength": 78,
              "pattern": "^(0|[1-9][0-9]{0,77})$",
              "title": "Amountraw",
              "type": "string",
              "x-maximum-raw": "115792089237316195423570985008687907853269984665640564039457584007913129639935"
            },
            "currency": {
              "maxLength": 42,
              "minLength": 42,
              "pattern": "^0x[0-9a-f]*[1-9a-f][0-9a-f]*$",
              "title": "Currency",
              "type": "string"
            }
          },
          "required": [
            "currency",
            "amountRaw"
          ],
          "title": "CapitalBalance",
          "type": "object"
        },
        "ContractPin": {
          "additionalProperties": false,
          "properties": {
            "address": {
              "maxLength": 42,
              "minLength": 42,
              "pattern": "^0x[0-9a-f]*[1-9a-f][0-9a-f]*$",
              "title": "Address",
              "type": "string"
            },
            "codeHash": {
              "maxLength": 66,
              "minLength": 66,
              "pattern": "^0x[0-9a-f]*[1-9a-f][0-9a-f]*$",
              "title": "Codehash",
              "type": "string"
            }
          },
          "required": [
            "address",
            "codeHash"
          ],
          "title": "ContractPin",
          "type": "object"
        },
        "FeeBalance": {
          "additionalProperties": false,
          "properties": {
            "chargedRaw": {
              "maxLength": 78,
              "pattern": "^(0|[1-9][0-9]{0,77})$",
              "title": "Chargedraw",
              "type": "string",
              "x-maximum-raw": "115792089237316195423570985008687907853269984665640564039457584007913129639935"
            },
            "currency": {
              "maxLength": 42,
              "minLength": 42,
              "pattern": "^0x[0-9a-f]*[1-9a-f][0-9a-f]*$",
              "title": "Currency",
              "type": "string"
            },
            "originalRaw": {
              "maxLength": 78,
              "pattern": "^(0|[1-9][0-9]{0,77})$",
              "title": "Originalraw",
              "type": "string",
              "x-maximum-raw": "115792089237316195423570985008687907853269984665640564039457584007913129639935"
            },
            "sourceId": {
              "maxLength": 66,
              "minLength": 66,
              "pattern": "^0x[0-9a-f]*[1-9a-f][0-9a-f]*$",
              "title": "Sourceid",
              "type": "string"
            }
          },
          "required": [
            "sourceId",
            "currency",
            "originalRaw",
            "chargedRaw"
          ],
          "title": "FeeBalance",
          "type": "object"
        },
        "Policy": {
          "additionalProperties": false,
          "properties": {
            "allowSuccessor": {
              "title": "Allowsuccessor",
              "type": "boolean"
            },
            "allowSwap": {
              "title": "Allowswap",
              "type": "boolean"
            },
            "maxDeviationBps": {
              "maximum": 1000,
              "minimum": 1,
              "title": "Maxdeviationbps",
              "type": "integer"
            },
            "maxObservationAge": {
              "maximum": 1800,
              "minimum": 1,
              "title": "Maxobservationage",
              "type": "integer"
            },
            "maxPositions": {
              "maximum": 8,
              "minimum": 1,
              "title": "Maxpositions",
              "type": "integer"
            },
            "maxSlippageBps": {
              "maximum": 1000,
              "minimum": 0,
              "title": "Maxslippagebps",
              "type": "integer"
            },
            "minInterval": {
              "maximum": 4294967295,
              "minimum": 0,
              "title": "Mininterval",
              "type": "integer"
            },
            "serviceFeeBps": {
              "enum": [
                200,
                400
              ],
              "title": "Servicefeebps",
              "type": "integer"
            },
            "successorTickLower": {
              "maximum": 887272,
              "minimum": -887272,
              "title": "Successorticklower",
              "type": "integer"
            },
            "successorTickUpper": {
              "maximum": 887272,
              "minimum": -887272,
              "title": "Successortickupper",
              "type": "integer"
            },
            "validUntil": {
              "maximum": 9007199254740991,
              "minimum": 0,
              "title": "Validuntil",
              "type": "integer"
            }
          },
          "required": [
            "serviceFeeBps",
            "maxPositions",
            "maxSlippageBps",
            "maxDeviationBps",
            "maxObservationAge",
            "minInterval",
            "validUntil",
            "allowSwap",
            "allowSuccessor",
            "successorTickLower",
            "successorTickUpper"
          ],
          "title": "Policy",
          "type": "object"
        },
        "PoolData": {
          "additionalProperties": false,
          "properties": {
            "address": {
              "maxLength": 42,
              "minLength": 42,
              "pattern": "^0x[0-9a-f]*[1-9a-f][0-9a-f]*$",
              "title": "Address",
              "type": "string"
            },
            "factory": {
              "maxLength": 42,
              "minLength": 42,
              "pattern": "^0x[0-9a-f]*[1-9a-f][0-9a-f]*$",
              "title": "Factory",
              "type": "string"
            },
            "fee": {
              "maximum": 999999,
              "minimum": 1,
              "title": "Fee",
              "type": "integer"
            },
            "liquidityRaw": {
              "maxLength": 78,
              "pattern": "^(0|[1-9][0-9]{0,77})$",
              "title": "Liquidityraw",
              "type": "string",
              "x-maximum-raw": "115792089237316195423570985008687907853269984665640564039457584007913129639935"
            },
            "sqrtPriceX96Raw": {
              "maxLength": 78,
              "pattern": "^(0|[1-9][0-9]{0,77})$",
              "title": "Sqrtpricex96Raw",
              "type": "string",
              "x-maximum-raw": "115792089237316195423570985008687907853269984665640564039457584007913129639935"
            },
            "tick": {
              "maximum": 887272,
              "minimum": -887272,
              "title": "Tick",
              "type": "integer"
            },
            "tickSpacing": {
              "maximum": 16383,
              "minimum": 1,
              "title": "Tickspacing",
              "type": "integer"
            },
            "token0": {
              "$ref": "#/$defs/TokenData"
            },
            "token1": {
              "$ref": "#/$defs/TokenData"
            },
            "unlocked": {
              "title": "Unlocked",
              "type": "boolean"
            }
          },
          "required": [
            "address",
            "factory",
            "token0",
            "token1",
            "fee",
            "tickSpacing",
            "tick",
            "sqrtPriceX96Raw",
            "liquidityRaw",
            "unlocked"
          ],
          "title": "PoolData",
          "type": "object"
        },
        "TokenData": {
          "additionalProperties": false,
          "properties": {
            "address": {
              "maxLength": 42,
              "minLength": 42,
              "pattern": "^0x[0-9a-f]*[1-9a-f][0-9a-f]*$",
              "title": "Address",
              "type": "string"
            },
            "decimals": {
              "anyOf": [
                {
                  "maximum": 36,
                  "minimum": 0,
                  "type": "integer"
                },
                {
                  "type": "null"
                }
              ],
              "title": "Decimals"
            },
            "symbol": {
              "anyOf": [
                {
                  "maxLength": 64,
                  "type": "string"
                },
                {
                  "type": "null"
                }
              ],
              "title": "Symbol"
            }
          },
          "required": [
            "address",
            "decimals",
            "symbol"
          ],
          "title": "TokenData",
          "type": "object"
        },
        "VaultPosition": {
          "additionalProperties": false,
          "properties": {
            "active": {
              "title": "Active",
              "type": "boolean"
            },
            "custodyOwner": {
              "anyOf": [
                {
                  "maxLength": 42,
                  "minLength": 42,
                  "pattern": "^0x[0-9a-f]*[1-9a-f][0-9a-f]*$",
                  "type": "string"
                },
                {
                  "type": "null"
                }
              ],
              "default": null,
              "title": "Custodyowner"
            },
            "liquidityRaw": {
              "maxLength": 78,
              "pattern": "^(0|[1-9][0-9]{0,77})$",
              "title": "Liquidityraw",
              "type": "string",
              "x-maximum-raw": "115792089237316195423570985008687907853269984665640564039457584007913129639935"
            },
            "parentTokenId": {
              "maxLength": 78,
              "pattern": "^(0|[1-9][0-9]{0,77})$",
              "title": "Parenttokenid",
              "type": "string",
              "x-maximum-raw": "115792089237316195423570985008687907853269984665640564039457584007913129639935"
            },
            "source0": {
              "maxLength": 66,
              "minLength": 66,
              "pattern": "^0x[0-9a-f]*[1-9a-f][0-9a-f]*$",
              "title": "Source0",
              "type": "string"
            },
            "source1": {
              "maxLength": 66,
              "minLength": 66,
              "pattern": "^0x[0-9a-f]*[1-9a-f][0-9a-f]*$",
              "title": "Source1",
              "type": "string"
            },
            "tickLower": {
              "maximum": 887272,
              "minimum": -887272,
              "title": "Ticklower",
              "type": "integer"
            },
            "tickUpper": {
              "maximum": 887272,
              "minimum": -887272,
              "title": "Tickupper",
              "type": "integer"
            },
            "tokenId": {
              "maxLength": 78,
              "pattern": "^(0|[1-9][0-9]{0,77})$",
              "title": "Tokenid",
              "type": "string",
              "x-maximum-raw": "115792089237316195423570985008687907853269984665640564039457584007913129639935"
            }
          },
          "required": [
            "tokenId",
            "active",
            "tickLower",
            "tickUpper",
            "liquidityRaw",
            "parentTokenId",
            "source0",
            "source1"
          ],
          "title": "VaultPosition",
          "type": "object"
        }
      },
      "additionalProperties": false,
      "properties": {
        "anchor": {
          "$ref": "#/$defs/AnchorModel"
        },
        "capital": {
          "items": {
            "$ref": "#/$defs/CapitalBalance"
          },
          "maxItems": 2,
          "minItems": 2,
          "title": "Capital",
          "type": "array"
        },
        "chainId": {
          "const": 99801,
          "title": "Chainid",
          "type": "integer"
        },
        "contractPins": {
          "items": {
            "$ref": "#/$defs/ContractPin"
          },
          "maxItems": 12,
          "minItems": 1,
          "title": "Contractpins",
          "type": "array"
        },
        "contractVersion": {
          "const": "1.0.0-rc.2",
          "title": "Contractversion",
          "type": "string"
        },
        "deploymentId": {
          "maxLength": 66,
          "minLength": 66,
          "pattern": "^0x[0-9a-f]*[1-9a-f][0-9a-f]*$",
          "title": "Deploymentid",
          "type": "string"
        },
        "feeBalances": {
          "items": {
            "$ref": "#/$defs/FeeBalance"
          },
          "maxItems": 128,
          "title": "Feebalances",
          "type": "array"
        },
        "operator": {
          "pattern": "^0x[0-9a-f]{40}$",
          "title": "Operator",
          "type": "string"
        },
        "owner": {
          "maxLength": 42,
          "minLength": 42,
          "pattern": "^0x[0-9a-f]*[1-9a-f][0-9a-f]*$",
          "title": "Owner",
          "type": "string"
        },
        "paused": {
          "title": "Paused",
          "type": "boolean"
        },
        "policy": {
          "anyOf": [
            {
              "$ref": "#/$defs/Policy"
            },
            {
              "type": "null"
            }
          ]
        },
        "policyVersion": {
          "maxLength": 78,
          "pattern": "^(0|[1-9][0-9]{0,77})$",
          "title": "Policyversion",
          "type": "string",
          "x-maximum-raw": "115792089237316195423570985008687907853269984665640564039457584007913129639935"
        },
        "pool": {
          "$ref": "#/$defs/PoolData"
        },
        "positionManager": {
          "maxLength": 42,
          "minLength": 42,
          "pattern": "^0x[0-9a-f]*[1-9a-f][0-9a-f]*$",
          "title": "Positionmanager",
          "type": "string"
        },
        "positions": {
          "items": {
            "$ref": "#/$defs/VaultPosition"
          },
          "maxItems": 32,
          "title": "Positions",
          "type": "array"
        },
        "protocol": {
          "const": "uniswap-v3",
          "title": "Protocol",
          "type": "string"
        },
        "qualification": {
          "enum": [
            "unqualified",
            "local-fixture",
            "testnet-rehearsal"
          ],
          "title": "Qualification",
          "type": "string"
        },
        "stateHash": {
          "maxLength": 66,
          "minLength": 66,
          "pattern": "^0x[0-9a-f]*[1-9a-f][0-9a-f]*$",
          "title": "Statehash",
          "type": "string"
        },
        "stateNonce": {
          "maxLength": 78,
          "pattern": "^(0|[1-9][0-9]{0,77})$",
          "title": "Statenonce",
          "type": "string",
          "x-maximum-raw": "115792089237316195423570985008687907853269984665640564039457584007913129639935"
        },
        "vault": {
          "maxLength": 42,
          "minLength": 42,
          "pattern": "^0x[0-9a-f]*[1-9a-f][0-9a-f]*$",
          "title": "Vault",
          "type": "string"
        },
        "vaultDeploymentId": {
          "maxLength": 66,
          "minLength": 66,
          "pattern": "^0x[0-9a-f]*[1-9a-f][0-9a-f]*$",
          "title": "Vaultdeploymentid",
          "type": "string"
        }
      },
      "required": [
        "chainId",
        "protocol",
        "deploymentId",
        "positionManager",
        "contractVersion",
        "qualification",
        "anchor",
        "vault",
        "owner",
        "pool",
        "vaultDeploymentId",
        "stateNonce",
        "policyVersion",
        "stateHash",
        "paused",
        "operator",
        "policy",
        "positions",
        "feeBalances",
        "capital",
        "contractPins"
      ],
      "title": "InspectResponse",
      "type": "object"
    }
  },
  "prepare": {
    "request": {
      "$defs": {
        "OpenAction": {
          "additionalProperties": false,
          "properties": {
            "amount0Raw": {
              "maxLength": 78,
              "pattern": "^(0|[1-9][0-9]{0,77})$",
              "title": "Amount0Raw",
              "type": "string",
              "x-maximum-raw": "115792089237316195423570985008687907853269984665640564039457584007913129639935"
            },
            "amount1Raw": {
              "maxLength": 78,
              "pattern": "^(0|[1-9][0-9]{0,77})$",
              "title": "Amount1Raw",
              "type": "string",
              "x-maximum-raw": "115792089237316195423570985008687907853269984665640564039457584007913129639935"
            },
            "kind": {
              "const": "open",
              "title": "Kind",
              "type": "string"
            },
            "slippageBps": {
              "maximum": 1000,
              "minimum": 0,
              "title": "Slippagebps",
              "type": "integer"
            },
            "tickLower": {
              "maximum": 887272,
              "minimum": -887272,
              "title": "Ticklower",
              "type": "integer"
            },
            "tickUpper": {
              "maximum": 887272,
              "minimum": -887272,
              "title": "Tickupper",
              "type": "integer"
            }
          },
          "required": [
            "kind",
            "tickLower",
            "tickUpper",
            "amount0Raw",
            "amount1Raw",
            "slippageBps"
          ],
          "title": "OpenAction",
          "type": "object"
        },
        "PauseAction": {
          "additionalProperties": false,
          "properties": {
            "kind": {
              "const": "pause",
              "title": "Kind",
              "type": "string"
            },
            "paused": {
              "title": "Paused",
              "type": "boolean"
            }
          },
          "required": [
            "kind",
            "paused"
          ],
          "title": "PauseAction",
          "type": "object"
        },
        "Policy": {
          "additionalProperties": false,
          "properties": {
            "allowSuccessor": {
              "title": "Allowsuccessor",
              "type": "boolean"
            },
            "allowSwap": {
              "title": "Allowswap",
              "type": "boolean"
            },
            "maxDeviationBps": {
              "maximum": 1000,
              "minimum": 1,
              "title": "Maxdeviationbps",
              "type": "integer"
            },
            "maxObservationAge": {
              "maximum": 1800,
              "minimum": 1,
              "title": "Maxobservationage",
              "type": "integer"
            },
            "maxPositions": {
              "maximum": 8,
              "minimum": 1,
              "title": "Maxpositions",
              "type": "integer"
            },
            "maxSlippageBps": {
              "maximum": 1000,
              "minimum": 0,
              "title": "Maxslippagebps",
              "type": "integer"
            },
            "minInterval": {
              "maximum": 4294967295,
              "minimum": 0,
              "title": "Mininterval",
              "type": "integer"
            },
            "serviceFeeBps": {
              "enum": [
                200,
                400
              ],
              "title": "Servicefeebps",
              "type": "integer"
            },
            "successorTickLower": {
              "maximum": 887272,
              "minimum": -887272,
              "title": "Successorticklower",
              "type": "integer"
            },
            "successorTickUpper": {
              "maximum": 887272,
              "minimum": -887272,
              "title": "Successortickupper",
              "type": "integer"
            },
            "validUntil": {
              "maximum": 9007199254740991,
              "minimum": 0,
              "title": "Validuntil",
              "type": "integer"
            }
          },
          "required": [
            "serviceFeeBps",
            "maxPositions",
            "maxSlippageBps",
            "maxDeviationBps",
            "maxObservationAge",
            "minInterval",
            "validUntil",
            "allowSwap",
            "allowSuccessor",
            "successorTickLower",
            "successorTickUpper"
          ],
          "title": "Policy",
          "type": "object"
        },
        "PolicyAction": {
          "additionalProperties": false,
          "properties": {
            "kind": {
              "const": "set-policy",
              "title": "Kind",
              "type": "string"
            },
            "operator": {
              "pattern": "^0x[0-9a-f]{40}$",
              "title": "Operator",
              "type": "string"
            },
            "policy": {
              "$ref": "#/$defs/Policy"
            }
          },
          "required": [
            "kind",
            "policy",
            "operator"
          ],
          "title": "PolicyAction",
          "type": "object"
        },
        "ReduceAction": {
          "additionalProperties": false,
          "properties": {
            "keepFees": {
              "title": "Keepfees",
              "type": "boolean"
            },
            "kind": {
              "const": "reduce",
              "title": "Kind",
              "type": "string"
            },
            "liquidityRaw": {
              "maxLength": 78,
              "pattern": "^(0|[1-9][0-9]{0,77})$",
              "title": "Liquidityraw",
              "type": "string",
              "x-maximum-raw": "115792089237316195423570985008687907853269984665640564039457584007913129639935"
            },
            "slippageBps": {
              "maximum": 1000,
              "minimum": 0,
              "title": "Slippagebps",
              "type": "integer"
            },
            "tokenId": {
              "maxLength": 78,
              "pattern": "^(0|[1-9][0-9]{0,77})$",
              "title": "Tokenid",
              "type": "string",
              "x-maximum-raw": "115792089237316195423570985008687907853269984665640564039457584007913129639935"
            }
          },
          "required": [
            "kind",
            "tokenId",
            "liquidityRaw",
            "slippageBps",
            "keepFees"
          ],
          "title": "ReduceAction",
          "type": "object"
        },
        "ReleaseAction": {
          "additionalProperties": false,
          "properties": {
            "kind": {
              "const": "release",
              "title": "Kind",
              "type": "string"
            },
            "tokenId": {
              "maxLength": 78,
              "pattern": "^(0|[1-9][0-9]{0,77})$",
              "title": "Tokenid",
              "type": "string",
              "x-maximum-raw": "115792089237316195423570985008687907853269984665640564039457584007913129639935"
            }
          },
          "required": [
            "kind",
            "tokenId"
          ],
          "title": "ReleaseAction",
          "type": "object"
        },
        "WithdrawCapitalAction": {
          "additionalProperties": false,
          "properties": {
            "amountRaw": {
              "maxLength": 78,
              "pattern": "^(0|[1-9][0-9]{0,77})$",
              "title": "Amountraw",
              "type": "string",
              "x-maximum-raw": "115792089237316195423570985008687907853269984665640564039457584007913129639935"
            },
            "currency": {
              "maxLength": 42,
              "minLength": 42,
              "pattern": "^0x[0-9a-f]*[1-9a-f][0-9a-f]*$",
              "title": "Currency",
              "type": "string"
            },
            "kind": {
              "const": "withdraw-capital",
              "title": "Kind",
              "type": "string"
            }
          },
          "required": [
            "kind",
            "currency",
            "amountRaw"
          ],
          "title": "WithdrawCapitalAction",
          "type": "object"
        },
        "WithdrawFeesAction": {
          "additionalProperties": false,
          "properties": {
            "chargedRaw": {
              "maxLength": 78,
              "pattern": "^(0|[1-9][0-9]{0,77})$",
              "title": "Chargedraw",
              "type": "string",
              "x-maximum-raw": "115792089237316195423570985008687907853269984665640564039457584007913129639935"
            },
            "currency": {
              "maxLength": 42,
              "minLength": 42,
              "pattern": "^0x[0-9a-f]*[1-9a-f][0-9a-f]*$",
              "title": "Currency",
              "type": "string"
            },
            "kind": {
              "const": "withdraw-fees",
              "title": "Kind",
              "type": "string"
            },
            "originalRaw": {
              "maxLength": 78,
              "pattern": "^(0|[1-9][0-9]{0,77})$",
              "title": "Originalraw",
              "type": "string",
              "x-maximum-raw": "115792089237316195423570985008687907853269984665640564039457584007913129639935"
            },
            "sourceId": {
              "maxLength": 66,
              "minLength": 66,
              "pattern": "^0x[0-9a-f]*[1-9a-f][0-9a-f]*$",
              "title": "Sourceid",
              "type": "string"
            }
          },
          "required": [
            "kind",
            "sourceId",
            "currency",
            "originalRaw",
            "chargedRaw"
          ],
          "title": "WithdrawFeesAction",
          "type": "object"
        }
      },
      "additionalProperties": false,
      "properties": {
        "action": {
          "anyOf": [
            {
              "$ref": "#/$defs/OpenAction"
            },
            {
              "$ref": "#/$defs/PolicyAction"
            },
            {
              "$ref": "#/$defs/PauseAction"
            },
            {
              "$ref": "#/$defs/ReduceAction"
            },
            {
              "$ref": "#/$defs/ReleaseAction"
            },
            {
              "$ref": "#/$defs/WithdrawFeesAction"
            },
            {
              "$ref": "#/$defs/WithdrawCapitalAction"
            }
          ],
          "title": "Action"
        },
        "chainId": {
          "const": 99801,
          "title": "Chainid",
          "type": "integer"
        },
        "deploymentId": {
          "maxLength": 66,
          "minLength": 66,
          "pattern": "^0x[0-9a-f]*[1-9a-f][0-9a-f]*$",
          "title": "Deploymentid",
          "type": "string"
        },
        "owner": {
          "maxLength": 42,
          "minLength": 42,
          "pattern": "^0x[0-9a-f]*[1-9a-f][0-9a-f]*$",
          "title": "Owner",
          "type": "string"
        },
        "positionManager": {
          "maxLength": 42,
          "minLength": 42,
          "pattern": "^0x[0-9a-f]*[1-9a-f][0-9a-f]*$",
          "title": "Positionmanager",
          "type": "string"
        },
        "protocol": {
          "const": "uniswap-v3",
          "title": "Protocol",
          "type": "string"
        },
        "vault": {
          "maxLength": 42,
          "minLength": 42,
          "pattern": "^0x[0-9a-f]*[1-9a-f][0-9a-f]*$",
          "title": "Vault",
          "type": "string"
        }
      },
      "required": [
        "chainId",
        "protocol",
        "deploymentId",
        "positionManager",
        "vault",
        "owner",
        "action"
      ],
      "title": "PrepareRequest",
      "type": "object"
    },
    "response": {
      "$defs": {
        "AnchorModel": {
          "additionalProperties": false,
          "properties": {
            "hash": {
              "maxLength": 66,
              "minLength": 66,
              "pattern": "^0x[0-9a-f]*[1-9a-f][0-9a-f]*$",
              "title": "Hash",
              "type": "string"
            },
            "number": {
              "maximum": 9007199254740991,
              "minimum": 0,
              "title": "Number",
              "type": "integer"
            },
            "timestamp": {
              "maximum": 9007199254740991,
              "minimum": 0,
              "title": "Timestamp",
              "type": "integer"
            }
          },
          "required": [
            "number",
            "hash",
            "timestamp"
          ],
          "title": "AnchorModel",
          "type": "object"
        },
        "ContractPin": {
          "additionalProperties": false,
          "properties": {
            "address": {
              "maxLength": 42,
              "minLength": 42,
              "pattern": "^0x[0-9a-f]*[1-9a-f][0-9a-f]*$",
              "title": "Address",
              "type": "string"
            },
            "codeHash": {
              "maxLength": 66,
              "minLength": 66,
              "pattern": "^0x[0-9a-f]*[1-9a-f][0-9a-f]*$",
              "title": "Codehash",
              "type": "string"
            }
          },
          "required": [
            "address",
            "codeHash"
          ],
          "title": "ContractPin",
          "type": "object"
        },
        "Draft": {
          "additionalProperties": false,
          "properties": {
            "action": {
              "anyOf": [
                {
                  "$ref": "#/$defs/OpenAction"
                },
                {
                  "$ref": "#/$defs/PolicyAction"
                },
                {
                  "$ref": "#/$defs/PauseAction"
                },
                {
                  "$ref": "#/$defs/ReduceAction"
                },
                {
                  "$ref": "#/$defs/ReleaseAction"
                },
                {
                  "$ref": "#/$defs/WithdrawFeesAction"
                },
                {
                  "$ref": "#/$defs/WithdrawCapitalAction"
                }
              ],
              "title": "Action"
            },
            "contractPins": {
              "items": {
                "$ref": "#/$defs/ContractPin"
              },
              "maxItems": 12,
              "minItems": 1,
              "title": "Contractpins",
              "type": "array"
            },
            "expiresAt": {
              "maximum": 9007199254740991,
              "minimum": 0,
              "title": "Expiresat",
              "type": "integer"
            },
            "id": {
              "maxLength": 66,
              "minLength": 66,
              "pattern": "^0x[0-9a-f]*[1-9a-f][0-9a-f]*$",
              "title": "Id",
              "type": "string"
            },
            "owner": {
              "maxLength": 42,
              "minLength": 42,
              "pattern": "^0x[0-9a-f]*[1-9a-f][0-9a-f]*$",
              "title": "Owner",
              "type": "string"
            },
            "policyVersion": {
              "maxLength": 78,
              "pattern": "^(0|[1-9][0-9]{0,77})$",
              "title": "Policyversion",
              "type": "string",
              "x-maximum-raw": "115792089237316195423570985008687907853269984665640564039457584007913129639935"
            },
            "readyForAction": {
              "title": "Readyforaction",
              "type": "boolean"
            },
            "stateHash": {
              "maxLength": 66,
              "minLength": 66,
              "pattern": "^0x[0-9a-f]*[1-9a-f][0-9a-f]*$",
              "title": "Statehash",
              "type": "string"
            },
            "stateNonce": {
              "maxLength": 78,
              "pattern": "^(0|[1-9][0-9]{0,77})$",
              "title": "Statenonce",
              "type": "string",
              "x-maximum-raw": "115792089237316195423570985008687907853269984665640564039457584007913129639935"
            },
            "step": {
              "enum": [
                "approve-reset",
                "approve-token0",
                "approve-token1",
                "open",
                "set-policy",
                "pause",
                "reduce",
                "release",
                "withdraw-fees",
                "withdraw-capital"
              ],
              "title": "Step",
              "type": "string"
            },
            "transaction": {
              "$ref": "#/$defs/OwnerTransaction"
            },
            "vault": {
              "maxLength": 42,
              "minLength": 42,
              "pattern": "^0x[0-9a-f]*[1-9a-f][0-9a-f]*$",
              "title": "Vault",
              "type": "string"
            }
          },
          "required": [
            "id",
            "owner",
            "vault",
            "action",
            "expiresAt",
            "stateNonce",
            "policyVersion",
            "stateHash",
            "contractPins",
            "transaction",
            "step",
            "readyForAction"
          ],
          "title": "Draft",
          "type": "object"
        },
        "OpenAction": {
          "additionalProperties": false,
          "properties": {
            "amount0Raw": {
              "maxLength": 78,
              "pattern": "^(0|[1-9][0-9]{0,77})$",
              "title": "Amount0Raw",
              "type": "string",
              "x-maximum-raw": "115792089237316195423570985008687907853269984665640564039457584007913129639935"
            },
            "amount1Raw": {
              "maxLength": 78,
              "pattern": "^(0|[1-9][0-9]{0,77})$",
              "title": "Amount1Raw",
              "type": "string",
              "x-maximum-raw": "115792089237316195423570985008687907853269984665640564039457584007913129639935"
            },
            "kind": {
              "const": "open",
              "title": "Kind",
              "type": "string"
            },
            "slippageBps": {
              "maximum": 1000,
              "minimum": 0,
              "title": "Slippagebps",
              "type": "integer"
            },
            "tickLower": {
              "maximum": 887272,
              "minimum": -887272,
              "title": "Ticklower",
              "type": "integer"
            },
            "tickUpper": {
              "maximum": 887272,
              "minimum": -887272,
              "title": "Tickupper",
              "type": "integer"
            }
          },
          "required": [
            "kind",
            "tickLower",
            "tickUpper",
            "amount0Raw",
            "amount1Raw",
            "slippageBps"
          ],
          "title": "OpenAction",
          "type": "object"
        },
        "OwnerTransaction": {
          "additionalProperties": false,
          "properties": {
            "chainId": {
              "const": 99801,
              "title": "Chainid",
              "type": "integer"
            },
            "data": {
              "maxLength": 16386,
              "minLength": 2,
              "pattern": "^0x(?:[0-9a-f]{2})*$",
              "title": "Data",
              "type": "string"
            },
            "from": {
              "maxLength": 42,
              "minLength": 42,
              "pattern": "^0x[0-9a-f]*[1-9a-f][0-9a-f]*$",
              "title": "From",
              "type": "string"
            },
            "gasLimitRaw": {
              "maxLength": 78,
              "pattern": "^(0|[1-9][0-9]{0,77})$",
              "title": "Gaslimitraw",
              "type": "string",
              "x-maximum-raw": "115792089237316195423570985008687907853269984665640564039457584007913129639935"
            },
            "maxFeePerGasWeiRaw": {
              "maxLength": 78,
              "pattern": "^(0|[1-9][0-9]{0,77})$",
              "title": "Maxfeepergasweiraw",
              "type": "string",
              "x-maximum-raw": "115792089237316195423570985008687907853269984665640564039457584007913129639935"
            },
            "maxPriorityFeePerGasWeiRaw": {
              "maxLength": 78,
              "pattern": "^(0|[1-9][0-9]{0,77})$",
              "title": "Maxpriorityfeepergasweiraw",
              "type": "string",
              "x-maximum-raw": "115792089237316195423570985008687907853269984665640564039457584007913129639935"
            },
            "nonce": {
              "maximum": 9007199254740991,
              "minimum": 0,
              "title": "Nonce",
              "type": "integer"
            },
            "to": {
              "maxLength": 42,
              "minLength": 42,
              "pattern": "^0x[0-9a-f]*[1-9a-f][0-9a-f]*$",
              "title": "To",
              "type": "string"
            },
            "valueRaw": {
              "const": "0",
              "title": "Valueraw",
              "type": "string"
            }
          },
          "required": [
            "chainId",
            "from",
            "to",
            "data",
            "valueRaw",
            "gasLimitRaw",
            "maxFeePerGasWeiRaw",
            "maxPriorityFeePerGasWeiRaw",
            "nonce"
          ],
          "title": "OwnerTransaction",
          "type": "object"
        },
        "PauseAction": {
          "additionalProperties": false,
          "properties": {
            "kind": {
              "const": "pause",
              "title": "Kind",
              "type": "string"
            },
            "paused": {
              "title": "Paused",
              "type": "boolean"
            }
          },
          "required": [
            "kind",
            "paused"
          ],
          "title": "PauseAction",
          "type": "object"
        },
        "Policy": {
          "additionalProperties": false,
          "properties": {
            "allowSuccessor": {
              "title": "Allowsuccessor",
              "type": "boolean"
            },
            "allowSwap": {
              "title": "Allowswap",
              "type": "boolean"
            },
            "maxDeviationBps": {
              "maximum": 1000,
              "minimum": 1,
              "title": "Maxdeviationbps",
              "type": "integer"
            },
            "maxObservationAge": {
              "maximum": 1800,
              "minimum": 1,
              "title": "Maxobservationage",
              "type": "integer"
            },
            "maxPositions": {
              "maximum": 8,
              "minimum": 1,
              "title": "Maxpositions",
              "type": "integer"
            },
            "maxSlippageBps": {
              "maximum": 1000,
              "minimum": 0,
              "title": "Maxslippagebps",
              "type": "integer"
            },
            "minInterval": {
              "maximum": 4294967295,
              "minimum": 0,
              "title": "Mininterval",
              "type": "integer"
            },
            "serviceFeeBps": {
              "enum": [
                200,
                400
              ],
              "title": "Servicefeebps",
              "type": "integer"
            },
            "successorTickLower": {
              "maximum": 887272,
              "minimum": -887272,
              "title": "Successorticklower",
              "type": "integer"
            },
            "successorTickUpper": {
              "maximum": 887272,
              "minimum": -887272,
              "title": "Successortickupper",
              "type": "integer"
            },
            "validUntil": {
              "maximum": 9007199254740991,
              "minimum": 0,
              "title": "Validuntil",
              "type": "integer"
            }
          },
          "required": [
            "serviceFeeBps",
            "maxPositions",
            "maxSlippageBps",
            "maxDeviationBps",
            "maxObservationAge",
            "minInterval",
            "validUntil",
            "allowSwap",
            "allowSuccessor",
            "successorTickLower",
            "successorTickUpper"
          ],
          "title": "Policy",
          "type": "object"
        },
        "PolicyAction": {
          "additionalProperties": false,
          "properties": {
            "kind": {
              "const": "set-policy",
              "title": "Kind",
              "type": "string"
            },
            "operator": {
              "pattern": "^0x[0-9a-f]{40}$",
              "title": "Operator",
              "type": "string"
            },
            "policy": {
              "$ref": "#/$defs/Policy"
            }
          },
          "required": [
            "kind",
            "policy",
            "operator"
          ],
          "title": "PolicyAction",
          "type": "object"
        },
        "ReduceAction": {
          "additionalProperties": false,
          "properties": {
            "keepFees": {
              "title": "Keepfees",
              "type": "boolean"
            },
            "kind": {
              "const": "reduce",
              "title": "Kind",
              "type": "string"
            },
            "liquidityRaw": {
              "maxLength": 78,
              "pattern": "^(0|[1-9][0-9]{0,77})$",
              "title": "Liquidityraw",
              "type": "string",
              "x-maximum-raw": "115792089237316195423570985008687907853269984665640564039457584007913129639935"
            },
            "slippageBps": {
              "maximum": 1000,
              "minimum": 0,
              "title": "Slippagebps",
              "type": "integer"
            },
            "tokenId": {
              "maxLength": 78,
              "pattern": "^(0|[1-9][0-9]{0,77})$",
              "title": "Tokenid",
              "type": "string",
              "x-maximum-raw": "115792089237316195423570985008687907853269984665640564039457584007913129639935"
            }
          },
          "required": [
            "kind",
            "tokenId",
            "liquidityRaw",
            "slippageBps",
            "keepFees"
          ],
          "title": "ReduceAction",
          "type": "object"
        },
        "ReleaseAction": {
          "additionalProperties": false,
          "properties": {
            "kind": {
              "const": "release",
              "title": "Kind",
              "type": "string"
            },
            "tokenId": {
              "maxLength": 78,
              "pattern": "^(0|[1-9][0-9]{0,77})$",
              "title": "Tokenid",
              "type": "string",
              "x-maximum-raw": "115792089237316195423570985008687907853269984665640564039457584007913129639935"
            }
          },
          "required": [
            "kind",
            "tokenId"
          ],
          "title": "ReleaseAction",
          "type": "object"
        },
        "WithdrawCapitalAction": {
          "additionalProperties": false,
          "properties": {
            "amountRaw": {
              "maxLength": 78,
              "pattern": "^(0|[1-9][0-9]{0,77})$",
              "title": "Amountraw",
              "type": "string",
              "x-maximum-raw": "115792089237316195423570985008687907853269984665640564039457584007913129639935"
            },
            "currency": {
              "maxLength": 42,
              "minLength": 42,
              "pattern": "^0x[0-9a-f]*[1-9a-f][0-9a-f]*$",
              "title": "Currency",
              "type": "string"
            },
            "kind": {
              "const": "withdraw-capital",
              "title": "Kind",
              "type": "string"
            }
          },
          "required": [
            "kind",
            "currency",
            "amountRaw"
          ],
          "title": "WithdrawCapitalAction",
          "type": "object"
        },
        "WithdrawFeesAction": {
          "additionalProperties": false,
          "properties": {
            "chargedRaw": {
              "maxLength": 78,
              "pattern": "^(0|[1-9][0-9]{0,77})$",
              "title": "Chargedraw",
              "type": "string",
              "x-maximum-raw": "115792089237316195423570985008687907853269984665640564039457584007913129639935"
            },
            "currency": {
              "maxLength": 42,
              "minLength": 42,
              "pattern": "^0x[0-9a-f]*[1-9a-f][0-9a-f]*$",
              "title": "Currency",
              "type": "string"
            },
            "kind": {
              "const": "withdraw-fees",
              "title": "Kind",
              "type": "string"
            },
            "originalRaw": {
              "maxLength": 78,
              "pattern": "^(0|[1-9][0-9]{0,77})$",
              "title": "Originalraw",
              "type": "string",
              "x-maximum-raw": "115792089237316195423570985008687907853269984665640564039457584007913129639935"
            },
            "sourceId": {
              "maxLength": 66,
              "minLength": 66,
              "pattern": "^0x[0-9a-f]*[1-9a-f][0-9a-f]*$",
              "title": "Sourceid",
              "type": "string"
            }
          },
          "required": [
            "kind",
            "sourceId",
            "currency",
            "originalRaw",
            "chargedRaw"
          ],
          "title": "WithdrawFeesAction",
          "type": "object"
        }
      },
      "additionalProperties": false,
      "properties": {
        "anchor": {
          "$ref": "#/$defs/AnchorModel"
        },
        "chainId": {
          "const": 99801,
          "title": "Chainid",
          "type": "integer"
        },
        "contractVersion": {
          "const": "1.0.0-rc.2",
          "title": "Contractversion",
          "type": "string"
        },
        "deploymentId": {
          "maxLength": 66,
          "minLength": 66,
          "pattern": "^0x[0-9a-f]*[1-9a-f][0-9a-f]*$",
          "title": "Deploymentid",
          "type": "string"
        },
        "draft": {
          "$ref": "#/$defs/Draft"
        },
        "owner": {
          "maxLength": 42,
          "minLength": 42,
          "pattern": "^0x[0-9a-f]*[1-9a-f][0-9a-f]*$",
          "title": "Owner",
          "type": "string"
        },
        "positionManager": {
          "maxLength": 42,
          "minLength": 42,
          "pattern": "^0x[0-9a-f]*[1-9a-f][0-9a-f]*$",
          "title": "Positionmanager",
          "type": "string"
        },
        "protocol": {
          "const": "uniswap-v3",
          "title": "Protocol",
          "type": "string"
        },
        "qualification": {
          "enum": [
            "unqualified",
            "local-fixture",
            "testnet-rehearsal"
          ],
          "title": "Qualification",
          "type": "string"
        },
        "vault": {
          "maxLength": 42,
          "minLength": 42,
          "pattern": "^0x[0-9a-f]*[1-9a-f][0-9a-f]*$",
          "title": "Vault",
          "type": "string"
        }
      },
      "required": [
        "chainId",
        "protocol",
        "deploymentId",
        "positionManager",
        "contractVersion",
        "qualification",
        "anchor",
        "vault",
        "owner",
        "draft"
      ],
      "title": "PrepareResponse",
      "type": "object"
    }
  },
  "receipt": {
    "request": {
      "additionalProperties": false,
      "properties": {
        "chainId": {
          "const": 99801,
          "title": "Chainid",
          "type": "integer"
        },
        "deploymentId": {
          "maxLength": 66,
          "minLength": 66,
          "pattern": "^0x[0-9a-f]*[1-9a-f][0-9a-f]*$",
          "title": "Deploymentid",
          "type": "string"
        },
        "owner": {
          "maxLength": 42,
          "minLength": 42,
          "pattern": "^0x[0-9a-f]*[1-9a-f][0-9a-f]*$",
          "title": "Owner",
          "type": "string"
        },
        "positionManager": {
          "maxLength": 42,
          "minLength": 42,
          "pattern": "^0x[0-9a-f]*[1-9a-f][0-9a-f]*$",
          "title": "Positionmanager",
          "type": "string"
        },
        "protocol": {
          "const": "uniswap-v3",
          "title": "Protocol",
          "type": "string"
        },
        "transactionHash": {
          "maxLength": 66,
          "minLength": 66,
          "pattern": "^0x[0-9a-f]*[1-9a-f][0-9a-f]*$",
          "title": "Transactionhash",
          "type": "string"
        },
        "vault": {
          "maxLength": 42,
          "minLength": 42,
          "pattern": "^0x[0-9a-f]*[1-9a-f][0-9a-f]*$",
          "title": "Vault",
          "type": "string"
        }
      },
      "required": [
        "chainId",
        "protocol",
        "deploymentId",
        "positionManager",
        "vault",
        "owner",
        "transactionHash"
      ],
      "title": "ReceiptRequest",
      "type": "object"
    },
    "response": {
      "$defs": {
        "AnchorModel": {
          "additionalProperties": false,
          "properties": {
            "hash": {
              "maxLength": 66,
              "minLength": 66,
              "pattern": "^0x[0-9a-f]*[1-9a-f][0-9a-f]*$",
              "title": "Hash",
              "type": "string"
            },
            "number": {
              "maximum": 9007199254740991,
              "minimum": 0,
              "title": "Number",
              "type": "integer"
            },
            "timestamp": {
              "maximum": 9007199254740991,
              "minimum": 0,
              "title": "Timestamp",
              "type": "integer"
            }
          },
          "required": [
            "number",
            "hash",
            "timestamp"
          ],
          "title": "AnchorModel",
          "type": "object"
        },
        "ReceiptTransaction": {
          "additionalProperties": false,
          "properties": {
            "data": {
              "maxLength": 16386,
              "minLength": 2,
              "pattern": "^0x(?:[0-9a-f]{2})*$",
              "title": "Data",
              "type": "string"
            },
            "from": {
              "maxLength": 42,
              "minLength": 42,
              "pattern": "^0x[0-9a-f]*[1-9a-f][0-9a-f]*$",
              "title": "From",
              "type": "string"
            },
            "nonce": {
              "maximum": 9007199254740991,
              "minimum": 0,
              "title": "Nonce",
              "type": "integer"
            },
            "to": {
              "maxLength": 42,
              "minLength": 42,
              "pattern": "^0x[0-9a-f]*[1-9a-f][0-9a-f]*$",
              "title": "To",
              "type": "string"
            },
            "valueRaw": {
              "maxLength": 78,
              "pattern": "^(0|[1-9][0-9]{0,77})$",
              "title": "Valueraw",
              "type": "string",
              "x-maximum-raw": "115792089237316195423570985008687907853269984665640564039457584007913129639935"
            }
          },
          "required": [
            "from",
            "to",
            "data",
            "valueRaw",
            "nonce"
          ],
          "title": "ReceiptTransaction",
          "type": "object"
        }
      },
      "additionalProperties": false,
      "properties": {
        "anchor": {
          "anyOf": [
            {
              "$ref": "#/$defs/AnchorModel"
            },
            {
              "type": "null"
            }
          ]
        },
        "chainId": {
          "const": 99801,
          "title": "Chainid",
          "type": "integer"
        },
        "contractVersion": {
          "const": "1.0.0-rc.2",
          "title": "Contractversion",
          "type": "string"
        },
        "deploymentId": {
          "maxLength": 66,
          "minLength": 66,
          "pattern": "^0x[0-9a-f]*[1-9a-f][0-9a-f]*$",
          "title": "Deploymentid",
          "type": "string"
        },
        "gasUsedRaw": {
          "anyOf": [
            {
              "maxLength": 78,
              "pattern": "^(0|[1-9][0-9]{0,77})$",
              "type": "string",
              "x-maximum-raw": "115792089237316195423570985008687907853269984665640564039457584007913129639935"
            },
            {
              "type": "null"
            }
          ],
          "title": "Gasusedraw"
        },
        "owner": {
          "maxLength": 42,
          "minLength": 42,
          "pattern": "^0x[0-9a-f]*[1-9a-f][0-9a-f]*$",
          "title": "Owner",
          "type": "string"
        },
        "positionManager": {
          "maxLength": 42,
          "minLength": 42,
          "pattern": "^0x[0-9a-f]*[1-9a-f][0-9a-f]*$",
          "title": "Positionmanager",
          "type": "string"
        },
        "protocol": {
          "const": "uniswap-v3",
          "title": "Protocol",
          "type": "string"
        },
        "qualification": {
          "enum": [
            "unqualified",
            "local-fixture",
            "testnet-rehearsal"
          ],
          "title": "Qualification",
          "type": "string"
        },
        "state": {
          "enum": [
            "pending",
            "confirmed",
            "reverted"
          ],
          "title": "State",
          "type": "string"
        },
        "transaction": {
          "anyOf": [
            {
              "$ref": "#/$defs/ReceiptTransaction"
            },
            {
              "type": "null"
            }
          ]
        },
        "transactionHash": {
          "maxLength": 66,
          "minLength": 66,
          "pattern": "^0x[0-9a-f]*[1-9a-f][0-9a-f]*$",
          "title": "Transactionhash",
          "type": "string"
        },
        "vault": {
          "maxLength": 42,
          "minLength": 42,
          "pattern": "^0x[0-9a-f]*[1-9a-f][0-9a-f]*$",
          "title": "Vault",
          "type": "string"
        }
      },
      "required": [
        "chainId",
        "protocol",
        "deploymentId",
        "positionManager",
        "contractVersion",
        "qualification",
        "vault",
        "owner",
        "transactionHash",
        "state",
        "anchor",
        "transaction",
        "gasUsedRaw"
      ],
      "title": "ReceiptResponse",
      "type": "object"
    }
  }
};
export const ERRORS = {
  "action_unavailable": 409,
  "body_too_large": 413,
  "bridge_forbidden": 403,
  "canonical_state_changed": 409,
  "capacity_exceeded": 429,
  "contract_mismatch": 409,
  "deployment_unqualified": 503,
  "gas_unavailable": 503,
  "identity_mismatch": 409,
  "invalid_request": 400,
  "loopback_required": 403,
  "origin_forbidden": 403,
  "owner_mismatch": 403,
  "provider_unavailable": 503,
  "route_not_found": 404,
  "service_disabled": 404,
  "state_changed": 409,
  "transaction_mismatch": 409,
  "unsupported_media_type": 415,
  "upstream_invalid_response": 502,
  "vault_not_admitted": 404
};
