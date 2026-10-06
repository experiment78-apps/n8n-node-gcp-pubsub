import { EventEmitter } from 'events';
import type { IExecuteFunctions, INode, ITriggerFunctions } from 'n8n-workflow';

import { GcpPubSubActionV1 } from '../../GcpPubSubAction/v1/GcpPubSubActionV1.node';
import { GcpPubSubPublishV1 } from '../../GcpPubSubPublish/v1/GcpPubSubPublishV1.node';
import { GcpPubSubTriggerV1 } from '../../GcpPubSubTrigger/v1/GcpPubSubTriggerV1.node';
import { buildPubSubAuth, type PubSubAuthBundle } from '../auth';

jest.mock('../auth', () => ({ buildPubSubAuth: jest.fn() }));

const node: INode = {
	id: 'pubsub-test',
	name: 'Pub/Sub test',
	type: 'test',
	typeVersion: 1,
	position: [0, 0],
	parameters: {},
};

function executeContext(parameters: Array<Record<string, unknown>>, continueOnFail = true) {
	const items = parameters.map((_, index) => ({ json: { index } }));
	return {
		getInputData: () => items,
		getNode: () => node,
		getNodeParameter: (name: string, index: number, fallback?: unknown) =>
			parameters[index][name] ?? fallback,
		continueOnFail: () => continueOnFail,
		logger: { warn: jest.fn() },
	} as unknown as IExecuteFunctions;
}

function mockAuth(bundle: Record<string, unknown>) {
	jest.mocked(buildPubSubAuth).mockResolvedValue({
		projectId: 'home',
		restApiBase: 'https://example.invalid/v1',
		...bundle,
	} as unknown as PubSubAuthBundle);
}

describe('action validation errors', () => {
	it.each([
		{ ackId: '', subscription: 'sub' },
		{ ackId: 'ack', subscription: '' },
		{
			ackId: 'ack',
			subscription: 'sub',
			operation: 'extendDeadline',
			ackDeadlineSeconds: 'invalid',
		},
	])('returns a visible error and continues processing valid items (%j)', async (invalid) => {
		const request = jest.fn().mockResolvedValue({ status: 200, data: {} });
		mockAuth({ authClient: { request } });
		const ctx = executeContext([
			{ operation: 'ack', ...invalid },
			{ operation: 'ack', ackId: 'valid-ack', subscription: 'sub' },
		]);
		const [output] = await new GcpPubSubActionV1().execute.call(ctx);
		expect(output[0].error).toBeDefined();
		expect(output[0].json).toMatchObject({
			index: 0,
			ok: false,
			status: 0,
			message: expect.any(String),
		});
		expect(output[0].pairedItem).toEqual({ item: 0 });
		expect(output[1].json.ok).toBe(true);
		expect(request).toHaveBeenCalledTimes(1);
		expect(request.mock.calls[0][0].data.ackIds).toEqual(['valid-ack']);
		expect(ctx.getInputData()[0]).toEqual({ json: { index: 0 } });
	});

	it('throws validation errors when Continue on Fail is disabled', async () => {
		const request = jest.fn();
		mockAuth({ authClient: { request } });
		await expect(
			new GcpPubSubActionV1().execute.call(
				executeContext([{ operation: 'ack', ackId: '', subscription: 'sub' }], false),
			),
		).rejects.toThrow('ackId is required');
		expect(request).not.toHaveBeenCalled();
	});
});

