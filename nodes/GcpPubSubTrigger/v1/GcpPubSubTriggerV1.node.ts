import type { CreateSubscriptionOptions, Message, Subscription } from '@google-cloud/pubsub';
import { Duration } from '@google-cloud/pubsub';
import type {
	IDataObject,
	ILoadOptionsFunctions,
	INodeListSearchResult,
	INodeType,
	INodeTypeDescription,
	IRun,
	ITriggerFunctions,
	ITriggerResponse,
} from 'n8n-workflow';
import { ApplicationError, NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import { buildPubSubAuth, type Authentication } from '../../shared/auth';
import { testPubSubCredential } from '../../shared/credentialTest';
import { searchSubscriptions, searchTopics } from '../../shared/listSearch';

const NOT_FOUND_CODE = 5;
const ALREADY_EXISTS_CODE = 6;
const MANUAL_RUN_TIMEOUT_MS = 30000;
const DEFAULT_RETRY_MIN_BACKOFF_SECONDS = 10;
const DEFAULT_RETRY_MAX_BACKOFF_SECONDS = 600;

type AckMode = 'manual' | 'executionFinish' | 'immediately';

function grpcCode(error: unknown): number | undefined {
	if (error !== null && typeof error === 'object' && 'code' in error) {
		const code = (error as { code?: unknown }).code;
		return typeof code === 'number' ? code : undefined;
	}
	return undefined;
}

function isAlreadyExistsError(error: unknown): boolean {
	if (grpcCode(error) === ALREADY_EXISTS_CODE) return true;
	const msg = error instanceof Error ? error.message : String(error);
	return /already exists/i.test(msg);
}

/**
 * Compares two `projects/{project}/topics/{name}` paths. Pub/Sub reports the
 * project ID even when the caller addressed the topic by project number, so
 * the project segment is only compared when both sides use the same form.
 */
function isSameTopic(a: string, b: string): boolean {
	const [, projectA, , nameA] = a.split('/');
	const [, projectB, , nameB] = b.split('/');
	if (nameA !== nameB) return false;
	const isNumber = (project: string) => /^\d+$/.test(project ?? '');
	return isNumber(projectA) !== isNumber(projectB) || projectA === projectB;
}

interface SubscriptionSettings {
	ackDeadlineSeconds?: number;
	filter?: string;
	enableMessageOrdering?: boolean;
	retainAckedMessages?: boolean;
	messageRetentionHours?: number;
	deadLetterTopic?: string;
	deadLetterMaxDeliveryAttempts?: number;
	retryPolicy?: 'exponentialBackoff' | 'immediate';
	retryMinBackoffSeconds?: number;
	retryMaxBackoffSeconds?: number;
}

function buildCreateOptions(
	settings: SubscriptionSettings,
	subscriptionProjectId: string,
): CreateSubscriptionOptions {
	const createOptions: CreateSubscriptionOptions = {
		ackDeadlineSeconds: settings.ackDeadlineSeconds ?? 60,
	};
	if (settings.filter && settings.filter.trim() !== '') {
		createOptions.filter = settings.filter.trim();
	}
	if (settings.enableMessageOrdering === true) {
		createOptions.enableMessageOrdering = true;
	}
	if (settings.retainAckedMessages === true) {
		createOptions.retainAckedMessages = true;
	}
	if (typeof settings.messageRetentionHours === 'number') {
		createOptions.messageRetentionDuration = Duration.from({
			minutes: settings.messageRetentionHours * 60,
		});
	}
	const dlqRaw = settings.deadLetterTopic?.trim();
	if (dlqRaw) {
		createOptions.deadLetterPolicy = {
			deadLetterTopic: dlqRaw.startsWith('projects/')
				? dlqRaw
				: `projects/${subscriptionProjectId}/topics/${dlqRaw}`,
			maxDeliveryAttempts: settings.deadLetterMaxDeliveryAttempts ?? 5,
		};
	}
	// A nack redelivers at once unless the subscription has a retry policy, so
	// a message that always fails would loop. Back off by default.
	if ((settings.retryPolicy ?? 'exponentialBackoff') === 'exponentialBackoff') {
		const minimum = settings.retryMinBackoffSeconds ?? DEFAULT_RETRY_MIN_BACKOFF_SECONDS;
		const maximum = settings.retryMaxBackoffSeconds ?? DEFAULT_RETRY_MAX_BACKOFF_SECONDS;
		if (minimum > maximum) {
			throw new ApplicationError(
				'Retry Minimum Backoff cannot be greater than Retry Maximum Backoff',
			);
		}
		createOptions.retryPolicy = {
			minimumBackoff: { seconds: minimum },
			maximumBackoff: { seconds: maximum },
		};
	}
	return createOptions;
}

function executionFailed(run: IRun | undefined): boolean {
	if (!run) return true;
	return (
		run.status === 'error' ||
		run.status === 'crashed' ||
		run.status === 'canceled' ||
		run.data?.resultData?.error !== undefined
	);
}

function executionWaiting(run: IRun | undefined): boolean {
	return run?.status === 'waiting' || Boolean(run?.waitTill);
}

// eslint-disable-next-line @n8n/community-nodes/node-usable-as-tool -- triggers cannot be used as tools; usableAsTool only accepts `true`.
export class GcpPubSubTriggerV1 implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Google Cloud Pub/Sub Trigger',
		name: 'gcpPubSubTrigger',
		icon: 'file:gcpPubSub.svg',
		group: ['trigger'],
		version: 1,
		description: 'Starts a workflow when a message arrives on a Google Cloud Pub/Sub subscription',
		defaults: {
			name: 'Google Cloud Pub/Sub Trigger',
		},
		inputs: [],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: 'gcpPubSubApi',
				required: true,
				testedBy: 'pubSubCredentialTest',
				displayOptions: {
					show: {
						authentication: ['serviceAccount'],
					},
				},
			},
			{
				name: 'gcpPubSubOAuth2Api',
				required: true,
				testedBy: 'pubSubCredentialTest',
				displayOptions: {
					show: {
						authentication: ['oAuth2'],
					},
				},
			},
		],
		properties: [
			{
				displayName: 'Authentication',
				name: 'authentication',
				type: 'options',
				default: 'serviceAccount',
				options: [
					{
						name: 'Service Account / ADC',
						value: 'serviceAccount',
						description:
							'Service account key, service account JSON, or Application Default Credentials',
					},
					{
						name: 'OAuth2',
						value: 'oAuth2',
						description: 'Authenticate as a Google user via OAuth2',
					},
				],
			},
			{
				displayName: 'Project ID',
				name: 'projectId',
				type: 'string',
				default: '',
				description:
					'Google Cloud project ID. If left empty, the project will be inferred from the credential.',
			},
			{
				displayName: 'Subscription',
				name: 'subscription',
				type: 'resourceLocator',
				default: { mode: 'list', value: '' },
				required: true,
				description:
					"Pub/Sub subscription to receive messages from. To create a new one, type its name and turn on 'Create Subscription If Missing'.",
				modes: [
					{
						displayName: 'From List',
						name: 'list',
						type: 'list',
						typeOptions: {
							searchListMethod: 'searchSubscriptions',
							searchable: true,
						},
					},
					{
						displayName: 'By Name',
						name: 'id',
						type: 'string',
						placeholder: 'my-subscription',
						validation: [
							{
								type: 'regex',
								properties: {
									regex:
										'^(?!goog)[A-Za-z][A-Za-z0-9._~%+\\-]{2,254}$|^projects/[^/]+/subscriptions/[^/]+$',
									errorMessage:
										'Enter a short subscription name (3-255 chars, cannot start with "goog") or a full resource path (projects/.../subscriptions/...)',
								},
							},
						],
					},
				],
			},
			{
				displayName: 'Acknowledge',
				name: 'ackMode',
				type: 'options',
				default: 'executionFinish',
				description: 'When a received message is acknowledged',
				options: [
					{
						name: 'When Execution Finishes',
						value: 'executionFinish',
						description:
							'Acknowledge when the workflow execution succeeds, nack (redeliver) when it fails',
					},
					{
						name: 'Manually (Pub/Sub Action Node)',
						value: 'manual',
						description:
							'Emit the ackId and let a Google Cloud Pub/Sub Action node acknowledge the message. If the execution finishes without acknowledging it, the message is redelivered.',
					},
					{
						name: 'Immediately',
						value: 'immediately',
						description:
							'Acknowledge as soon as the message is handed to the workflow. The message is not redelivered if the execution fails.',
					},
				],
			},
			{
				displayName: 'Decode JSON',
				name: 'decodeJSON',
				type: 'boolean',
				default: false,
				description:
					'Whether to parse the message data as JSON. On parse failure the raw string is returned under data and jsonDecodeFailed is set to true.',
			},
			{
				displayName: 'Create Subscription If Missing',
				name: 'createSubscription',
				type: 'boolean',
				default: false,
				description:
					'Whether to create the subscription when it does not exist yet. Requires the pubsub.subscriptions.create and pubsub.topics.attachSubscription permissions (roles/pubsub.editor).',
			},
			{
				displayName: 'Topic',
				name: 'topic',
				type: 'resourceLocator',
				default: { mode: 'list', value: '' },
				required: true,
				description:
					'Topic the subscription is created on. If the subscription already exists it must belong to this topic.',
				displayOptions: {
					show: {
						createSubscription: [true],
					},
				},
				modes: [
					{
						displayName: 'From List',
						name: 'list',
						type: 'list',
						typeOptions: {
							searchListMethod: 'searchTopics',
							searchable: true,
						},
					},
					{
						displayName: 'By Name',
						name: 'id',
						type: 'string',
						placeholder: 'my-topic',
						validation: [
							{
								type: 'regex',
								properties: {
									regex:
										'^(?!goog)[A-Za-z][A-Za-z0-9._~%+\\-]{2,254}$|^projects/[^/]+/topics/[^/]+$',
									errorMessage:
										'Enter a short topic name (3-255 chars, cannot start with "goog") or a full resource path (projects/.../topics/...)',
								},
							},
						],
					},
				],
			},
			{
				displayName: 'New Subscription Settings',
				name: 'subscriptionCreateOptions',
				type: 'collection',
				placeholder: 'Add Subscription Setting',
				default: {},
				description:
					'Settings for a subscription this node creates. They are not applied to a subscription that already exists; edit that one in the Google Cloud Console.',
				displayOptions: {
					show: {
						createSubscription: [true],
					},
				},
				options: [
					{
						displayName: 'Ack Deadline (Seconds)',
						name: 'ackDeadlineSeconds',
						type: 'number',
						typeOptions: { minValue: 10, maxValue: 600 },
						default: 60,
						description:
							'Default ack deadline of the subscription. The trigger manages deadlines itself while it is running.',
					},
					{
						displayName: 'Dead-Letter Max Delivery Attempts',
						name: 'deadLetterMaxDeliveryAttempts',
						type: 'number',
						typeOptions: { minValue: 5, maxValue: 100 },
						default: 5,
						description:
							'Number of delivery attempts before Pub/Sub forwards the message to the dead-letter topic. Applied only when Dead-Letter Topic is set.',
					},
					{
						displayName: 'Dead-Letter Topic',
						name: 'deadLetterTopic',
						type: 'string',
						default: '',
						placeholder: 'my-dlq-topic',
						description:
							'Topic to forward undeliverable messages to. Short name or full projects/{project}/topics/{name}. The DLQ topic must already exist and grant roles/pubsub.publisher to the Pub/Sub service agent.',
					},
					{
						displayName: 'Enable Message Ordering',
						name: 'enableMessageOrdering',
						type: 'boolean',
						default: false,
						description:
							'Whether Pub/Sub should deliver messages with the same orderingKey in order. On an ordered subscription the trigger runs executions for the same ordering key one at a time.',
					},
					{
						displayName: 'Filter',
						name: 'filter',
						type: 'string',
						default: '',
						placeholder: 'attributes.type = "order.created"',
						description:
							'Server-side subscription filter. Only messages matching this expression are delivered. See https://cloud.google.com/pubsub/docs/filtering.',
					},
					{
						displayName: 'Message Retention (Hours)',
						name: 'messageRetentionHours',
						type: 'number',
						typeOptions: { minValue: 1, maxValue: 168 },
						default: 168,
						description:
							'How long Pub/Sub retains unacknowledged messages (1-168 hours; default 7 days)',
					},
					{
						displayName: 'Retain Acked Messages',
						name: 'retainAckedMessages',
						type: 'boolean',
						default: false,
						description:
							'Whether to keep acknowledged messages for the retention duration (useful for seeking back in time)',
					},
					{
						displayName: 'Retry Maximum Backoff (Seconds)',
						name: 'retryMaxBackoffSeconds',
						type: 'number',
						typeOptions: { minValue: 0, maxValue: 600 },
						default: 600,
						description:
							'Longest delay between redeliveries of a message that keeps failing. Used with the Exponential Backoff retry policy.',
					},
					{
						displayName: 'Retry Minimum Backoff (Seconds)',
						name: 'retryMinBackoffSeconds',
						type: 'number',
						typeOptions: { minValue: 0, maxValue: 600 },
						default: 10,
						description:
							'Delay before the first redelivery of a failed message. Used with the Exponential Backoff retry policy.',
					},
					{
						displayName: 'Retry Policy',
						name: 'retryPolicy',
						type: 'options',
						default: 'exponentialBackoff',
						description:
							'How quickly Pub/Sub redelivers a message after a nack or an expired ack deadline. New subscriptions use Exponential Backoff unless changed here.',
						options: [
							{
								name: 'Exponential Backoff',
								value: 'exponentialBackoff',
								description:
									'Wait between redeliveries, from the minimum to the maximum backoff. Keeps a message that always fails from looping.',
							},
							{
								name: 'Retry Immediately',
								value: 'immediate',
								description: 'Redeliver as soon as possible',
							},
						],
					},
				],
			},
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				options: [
					{
						displayName: 'Max Extension (Minutes)',
						name: 'maxExtensionMinutes',
						type: 'number',
						typeOptions: { minValue: 1, maxValue: 720 },
						default: 10,
						description:
							'How long the trigger keeps extending the ack deadline of a message while its execution is running. Set this comfortably higher than the slowest expected workflow run so the message is not redelivered mid-execution.',
					},
					{
						displayName: 'Max Outstanding Bytes',
						name: 'maxBytes',
						type: 'number',
						typeOptions: { minValue: 1024 },
						default: 104857600,
						description:
							'Flow control: maximum total size (bytes) of messages being processed at once',
					},
					{
						displayName: 'Max Outstanding Messages',
						name: 'maxMessages',
						type: 'number',
						typeOptions: { minValue: 1 },
						default: 100,
						description:
							'Flow control: maximum number of messages being processed at once. A message stops counting when it is acknowledged or its execution finishes.',
					},
				],
			},
		],
	};

	methods = {
		listSearch: {
			async searchTopics(
				this: ILoadOptionsFunctions,
				filter?: string,
				paginationToken?: string,
			): Promise<INodeListSearchResult> {
				return await searchTopics.call(this, filter, paginationToken);
			},
			async searchSubscriptions(
				this: ILoadOptionsFunctions,
				filter?: string,
				paginationToken?: string,
			): Promise<INodeListSearchResult> {
				return await searchSubscriptions.call(this, filter, paginationToken);
			},
		},
		credentialTest: {
			pubSubCredentialTest: testPubSubCredential,
		},
	};

	async trigger(this: ITriggerFunctions): Promise<ITriggerResponse> {
		const authentication = this.getNodeParameter(
			'authentication',
			'serviceAccount',
		) as Authentication;
		const projectIdParam = (this.getNodeParameter('projectId', '') as string).trim();
		const subscriptionName = (
			this.getNodeParameter('subscription', '', { extractValue: true }) as string
		).trim();
		const ackMode = this.getNodeParameter('ackMode', 'executionFinish') as AckMode;
		const decodeJSON = this.getNodeParameter('decodeJSON', false) as boolean;
		const createIfMissing = this.getNodeParameter('createSubscription', false) as boolean;
		const options = this.getNodeParameter('options', {}) as {
			maxExtensionMinutes?: number;
			maxMessages?: number;
			maxBytes?: number;
		};

		if (!subscriptionName) {
			throw new NodeOperationError(this.getNode(), 'Subscription is required');
		}

		let pubsub;
		let projectId: string;
		try {
			({ pubsub, projectId } = await buildPubSubAuth(this, {
				authentication,
				projectIdOverride: projectIdParam || undefined,
			}));
		} catch (error) {
			throw new NodeOperationError(
				this.getNode(),
				error instanceof Error ? error.message : String(error),
			);
		}

		const maxExtensionMinutes = options.maxExtensionMinutes ?? 10;
		const maxMessages = options.maxMessages ?? 100;
		const maxBytes = options.maxBytes ?? 100 * 1024 * 1024;
		// A test run in the editor consumes exactly one message.
		const isManualRun = this.getMode() === 'manual';

		const fullSubscriptionName = subscriptionName.startsWith('projects/')
			? subscriptionName
			: `projects/${projectId}/subscriptions/${subscriptionName}`;
		const subscriptionProjectId = fullSubscriptionName.split('/')[1];

		const subscription: Subscription = pubsub.subscription(fullSubscriptionName, {
			flowControl: {
				maxMessages: isManualRun ? 1 : maxMessages,
				maxBytes,
			},
			maxExtensionTime: Duration.from({ minutes: maxExtensionMinutes }),
			// On close, stop pulling at once but keep extending the leases of
			// messages whose executions are still running, instead of nacking them.
			closeOptions: { behavior: 'WAIT' },
		});

		// Whether same-key executions must run one at a time. Unknown (the
		// principal may not read the subscription's settings) counts as ordered:
		// serialising an ordering key that did not need it only costs parallelism.
		let orderingEnabled = true;
		try {
			let fullTopic: string | undefined;
			let created = false;
			if (createIfMissing) {
				const topic = (this.getNodeParameter('topic', '', { extractValue: true }) as string).trim();
				if (!topic) {
					throw new NodeOperationError(
						this.getNode(),
						'Topic is required to create the subscription',
					);
				}
				fullTopic = topic.startsWith('projects/') ? topic : `projects/${projectId}/topics/${topic}`;
				const createOptions = this.getNodeParameter(
					'subscriptionCreateOptions',
					{},
				) as SubscriptionSettings;
				const settings = buildCreateOptions(createOptions, subscriptionProjectId);
				try {
					await pubsub.topic(fullTopic).createSubscription(fullSubscriptionName, settings);
					created = true;
					orderingEnabled = settings.enableMessageOrdering === true;
				} catch (error) {
					if (!isAlreadyExistsError(error)) throw error;
				}
			}

			if (!created) {
				let metadata;
				try {
					[metadata] = await subscription.getMetadata();
				} catch (error) {
					if (grpcCode(error) === NOT_FOUND_CODE) {
						throw new NodeOperationError(
							this.getNode(),
							`Subscription "${fullSubscriptionName}" does not exist`,
							{ description: "Create it first, or turn on 'Create Subscription If Missing'." },
						);
					}
					// Typically PERMISSION_DENIED: roles/pubsub.subscriber may consume
					// from a subscription without being allowed to read its settings.
					this.logger.warn('Could not read Pub/Sub subscription settings', {
						subscription: fullSubscriptionName,
						error: error instanceof Error ? error.message : String(error),
					});
				}
				if (metadata) {
					if (fullTopic && metadata.topic && !isSameTopic(metadata.topic, fullTopic)) {
						throw new NodeOperationError(
							this.getNode(),
							`Subscription "${fullSubscriptionName}" already exists on topic "${metadata.topic}", not "${fullTopic}"`,
							{
								description:
									'Pick the topic this subscription belongs to, or choose a different subscription name.',
							},
						);
					}
					orderingEnabled = metadata.enableMessageOrdering === true;
				}
			}
		} catch (error) {
			await pubsub.close().catch(() => undefined);
			throw error instanceof NodeOperationError
				? error
				: new NodeOperationError(this.getNode(), error as Error);
		}

		let closing = false;
		let manualRunEmitted = false;
		// Messages handed to the workflow whose lease the trigger still holds.
		let unsettled = 0;

		const toRow = (message: Message): IDataObject => {
			const rawData = message.data.toString('utf-8');
			const row: IDataObject = {
				messageId: message.id,
				ackId: message.ackId,
				publishTime: message.publishTime?.toISOString(),
				orderingKey: message.orderingKey ?? null,
				deliveryAttempt: message.deliveryAttempt ?? null,
				attributes: message.attributes ?? {},
				data: rawData,
				_pubsub: {
					projectId: subscriptionProjectId,
					subscription: fullSubscriptionName,
				},
			};

			if (decodeJSON) {
				try {
					row.data = JSON.parse(rawData) as IDataObject;
				} catch (e) {
					row.data = rawData;
					row.jsonDecodeFailed = true;
					row.jsonDecodeErrorMessage = e instanceof Error ? e.message : String(e);
				}
			}
			return row;
		};

		/**
		 * Starts an execution for the message and resolves once that execution
		 * has finished and the trigger's lease on the message is settled. The
		 * client library keeps a message in its inventory, re-extending its ack
		 * deadline and counting it against flow control, until ack() or nack() is
		 * called on it, so every finished execution ends in one of them.
		 * Resolves false when the message was not processed successfully.
		 */
		const processMessage = async (message: Message): Promise<boolean> => {
			if (closing || (isManualRun && manualRunEmitted)) {
				message.nack();
				return false;
			}
			manualRunEmitted = true;

			if (ackMode === 'immediately') {
				message.ack();
			} else {
				unsettled++;
			}

			let run: IRun | undefined;
			try {
				const done = this.helpers.createDeferredPromise<IRun>();
				this.emit([this.helpers.returnJsonArray([toRow(message)])], undefined, done);
				run = await done.promise;
			} catch (error) {
				this.logger.warn('Pub/Sub trigger could not follow the workflow execution', {
					messageId: message.id,
					error: error instanceof Error ? error.message : String(error),
				});
			}
			if (ackMode === 'immediately') return true;

			const failed = executionFailed(run);
			if (ackMode === 'executionFinish') {
				if (failed) {
					message.nack();
				} else {
					message.ack();
				}
				unsettled--;
			} else if (!executionWaiting(run)) {
				// Acking is the Action node's job (over REST, possibly on another
				// worker). This only releases the trigger's lease: a nack on an
				// already-acknowledged message is a no-op, otherwise it makes the
				// unacknowledged message available for redelivery.
				message.nack();
				unsettled--;
			}
			// A waiting execution in manual mode keeps its lease (up to Max
			// Extension) so the Action node can still ack after the wait.
			return !failed;
		};

		// On an ordered subscription, executions for one ordering key run one at
		// a time. After a failure Pub/Sub redelivers that message and everything
		// after it for the key, so queued successors are released unprocessed.
		const orderingChains = new Map<string, Promise<boolean>>();

		const onMessage = (message: Message) => {
			const key = orderingEnabled ? message.orderingKey : undefined;
			if (!key) {
				void processMessage(message);
				return;
			}
			const previous = orderingChains.get(key) ?? Promise.resolve(true);
			const current = previous.then(async (previousOk) => {
				if (!previousOk) {
					message.nack();
					return false;
				}
				return await processMessage(message);
			});
			orderingChains.set(key, current);
			void current.then(() => {
				if (orderingChains.get(key) === current) orderingChains.delete(key);
			});
		};

		const onError = (err: Error) => {
			this.logger.error('Google Cloud Pub/Sub subscription error', { error: err });
			// In a test run the error is reported through manualTriggerFunction.
			if (closing || isManualRun) return;
			if (typeof this.emitError === 'function') {
				this.emitError(err);
			}
		};

		subscription.on('message', onMessage);
		subscription.on('error', onError);

		const shutdown = async () => {
			// The message listener stays attached until close() returns: removing
			// the last one makes the library start an un-awaited close of its own.
			try {
				await subscription.close();
			} catch (err) {
				this.logger.warn('Error while closing Pub/Sub subscription', {
					error: err instanceof Error ? err.message : String(err),
				});
			}
			subscription.removeListener('message', onMessage);
			subscription.removeListener('error', onError);
			try {
				await pubsub.close();
			} catch (err) {
				this.logger.warn('Error while closing Pub/Sub client', {
					error: err instanceof Error ? err.message : String(err),
				});
			}
		};

		const closeFunction = async () => {
			if (closing) return;
			closing = true;
			if (unsettled === 0) {
				await shutdown();
				return;
			}
			// Executions are still running. Pulling has stopped, but the client
			// must outlive this call to keep extending their leases; otherwise
			// their messages are redelivered as soon as the current lease lapses.
			// n8n awaits closeFunction before a test run's execution completes, so
			// waiting here would deadlock until Max Extension elapsed.
			void shutdown();
		};

		const manualTriggerFunction = async () => {
			await new Promise<void>((resolve, reject) => {
				const stopWaiting = () => {
					clearTimeout(timeoutHandler);
					subscription.removeListener('message', onManualMessage);
					subscription.removeListener('error', onManualError);
				};
				// n8n does not call closeFunction when this promise rejects, so the
				// subscriber has to be closed here or it would keep pulling.
				const fail = (error: Error) => {
					stopWaiting();
					void closeFunction().then(() => reject(error));
				};
				const onManualMessage = () => {
					stopWaiting();
					resolve();
				};
				const onManualError = (err: Error) => {
					fail(new NodeOperationError(this.getNode(), err));
				};
				const timeoutHandler = setTimeout(() => {
					fail(
						new NodeOperationError(
							this.getNode(),
							'No message received within 30 seconds. This timeout only applies to manual executions; active workflows listen indefinitely.',
						),
					);
				}, MANUAL_RUN_TIMEOUT_MS);
				subscription.once('message', onManualMessage);
				subscription.once('error', onManualError);
			});
		};

		return {
			closeFunction,
			manualTriggerFunction,
		};
	}
}
