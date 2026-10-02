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
        "financialExecutionAvailable": {
          "const": false,
          "title": "Financialexecutionavailable",
          "type": "boolean"
        },
        "ledgerConfigured": {
          "title": "Ledgerconfigured",
          "type": "boolean"
        },
        "protocol": {
          "const": "uniswap-v3",
          "title": "Protocol",
          "type": "string"
        },
        "providerConfigured": {
          "title": "Providerconfigured",
          "type": "boolean"
        },
        "registryId": {
          "const": "elysium-v3-unqualified",
          "title": "Registryid",
          "type": "string"
        },
        "status": {
          "enum": [
            "unqualified",
            "configured-read-only"
          ],
          "title": "Status",
          "type": "string"
        },
        "walletAuthenticationAvailable": {
          "const": false,
          "title": "Walletauthenticationavailable",
          "type": "boolean"
        }
      },
      "required": [
        "contractVersion",
        "chainId",
        "protocol",
        "registryId",
        "deployment",
        "status",
        "financialExecutionAvailable",
        "walletAuthenticationAvailable",
        "providerConfigured",
        "ledgerConfigured"
      ],
      "title": "CapabilitiesResponse",
      "type": "object"
    }
  },
  "discover-pool": {
    "request": {
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
          ],
          "default": null
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
        "fee": {
          "maximum": 999999,
          "minimum": 1,
          "title": "Fee",
          "type": "integer"
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
        "tokenA": {
          "maxLength": 42,
          "minLength": 42,
          "pattern": "^0x[0-9a-f]*[1-9a-f][0-9a-f]*$",
          "title": "Tokena",
          "type": "string"
        },
        "tokenB": {
          "maxLength": 42,
          "minLength": 42,
          "pattern": "^0x[0-9a-f]*[1-9a-f][0-9a-f]*$",
          "title": "Tokenb",
          "type": "string"
        }
      },
      "required": [
        "chainId",
        "protocol",
        "deploymentId",
        "positionManager",
        "tokenA",
        "tokenB",
        "fee"
      ],
      "title": "DiscoverRequest",
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
        "financialExecutionAvailable": {
          "const": false,
          "title": "Financialexecutionavailable",
          "type": "boolean"
        },
        "pool": {
          "anyOf": [
            {
              "$ref": "#/$defs/PoolData"
            },
            {
              "type": "null"
            }
          ]
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
            "local-fixture",
            "unqualified",
            "testnet-rehearsal"
          ],
          "title": "Qualification",
          "type": "string"
        },
        "status": {
          "enum": [
            "found",
            "not-found"
          ],
          "title": "Status",
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
        "financialExecutionAvailable",
        "pool",
        "status"
      ],
      "title": "DiscoverResponse",
      "type": "object"
    }
  },
  "history": {
    "request": {
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
        "Cursor": {
          "additionalProperties": false,
          "properties": {
            "blockHash": {
              "maxLength": 66,
              "minLength": 66,
              "pattern": "^0x[0-9a-f]*[1-9a-f][0-9a-f]*$",
              "title": "Blockhash",
              "type": "string"
            },
            "blockNumber": {
              "maximum": 9007199254740991,
              "minimum": 0,
              "title": "Blocknumber",
              "type": "integer"
            },
            "logIndex": {
              "maximum": 9007199254740991,
              "minimum": 0,
              "title": "Logindex",
              "type": "integer"
            },
            "transactionIndex": {
              "maximum": 9007199254740991,
              "minimum": 0,
              "title": "Transactionindex",
              "type": "integer"
            }
          },
          "required": [
            "blockNumber",
            "blockHash",
            "transactionIndex",
            "logIndex"
          ],
          "title": "Cursor",
          "type": "object"
        }
      },
      "additionalProperties": false,
      "properties": {
        "after": {
          "anyOf": [
            {
              "$ref": "#/$defs/Cursor"
            },
            {
              "type": "null"
            }
          ],
          "default": null
        },
        "anchor": {
          "anyOf": [
            {
              "$ref": "#/$defs/AnchorModel"
            },
            {
              "type": "null"
            }
          ],
          "default": null
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
        "limit": {
          "default": 50,
          "maximum": 100,
          "minimum": 1,
          "title": "Limit",
          "type": "integer"
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
      "title": "HistoryRequest",
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
        "Coverage": {
          "additionalProperties": false,
          "properties": {
            "basis": {
              "const": "canonical-vault-events",
              "title": "Basis",
              "type": "string"
            },
            "complete": {
              "title": "Complete",
              "type": "boolean"
            },
            "fromBlock": {
              "maximum": 9007199254740991,
              "minimum": 0,
              "title": "Fromblock",
              "type": "integer"
            },
            "reason": {
              "enum": [
                "complete",
                "missing-history",
                "unclassified-owner-exit-fees"
              ],
              "title": "Reason",
              "type": "string"
            },
            "toBlock": {
              "maximum": 9007199254740991,
              "minimum": 0,
              "title": "Toblock",
              "type": "integer"
            }
          },
          "required": [
            "fromBlock",
            "toBlock",
            "complete",
            "basis",
            "reason"
          ],
          "title": "Coverage",
          "type": "object"
        },
        "Cursor": {
          "additionalProperties": false,
          "properties": {
            "blockHash": {
              "maxLength": 66,
              "minLength": 66,
              "pattern": "^0x[0-9a-f]*[1-9a-f][0-9a-f]*$",
              "title": "Blockhash",
              "type": "string"
            },
            "blockNumber": {
              "maximum": 9007199254740991,
              "minimum": 0,
              "title": "Blocknumber",
              "type": "integer"
            },
            "logIndex": {
              "maximum": 9007199254740991,
              "minimum": 0,
              "title": "Logindex",
              "type": "integer"
            },
            "transactionIndex": {
              "maximum": 9007199254740991,
              "minimum": 0,
              "title": "Transactionindex",
              "type": "integer"
            }
          },
          "required": [
            "blockNumber",
            "blockHash",
            "transactionIndex",
            "logIndex"
          ],
          "title": "Cursor",
          "type": "object"
        },
        "HistoryItem": {
          "additionalProperties": false,
          "properties": {
            "amount0Raw": {
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
              "title": "Amount0Raw"
            },
            "amount1Raw": {
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
              "title": "Amount1Raw"
            },
            "basis": {
              "enum": [
                "capital",
                "earned-fees",
                "conversion",
                "custody",
                "policy",
                "unclassified"
              ],
              "title": "Basis",
              "type": "string"
            },
            "blockHash": {
              "maxLength": 66,
              "minLength": 66,
              "pattern": "^0x[0-9a-f]*[1-9a-f][0-9a-f]*$",
              "title": "Blockhash",
              "type": "string"
            },
            "blockNumber": {
              "maximum": 9007199254740991,
              "minimum": 0,
              "title": "Blocknumber",
              "type": "integer"
            },
            "chargedRaw": {
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
              "title": "Chargedraw"
            },
            "currency": {
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
              "title": "Currency"
            },
            "kind": {
              "maxLength": 64,
              "pattern": "^[A-Za-z][A-Za-z0-9]{0,63}$",
              "title": "Kind",
              "type": "string"
            },
            "liquidityRaw": {
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
              "title": "Liquidityraw"
            },
            "logIndex": {
              "maximum": 9007199254740991,
              "minimum": 0,
              "title": "Logindex",
              "type": "integer"
            },
            "originalRaw": {
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
              "title": "Originalraw"
            },
            "serviceFeeRaw": {
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
              "title": "Servicefeeraw"
            },
            "sourceId": {
              "anyOf": [
                {
                  "maxLength": 66,
                  "minLength": 66,
                  "pattern": "^0x[0-9a-f]*[1-9a-f][0-9a-f]*$",
                  "type": "string"
                },
                {
                  "type": "null"
                }
              ],
              "title": "Sourceid"
            },
            "timestamp": {
              "maximum": 9007199254740991,
              "minimum": 0,
              "title": "Timestamp",
              "type": "integer"
            },
            "tokenId": {
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
              "title": "Tokenid"
            },
            "transactionHash": {
              "maxLength": 66,
              "minLength": 66,
              "pattern": "^0x[0-9a-f]*[1-9a-f][0-9a-f]*$",
              "title": "Transactionhash",
              "type": "string"
            },
            "transactionIndex": {
              "maximum": 9007199254740991,
              "minimum": 0,
              "title": "Transactionindex",
              "type": "integer"
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
            "blockNumber",
            "blockHash",
            "transactionIndex",
            "logIndex",
            "timestamp",
            "transactionHash",
            "vault",
            "kind",
            "tokenId",
            "sourceId",
            "currency",
            "amount0Raw",
            "amount1Raw",
            "originalRaw",
            "chargedRaw",
            "serviceFeeRaw",
            "liquidityRaw",
            "basis"
          ],
          "title": "HistoryItem",
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
        "coverage": {
          "$ref": "#/$defs/Coverage"
        },
        "deploymentId": {
          "maxLength": 66,
          "minLength": 66,
          "pattern": "^0x[0-9a-f]*[1-9a-f][0-9a-f]*$",
          "title": "Deploymentid",
          "type": "string"
        },
        "financialExecutionAvailable": {
          "const": false,
          "title": "Financialexecutionavailable",
          "type": "boolean"
        },
        "items": {
          "items": {
            "$ref": "#/$defs/HistoryItem"
          },
          "maxItems": 100,
          "title": "Items",
          "type": "array"
        },
        "nextAfter": {
          "anyOf": [
            {
              "$ref": "#/$defs/Cursor"
            },
            {
              "type": "null"
            }
          ]
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
            "local-fixture",
            "unqualified",
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
        "financialExecutionAvailable",
        "vault",
        "coverage",
        "items",
        "nextAfter"
      ],
      "title": "HistoryResponse",
      "type": "object"
    }
  },
  "ledger": {
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
      "title": "LedgerRequest",
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
        "Coverage": {
          "additionalProperties": false,
          "properties": {
            "basis": {
              "const": "canonical-vault-events",
              "title": "Basis",
              "type": "string"
            },
            "complete": {
              "title": "Complete",
              "type": "boolean"
            },
            "fromBlock": {
              "maximum": 9007199254740991,
              "minimum": 0,
              "title": "Fromblock",
              "type": "integer"
            },
            "reason": {
              "enum": [
                "complete",
                "missing-history",
                "unclassified-owner-exit-fees"
              ],
              "title": "Reason",
              "type": "string"
            },
            "toBlock": {
              "maximum": 9007199254740991,
              "minimum": 0,
              "title": "Toblock",
              "type": "integer"
            }
          },
          "required": [
            "fromBlock",
            "toBlock",
            "complete",
            "basis",
            "reason"
          ],
          "title": "Coverage",
          "type": "object"
        },
        "CurrencyTotals": {
          "additionalProperties": false,
          "properties": {
            "chargedAwaitingRaw": {
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
              "title": "Chargedawaitingraw"
            },
            "collectedFeesRaw": {
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
              "title": "Collectedfeesraw"
            },
            "currency": {
              "maxLength": 42,
              "minLength": 42,
              "pattern": "^0x[0-9a-f]*[1-9a-f][0-9a-f]*$",
              "title": "Currency",
              "type": "string"
            },
            "manualAddedRaw": {
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
              "title": "Manualaddedraw"
            },
            "originalAwaitingRaw": {
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
              "title": "Originalawaitingraw"
            },
            "principalWithdrawnRaw": {
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
              "title": "Principalwithdrawnraw"
            },
            "reinvestedRaw": {
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
              "title": "Reinvestedraw"
            },
            "serviceFeesRaw": {
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
              "title": "Servicefeesraw"
            },
            "withdrawnFeesRaw": {
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
              "title": "Withdrawnfeesraw"
            }
          },
          "required": [
            "currency",
            "collectedFeesRaw",
            "serviceFeesRaw",
            "reinvestedRaw",
            "withdrawnFeesRaw",
            "principalWithdrawnRaw",
            "manualAddedRaw",
            "originalAwaitingRaw",
            "chargedAwaitingRaw"
          ],
          "title": "CurrencyTotals",
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
        "coverage": {
          "$ref": "#/$defs/Coverage"
        },
        "currencies": {
          "items": {
            "$ref": "#/$defs/CurrencyTotals"
          },
          "maxItems": 2,
          "title": "Currencies",
          "type": "array"
        },
        "deploymentId": {
          "maxLength": 66,
          "minLength": 66,
          "pattern": "^0x[0-9a-f]*[1-9a-f][0-9a-f]*$",
          "title": "Deploymentid",
          "type": "string"
        },
        "feeApr": {
          "title": "Feeapr",
          "type": "null"
        },
        "financialExecutionAvailable": {
          "const": false,
          "title": "Financialexecutionavailable",
          "type": "boolean"
        },
        "incomeUsd": {
          "title": "Incomeusd",
          "type": "null"
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
            "local-fixture",
            "unqualified",
            "testnet-rehearsal"
          ],
          "title": "Qualification",
          "type": "string"
        },
        "valuationStatus": {
          "const": "unavailable",
          "title": "Valuationstatus",
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
        "financialExecutionAvailable",
        "vault",
        "coverage",
        "currencies",
        "feeApr",
        "incomeUsd",
        "valuationStatus"
      ],
      "title": "LedgerResponse",
      "type": "object"
    }
  },
  "pool": {
    "request": {
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
          ],
          "default": null
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
        "pool": {
          "maxLength": 42,
          "minLength": 42,
          "pattern": "^0x[0-9a-f]*[1-9a-f][0-9a-f]*$",
          "title": "Pool",
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
        "positionManager",
        "pool"
      ],
      "title": "PoolRequest",
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
        "financialExecutionAvailable": {
          "const": false,
          "title": "Financialexecutionavailable",
          "type": "boolean"
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
        "protocol": {
          "const": "uniswap-v3",
          "title": "Protocol",
          "type": "string"
        },
        "qualification": {
          "enum": [
            "local-fixture",
            "unqualified",
            "testnet-rehearsal"
          ],
          "title": "Qualification",
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
        "financialExecutionAvailable",
        "pool"
      ],
      "title": "PoolResponse",
      "type": "object"
    }
  },
  "position": {
    "request": {
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
          ],
          "default": null
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
        "tokenId": {
          "maxLength": 78,
          "pattern": "^(0|[1-9][0-9]{0,77})$",
          "title": "Tokenid",
          "type": "string",
          "x-maximum-raw": "115792089237316195423570985008687907853269984665640564039457584007913129639935"
        }
      },
      "required": [
        "chainId",
        "protocol",
        "deploymentId",
        "positionManager",
        "tokenId"
      ],
      "title": "PositionRequest",
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
        "PositionData": {
          "additionalProperties": false,
          "properties": {
            "accruedSinceCheckpoint0Raw": {
              "maxLength": 78,
              "pattern": "^(0|[1-9][0-9]{0,77})$",
              "title": "Accruedsincecheckpoint0Raw",
              "type": "string",
              "x-maximum-raw": "115792089237316195423570985008687907853269984665640564039457584007913129639935"
            },
            "accruedSinceCheckpoint1Raw": {
              "maxLength": 78,
              "pattern": "^(0|[1-9][0-9]{0,77})$",
              "title": "Accruedsincecheckpoint1Raw",
              "type": "string",
              "x-maximum-raw": "115792089237316195423570985008687907853269984665640564039457584007913129639935"
            },
            "fee": {
              "maximum": 999999,
              "minimum": 1,
              "title": "Fee",
              "type": "integer"
            },
            "inRange": {
              "title": "Inrange",
              "type": "boolean"
            },
            "liquidityRaw": {
              "maxLength": 78,
              "pattern": "^(0|[1-9][0-9]{0,77})$",
              "title": "Liquidityraw",
              "type": "string",
              "x-maximum-raw": "115792089237316195423570985008687907853269984665640564039457584007913129639935"
            },
            "owedClassification": {
              "const": "unclassified",
              "title": "Owedclassification",
              "type": "string"
            },
            "owner": {
              "maxLength": 42,
              "minLength": 42,
              "pattern": "^0x[0-9a-f]*[1-9a-f][0-9a-f]*$",
              "title": "Owner",
              "type": "string"
            },
            "pool": {
              "maxLength": 42,
              "minLength": 42,
              "pattern": "^0x[0-9a-f]*[1-9a-f][0-9a-f]*$",
              "title": "Pool",
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
            "token0": {
              "maxLength": 42,
              "minLength": 42,
              "pattern": "^0x[0-9a-f]*[1-9a-f][0-9a-f]*$",
              "title": "Token0",
              "type": "string"
            },
            "token1": {
              "maxLength": 42,
              "minLength": 42,
              "pattern": "^0x[0-9a-f]*[1-9a-f][0-9a-f]*$",
              "title": "Token1",
              "type": "string"
            },
            "tokenId": {
              "maxLength": 78,
              "pattern": "^(0|[1-9][0-9]{0,77})$",
              "title": "Tokenid",
              "type": "string",
              "x-maximum-raw": "115792089237316195423570985008687907853269984665640564039457584007913129639935"
            },
            "tokensOwed0Raw": {
              "maxLength": 78,
              "pattern": "^(0|[1-9][0-9]{0,77})$",
              "title": "Tokensowed0Raw",
              "type": "string",
              "x-maximum-raw": "115792089237316195423570985008687907853269984665640564039457584007913129639935"
            },
            "tokensOwed1Raw": {
              "maxLength": 78,
              "pattern": "^(0|[1-9][0-9]{0,77})$",
              "title": "Tokensowed1Raw",
              "type": "string",
              "x-maximum-raw": "115792089237316195423570985008687907853269984665640564039457584007913129639935"
            }
          },
          "required": [
            "tokenId",
            "owner",
            "pool",
            "token0",
            "token1",
            "fee",
            "tickLower",
            "tickUpper",
            "liquidityRaw",
            "accruedSinceCheckpoint0Raw",
            "accruedSinceCheckpoint1Raw",
            "tokensOwed0Raw",
            "tokensOwed1Raw",
            "owedClassification",
            "inRange"
          ],
          "title": "PositionData",
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
        "financialExecutionAvailable": {
          "const": false,
          "title": "Financialexecutionavailable",
          "type": "boolean"
        },
        "position": {
          "$ref": "#/$defs/PositionData"
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
            "local-fixture",
            "unqualified",
            "testnet-rehearsal"
          ],
          "title": "Qualification",
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
        "financialExecutionAvailable",
        "position"
      ],
      "title": "PositionResponse",
      "type": "object"
    }
  }
};
export const ERRORS = {
  "body_too_large": 413,
  "canonical_state_changed": 409,
  "capacity_exceeded": 429,
  "contract_mismatch": 409,
  "deployment_unqualified": 503,
  "historical_state_unavailable": 503,
  "identity_mismatch": 409,
  "invalid_request": 400,
  "ledger_unavailable": 503,
  "loopback_required": 403,
  "origin_forbidden": 403,
  "provider_unavailable": 503,
  "route_not_found": 404,
  "service_disabled": 404,
  "unsupported_media_type": 415,
  "upstream_invalid_response": 502
};
