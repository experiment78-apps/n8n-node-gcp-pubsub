import type { CreateSubscriptionOptions, Message, Subscription } from '@google-cloud/pubsub';
import { Duration } from '@google-cloud/pubsub';
import type {
	IDataObject,
	ILoadOptionsFunctions,
	INodeListSearchResult,
	INodeType,
	INodeTypeDescription,
	ITriggerFunctions,
	ITriggerResponse,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import { buildPubSubAuth, type Authentication } from '../../shared/auth';
import { testPubSubCredential } from '../../shared/credentialTest';
import { searchSubscriptions, searchTopics } from '../../shared/listSearch';

const ALREADY_EXISTS_CODE = 6;

function isAlreadyExistsError(error: unknown): boolean {
	if (error !== null && typeof error === 'object' && 'code' in error) {
		const code = (error as { code?: number }).code;
		if (code === ALREADY_EXISTS_CODE) return true;
	}
	const msg = error instanceof Error ? error.message : String(error);
	return /already exists/i.test(msg);
}

// eslint-disable-next-line @n8n/community-nodes/node-usable-as-tool -- triggers cannot be used as tools; usableAsTool only accepts `true`.
export class GcpPubSubTriggerV1 implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Google Cloud Pub/Sub Trigger',
		name: 'gcpPubSubTrigger',
		icon: 'file:gcpPubSub.svg',
		group: ['trigger'],
		version: 1,
		description:
			'Starts a workflow when a message is received on a Google Cloud Pub/Sub topic',
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
				displayName: 'Topic',
				name: 'topic',
				type: 'resourceLocator',
				default: { mode: 'list', value: '' },
				required: true,
				description:
					'Pub/Sub topic to listen to. Pick from the list or type a short name.',
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
									regex: '^(?!goog)[A-Za-z][A-Za-z0-9._~%+\\-]{2,254}$|^projects/[^/]+/topics/[^/]+$',
									errorMessage:
										'Enter a short topic name (3-255 chars, cannot start with "goog") or a full resource path (projects/.../topics/...)',
								},
							},
						],
					},
				],
			},
			{
				displayName: 'Subscription',
				name: 'subscription',
				type: 'resourceLocator',
				default: { mode: 'list', value: '' },
				required: true,
				description:
					"Pub/Sub subscription. Pick an existing one, or type a new name with 'Auto-Create Subscription' on to create it on the topic.",
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
									regex: '^(?!goog)[A-Za-z][A-Za-z0-9._~%+\\-]{2,254}$|^projects/[^/]+/subscriptions/[^/]+$',
									errorMessage:
										'Enter a short subscription name (3-255 chars, cannot start with "goog") or a full resource path (projects/.../subscriptions/...)',
								},
							},
						],
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
				displayName: 'Subscription Settings (On Create)',
				name: 'subscriptionCreateOptions',
				type: 'collection',
				placeholder: 'Add Subscription Setting',
				default: {},
				description:
					'Settings applied when auto-creating a subscription. Ignored if the subscription already exists; change them via the Google Cloud Console to edit a live subscription.',
				options: [
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
							'Whether Pub/Sub should deliver messages with the same orderingKey in order. Also makes the subscriber honour ordering.',
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
						displayName: 'Ack Deadline (Seconds)',
						name: 'ackDeadlineSeconds',
						type: 'number',
						typeOptions: { minValue: 10, maxValue: 600 },
						default: 60,
						description:
							'Ack deadline applied when a subscription is auto-created. Ignored when the subscription already exists.',
					},
					{
						displayName: 'Auto-Create Subscription',
						name: 'autoCreateSubscription',
						type: 'boolean',
						default: true,
						description:
							'Whether to create the subscription on the topic if it does not exist. Requires pubsub.subscriptions.create permission.',
					},
					{
						displayName: 'Max Extension (Minutes)',
						name: 'maxExtensionMinutes',
						type: 'number',
						typeOptions: { minValue: 1, maxValue: 720 },
						default: 10,
						description:
							'How long the client library will keep extending the ack deadline while waiting for the ack. Set this comfortably higher than the slowest expected workflow run so the ackId stays valid until the action node acks or nacks.',
					},
					{
						displayName: 'Max Outstanding Bytes',
						name: 'maxBytes',
						type: 'number',
						typeOptions: { minValue: 1024 },
						default: 104857600,
						description:
							'Flow control: maximum total size (bytes) of unacknowledged messages held in memory at once',
					},
					{
						displayName: 'Max Outstanding Messages',
						name: 'maxMessages',
						type: 'number',
						typeOptions: { minValue: 1 },
						default: 100,
						description:
							'Flow control: maximum number of unacknowledged messages held in memory at once',
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
		const topic = (this.getNodeParameter('topic', '', { extractValue: true }) as string).trim();
		const subscriptionName = (
			this.getNodeParameter('subscription', '', { extractValue: true }) as string
		).trim();
		const decodeJSON = this.getNodeParameter('decodeJSON') as boolean;
		const options = this.getNodeParameter('options', {}) as {
			autoCreateSubscription?: boolean;
			ackDeadlineSeconds?: number;
			maxExtensionMinutes?: number;
			maxMessages?: number;
			maxBytes?: number;
		};
		const createOptions = this.getNodeParameter('subscriptionCreateOptions', {}) as {
			filter?: string;
			enableMessageOrdering?: boolean;
			retainAckedMessages?: boolean;
			messageRetentionHours?: number;
			deadLetterTopic?: string;
			deadLetterMaxDeliveryAttempts?: number;
		};

		if (!topic) {
			throw new NodeOperationError(this.getNode(), 'Topic is required');
		}
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

		const autoCreate = options.autoCreateSubscription ?? true;
		const ackDeadlineSeconds = options.ackDeadlineSeconds ?? 60;
		const maxExtensionMinutes = options.maxExtensionMinutes ?? 10;
		const maxMessages = options.maxMessages ?? 100;
		const maxBytes = options.maxBytes ?? 100 * 1024 * 1024;
		const enableMessageOrdering = createOptions.enableMessageOrdering === true;

		const shortTopic = topic.startsWith('projects/')
			? topic.split('/').pop() ?? topic
			: topic;
		const shortSubscription = subscriptionName.startsWith('projects/')
			? subscriptionName.split('/').pop() ?? subscriptionName
			: subscriptionName;

		if (autoCreate) {
			const subscriptionCreateOptions: CreateSubscriptionOptions = {
				ackDeadlineSeconds,
			};
			if (createOptions.filter && createOptions.filter.trim() !== '') {
				subscriptionCreateOptions.filter = createOptions.filter.trim();
			}
			if (enableMessageOrdering) {
				subscriptionCreateOptions.enableMessageOrdering = true;
			}
			if (createOptions.retainAckedMessages === true) {
				subscriptionCreateOptions.retainAckedMessages = true;
			}
			if (typeof createOptions.messageRetentionHours === 'number') {
				subscriptionCreateOptions.messageRetentionDuration = Duration.from({
					minutes: createOptions.messageRetentionHours * 60,
				});
			}
			const dlqRaw = createOptions.deadLetterTopic?.trim();
			if (dlqRaw) {
				const dlqFullName = dlqRaw.startsWith('projects/')
					? dlqRaw
					: `projects/${projectId}/topics/${dlqRaw}`;
				subscriptionCreateOptions.deadLetterPolicy = {
					deadLetterTopic: dlqFullName,
					maxDeliveryAttempts: createOptions.deadLetterMaxDeliveryAttempts ?? 5,
				};
			}

			try {
				await pubsub
					.topic(shortTopic)
					.createSubscription(shortSubscription, subscriptionCreateOptions);
			} catch (error) {
				if (!isAlreadyExistsError(error)) {
					throw error;
				}
			}
		}

		const subscription: Subscription = pubsub.subscription(shortSubscription, {
			flowControl: {
				maxMessages,
				maxBytes,
			},
			maxExtensionTime: Duration.from({ minutes: maxExtensionMinutes }),
			...(enableMessageOrdering ? { enableMessageOrdering: true } : {}),
		});

		const fullSubscriptionName = `projects/${projectId}/subscriptions/${shortSubscription}`;

		const onMessage = (message: Message) => {
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
					projectId,
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

			this.emit([this.helpers.returnJsonArray([row])]);
		};

		const onError = (err: Error) => {
			this.logger.error('Google Cloud Pub/Sub subscription error', { error: err });
			if (typeof this.emitError === 'function') {
				this.emitError(err);
			}
		};

		subscription.on('message', onMessage);
		subscription.on('error', onError);

		const closeFunction = async () => {
			subscription.removeListener('message', onMessage);
			subscription.removeListener('error', onError);
			try {
				await subscription.close();
			} catch (err) {
				this.logger.warn('Error while closing Pub/Sub subscription', {
					error: err instanceof Error ? err.message : String(err),
				});
			}
			try {
				await pubsub.close();
			} catch (err) {
				this.logger.warn('Error while closing Pub/Sub client', {
					error: err instanceof Error ? err.message : String(err),
				});
			}
		};

		const manualTriggerFunction = async () => {
			await new Promise<void>((resolve, reject) => {
				const onManualMessage = () => {
					clearTimeout(timeoutHandler);
					resolve();
				};
				const timeoutHandler = setTimeout(() => {
					subscription.removeListener('message', onManualMessage);
					reject(
						new NodeOperationError(
							this.getNode(),
							'No message received within 30 seconds. This timeout only applies to manual executions; active workflows listen indefinitely.',
						),
					);
				}, 30000);
				subscription.once('message', onManualMessage);
			});
		};

		return {
			closeFunction,
			manualTriggerFunction,
		};
	}
}
