import type { Message, Subscription } from '@google-cloud/pubsub';
import { Duration } from '@google-cloud/pubsub';
import type {
	IDataObject,
	INodeType,
	INodeTypeDescription,
	ITriggerFunctions,
	ITriggerResponse,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import { buildPubSubAuth, type Authentication } from '../shared/auth';

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
export class GCPPubSubTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Google Cloud Pub/Sub Trigger',
		name: 'gcpPubSubTrigger',
		icon: 'file:gcpPubSub.svg',
		group: ['trigger'],
		version: 1,
		description: 'Starts a workflow when a message is received on a Google Cloud Pub/Sub topic',
		defaults: {
			name: 'Google Cloud Pub/Sub Trigger',
		},
		inputs: [],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: 'gcpPubSubApi',
				required: true,
				displayOptions: {
					show: {
						authentication: ['serviceAccount'],
					},
				},
			},
			{
				name: 'gcpPubSubOAuth2Api',
				required: true,
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
						description: 'Service account key, service account JSON, or Application Default Credentials',
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
				description: 'Google Cloud project ID. If left empty, the project will be inferred from the credential.',
			},
			{
				displayName: 'Topic',
				name: 'topic',
				type: 'string',
				default: '',
				placeholder: 'my-topic',
				description: 'Name of the Pub/Sub topic to listen to (short name, not a full resource path)',
				required: true,
			},
			{
				displayName: 'Subscription',
				name: 'subscription',
				type: 'string',
				default: '',
				placeholder: 'my-subscription',
				description: 'Name of the Pub/Sub subscription (short name). If \'Auto-Create Subscription\' is enabled, it will be created on the topic if missing.',
				required: true,
			},
			{
				displayName: 'Decode JSON',
				name: 'decodeJSON',
				type: 'boolean',
				default: false,
				description: 'Whether to parse the message data as JSON. On parse failure the raw string is returned under data and jsonDecodeFailed is set to true.',
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
						description: 'Ack deadline applied when a subscription is auto-created. Ignored when the subscription already exists.',
					},
					{
						displayName: 'Auto-Create Subscription',
						name: 'autoCreateSubscription',
						type: 'boolean',
						default: true,
						description: 'Whether to create the subscription on the topic if it does not exist. Requires pubsub.subscriptions.create permission.',
					},
					{
						displayName: 'Max Extension (Minutes)',
						name: 'maxExtensionMinutes',
						type: 'number',
						typeOptions: { minValue: 1, maxValue: 720 },
						default: 10,
						description: 'How long the client library will keep extending the ack deadline while waiting for the ack. Set this comfortably higher than the slowest expected workflow run so the ackId stays valid until the action node acks or nacks.',
					},
					{
						displayName: 'Max Outstanding Bytes',
						name: 'maxBytes',
						type: 'number',
						typeOptions: { minValue: 1024 },
						default: 104857600,
						description: 'Flow control: maximum total size (bytes) of unacknowledged messages held in memory at once',
					},
					{
						displayName: 'Max Outstanding Messages',
						name: 'maxMessages',
						type: 'number',
						typeOptions: { minValue: 1 },
						default: 100,
						description: 'Flow control: maximum number of unacknowledged messages held in memory at once',
					},
				],
			},
		],
	};

	async trigger(this: ITriggerFunctions): Promise<ITriggerResponse> {
		const authentication = this.getNodeParameter(
			'authentication',
			'serviceAccount',
		) as Authentication;
		const projectIdParam = (this.getNodeParameter('projectId', '') as string).trim();
		const topic = (this.getNodeParameter('topic') as string).trim();
		const subscriptionName = (this.getNodeParameter('subscription') as string).trim();
		const decodeJSON = this.getNodeParameter('decodeJSON') as boolean;
		const options = this.getNodeParameter('options', {}) as {
			autoCreateSubscription?: boolean;
			ackDeadlineSeconds?: number;
			maxExtensionMinutes?: number;
			maxMessages?: number;
			maxBytes?: number;
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

		if (autoCreate) {
			try {
				await pubsub
					.topic(topic)
					.createSubscription(subscriptionName, { ackDeadlineSeconds });
			} catch (error) {
				if (!isAlreadyExistsError(error)) {
					throw error;
				}
			}
		}

		const subscription: Subscription = pubsub.subscription(subscriptionName, {
			flowControl: {
				maxMessages,
				maxBytes,
			},
			maxExtensionTime: Duration.from({ minutes: maxExtensionMinutes }),
		});

		const fullSubscriptionName = `projects/${projectId}/subscriptions/${subscriptionName}`;

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
