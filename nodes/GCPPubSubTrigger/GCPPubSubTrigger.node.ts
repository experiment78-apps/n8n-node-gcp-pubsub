import { PubSub } from '@google-cloud/pubsub';
import { GoogleAuth } from 'google-auth-library';
import {
	IDataObject,
	INodeType,
	INodeTypeDescription,
	ITriggerFunctions,
	ITriggerResponse,
} from 'n8n-workflow';

function isAlreadyExistsError(error: unknown): boolean {
	if (error !== null && typeof error === 'object' && 'code' in error) {
		const code = (error as { code?: number }).code;
		if (code === 6) return true;
	}
	const msg = error instanceof Error ? error.message : String(error);
	return /already exists/i.test(msg);
}

export class GCPPubSubTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'GCP Pub/Sub Trigger',
		name: 'gcpPubSubTrigger',
		icon: 'file:googlePubSubTrigger.png',
		group: ['trigger'],
		version: 1,
		description: 'Listens to GCP Pub/Sub messages',
		defaults: {
			name: 'GCP Pub/Sub Trigger',
			color: '#1A73E8',
		},
		inputs: [],
		outputs: ['main'],
		credentials: [
			{
				name: 'googleApi',
				required: true,
			},
		],
		properties: [
			// Node properties which the user gets displayed and
			// can change on the node.
			{
				displayName: 'Project Id.',
				name: 'projectId',
				type: 'string',
				default: '',
				description: 'Google Cloud project id.',
				required: true,
			},
			{
				displayName: 'Topic',
				name: 'topic',
				type: 'string',
				default: '',
				description: 'Name of the Google Pub/Sub topic to listen to.',
				required: true,
			},
			{
				displayName: 'Subscription',
				name: 'subscription',
				type: 'string',
				default: '',
				description:
					"Name of the Google Pub/Sub subscription for this topic and node. It will be created if it doesn't exist.",
				required: true,
			},
			{
				displayName: 'Decode JSON',
				name: 'decodeJSON',
				type: 'boolean',
				default: false,
				description:
					'If your message data is JSON, enable this to parse it automatically. If parsing fails, the raw string is emitted in data and jsonDecodeFailed is set to true.',
			},
		],
	};

	async trigger(this: ITriggerFunctions): Promise<ITriggerResponse> {
		const credentials = await this.getCredentials('googleApi');
		if (!credentials) {
			throw new Error('Credentials are mandatory!');
		}
		const auth = new GoogleAuth({
			credentials: {
				client_email: credentials.email as string,
				private_key: credentials.privateKey as string,
			},
		});

		const projectId = this.getNodeParameter('projectId') as string;
		const topic = this.getNodeParameter('topic') as string;
		const subscriptionName = this.getNodeParameter('subscription') as string;
		const decodeJSON = this.getNodeParameter('decodeJSON') as boolean;

		const pubsub = new PubSub({ projectId, auth });

		const subscription = pubsub.topic(topic).subscription(subscriptionName);
		if ((await subscription.exists())[0] === false) {
			try {
				await subscription.create();
			} catch (error) {
				if (!isAlreadyExistsError(error)) {
					throw error;
				}
			}
		}

		const logSubscriptionError = (err: Error) => {
			const logger = (this as unknown as {
				logger?: { error: (msg: string, meta?: { error: Error }) => void };
			}).logger;
			if (logger?.error) {
				logger.error('GCP Pub/Sub subscription error', { error: err });
			} else {
				// eslint-disable-next-line no-console -- fallback when trigger context has no logger
				console.error('[GCP Pub/Sub Trigger] subscription error', err);
			}
		};

		subscription.on('error', (err: Error) => {
			logSubscriptionError(err);
		});

		subscription.on('message', (message) => {
			const decodedData = message.data.toString('utf-8');
			const row: IDataObject = {
				id: message.id,
				data: decodedData,
				attributes: message.attributes,
			};

			if (decodeJSON) {
				try {
					row.data = JSON.parse(decodedData) as IDataObject[keyof IDataObject];
				} catch (e) {
					row.data = decodedData;
					row.jsonDecodeFailed = true;
					row.jsonDecodeErrorMessage = e instanceof Error ? e.message : String(e);
				}
			}

			this.emit([this.helpers.returnJsonArray([row])]);
			message.ack();
		});

		// The "closeFunction" function gets called by n8n whenever
		// the workflow gets deactivated and can so clean up.
		async function closeFunction() {
			await subscription.close();
		}

		// The "manualTriggerFunction" function gets called by n8n
		// when a user is in the workflow editor and starts the
		// workflow manually.
		// for Pub/Sub it doesn't make much sense to wait here but
		// for a new user who doesn't know how this works, it's better to wait and show a respective info message
		async function manualTriggerFunction() {
			await new Promise<void>((resolve, reject) => {
				const timeoutHandler = setTimeout(() => {
					reject(
						new Error(
							'Aborted, no message received within 30secs. This 30sec timeout is only set for "manually triggered execution". Active Workflows will listen indefinitely.',
						),
					);
				}, 30000);
				subscription.once('message', () => {
					clearTimeout(timeoutHandler);
					resolve();
				});
			});
		}

		return {
			closeFunction,
			manualTriggerFunction,
		};
	}
}
