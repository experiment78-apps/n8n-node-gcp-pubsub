import type { Attributes, Topic } from '@google-cloud/pubsub';
import type {
	IDataObject,
	IExecuteFunctions,
	ILoadOptionsFunctions,
	INodeExecutionData,
	INodeListSearchResult,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import { buildPubSubAuth, type Authentication } from '../../shared/auth';
import { testPubSubCredential } from '../../shared/credentialTest';
import { searchTopics } from '../../shared/listSearch';

type DataMode = 'json' | 'text' | 'binary';

interface AttributeEntry {
	key: string;
	value: unknown;
}

/** Text form of an expression result: strings as-is, objects as JSON. */
function toText(value: unknown): string {
	if (typeof value === 'string') return value;
	if (value === null || value === undefined) return '';
	return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

/**
 * Decodes standard or URL-safe base64, with or without padding. Buffer.from
 * silently drops characters it does not recognise, so the input is validated
 * first; returns undefined when it is not base64.
 */
function decodeBase64(value: string): Buffer | undefined {
	const compact = value.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
	const unpadded = compact.replace(/={1,2}$/, '');
	if (!/^[A-Za-z0-9+/]*$/.test(unpadded) || unpadded.length % 4 === 1) return undefined;
	return Buffer.from(unpadded, 'base64');
}

export class GcpPubSubPublishV1 implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Google Cloud Pub/Sub Publish',
		name: 'gcpPubSubPublish',
		icon: 'file:gcpPubSub.svg',
		group: ['output'],
		version: 1,
		description: 'Publishes messages to a Google Cloud Pub/Sub topic',
		defaults: {
			name: 'Google Cloud Pub/Sub Publish',
		},
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		usableAsTool: true,
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
					'Google Cloud project ID. Only needed when the Topic is a short name and the credential does not include a project ID.',
			},
			{
				displayName: 'Topic',
				name: 'topic',
				type: 'resourceLocator',
				default: { mode: 'list', value: '' },
				required: true,
				description: 'Pub/Sub topic to publish to. Pick from the list or type a short name.',
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
				displayName: 'Data Mode',
				name: 'dataMode',
				type: 'options',
				default: 'json',
				description: 'How the Data field is interpreted before being sent to Pub/Sub',
				options: [
					{
						name: 'JSON (Auto-Serialize)',
						value: 'json',
						description:
							'Serialize the expression result as JSON. Objects and arrays are stringified; strings are passed through untouched.',
					},
					{
						name: 'Text',
						value: 'text',
						description: 'Send the value as a UTF-8 string. Objects and arrays are stringified as JSON.',
					},
					{
						name: 'Binary (Base64)',
						value: 'binary',
						description:
							'Decode the value as base64 (standard or URL-safe) and send the resulting bytes. Fails if the value is not valid base64.',
					},
				],
			},
			{
				displayName: 'Data',
				name: 'data',
				type: 'string',
				typeOptions: {
					rows: 4,
				},
				default: '={{ $json }}',
				description:
					'Payload to publish. Supports expressions. Interpreted according to Data Mode.',
			},
			{
				displayName: 'Attributes',
				name: 'attributes',
				placeholder: 'Add Attribute',
				type: 'fixedCollection',
				typeOptions: {
					multipleValues: true,
				},
				default: {},
				description:
					'Optional key/value pairs attached to each message. Values are sent as strings. Pub/Sub filters can match on attributes.',
				options: [
					{
						name: 'attribute',
						displayName: 'Attribute',
						values: [
							{
								displayName: 'Key',
								name: 'key',
								type: 'string',
								default: '',
							},
							{
								displayName: 'Value',
								name: 'value',
								type: 'string',
								default: '',
							},
						],
					},
				],
			},
			{
				displayName: 'Ordering Key',
				name: 'orderingKey',
				type: 'string',
				default: '',
				description:
					'Optional ordering key. Messages with the same ordering key are delivered in order to subscriptions that have message ordering enabled.',
			},
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				options: [
					{
						displayName: 'Batch Max Messages',
						name: 'batchingMaxMessages',
						type: 'number',
						typeOptions: { minValue: 1 },
						default: 100,
						description: 'Maximum messages buffered before a batch is sent',
					},
					{
						displayName: 'Batch Max Bytes',
						name: 'batchingMaxBytes',
						type: 'number',
						typeOptions: { minValue: 1024 },
						default: 1048576,
						description:
							'Maximum total payload bytes buffered before a batch is sent (default 1 MiB)',
					},
					{
						displayName: 'Batch Max Milliseconds',
						name: 'batchingMaxMilliseconds',
						type: 'number',
						typeOptions: { minValue: 0 },
						default: 10,
						description: 'Maximum time to wait before sending a partial batch',
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
		},
		credentialTest: {
			pubSubCredentialTest: testPubSubCredential,
		},
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		if (items.length === 0) {
			return [[]];
		}

		const authentication = this.getNodeParameter(
			'authentication',
			0,
			'serviceAccount',
		) as Authentication;
		const projectIdOverride = ((this.getNodeParameter('projectId', 0, '') as string) ?? '').trim();
		const options = this.getNodeParameter('options', 0, {}) as {
			batchingMaxMessages?: number;
			batchingMaxBytes?: number;
			batchingMaxMilliseconds?: number;
		};

		let pubsub;
		let projectId: string;
		try {
			({ pubsub, projectId } = await buildPubSubAuth(this, {
				authentication,
				projectIdOverride: projectIdOverride || undefined,
			}));
		} catch (error) {
			throw new NodeOperationError(
				this.getNode(),
				error instanceof Error ? error.message : String(error),
			);
		}

		const topics = new Map<string, Topic>();
		const topicNames: Array<string | undefined> = [];
		const output: INodeExecutionData[] = [];

		try {
			const publishes = items.map(async (_item, i) => {
				const topicName = (
					(this.getNodeParameter('topic', i, '', { extractValue: true }) as string) ?? ''
				).trim();
				if (!topicName) {
					throw new NodeOperationError(this.getNode(), 'Topic is required', { itemIndex: i });
				}
				const itemProjectId =
					((this.getNodeParameter('projectId', i, '') as string) ?? '').trim() || projectId;
				const fullTopic = topicName.startsWith('projects/')
					? topicName
					: `projects/${itemProjectId}/topics/${topicName}`;
				topicNames[i] = fullTopic;
				let topic = topics.get(fullTopic);
				if (!topic) {
					topic = pubsub.topic(fullTopic, {
						batching: {
							maxMessages: options.batchingMaxMessages ?? 100,
							maxBytes: options.batchingMaxBytes ?? 1024 * 1024,
							maxMilliseconds: options.batchingMaxMilliseconds ?? 10,
						},
					});
					topics.set(fullTopic, topic);
				}
				const dataMode = this.getNodeParameter('dataMode', i, 'json') as DataMode;
				const rawData = this.getNodeParameter('data', i, '');
				const attributesParam = this.getNodeParameter('attributes', i, {}) as {
					attribute?: AttributeEntry[];
				};
				const orderingKey = ((this.getNodeParameter('orderingKey', i, '') as string) ?? '').trim();

				let buffer: Buffer;
				if (dataMode === 'binary') {
					const decoded = typeof rawData === 'string' ? decodeBase64(rawData) : undefined;
					if (!decoded) {
						throw new NodeOperationError(
							this.getNode(),
							'Data is not valid base64. Binary mode expects a base64-encoded string.',
							{ itemIndex: i },
						);
					}
					buffer = decoded;
				} else if (dataMode === 'text') {
					buffer = Buffer.from(toText(rawData), 'utf-8');
				} else {
					const serialized =
						typeof rawData === 'string' ? rawData : JSON.stringify(rawData ?? null);
					buffer = Buffer.from(serialized, 'utf-8');
				}

				const attributes: Attributes = {};
				for (const entry of attributesParam.attribute ?? []) {
					if (entry?.key) {
						attributes[entry.key] = toText(entry.value);
					}
				}

				const messageId = await topic.publishMessage({
					data: buffer,
					attributes,
					...(orderingKey ? { orderingKey } : {}),
				});

				return { topic: fullTopic, messageId };
			});

			const results = await Promise.allSettled(publishes);

			for (let i = 0; i < items.length; i++) {
				const res = results[i];
				const baseJson = items[i].json as IDataObject;
				if (res.status === 'fulfilled') {
					output.push({
						json: {
							...baseJson,
							_publish: {
								topic: res.value.topic,
								messageId: res.value.messageId,
								ok: true,
							},
						},
						pairedItem: { item: i },
					});
				} else {
					const error = res.reason instanceof Error ? res.reason : new Error(String(res.reason));
					if (this.continueOnFail()) {
						output.push({
							json: {
								...baseJson,
								_publish: {
									topic: topicNames[i] ?? null,
									ok: false,
									message: error.message,
								},
							},
							error: new NodeOperationError(this.getNode(), error, { itemIndex: i }),
							pairedItem: { item: i },
						});
					} else {
						throw new NodeOperationError(this.getNode(), error, { itemIndex: i });
					}
				}
			}
		} finally {
			for (const topic of topics.values()) {
				try {
					await topic.flush();
				} catch (err) {
					this.logger.warn('Error while flushing Pub/Sub publisher', {
						error: err instanceof Error ? err.message : String(err),
					});
				}
			}
			try {
				await pubsub.close();
			} catch (err) {
				this.logger.warn('Error while closing Pub/Sub client', {
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}

		return [output];
	}
}
