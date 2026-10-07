# n8n-nodes-gcp-pubsub

Community n8n nodes for Google Cloud Pub/Sub:

- **Google Cloud Pub/Sub Trigger** — starts a workflow when a message arrives on a subscription. By default it acknowledges the message when the execution succeeds and has it redelivered when the execution fails.
- **Google Cloud Pub/Sub Action** — acknowledges, nacks (redelivers) or extends the ack deadline of a specific message, for workflows that want to decide this themselves.
- **Google Cloud Pub/Sub Publish** — publishes messages to a topic.

See [Acknowledgement modes](#acknowledgement-modes) for how the trigger and the action node share responsibility for a message.

## Contents

- [Installation](#installation)
- [Credentials](#credentials)
- [Quick start](#quick-start)
- [Trigger output](#trigger-output)
- [Acknowledgement modes](#acknowledgement-modes)
- [Action node operations](#action-node-operations)
- [Publish node](#publish-node)
- [Ack lifecycle and guarantees](#ack-lifecycle-and-guarantees)
- [IAM roles](#iam-roles)
- [Troubleshooting](#troubleshooting)
- [Development](#development)

## Installation

Requires Node.js 22 or newer (including for the Google Cloud client libraries).

Via the n8n UI: **Settings → Community Nodes → Install** and enter the package name `n8n-nodes-gcp-pubsub-x78`.

From the CLI:

```bash
npm install n8n-nodes-gcp-pubsub-x78
```

## Credentials

All three nodes expose an **Authentication** dropdown with two branches:

- **Service Account / ADC** → uses the **Google Cloud Pub/Sub API** credential, which supports three sub-modes selected by its **Auth Method** dropdown.
- **OAuth2** → uses the **Google Cloud Pub/Sub OAuth2 API** credential, which authenticates as a Google user via n8n's OAuth2 flow.

You only need to configure the credential that matches the branch you pick on each node. Switching between them is a one-click change; nothing is lost.

### Google Cloud Pub/Sub API (service account / ADC)

Pick one **Auth Method**:

- **Service Account Key (Email + Private Key)** — paste the `client_email` and `private_key` from a downloaded JSON key into two separate fields. Escaped `\n` sequences in the private key are handled automatically. Use this when you prefer not to paste the full JSON blob. This is the default and is backwards-compatible with credentials created in earlier versions of the package.
- **Service Account JSON** — paste the entire JSON key as downloaded from Google Cloud. `project_id`, `client_email` and `private_key` are extracted automatically, so the **Project ID** field can usually stay blank.
- **Application Default Credentials** — no key material stored in n8n. The Google client library resolves credentials from the environment at runtime in this order: the `GOOGLE_APPLICATION_CREDENTIALS` env var, the gcloud user credentials file, then the metadata server when running on GCE / GKE / Cloud Run. Pair this mode with [Workload Identity](https://cloud.google.com/kubernetes-engine/docs/concepts/workload-identity) when hosting n8n on GKE or Cloud Run so credentials never leave Google Cloud. **Not available on n8n Cloud** — ambient credentials are not exposed to community nodes there.

**Project ID** on this credential is optional. If blank it is inferred from the service account itself — the JSON `project_id`, or the project in a `name@project.iam.gserviceaccount.com` email — or, in ADC mode only, from the environment (`auth.getProjectId()`). A pasted key never falls back to the project of the machine running n8n; if the project cannot be read from the key, the node asks for it. Each node can still override it.

Both the service-account and OAuth2 credentials also expose two deployment-level toggles:

- **API Endpoint (Regional)** — routes all Pub/Sub traffic through a regional endpoint instead of the default global one. Useful for data-residency and latency. Leave blank for the default `pubsub.googleapis.com:443`. Example values: `us-east1-pubsub.googleapis.com:443`, `europe-west1-pubsub.googleapis.com:443`. See [Pub/Sub regional endpoints](https://cloud.google.com/pubsub/docs/reference/service_apis_overview#regional_endpoints).
- **Use Pub/Sub Emulator** — targets a local emulator (`gcloud beta emulators pubsub start`) instead of the real service. When on, auth is skipped and all traffic (streaming pull and REST acks) goes to the **Emulator Host** (default `localhost:8085`; the port defaults to 8085 when omitted, and IPv6 addresses are not supported). Not available on n8n Cloud.

### Google Cloud Pub/Sub OAuth2 API

Use this when you want the nodes to act on behalf of a human Google user (for example a developer testing a workflow against their own subscriptions) rather than a machine identity.

1. In **Google Cloud Console → APIs & Services → Credentials**, create an **OAuth 2.0 Client ID** of type **Web application**.
2. Add your n8n callback URL as an **Authorised redirect URI**. n8n shows the exact URL in the credential editor (typically `https://<your-n8n-host>/rest/oauth2-credential/callback`).
3. Enable the **Cloud Pub/Sub API** on the same project (**APIs & Services → Library**).
4. In n8n, create a **Google Cloud Pub/Sub OAuth2 API** credential and paste the **Client ID** and **Client Secret**. All other OAuth2 fields (auth URL, token URL, scope, `access_type=offline&prompt=consent`) are pre-filled. The scope is pinned to `https://www.googleapis.com/auth/pubsub`.
5. Fill in **Project ID** — OAuth2 tokens are not scoped to a project, so this field is required (or must be set per node).
6. Click **Sign in with Google** and approve the consent screen.

> **IAM caveat** — OAuth2 authenticates as the *user*, so `roles/pubsub.subscriber` (and, if you auto-create subscriptions, `roles/pubsub.editor`) must be granted to the Google account that signs in, **not** to a service account. If your org uses Google Groups, granting the role to the group works too.

## Quick start

1. Add a **Google Cloud Pub/Sub Trigger** node and pick a **Subscription** from the dropdown. Switch to **By Name** to type a short name or paste a full resource path.
2. Optionally override **Project ID**.
3. Process messages with any n8n nodes you like. Every message starts its own execution with exactly one item, so no splitting is needed.

That is all: when the execution succeeds the message is acknowledged, and when it fails Pub/Sub redelivers it.

To have the trigger create the subscription, turn on **Create Subscription If Missing**, pick the **Topic**, and type the new subscription's name. This needs `roles/pubsub.editor`; see [IAM roles](#iam-roles).

### Deciding per message

```mermaid
flowchart LR
    Trigger["Pub/Sub Trigger · Acknowledge: Manually"] --> Work["Your business logic"]
    Work -- "done" --> Ack["Pub/Sub Action · Acknowledge"]
    Work -- "give up early" --> Nack["Pub/Sub Action · Nack"]
```

Set **Acknowledge** to **Manually (Pub/Sub Action Node)** when the workflow should decide itself — for example to acknowledge before a slow step, or to keep a message for later on a branch that otherwise succeeds. Add a **Google Cloud Pub/Sub Action** node with **Operation = Acknowledge** where the message is done; its defaults already reference `{{$json.ackId}}` and `{{$json._pubsub.subscription}}`. An execution that ends without acknowledging has its message redelivered, so a **Nack** node is only needed to hand a message back before the execution ends.

## Trigger output

Each message is emitted as one item with the following shape:

```json
{
  "messageId": "12345",
  "ackId": "Rd1-AUYeN...",
  "publishTime": "2026-04-19T12:34:56.789Z",
  "orderingKey": null,
  "deliveryAttempt": 1,
  "attributes": { "type": "order.created" },
  "data": "{\"orderId\":\"abc\"}",
  "_pubsub": {
    "projectId": "my-proj",
    "subscription": "projects/my-proj/subscriptions/my-sub"
  }
}
```

Enable **Decode JSON** on the trigger to have `data` automatically `JSON.parse`d. On parse failure the raw string is preserved and `jsonDecodeFailed: true` plus `jsonDecodeErrorMessage` are added to the item.

`_pubsub.subscription` is the full Pub/Sub resource name and is the only identifier the action node needs to route its requests.

## Acknowledgement modes

The trigger's **Acknowledge** field decides who resolves each message:

| Mode | Behaviour |
|---|---|
| **When Execution Finishes** (default) | The trigger acks when the execution succeeds and nacks when it fails, is cancelled, or crashes. No action node needed. |
| **Manually (Pub/Sub Action Node)** | The trigger emits the `ackId` and a Pub/Sub Action node acks it. When the execution finishes, the trigger lets go of the message: one that was acknowledged stays acknowledged, one that was not is redelivered. |
| **Immediately** | The trigger acks as soon as the message is handed to the workflow. A failed execution does not cause redelivery (at-most-once). |

Things to know:

- **Flow control.** A message counts towards **Max Outstanding Messages** until it is resolved as described above. Pub/Sub stops sending new messages while that many are outstanding.
- **Redelivery timing is the subscription's retry policy.** Without one, Pub/Sub redelivers a failed message at once, so a message that always fails loops. Subscriptions created by the trigger get exponential backoff (10–600 s) by default; for subscriptions created elsewhere, set a [retry policy](https://cloud.google.com/pubsub/docs/handling-failures#subscription_retry_policy) and a dead-letter topic yourself.
- **Wait nodes.** An execution that enters a Wait counts as finished for the trigger. In **When Execution Finishes** mode the message is acknowledged at that point. In **Manually** mode the lease is kept for up to **Max Extension (Minutes)** so an action node placed after the wait can still acknowledge.
- **Acknowledging from another workflow.** In **Manually** mode the message must be acknowledged before the triggered execution ends. Passing the `ackId` to a separate workflow to acknowledge later does not work, because the trigger lets go of the message when the first execution finishes.
- **Deactivating or saving the workflow** stops pulling immediately. Executions that are still running keep their leases until they finish (bounded by **Max Extension**), so they are not redelivered just because the trigger was restarted.
- **Test runs** ("Execute workflow" in the editor) consume a single message and follow the same rules.
- **Ordering keys.** On a subscription with message ordering enabled, executions for the same `orderingKey` run one at a time, in order. If one fails, queued messages for that key are released unprocessed, because Pub/Sub redelivers the failed message and everything after it. If the credential may not read the subscription's settings (`pubsub.subscriptions.get`), the trigger assumes ordering is on.

### Trigger options

| Option | Default | Purpose |
|---|---|---|
| Max Extension (Minutes) | 10 | How long the trigger keeps extending the ack deadline while a message's execution is running. Set higher than the slowest expected workflow run. |
| Max Outstanding Messages | 100 | Flow control: cap on messages being processed at once. |
| Max Outstanding Bytes | 100 MiB | Flow control: cap on cumulative size of messages being processed. |

### Creating the subscription

**Create Subscription If Missing** is off by default: the trigger then only needs `roles/pubsub.subscriber`, has no **Topic** field, and reports a missing subscription when the workflow is activated (when it is allowed to look; otherwise the error arrives from the message stream).

With it on, the trigger creates the subscription on the selected **Topic** using **New Subscription Settings**. If a subscription with that name already exists it is used as it is — the settings below are not applied to it — but the trigger refuses to start if it belongs to a different topic.

| Setting | Default | Purpose |
|---|---|---|
| Filter | — | Server-side [subscription filter](https://cloud.google.com/pubsub/docs/filtering) (for example `attributes.type = "order.created"`). Non-matching messages are dropped before delivery. |
| Enable Message Ordering | off | When on, Pub/Sub delivers messages sharing the same `orderingKey` in publish order, and the trigger runs their executions one at a time. |
| Retain Acked Messages | off | Keep acknowledged messages for the retention duration to allow seek-to-time replays. |
| Message Retention (Hours) | 168 (7 days) | How long Pub/Sub retains unacked (and, if enabled, acked) messages. Range 1–168. |
| Ack Deadline (Seconds) | 60 | Default ack deadline of the subscription. The trigger manages deadlines itself while it runs. |
| Retry Policy | Exponential Backoff | How quickly a nacked or expired message is redelivered. **Retry Immediately** removes the delay. |
| Retry Minimum / Maximum Backoff (Seconds) | 10 / 600 | Bounds of the exponential backoff (0–600). |
| Dead-Letter Topic | — | Short name or full `projects/{project}/topics/{name}`. Undeliverable messages are forwarded here once `Dead-Letter Max Delivery Attempts` is exceeded. The DLQ topic must already exist and grant `roles/pubsub.publisher` to the Pub/Sub service agent `service-{project-number}@gcp-sa-pubsub.iam.gserviceaccount.com`. |
| Dead-Letter Max Delivery Attempts | 5 | Number of delivery attempts (5–100) before a message is routed to the DLQ. Applied only when a DLQ topic is set. |

## Action node operations

The action node takes one of three operations, defaulting its inputs to the fields emitted by the trigger:

- **Acknowledge** — `POST …/subscriptions/{sub}:acknowledge` — tells Pub/Sub the message was handled successfully.
- **Nack (Return Immediately)** — `POST …/subscriptions/{sub}:modifyAckDeadline` with `ackDeadlineSeconds: 0` — releases the lease so Pub/Sub redelivers as soon as possible.
- **Extend Ack Deadline** — same endpoint with a user-supplied `ackDeadlineSeconds` (0–600). Use it when a downstream step is slow and you want to be explicit about holding the lease, on top of the trigger's automatic extension.

Items that share a `subscription` (and deadline, for `Extend Ack Deadline`) are batched into shared REST calls of up to 1000 messages by default. Disable **Batch Requests** under **Options** to force one call per item.

On success the action node attaches `ok: true`, `status: 200`, `operation`, `subscription` and `ackId` to the item. On failure it raises a `NodeOperationError` pointing at the offending item (respecting the workflow's **Continue on Fail** setting). `ok: true` means Pub/Sub accepted the request; see [Ack lifecycle and guarantees](#ack-lifecycle-and-guarantees) for what that does and does not prove.

The REST helper retries up to 3 times on transient failures (HTTP 408, 429, 5xx, and network errors), with a 10-second request timeout and a 30-second overall deadline. HTTP 400 errors, including `FAILED_PRECONDITION`, are never retried — they are reported verbatim so your workflow can branch on them.

## Publish node

The **Google Cloud Pub/Sub Publish** node sends messages to a topic. Useful when a workflow needs to emit events in addition to (or instead of) consuming them.

Fields:

- **Topic** — resource locator (list, short name, or full resource path). Topic and Project ID expressions are resolved per input item; messages are batched separately for each destination topic.
- **Data Mode** — how the **Data** field is encoded into the Pub/Sub payload:
  - `JSON (Auto-Serialize)` — objects and arrays are stringified; strings pass through unchanged.
  - `Text` — sent as a UTF-8 string; objects and arrays are stringified as JSON.
  - `Binary (Base64)` — decoded from base64 (standard or URL-safe) before publish. A value that is not valid base64 fails the item.
- **Data** — the payload (expressions supported; default `={{ $json }}`).
- **Attributes** — optional key/value pairs; values are sent as strings. Pub/Sub subscription filters can match on these.
- **Ordering Key** — optional. Requires the subscription to have **Enable Message Ordering** turned on to take effect.
- **Options**:
  - `Batch Max Messages` (default 100) — publisher buffer size.
  - `Batch Max Bytes` (default 1 MiB) — publisher byte buffer.
  - `Batch Max Milliseconds` (default 10) — max time a partial batch waits before flush.

Each input item becomes one published message. The node attaches `_publish: { topic, messageId, ok }` to each output item. It flushes the batch and closes the Pub/Sub client between executions, so you do not need to worry about lingering connections.

## Ack lifecycle and guarantees

- **Delivery guarantee**: at-least-once (except in **Immediately** mode). Duplicates can occur (n8n stopping mid-execution, an execution outlasting `Max Extension (Minutes)`, Pub/Sub redelivery). Design your workflow to be idempotent.
- **ackId validity**: an `ackId` is a handle to one specific delivery and stays valid while the ack deadline hasn't expired. The trigger extends the deadline for as long as the message's execution is running, up to `Max Extension (Minutes)`.
- **Ack done by the action node** travels over the public Pub/Sub REST endpoint, so it works regardless of which n8n worker the action runs on (this matters in queue-mode deployments).
- **Late acks are not reported on ordinary subscriptions.** If the lease has already expired, Pub/Sub usually still answers the acknowledge call with `200` and redelivers the message anyway, so `ok: true` on the action node is not proof that the message is gone. Only subscriptions with [exactly-once delivery](https://cloud.google.com/pubsub/docs/exactly-once-delivery) reject an expired `ackId` (HTTP 400, `FAILED_PRECONDITION`), which the action node reports as an error you can branch on.
- **Ordering keys**: on an ordered subscription a nacked message is redelivered together with every later message for the same key. Keep this in mind when designing retry logic.

## IAM roles

Grant the principal used by the credential the minimum roles needed:

| Feature | Role |
|---|---|
| Consume messages, ack/nack/modify deadline | `roles/pubsub.subscriber` |
| Publish messages | `roles/pubsub.publisher` |
| Topic / Subscription dropdowns, reading subscription settings at activation | `roles/pubsub.viewer` (optional) |
| **Create Subscription If Missing** on the trigger | `roles/pubsub.editor` (or a custom role with `pubsub.subscriptions.create`, `pubsub.subscriptions.get` and `pubsub.topics.attachSubscription`) |

`roles/pubsub.viewer` is optional. Without it the credential test still passes (it notes that listing is not allowed), the dropdowns do not load — switch the fields to **By Name** — and the trigger cannot check up front that the subscription exists or whether it is ordered.

The *principal* depends on the auth mode:

- **Service Account Key / Service Account JSON** — grant roles to the service account whose key you pasted (`client_email`).
- **Application Default Credentials** — grant roles to whichever identity the environment resolves to (the Workload Identity-bound service account on GKE / Cloud Run, or the user in `gcloud auth application-default login`).
- **OAuth2** — grant roles to the Google user (or their group) who authorises the credential. Service-account grants do **not** apply.

Leave **Create Subscription If Missing** off in the trigger if you don't want to grant editor-level permissions and prefer to create subscriptions out-of-band.

## Troubleshooting

**`FAILED_PRECONDITION: You are attempting to acknowledge with expired ackId`**
Seen on exactly-once subscriptions: the message's lease expired before the action node acked it. Raise **Max Extension (Minutes)** on the trigger so the deadline is extended for longer, or simplify the downstream workflow so it finishes sooner. Pub/Sub will redeliver the message. On ordinary subscriptions the same situation produces no error — the ack returns `ok: true` and the message simply arrives again.

**The same message keeps arriving in a tight loop**
Its execution fails (or, in **Manually** mode, ends without an ack) and the subscription has no retry policy, so Pub/Sub redelivers immediately. Fix the failing step, and configure a retry policy and dead-letter topic on the subscription so poison messages back off and eventually leave the queue.

**Private-key auth errors (`invalid_grant`, `PEM_read_bio_PrivateKey`)**
Make sure the **Private Key** credential field contains the full PEM, BEGIN/END markers included. Escaped `\n` sequences are converted automatically; triple-escaping them (for example by wrapping the value in extra quotes before pasting) will break parsing.

**Trigger stays quiet while messages are visible in the console**
Check that the service account has `roles/pubsub.subscriber` on the subscription. If **Max Outstanding Messages** messages are already outstanding — executions still running, or waiting in **Manually** mode — Pub/Sub holds further messages back until one of them is resolved.

**Messages show up again after processing**
Either the action node did not run (check your error branch wiring), the ack call failed (inspect the item's `ok`, `status`, and `message` fields), or the ack arrived after the lease expired. Remember: delivery is at-least-once.

## Running behind a corporate proxy

Both transports used by these nodes honour standard proxy environment variables on the host that runs n8n:

- REST ack calls (gaxios): `HTTPS_PROXY`, `HTTP_PROXY`, and `NO_PROXY`.
- Streaming pull (gRPC): the same variables, plus `grpc.http_proxy` for the underlying gRPC client. If gRPC traffic does not reach Google, set `grpc.http_proxy=http://user:pass@proxy.example.com:3128` as well.
- Corporate TLS interception: point `NODE_EXTRA_CA_CERTS` at a PEM bundle that includes your internal root CA so both gaxios and gRPC can validate the proxy's certificate.

A dedicated credential-level proxy field is not exposed yet; it needs per-call `http.Agent` wiring on the gaxios side *and* a custom gRPC channel on the Pub/Sub client side. Until that lands, the environment-variable approach is the supported path.

## Development

```bash
npm install
npm run dev           # hot-reload n8n with the nodes loaded
npm run build         # build into dist/
npm run lint          # n8n community-node lint + eslint
npm run lint:fix      # auto-fix where possible
npm test              # jest unit tests
npm run test:watch    # jest in watch mode
```

Code layout:

- [`credentials/GcpPubSubApi.credentials.ts`](credentials/GcpPubSubApi.credentials.ts) — service-account credential (key / JSON / ADC sub-modes).
- [`credentials/GcpPubSubOAuth2Api.credentials.ts`](credentials/GcpPubSubOAuth2Api.credentials.ts) — OAuth2 credential preset for Google + Pub/Sub scope.
- [`nodes/GcpPubSubTrigger/`](nodes/GcpPubSubTrigger) — versioned streaming-pull trigger (`GcpPubSubTrigger.node.ts` wrapper + `v1/GcpPubSubTriggerV1.node.ts`).
- [`nodes/GcpPubSubAction/`](nodes/GcpPubSubAction) — versioned ack/nack/extend action.
- [`nodes/GcpPubSubPublish/`](nodes/GcpPubSubPublish) — versioned publisher node with batching.
- [`nodes/shared/auth.ts`](nodes/shared/auth.ts) — `buildPubSubAuth` dispatcher that returns `{ authClient, pubsub, projectId, restApiBase }` for all four auth modes, and handles emulator / regional-endpoint routing.
- [`nodes/shared/pubsubRest.ts`](nodes/shared/pubsubRest.ts) — thin REST wrapper around `:acknowledge` and `:modifyAckDeadline` with gaxios retry (skipping `FAILED_PRECONDITION`), parameterised by `apiBase` so it follows the credential's endpoint setting.
- [`nodes/shared/listSearch.ts`](nodes/shared/listSearch.ts) — `searchTopics` / `searchSubscriptions` helpers that power the resource-locator dropdowns on all three nodes; a filtered search scans further pages until it has a page of matches.
- [`nodes/shared/credentialTest.ts`](nodes/shared/credentialTest.ts) — shared `pubSubCredentialTest` used by every node's `methods.credentialTest`.
- [`nodes/shared/__tests__/`](nodes/shared/__tests__) — jest unit tests for `auth.ts`, `pubsubRest.ts` and `listSearch.ts`.

The project depends on `@google-cloud/pubsub` (for streaming pull) and `google-auth-library` (for signing JWTs used by the REST ack calls). These external runtime dependencies mean the package is not eligible for the "n8n Cloud verified" status today; self-hosted n8n instances install it without issue.

## License

[MIT](LICENSE.md)
