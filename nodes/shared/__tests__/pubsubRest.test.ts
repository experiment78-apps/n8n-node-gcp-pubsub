import type { AuthClient } from 'google-auth-library';
import { gaxios } from 'google-auth-library';

import {
	acknowledge,
	isAckIdExpiredError,
	modifyAckDeadline,
	normaliseSubscription,
} from '../pubsubRest';

describe('normaliseSubscription', () => {
	it('returns full path untouched', () => {
		expect(normaliseSubscription('projects/p/subscriptions/s', 'other')).toBe(
			'projects/p/subscriptions/s',
		);
	});

	it('builds full path from short name + project', () => {
		expect(normaliseSubscription('sub', 'proj')).toBe('projects/proj/subscriptions/sub');
	});

	it('throws when subscription is blank', () => {
		expect(() => normaliseSubscription('   ', 'proj')).toThrow(/required/i);
	});

	it('throws when projectId missing for a short name', () => {
		expect(() => normaliseSubscription('sub', '')).toThrow(/Project ID is required/i);
	});

	it('trims whitespace', () => {
		expect(normaliseSubscription('  sub  ', 'proj')).toBe('projects/proj/subscriptions/sub');
	});
});

describe('isAckIdExpiredError', () => {
	it('matches FAILED_PRECONDITION at 400', () => {
		expect(isAckIdExpiredError({ ok: false, status: 400, code: 'FAILED_PRECONDITION' })).toBe(true);
	});

	it('matches message that mentions ackId', () => {
		expect(isAckIdExpiredError({ ok: false, status: 400, message: 'invalid ackId abc' })).toBe(
			true,
		);
	});

	it('does not match unrelated 400s', () => {
		expect(isAckIdExpiredError({ ok: false, status: 400, message: 'bad request' })).toBe(false);
	});

	it('does not match non-400 status', () => {
		expect(isAckIdExpiredError({ ok: false, status: 500, code: 'FAILED_PRECONDITION' })).toBe(
			false,
		);
	});
});

function makeAuthClient(
	handler: (opts: { url: string; data: unknown }) => Promise<{ status: number; data?: unknown }>,
) {
	const request = jest.fn(async (opts: { url: string; data: unknown }) => handler(opts));
	return { request } as unknown as AuthClient & { request: jest.Mock };
}

describe('postToSubscription routing', () => {
	it('acknowledge targets DEFAULT api base and correct action', async () => {
		const client = makeAuthClient(async () => ({ status: 200, data: {} }));
		const res = await acknowledge(client, 'projects/p/subscriptions/s', ['a1']);
		expect(res.ok).toBe(true);
		expect(res.status).toBe(200);
		const call = (client as unknown as { request: jest.Mock }).request.mock.calls[0][0];
		expect(call.url).toBe(
			'https://pubsub.googleapis.com/v1/projects/p/subscriptions/s:acknowledge',
		);
		expect(call.data).toEqual({ ackIds: ['a1'] });
	});

	it('modifyAckDeadline respects a custom apiBase', async () => {
		const client = makeAuthClient(async () => ({ status: 200, data: {} }));
		const res = await modifyAckDeadline(
			client,
			'projects/p/subscriptions/s',
			['a1', 'a2'],
			30,
			'https://europe-west1-pubsub.googleapis.com/v1',
		);
		expect(res.ok).toBe(true);
		const call = (client as unknown as { request: jest.Mock }).request.mock.calls[0][0];
		expect(call.url).toBe(
			'https://europe-west1-pubsub.googleapis.com/v1/projects/p/subscriptions/s:modifyAckDeadline',
		);
		expect(call.data).toEqual({ ackIds: ['a1', 'a2'], ackDeadlineSeconds: 30 });
	});
});

