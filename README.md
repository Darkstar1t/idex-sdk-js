<!-- markdownlint-disable MD033 -->
# <img src="assets/logo.png" alt="IDEX" height="36px" valign="top"> Javascript SDK

![Discord](https://img.shields.io/discord/455246457465733130?label=Discord&style=flat-square)
![GitHub](https://img.shields.io/github/license/idexio/idex-sdk-js?style=flat-square)
![npm](https://img.shields.io/npm/v/@idexio/idex-sdk?style=flat-square)
![GitHub issues](https://img.shields.io/github/issues/idexio/idex-sdk-js?style=flat-square)


![Twitter Follow](https://img.shields.io/twitter/follow/idexio?style=social)


The official library for [IDEX 2.0's](https://idex.io) REST and WebSocket APIs

Complete documentation for the IDEX 2.0 API is available at https://docs.idex.io.

## Features

- Easy functionality to use in programmatic trading
- A WebSocket-backed real-time order book implementation
- Clients with convenient methods for every API endpoint
- Abstracted interfaces – don't worry about HMAC signing, JSON formatting, or ECDSA signatures; the library does it for you
- Supports both Node.js and browser environments
- Written in Typescript with full typings for all requests and responses

## Installation

```bash
yarn add @idexio/idex-sdk
// or
npm install --save @idexio/idex-sdk
```

## Getting Started

Get IDEX 2.0 sandbox [API keys](https://idex.io).

```typescript
import * as idex from '@idexio/idex-sdk';

const publicClient = new idex.RestPublicClient({
  sandbox: true,
});
console.log(await publicClient.getServerTime());
```

In-depth usage documentation by endpoint is [available here](https://github.com/idexio/idex-sdk-js/blob/master/API.md).

## Contracts

Included in the `contracts/` directory are the Solidity [source](https://github.com/idexio/idex-sdk-js/blob/master/contracts/SandboxToken.sol)
and corresponding [ABI](https://github.com/idexio/idex-sdk-js/blob/master/contracts/SandboxToken.abi.json) for the
[testnet sandbox](https://docs.idex.io/#sandbox) ERC-20 tokens, which feature a [faucet](https://docs.idex.io/#faucets)
function for dispensing tokens.

See the [idex-contracts](https://github.com/idexio/idex-contracts) repo for a reference
[Solidity implementation](https://github.com/idexio/idex-contracts/blob/master/contracts/libraries/Signatures.sol) of
order and withdrawal signature verification that exactly mirrors the [Javascript implementation](https://github.com/idexio/idex-sdk-js/blob/main/src/signatures.ts)
found in this repo.

The [Exchange ABI](https://github.com/idexio/idex-sdk-js/blob/master/contracts/Exchange.abi.json) can be used to query
contract state, [deposit funds](https://docs.idex.io/#deposit-funds), or [exit wallets](https://docs.idex.io/#exit-wallet).

## License

The IDEX Javascript SDK is released under the [MIT License](https://opensource.org/licenses/MIT).
