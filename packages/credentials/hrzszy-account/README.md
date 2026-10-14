---
description: "The account provider that signs a user in through the CRC RWork identity gateway and shows the resulting name and avatar, replacing the DeepSeek platform account."
kind: "package-reference"
---

# @deepseek-ai/dsh-hrzszy-account

English | [中文](README.zh.md)

## Summary

This distribution signs users in against the tenant's own identity gateway instead of the DeepSeek platform. It implements the account service the rest of the product already consumes: the client opens the RWork login page in a desktop window, the host reads the resulting session cookie, exchanges it for the user's name and avatar, and stores it as a credential grant. Models are unaffected, because they authenticate with API keys. Choose it when a deployment must keep sign-in inside its own tenant; the shared account contract leaves the client, the RPC controller, and the settings UI unchanged.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Mount this provider in place of the platform account provider; the account service name stays `deepseekAccount`, so nothing else in the graph changes.

### Configuration

| Field | Default | Meaning |
|---|---|---|
| `apiOrigin` | `https://app.rwork.crc.com.cn` | Origin serving the identity API. |
| `loginOrigin` | `https://accounts.rwork.crc.com.cn` | Origin serving the sign-in page. |
| `appId` | `2` | Application id the gateway expects. |
| `requestTimeoutMs` | `15000` | Identity request timeout. |
| `attemptTimeoutMs` | `600000` | How long a sign-in attempt stays open. |

### When to choose it

Choose it for a tenant-bound deployment whose users sign in through the corporate identity gateway. Avoid it when the product must sign in against the upstream platform account, in which case the platform provider remains the right implementation of the same service.

<a id="understand-the-implementation"></a>
## Understand the implementation

`startSignIn` records an attempt in the `waiting-browser` phase and hands the client an `authorizeUrl` built from `loginOrigin`. The client opens that URL in a window it controls, polls the window's cookie jar, and passes the cookie back through `acceptExternalSession`. That method calls the identity endpoint, and on success writes a grant record whose payload holds the cookie and the resolved user, then reports the attempt as succeeded.

`getProfile` reads that grant and reports `id`, `name`, and `avatarUrl`, which is what the settings UI and the account menu render. `getState` reports signed-in or signed-out from the same record.

`getBalance`, `getUnnotifiedBonuses`, `resolveToken`, and `getPlatformSession` are deliberately inert: this deployment has no balance ledger, no bonus programme, and no platform session or bearer token, because models authenticate with API keys. `signOut` deletes the grant.

The base provider declares `acceptExternalSession` as a rejection, so providers that cannot accept a captured session are unaffected by the extension.

## Model Experience

None, as the identity gateway registers no model context or tools; the session cookie affects host HTTP authentication only.

#### KV Cache effect

No model request prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

**Runtime invariant:** No runtime invariant companion is published; the provider owns one credential record and the parsed identity inside it, and the transport it reads through belongs to the identity gateway rather than to this package.

- **No refresh or expiry handling** — a cookie the gateway later invalidates surfaces as a failed identity request, not as a sign-out, so the user sees the account they had until something else clears it.
- **No tenant discovery** — `appId` is configuration, so a second tenant needs a second profile rather than a lookup.
- **Balance and bonus surfaces stay empty** — the client renders them from the shared contract and shows nothing, which is intentional rather than unimplemented.
