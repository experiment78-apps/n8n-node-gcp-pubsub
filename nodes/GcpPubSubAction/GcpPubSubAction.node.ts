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

import { buildPubSubAuth, type Authentication } from '../shared/auth';
import { searchSubscriptions } from '../shared/listSearch';
import {
	acknowledge,
	isAckIdExpiredError,
	modifyAckDeadline,
	normaliseSubscription,
	type AcknowledgeResult,
} from '../shared/pubsubRest';

type Operation = 'ack' | 'nack' | 'extendDeadline';

interface BatchKey {
	subscription: string;
	deadline: number | null;
}

export class GCPPubSubAction implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Google Cloud Pub/Sub Action',
		name: 'gcpPubSubAction',
		icon: 'file:gcpPubSub.svg',
		group: ['transform'],
		version: 1,
		description: 'Acknowledge, nack or extend the ack deadline of a Pub/Sub message',
		defaults: {
			name: 'Google Cloud Pub/Sub Action',
		},
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		usableAsTool: true,
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
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				options: [
					{
						name: 'Acknowledge',
						value: 'ack',
						description: 'Confirm successful processing so Pub/Sub stops redelivering',
						action: 'Acknowledge a message',
					},
					{
						name: 'Nack (Return Immediately)',
						value: 'nack',
						description:
							'Set the ack deadline to 0 so Pub/Sub redelivers the message as soon as possible',
						action: 'Nack a message',
					},
					{
						name: 'Extend Ack Deadline',
						value: 'extendDeadline',
						description: 'Give the workflow more time to process the message',
						action: 'Extend the ack deadline',
					},
				],
				default: 'ack',
			},
			{
				displayName: 'Subscription',
				name: 'subscription',
				type: 'resourceLocator',
				default: { mode: 'id', value: '={{$json._pubsub.subscription}}' },
				required: true,
				description:
					'Pub/Sub subscription to operate on. Defaults to the value emitted by the trigger.',
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
										'^=.*|^[A-Za-z][A-Za-z0-9._~%+\\-]{2,254}$|^projects/[^/]+/subscriptions/[^/]+$',
									errorMessage:
										'Enter a short subscription name (3-255 chars), a full resource path (projects/.../subscriptions/...), or an expression.',
								},
							},
						],
					},
				],
			},
			{
				displayName: 'Ack ID',
				name: 'ackId',
				type: 'string',
				default: '={{$json.ackId}}',
				description: 'The ackId of the message delivery to operate on. Defaults to the value emitted by the trigger.',
				required: true,
			},
			{
				displayName: 'Ack Deadline (Seconds)',
				name: 'ackDeadlineSeconds',
				type: 'number',
				typeOptions: { minValue: 0, maxValue: 600 },
				default: 60,
				description: 'New ack deadline in seconds (0-600). Only used for Extend Ack Deadline.',
				displayOptions: {
					show: {
						operation: ['extendDeadline'],
					},
				},
			},
			{
				displayName: 'Project ID',
				name: 'projectId',
				type: 'string',
				default: '',
				description: 'Google Cloud project ID. Only needed when the Subscription field is a short name and the credential does not include a project ID.',
			},
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				options: [
					{
						displayName: 'Batch Requests',
						name: 'batchRequests',
						type: 'boolean',
						default: true,
						description:
							'Whether to group items sharing the same subscription (and deadline for Extend Ack Deadline) into a single API call',
					},
				],
			},
		],
	};

	methods = {
		listSearch: {
			async searchSubscriptions(
				this: ILoadOptionsFunctions,
				filter?: string,
				paginationToken?: string,
			): Promise<INodeListSearchResult> {
				return await searchSubscriptions.call(this, filter, paginationToken);
			},
		},
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		if (items.length === 0) {
			return [[]];
		}

		const operation = this.getNodeParameter('operation', 0) as Operation;
		const options = this.getNodeParameter('options', 0, {}) as { batchRequests?: boolean };
		const batchRequests = options.batchRequests ?? true;

		const authentication = this.getNodeParameter(
			'authentication',
			0,
			'serviceAccount',
		) as Authentication;
		const nodeProjectId = ((this.getNodeParameter('projectId', 0, '') as string) ?? '').trim();

		let authClient;
		let resolvedProjectId: string;
		let restApiBase: string;
		try {
			({
				authClient,
				projectId: resolvedProjectId,
				restApiBase,
			} = await buildPubSubAuth(this, {
				authentication,
				projectIdOverride: nodeProjectId || undefined,
			}));
		} catch (error) {
			throw new NodeOperationError(
				this.getNode(),
				error instanceof Error ? error.message : String(error),
			);
		}

		interface ItemPlan {
			index: number;
			subscription: string;
			ackId: string;
			deadline: number | null;
		}

		const plans: ItemPlan[] = [];

		for (let i = 0; i < items.length; i++) {
			try {
				const subscriptionParam =
					(this.getNodeParameter('subscription', i, '', { extractValue: true }) as string) ?? '';
				const ackId = ((this.getNodeParameter('ackId', i) as string) ?? '').trim();
				const projectIdParam = ((this.getNodeParameter('projectId', i, '') as string) ?? '').trim();
				const projectId = projectIdParam || resolvedProjectId;

				if (!ackId) {
					throw new NodeOperationError(this.getNode(), 'ackId is required', { itemIndex: i });
				}
				const subscription = normaliseSubscription(subscriptionParam, projectId);

				let deadline: number | null = null;
				if (operation === 'extendDeadline') {
					deadline = this.getNodeParameter('ackDeadlineSeconds', i, 60) as number;
					if (typeof deadline !== 'number' || Number.isNaN(deadline)) {
						throw new NodeOperationError(
							this.getNode(),
							'ackDeadlineSeconds must be a number between 0 and 600',
							{ itemIndex: i },
						);
					}
				} else if (operation === 'nack') {
					deadline = 0;
				}

				plans.push({ index: i, subscription, ackId, deadline });
			} catch (error) {
				if (this.continueOnFail()) {
					plans.push({ index: i, subscription: '', ackId: '', deadline: null });
					items[i] = {
						json: items[i].json,
						error: error as NodeOperationError,
						pairedItem: { item: i },
					};
				} else {
					throw error;
				}
			}
		}

		const groups = new Map<string, ItemPlan[]>();
		for (const plan of plans) {
			if (!plan.ackId) continue;
			const key: BatchKey = {
				subscription: plan.subscription,
				deadline: batchRequests ? plan.deadline : Number.MIN_SAFE_INTEGER + plan.index,
			};
			const groupKey = `${key.subscription}|${key.deadline}|${batchRequests ? '' : plan.index}`;
			const existing = groups.get(groupKey) ?? [];
			existing.push(plan);
			groups.set(groupKey, existing);
		}

		const output: INodeExecutionData[] = items.map((item, i) => ({
			json: { ...(item.json as IDataObject) },
			pairedItem: { item: i },
		}));

		for (const group of groups.values()) {
			const { subscription, deadline } = group[0];
			const ackIds = group.map((p) => p.ackId);
			let result: AcknowledgeResult;
			if (operation === 'ack') {
				result = await acknowledge(authClient, subscription, ackIds, restApiBase);
			} else {
				const seconds = deadline ?? 0;
				result = await modifyAckDeadline(authClient, subscription, ackIds, seconds, restApiBase);
			}

			for (const plan of group) {
				const resultJson: IDataObject = {
					subscription,
					ackId: plan.ackId,
					operation,
					ok: result.ok,
					status: result.status,
				};
				if (operation === 'extendDeadline') {
					resultJson.ackDeadlineSeconds = deadline ?? 0;
				}
				if (result.code) resultJson.code = result.code;
				if (result.message) resultJson.message = result.message;

				if (!result.ok) {
					const errMessage =
						result.message ?? `Pub/Sub request failed with status ${result.status}`;
					const hint = isAckIdExpiredError(result)
						? ' (the ackId may have expired; Pub/Sub will redeliver)'
						: '';
					const error = new NodeOperationError(this.getNode(), `${errMessage}${hint}`, {
						itemIndex: plan.index,
					});
					if (this.continueOnFail()) {
						output[plan.index] = {
							json: { ...(output[plan.index].json as IDataObject), ...resultJson },
							error,
							pairedItem: { item: plan.index },
						};
						continue;
					}
					throw error;
				}

				output[plan.index] = {
					json: { ...(output[plan.index].json as IDataObject), ...resultJson },
					pairedItem: { item: plan.index },
				};
			}
		}

		return [output];
	}
}
