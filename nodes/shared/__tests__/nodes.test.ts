import { EventEmitter } from 'events';
import type {
	IDeferredPromise,
	IExecuteFunctions,
	INode,
	IRun,
	ITriggerFunctions,
} from 'n8n-workflow';
import { createDeferredPromise } from 'n8n-workflow';

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
		{ ackId: 'ack', subscription: 'sub', operation: 'extendDeadline', ackDeadlineSeconds: 601 },
		{ ackId: 'ack', subscription: 'sub', operation: 'extendDeadline', ackDeadlineSeconds: 1.5 },
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

describe('action batching', () => {
	it('splits a large batch into requests of at most 1000 ackIds', async () => {
		const request = jest.fn().mockResolvedValue({ status: 200, data: {} });
		mockAuth({ authClient: { request } });
		const parameters = Array.from({ length: 2500 }, (_, i) => ({
			operation: 'ack',
			ackId: `ack-${i}`,
			subscription: 'sub',
		}));
		const [output] = await new GcpPubSubActionV1().execute.call(executeContext(parameters));
		expect(request.mock.calls.map(([call]) => call.data.ackIds.length)).toEqual([1000, 1000, 500]);
		expect(output).toHaveLength(2500);
		expect(output.every((item) => item.json.ok === true)).toBe(true);
		expect(output[2499].json.ackId).toBe('ack-2499');
	});

	it('reports a failed chunk only on the items it contained', async () => {
		const request = jest
			.fn()
			.mockResolvedValueOnce({ status: 200, data: {} })
			.mockResolvedValueOnce({ status: 400, data: { error: { message: 'bad chunk' } } });
		mockAuth({ authClient: { request } });
		const parameters = Array.from({ length: 1001 }, (_, i) => ({
			operation: 'ack',
			ackId: `ack-${i}`,
			subscription: 'sub',
		}));
		const [output] = await new GcpPubSubActionV1().execute.call(executeContext(parameters));
		expect(output[999].json.ok).toBe(true);
		expect(output[1000].json.ok).toBe(false);
		expect(output[1000].error?.message).toContain('bad chunk');
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

describe('publisher payload encoding', () => {
	function publishMessage() {
		const publish = jest.fn().mockResolvedValue('id');
		mockAuth({
			pubsub: {
				topic: () => ({ publishMessage: publish, flush: jest.fn().mockResolvedValue(undefined) }),
				close: jest.fn().mockResolvedValue(undefined),
			},
		});
		return publish;
	}

	it('stringifies objects in text mode instead of sending [object Object]', async () => {
		const publish = publishMessage();
		await new GcpPubSubPublishV1().execute.call(
			executeContext([{ topic: 't', dataMode: 'text', data: { a: 1 } }]),
		);
		expect(publish.mock.calls[0][0].data.toString()).toBe('{"a":1}');
	});

	it.each(['aGVsbG8=', 'aGVsbG8', ' aGVs\nbG8= '])('decodes base64 %j', async (data) => {
		const publish = publishMessage();
		await new GcpPubSubPublishV1().execute.call(
			executeContext([{ topic: 't', dataMode: 'binary', data }]),
		);
		expect(publish.mock.calls[0][0].data.toString()).toBe('hello');
	});

	it('decodes URL-safe base64', async () => {
		const publish = publishMessage();
		await new GcpPubSubPublishV1().execute.call(
			executeContext([{ topic: 't', dataMode: 'binary', data: '-_8' }]),
		);
		expect(publish.mock.calls[0][0].data).toEqual(Buffer.from([0xfb, 0xff]));
	});

	it.each(['not base64!!', 'abcde', { a: 1 }])('rejects invalid base64 %j', async (data) => {
		const publish = publishMessage();
		const [output] = await new GcpPubSubPublishV1().execute.call(
			executeContext([{ topic: 't', dataMode: 'binary', data }]),
		);
		expect(output[0].error?.message).toContain('not valid base64');
		expect(publish).not.toHaveBeenCalled();
	});

	it('coerces attribute values to strings', async () => {
		const publish = publishMessage();
		await new GcpPubSubPublishV1().execute.call(
			executeContext([
				{
					topic: 't',
					data: 'x',
					attributes: {
						attribute: [
							{ key: 'count', value: 3 },
							{ key: 'flag', value: false },
							{ key: 'obj', value: { a: 1 } },
							{ key: 'none', value: null },
						],
					},
				},
			]),
		);
		expect(publish.mock.calls[0][0].attributes).toEqual({
			count: '3',
			flag: 'false',
			obj: '{"a":1}',
			none: '',
		});
	});
});

interface TriggerHarnessOptions {
	mode?: string;
	metadata?: Record<string, unknown>;
	metadataError?: unknown;
	subscriptionClose?: () => Promise<void>;
}

function triggerHarness(
	parameterOverrides: Record<string, unknown> = {},
	{ mode = 'trigger', metadata, metadataError, subscriptionClose }: TriggerHarnessOptions = {},
) {
	const subscription = Object.assign(new EventEmitter(), {
		close: jest.fn(subscriptionClose ?? (async () => undefined)),
		getMetadata: metadataError
			? jest.fn().mockRejectedValue(metadataError)
			: jest.fn().mockResolvedValue([{ topic: 'projects/home/topics/topic', ...metadata }]),
	});
	const createSubscription = jest.fn().mockResolvedValue([subscription]);
	const pubsub = {
		topic: jest.fn().mockReturnValue({ createSubscription }),
		subscription: jest.fn().mockReturnValue(subscription),
		close: jest.fn().mockResolvedValue(undefined),
	};
	mockAuth({ pubsub });
	const done: Array<IDeferredPromise<IRun>> = [];
	const emit = jest.fn((_data: unknown, _response: unknown, donePromise: IDeferredPromise<IRun>) => {
		done.push(donePromise);
	});
	const emitError = jest.fn();
	const parameters: Record<string, unknown> = {
		subscription: 'sub',
		...parameterOverrides,
	};
	const ctx = {
		getNode: () => node,
		getMode: () => mode,
		getNodeParameter: (name: string, fallback?: unknown) => parameters[name] ?? fallback,
		emit,
		emitError,
		helpers: {
			returnJsonArray: (rows: unknown[]) => rows.map((json) => ({ json })),
			createDeferredPromise,
		},
		logger: { warn: jest.fn(), error: jest.fn() },
	} as unknown as ITriggerFunctions;
	return { ctx, subscription, createSubscription, pubsub, emit, emitError, done };
}

function pubsubMessage(id: string, orderingKey?: string) {
	return {
		id,
		ackId: `ack-${id}`,
		data: Buffer.from('payload'),
		orderingKey,
		ack: jest.fn(),
		nack: jest.fn(),
	};
}

function run(status: string, extra: Record<string, unknown> = {}): IRun {
	return { status, data: { resultData: {} }, ...extra } as unknown as IRun;
}

const settle = async () => await new Promise((resolve) => setImmediate(resolve));

describe('trigger acknowledgement', () => {
	it('acknowledges when the execution finishes by default', async () => {
		const { ctx, subscription, done } = triggerHarness();
		await new GcpPubSubTriggerV1().trigger.call(ctx);
		const message = pubsubMessage('1');
		subscription.emit('message', message);
		done[0].resolve(run('success'));
		await settle();
		expect(message.ack).toHaveBeenCalledTimes(1);
	});

	it('manual mode holds the lease during the execution and releases it afterwards', async () => {
		const { ctx, subscription, emit, done } = triggerHarness({ ackMode: 'manual' });
		await new GcpPubSubTriggerV1().trigger.call(ctx);
		const message = pubsubMessage('1');
		subscription.emit('message', message);
		await settle();
		expect(emit).toHaveBeenCalledTimes(1);
		expect(message.ack).not.toHaveBeenCalled();
		expect(message.nack).not.toHaveBeenCalled();

		done[0].resolve(run('success'));
		await settle();
		expect(message.nack).toHaveBeenCalledTimes(1);
		expect(message.ack).not.toHaveBeenCalled();
	});

	it('manual mode keeps the lease while the execution is waiting', async () => {
		const { ctx, subscription, done } = triggerHarness({ ackMode: 'manual' });
		await new GcpPubSubTriggerV1().trigger.call(ctx);
		const message = pubsubMessage('1');
		subscription.emit('message', message);
		done[0].resolve(run('waiting', { waitTill: new Date() }));
		await settle();
		expect(message.ack).not.toHaveBeenCalled();
		expect(message.nack).not.toHaveBeenCalled();
	});

	it.each([
		['success', 'ack'],
		['waiting', 'ack'],
		['error', 'nack'],
		['crashed', 'nack'],
		['canceled', 'nack'],
	] as const)('executionFinish mode: %s execution -> %s', async (status, expected) => {
		const { ctx, subscription, done } = triggerHarness({ ackMode: 'executionFinish' });
		await new GcpPubSubTriggerV1().trigger.call(ctx);
		const message = pubsubMessage('1');
		subscription.emit('message', message);
		expect(message.ack).not.toHaveBeenCalled();
		done[0].resolve(run(status));
		await settle();
		expect(message[expected]).toHaveBeenCalledTimes(1);
		expect(message[expected === 'ack' ? 'nack' : 'ack']).not.toHaveBeenCalled();
	});

	it('executionFinish mode nacks when the run carries an error or cannot be followed', async () => {
		const { ctx, subscription, done } = triggerHarness({ ackMode: 'executionFinish' });
		await new GcpPubSubTriggerV1().trigger.call(ctx);
		const withError = pubsubMessage('1');
		const rejected = pubsubMessage('2');
		const missing = pubsubMessage('3');
		for (const message of [withError, rejected, missing]) subscription.emit('message', message);
		done[0].resolve({ status: 'success', data: { resultData: { error: {} } } } as unknown as IRun);
		done[1].reject(new Error('lost'));
		done[2].resolve(undefined as unknown as IRun);
		await settle();
		for (const message of [withError, rejected, missing]) {
			expect(message.nack).toHaveBeenCalledTimes(1);
			expect(message.ack).not.toHaveBeenCalled();
		}
	});

	it('immediately mode acks before the execution finishes and never nacks', async () => {
		const { ctx, subscription, done } = triggerHarness({ ackMode: 'immediately' });
		await new GcpPubSubTriggerV1().trigger.call(ctx);
		const message = pubsubMessage('1');
		subscription.emit('message', message);
		expect(message.ack).toHaveBeenCalledTimes(1);
		done[0].resolve(run('error'));
		await settle();
		expect(message.nack).not.toHaveBeenCalled();
	});
});

describe('trigger shutdown', () => {
	it('asks the client to wait for in-flight messages instead of nacking them', async () => {
		const { ctx, pubsub } = triggerHarness();
		await new GcpPubSubTriggerV1().trigger.call(ctx);
		expect(pubsub.subscription.mock.calls[0][1]).toMatchObject({
			closeOptions: { behavior: 'WAIT' },
			flowControl: { maxMessages: 100 },
		});
	});

	it('closes without blocking on, or nacking, an execution that is still running', async () => {
		let finishClose: () => void = () => undefined;
		const { ctx, subscription, pubsub, done } = triggerHarness(
			{},
			{ subscriptionClose: async () => await new Promise<void>((r) => (finishClose = r)) },
		);
		const response = await new GcpPubSubTriggerV1().trigger.call(ctx);
		const message = pubsubMessage('1');
		subscription.emit('message', message);

		await response.closeFunction?.();
		expect(subscription.close).toHaveBeenCalledTimes(1);
		expect(subscription.listenerCount('message')).toBe(1);
		expect(message.nack).not.toHaveBeenCalled();
		expect(pubsub.close).not.toHaveBeenCalled();

		done[0].resolve(run('success'));
		finishClose();
		await settle();
		expect(message.ack).toHaveBeenCalledTimes(1);
		expect(message.nack).not.toHaveBeenCalled();
		expect(pubsub.close).toHaveBeenCalledTimes(1);
		expect(subscription.listenerCount('message')).toBe(0);
	});

	it('releases messages that arrive after close and ignores late errors', async () => {
		let finishClose: () => void = () => undefined;
		const { ctx, subscription, emit, emitError } = triggerHarness(
			{},
			{ subscriptionClose: async () => await new Promise<void>((r) => (finishClose = r)) },
		);
		const response = await new GcpPubSubTriggerV1().trigger.call(ctx);
		subscription.emit('message', pubsubMessage('1'));
		await response.closeFunction?.();

		const late = pubsubMessage('2');
		subscription.emit('message', late);
		subscription.emit('error', new Error('late'));
		await settle();
		expect(emit).toHaveBeenCalledTimes(1);
		expect(late.nack).toHaveBeenCalledTimes(1);
		expect(emitError).not.toHaveBeenCalled();
		finishClose();
	});

	it('reports stream errors of an active workflow to n8n', async () => {
		const { ctx, subscription, emitError } = triggerHarness();
		await new GcpPubSubTriggerV1().trigger.call(ctx);
		const error = new Error('stream broke');
		subscription.emit('error', error);
		expect(emitError).toHaveBeenCalledWith(error);
	});
});

describe('trigger test runs', () => {
	afterEach(() => jest.useRealTimers());

	it('closes the subscriber when no message arrives within the timeout', async () => {
		jest.useFakeTimers();
		const { ctx, subscription, pubsub } = triggerHarness({}, { mode: 'manual' });
		const response = await new GcpPubSubTriggerV1().trigger.call(ctx);
		const outcome = expect(response.manualTriggerFunction?.()).rejects.toThrow(
			'No message received within 30 seconds',
		);
		await jest.advanceTimersByTimeAsync(30000);
		await outcome;
		expect(subscription.close).toHaveBeenCalledTimes(1);
		expect(pubsub.close).toHaveBeenCalledTimes(1);
	});

	it('closes the subscriber and rejects when the stream errors while waiting', async () => {
		const { ctx, subscription, pubsub, emitError } = triggerHarness({}, { mode: 'manual' });
		const response = await new GcpPubSubTriggerV1().trigger.call(ctx);
		const outcome = expect(response.manualTriggerFunction?.()).rejects.toThrow('NOT_FOUND');
		subscription.emit('error', new Error('NOT_FOUND'));
		await outcome;
		expect(pubsub.close).toHaveBeenCalledTimes(1);
		expect(emitError).not.toHaveBeenCalled();
	});

	it('hands exactly one message to the test execution', async () => {
		const { ctx, subscription, pubsub, emit } = triggerHarness({}, { mode: 'manual' });
		const response = await new GcpPubSubTriggerV1().trigger.call(ctx);
		expect(pubsub.subscription.mock.calls[0][1]).toMatchObject({
			flowControl: { maxMessages: 1 },
		});
		const waiting = response.manualTriggerFunction?.();
		const first = pubsubMessage('1');
		const second = pubsubMessage('2');
		subscription.emit('message', first);
		subscription.emit('message', second);
		await waiting;
		expect(emit).toHaveBeenCalledTimes(1);
		expect(first.nack).not.toHaveBeenCalled();
		expect(second.nack).toHaveBeenCalledTimes(1);
	});
});

describe('trigger subscription checks', () => {
	const creating = { createSubscription: true, topic: 'topic' };
	const alreadyExists = Object.assign(new Error('exists'), { code: 6 });

	it('needs no topic, and creates nothing, for an existing subscription', async () => {
		const { ctx, pubsub, createSubscription } = triggerHarness();
		await expect(new GcpPubSubTriggerV1().trigger.call(ctx)).resolves.toBeDefined();
		expect(pubsub.topic).not.toHaveBeenCalled();
		expect(createSubscription).not.toHaveBeenCalled();
	});

	it('requires a topic when asked to create the subscription', async () => {
		const { ctx, pubsub } = triggerHarness({ createSubscription: true });
		await expect(new GcpPubSubTriggerV1().trigger.call(ctx)).rejects.toThrow('Topic is required');
		expect(pubsub.close).toHaveBeenCalledTimes(1);
	});

	it('refuses to reuse a subscription that already exists on a different topic', async () => {
		const { ctx, pubsub, createSubscription } = triggerHarness(creating, {
			metadata: { topic: 'projects/home/topics/other' },
		});
		createSubscription.mockRejectedValue(alreadyExists);
		await expect(new GcpPubSubTriggerV1().trigger.call(ctx)).rejects.toThrow(
			'already exists on topic "projects/home/topics/other", not "projects/home/topics/topic"',
		);
		expect(pubsub.close).toHaveBeenCalledTimes(1);
	});

	it('reuses a subscription that already exists on the same topic', async () => {
		const { ctx, createSubscription } = triggerHarness(creating);
		createSubscription.mockRejectedValue(alreadyExists);
		await expect(new GcpPubSubTriggerV1().trigger.call(ctx)).resolves.toBeDefined();
	});

	it('skips the check for a subscription it has just created', async () => {
		const { ctx, subscription } = triggerHarness(creating);
		await new GcpPubSubTriggerV1().trigger.call(ctx);
		expect(subscription.getMetadata).not.toHaveBeenCalled();
	});

	it('accepts a topic addressed by project number', async () => {
		const { ctx, createSubscription } = triggerHarness({
			...creating,
			topic: 'projects/123456/topics/topic',
		});
		createSubscription.mockRejectedValue(alreadyExists);
		await expect(new GcpPubSubTriggerV1().trigger.call(ctx)).resolves.toBeDefined();
	});

	it('reports a create failure as a node error and closes the client', async () => {
		const { ctx, pubsub, createSubscription } = triggerHarness(creating);
		createSubscription.mockRejectedValue(Object.assign(new Error('denied'), { code: 7 }));
		await expect(new GcpPubSubTriggerV1().trigger.call(ctx)).rejects.toThrow('denied');
		expect(pubsub.close).toHaveBeenCalledTimes(1);
	});

	it('creates subscriptions with exponential backoff unless told otherwise', async () => {
		const { ctx, createSubscription } = triggerHarness(creating);
		await new GcpPubSubTriggerV1().trigger.call(ctx);
		expect(createSubscription).toHaveBeenCalledWith('projects/home/subscriptions/sub', {
			ackDeadlineSeconds: 60,
			retryPolicy: { minimumBackoff: { seconds: 10 }, maximumBackoff: { seconds: 600 } },
		});
	});

	it('honours custom and immediate retry policies', async () => {
		const custom = triggerHarness({
			...creating,
			subscriptionCreateOptions: { retryMinBackoffSeconds: 30, retryMaxBackoffSeconds: 120 },
		});
		await new GcpPubSubTriggerV1().trigger.call(custom.ctx);
		expect(custom.createSubscription.mock.calls[0][1].retryPolicy).toEqual({
			minimumBackoff: { seconds: 30 },
			maximumBackoff: { seconds: 120 },
		});

		const immediate = triggerHarness({
			...creating,
			subscriptionCreateOptions: { retryPolicy: 'immediate' },
		});
		await new GcpPubSubTriggerV1().trigger.call(immediate.ctx);
		expect(immediate.createSubscription.mock.calls[0][1].retryPolicy).toBeUndefined();
	});

	it('rejects a minimum backoff above the maximum', async () => {
		const { ctx, createSubscription } = triggerHarness({
			...creating,
			subscriptionCreateOptions: { retryMinBackoffSeconds: 300, retryMaxBackoffSeconds: 60 },
		});
		await expect(new GcpPubSubTriggerV1().trigger.call(ctx)).rejects.toThrow(
			'Retry Minimum Backoff cannot be greater',
		);
		expect(createSubscription).not.toHaveBeenCalled();
	});

	it('reports a missing subscription at activation', async () => {
		const { ctx, pubsub } = triggerHarness(
			{},
			{ metadataError: Object.assign(new Error('gone'), { code: 5 }) },
		);
		await expect(new GcpPubSubTriggerV1().trigger.call(ctx)).rejects.toThrow('does not exist');
		expect(pubsub.close).toHaveBeenCalledTimes(1);
	});

	it('starts anyway when the principal may not read subscription settings', async () => {
		const { ctx, subscription, emit } = triggerHarness(
			{},
			{ metadataError: Object.assign(new Error('denied'), { code: 7 }) },
		);
		await new GcpPubSubTriggerV1().trigger.call(ctx);
		subscription.emit('message', pubsubMessage('1'));
		expect(emit).toHaveBeenCalledTimes(1);
		expect(ctx.logger.warn).toHaveBeenCalled();
	});
});

describe('trigger message ordering', () => {
	const ordered = { metadata: { enableMessageOrdering: true } };

	it('runs executions for one ordering key one at a time', async () => {
		const { ctx, subscription, emit, done } = triggerHarness({ ackMode: 'executionFinish' }, ordered);
		await new GcpPubSubTriggerV1().trigger.call(ctx);
		const first = pubsubMessage('1', 'key-a');
		const second = pubsubMessage('2', 'key-a');
		const otherKey = pubsubMessage('3', 'key-b');
		for (const message of [first, second, otherKey]) subscription.emit('message', message);
		await settle();
		expect(emit).toHaveBeenCalledTimes(2);
		expect(emit.mock.calls.map(([data]) => (data as any)[0][0].json.messageId)).toEqual(['1', '3']);

		done[0].resolve(run('success'));
		await settle();
		expect(first.ack).toHaveBeenCalledTimes(1);
		expect(emit).toHaveBeenCalledTimes(3);
		expect((emit.mock.calls[2][0] as any)[0][0].json.messageId).toBe('2');
	});

	it('releases queued messages for a key after a failure without running them', async () => {
		const { ctx, subscription, emit, done } = triggerHarness({ ackMode: 'executionFinish' }, ordered);
		await new GcpPubSubTriggerV1().trigger.call(ctx);
		const first = pubsubMessage('1', 'key-a');
		const second = pubsubMessage('2', 'key-a');
		subscription.emit('message', first);
		subscription.emit('message', second);
		await settle();
		done[0].resolve(run('error'));
		await settle();
		expect(first.nack).toHaveBeenCalledTimes(1);
		expect(second.nack).toHaveBeenCalledTimes(1);
		expect(emit).toHaveBeenCalledTimes(1);

		const redelivered = pubsubMessage('1', 'key-a');
		subscription.emit('message', redelivered);
		await settle();
		expect(emit).toHaveBeenCalledTimes(2);
	});

	it('serialises by ordering key when the subscription settings cannot be read', async () => {
		const { ctx, subscription, emit } = triggerHarness(
			{},
			{ metadataError: Object.assign(new Error('denied'), { code: 7 }) },
		);
		await new GcpPubSubTriggerV1().trigger.call(ctx);
		subscription.emit('message', pubsubMessage('1', 'key-a'));
		subscription.emit('message', pubsubMessage('2', 'key-a'));
		subscription.emit('message', pubsubMessage('3'));
		subscription.emit('message', pubsubMessage('4'));
		await settle();
		expect(emit).toHaveBeenCalledTimes(3);
	});

	it('follows the setting of a subscription it creates', async () => {
		const { ctx, subscription, emit } = triggerHarness({
			createSubscription: true,
			topic: 'topic',
			subscriptionCreateOptions: { enableMessageOrdering: true },
		});
		await new GcpPubSubTriggerV1().trigger.call(ctx);
		subscription.emit('message', pubsubMessage('1', 'key-a'));
		subscription.emit('message', pubsubMessage('2', 'key-a'));
		await settle();
		expect(emit).toHaveBeenCalledTimes(1);
	});

	it('does not serialise by ordering key on an unordered subscription', async () => {
		const { ctx, subscription, emit } = triggerHarness();
		await new GcpPubSubTriggerV1().trigger.call(ctx);
		subscription.emit('message', pubsubMessage('1', 'key-a'));
		subscription.emit('message', pubsubMessage('2', 'key-a'));
		await settle();
		expect(emit).toHaveBeenCalledTimes(2);
	});
});

describe('trigger resource paths', () => {
	it.each([true, false])(
		'preserves cross-project paths with create-if-missing=%s',
		async (autoCreate) => {
			const subscription = Object.assign(new EventEmitter(), {
				close: jest.fn().mockResolvedValue(undefined),
				getMetadata: jest
					.fn()
					.mockResolvedValue([{ topic: 'projects/topic-project/topics/topic' }]),
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
				createSubscription: autoCreate,
				subscriptionCreateOptions: { deadLetterTopic: 'dead-letter' },
			};
			const ctx = {
				getNode: () => node,
				getMode: () => 'trigger',
				getNodeParameter: (name: string, fallback?: unknown) => parameters[name] ?? fallback,
				emit,
				helpers: {
					returnJsonArray: (rows: unknown[]) => rows.map((json) => ({ json })),
					createDeferredPromise,
				},
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
			await settle();
			expect(pubsub.close).toHaveBeenCalledTimes(1);
		},
	);
});