describe('publisher destinations', () => {
	function publisher() {
		const clients = new Map<string, { publishMessage: jest.Mock; flush: jest.Mock }>();
		const topic = jest.fn((name: string) => {
			const client = {
				publishMessage: jest.fn().mockResolvedValue(`message-${name}`),
				flush: jest.fn().mockResolvedValue(undefined),
			};
			clients.set(name, client);
			return client;
		});
		const close = jest.fn().mockResolvedValue(undefined);
		mockAuth({ pubsub: { topic, close } });
		return { clients, topic, close };
	}

	it('resolves topic and project per item and shares a publisher for each canonical destination', async () => {
		const { clients, topic, close } = publisher();
		const [output] = await new GcpPubSubPublishV1().execute.call(
			executeContext([
				{ topic: 'alpha', data: 'first' },
				{ topic: 'projects/other/topics/beta', data: 'second' },
				{ topic: 'projects/home/topics/alpha', data: 'third' },
				{ topic: 'alpha', projectId: 'tenant', data: 'fourth' },
			]),
		);
		expect(topic).toHaveBeenCalledTimes(3);
		expect(clients.get('projects/home/topics/alpha')?.publishMessage).toHaveBeenCalledTimes(2);
		expect(output.map((item) => item.json._publish)).toEqual([
			{
				topic: 'projects/home/topics/alpha',
				messageId: 'message-projects/home/topics/alpha',
				ok: true,
			},
			{
				topic: 'projects/other/topics/beta',
				messageId: 'message-projects/other/topics/beta',
				ok: true,
			},
			{
				topic: 'projects/home/topics/alpha',
				messageId: 'message-projects/home/topics/alpha',
				ok: true,
			},
			{
				topic: 'projects/tenant/topics/alpha',
				messageId: 'message-projects/tenant/topics/alpha',
				ok: true,
			},
		]);
		for (const client of clients.values()) expect(client.flush).toHaveBeenCalledTimes(1);
		expect(close).toHaveBeenCalledTimes(1);
	});

	it('isolates an invalid destination while publishing valid items', async () => {
		const { topic, close } = publisher();
		const [output] = await new GcpPubSubPublishV1().execute.call(
			executeContext([{ topic: '' }, { topic: 'valid', data: 'payload' }]),
		);
		expect(output[0].error?.message).toContain('Topic is required');
		expect(output[0].json._publish).toMatchObject({ ok: false, topic: null });
		expect(output[1].json._publish).toMatchObject({
			ok: true,
			topic: 'projects/home/topics/valid',
		});
		expect(topic).toHaveBeenCalledTimes(1);
		expect(close).toHaveBeenCalledTimes(1);
	});
});

describe('trigger resource paths', () => {
	it.each([true, false])(
		'preserves cross-project paths with auto-create=%s',
		async (autoCreate) => {
			const subscription = Object.assign(new EventEmitter(), {
				close: jest.fn().mockResolvedValue(undefined),
			});
			const createSubscription = jest.fn().mockResolvedValue([subscription]);
			const pubsub = {
				topic: jest.fn().mockReturnValue({ createSubscription }),
				subscription: jest.fn().mockReturnValue(subscription),
				close: jest.fn().mockResolvedValue(undefined),
			};
			mockAuth({ pubsub });
			const emit = jest.fn();
			const parameters: Record<string, unknown> = {
				topic: 'projects/topic-project/topics/topic',
				subscription: 'projects/sub-project/subscriptions/sub',
				decodeJSON: false,
				options: { autoCreateSubscription: autoCreate },
				subscriptionCreateOptions: { deadLetterTopic: 'dead-letter' },
			};
			const ctx = {
				getNode: () => node,
				getNodeParameter: (name: string, fallback?: unknown) => parameters[name] ?? fallback,
				emit,
				helpers: { returnJsonArray: (rows: unknown[]) => rows.map((json) => ({ json })) },
				logger: { warn: jest.fn(), error: jest.fn() },
			} as unknown as ITriggerFunctions;
			const response = await new GcpPubSubTriggerV1().trigger.call(ctx);
			expect(pubsub.subscription).toHaveBeenCalledWith(
				'projects/sub-project/subscriptions/sub',
				expect.any(Object),
			);
			if (autoCreate) {
				expect(pubsub.topic).toHaveBeenCalledWith('projects/topic-project/topics/topic');
				expect(createSubscription).toHaveBeenCalledWith(
					'projects/sub-project/subscriptions/sub',
					expect.objectContaining({
						deadLetterPolicy: {
							deadLetterTopic: 'projects/sub-project/topics/dead-letter',
							maxDeliveryAttempts: 5,
						},
					}),
				);
			} else {
				expect(createSubscription).not.toHaveBeenCalled();
			}
			subscription.emit('message', { id: 'message', ackId: 'ack', data: Buffer.from('payload') });
			expect(emit.mock.calls[0][0][0][0].json._pubsub).toEqual({
				projectId: 'sub-project',
				subscription: 'projects/sub-project/subscriptions/sub',
			});
			await response.closeFunction?.();
			expect(pubsub.close).toHaveBeenCalledTimes(1);
		},
	);
});