describe('postToSubscription error handling', () => {
	it('returns ok=false with parsed API error for 400', async () => {
		const client = makeAuthClient(async () => ({
			status: 400,
			data: { error: { status: 'FAILED_PRECONDITION', message: 'ackId expired' } },
		}));
		const res = await acknowledge(client, 'projects/p/subscriptions/s', ['a1']);
		expect(res.ok).toBe(false);
		expect(res.status).toBe(400);
		expect(res.code).toBe('FAILED_PRECONDITION');
		expect(res.message).toBe('ackId expired');
	});

	it('maps thrown GaxiosError into structured result', async () => {
		const client = makeAuthClient(async () => {
			const err = Object.assign(new Error('boom'), {
				response: { status: 503, data: { error: { status: 'UNAVAILABLE', message: 'boom' } } },
			});
			throw err;
		});
		const res = await acknowledge(client, 'projects/p/subscriptions/s', ['a1']);
		expect(res.ok).toBe(false);
		expect(res.status).toBe(503);
		expect(res.code).toBe('UNAVAILABLE');
		expect(res.message).toBe('boom');
	});
});

describe('REST retry limits with the real gaxios transport', () => {
	function transportClient(fetchImplementation: jest.Mock): AuthClient {
		const transport = new gaxios.Gaxios({ fetchImplementation });
		return {
			request: (options: gaxios.GaxiosOptions) =>
				transport.request({
					...options,
					retryConfig: { ...options.retryConfig, retryBackoff: async () => {} },
				}),
		} as unknown as AuthClient;
	}

	it.each([429, 503])('stops after three retries for persistent HTTP %s', async (status) => {
		const fetchImplementation = jest
			.fn()
			.mockImplementation(
				async () =>
					new Response(
						JSON.stringify({ error: { status: 'UNAVAILABLE', message: 'temporary failure' } }),
						{ status, headers: { 'Content-Type': 'application/json' } },
					),
			);
		const result = await acknowledge(
			transportClient(fetchImplementation),
			'projects/p/subscriptions/s',
			['ack'],
		);
		expect(result).toMatchObject({ ok: false, status });
		expect(fetchImplementation).toHaveBeenCalledTimes(4);
	});

	it('stops after three retries for persistent network errors', async () => {
		const fetchImplementation = jest.fn().mockRejectedValue(new Error('connection reset'));
		const result = await acknowledge(
			transportClient(fetchImplementation),
			'projects/p/subscriptions/s',
			['ack'],
		);
		expect(result).toMatchObject({ ok: false, status: 0 });
		expect(fetchImplementation).toHaveBeenCalledTimes(4);
	});

	it('does not retry FAILED_PRECONDITION', async () => {
		const fetchImplementation = jest
			.fn()
			.mockImplementation(
				async () =>
					new Response(
						JSON.stringify({ error: { status: 'FAILED_PRECONDITION', message: 'ackId expired' } }),
						{ status: 400, headers: { 'Content-Type': 'application/json' } },
					),
			);
		const result = await acknowledge(
			transportClient(fetchImplementation),
			'projects/p/subscriptions/s',
			['ack'],
		);
		expect(result).toMatchObject({ ok: false, status: 400, code: 'FAILED_PRECONDITION' });
		expect(fetchImplementation).toHaveBeenCalledTimes(1);
	});

	it('succeeds after a transient failure', async () => {
		const fetchImplementation = jest
			.fn()
			.mockImplementationOnce(async () => new Response('{}', { status: 503 }))
			.mockImplementationOnce(async () => new Response('{}', { status: 200 }));
		const result = await acknowledge(
			transportClient(fetchImplementation),
			'projects/p/subscriptions/s',
			['ack'],
		);
		expect(result).toMatchObject({ ok: true, status: 200 });
		expect(fetchImplementation).toHaveBeenCalledTimes(2);
	});

	it('stops retries when the overall operation deadline aborts', async () => {
		const deadline = new AbortController();
		const timeout = AbortSignal.timeout.bind(AbortSignal);
		const timeoutSpy = jest
			.spyOn(AbortSignal, 'timeout')
			.mockImplementation((milliseconds) =>
				milliseconds === 30000 ? deadline.signal : timeout(milliseconds),
			);
		try {
			const fetchImplementation = jest.fn().mockImplementation(async () => {
				deadline.abort();
				throw new Error('operation deadline reached');
			});
			const result = await acknowledge(
				transportClient(fetchImplementation),
				'projects/p/subscriptions/s',
				['ack'],
			);
			expect(result.ok).toBe(false);
			expect(fetchImplementation).toHaveBeenCalledTimes(1);
			expect(timeoutSpy).toHaveBeenCalledWith(30000);
		} finally {
			timeoutSpy.mockRestore();
		}
	});
});
