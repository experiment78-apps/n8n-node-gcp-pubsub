const mockBuildPubSubAuth = jest.fn();

jest.mock('../auth', () => ({
	buildPubSubAuth: (...args: unknown[]) => mockBuildPubSubAuth(...args),
}));

import type { ILoadOptionsFunctions } from 'n8n-workflow';

import { searchSubscriptions, searchTopics } from '../listSearch';

interface PubSubStub {
	getTopics: jest.Mock;
	getSubscriptions: jest.Mock;
	close: jest.Mock;
}

function makeCtx(params: Record<string, unknown>): ILoadOptionsFunctions {
	return {
		getCurrentNodeParameter: (name: string) => params[name],
		getNode: () => ({ name: 'Pub/Sub', type: 'test', typeVersion: 1, parameters: {} }),
	} as unknown as ILoadOptionsFunctions;
}

function stubPubSub(): PubSubStub {
	return {
		getTopics: jest.fn(),
		getSubscriptions: jest.fn(),
		close: jest.fn(async () => undefined),
	};
}

describe('searchTopics', () => {
	beforeEach(() => {
		mockBuildPubSubAuth.mockReset();
	});

	it('returns one unfiltered page with its pagination token', async () => {
		const pubsub = stubPubSub();
		pubsub.getTopics.mockResolvedValue([
			[{ name: 'projects/p/topics/alpha' }, { name: 'projects/p/topics/beta' }],
			undefined,
			{ nextPageToken: 'TOKEN' },
		]);
		mockBuildPubSubAuth.mockResolvedValue({ pubsub });

		const ctx = makeCtx({ authentication: 'serviceAccount', projectId: 'p' });
		const res = await searchTopics.call(ctx);

		expect(res.results).toEqual([
			{ name: 'alpha', value: 'alpha' },
			{ name: 'beta', value: 'beta' },
		]);
		expect(res.paginationToken).toBe('TOKEN');
		expect(pubsub.getTopics).toHaveBeenCalledTimes(1);
		expect(pubsub.close).toHaveBeenCalled();
	});

	it('keeps scanning pages for a filter match that is not on the first page', async () => {
		const pubsub = stubPubSub();
		pubsub.getTopics
			.mockResolvedValueOnce([
				[{ name: 'projects/p/topics/alpha' }, { name: 'projects/p/topics/gamma' }],
				undefined,
				{ nextPageToken: 'PAGE2' },
			])
			.mockResolvedValueOnce([[{ name: 'projects/p/topics/beta' }], undefined, {}]);
		mockBuildPubSubAuth.mockResolvedValue({ pubsub });

		const ctx = makeCtx({ authentication: 'serviceAccount', projectId: 'p' });
		const res = await searchTopics.call(ctx, 'bet');

		expect(res.results).toEqual([{ name: 'beta', value: 'beta' }]);
		expect(res.paginationToken).toBeUndefined();
		expect(pubsub.getTopics).toHaveBeenNthCalledWith(1, {
			pageSize: 500,
			pageToken: undefined,
			autoPaginate: false,
		});
		expect(pubsub.getTopics).toHaveBeenNthCalledWith(2, {
			pageSize: 500,
			pageToken: 'PAGE2',
			autoPaginate: false,
		});
	});

	it('stops a filtered scan once it has a page of matches and hands back the token', async () => {
		const pubsub = stubPubSub();
		const page = Array.from({ length: 60 }, (_, i) => ({ name: `projects/p/topics/match-${i}` }));
		pubsub.getTopics.mockResolvedValue([page, undefined, { nextPageToken: 'MORE' }]);
		mockBuildPubSubAuth.mockResolvedValue({ pubsub });

		const res = await searchTopics.call(makeCtx({ authentication: 'serviceAccount' }), 'match');

		expect(res.results).toHaveLength(60);
		expect(res.paginationToken).toBe('MORE');
		expect(pubsub.getTopics).toHaveBeenCalledTimes(1);
	});

	it('bounds a filtered scan that never matches', async () => {
		const pubsub = stubPubSub();
		pubsub.getTopics.mockResolvedValue([
			[{ name: 'projects/p/topics/alpha' }],
			undefined,
			{ nextPageToken: 'MORE' },
		]);
		mockBuildPubSubAuth.mockResolvedValue({ pubsub });

		const res = await searchTopics.call(makeCtx({ authentication: 'serviceAccount' }), 'zzz');

		expect(res.results).toEqual([]);
		expect(res.paginationToken).toBe('MORE');
		expect(pubsub.getTopics).toHaveBeenCalledTimes(20);
	});

	it('explains a missing list permission', async () => {
		const pubsub = stubPubSub();
		pubsub.getTopics.mockRejectedValue(Object.assign(new Error('denied'), { code: 7 }));
		mockBuildPubSubAuth.mockResolvedValue({ pubsub });

		await expect(searchTopics.call(makeCtx({ authentication: 'serviceAccount' }))).rejects.toThrow(
			'not allowed to list topics (pubsub.topics.list)',
		);
		expect(pubsub.close).toHaveBeenCalled();
	});

	it('omits paginationToken when empty', async () => {
		const pubsub = stubPubSub();
		pubsub.getTopics.mockResolvedValue([[{ name: 'projects/p/topics/x' }], undefined, {}]);
		mockBuildPubSubAuth.mockResolvedValue({ pubsub });

		const ctx = makeCtx({ authentication: 'serviceAccount' });
		const res = await searchTopics.call(ctx);
		expect(res.paginationToken).toBeUndefined();
	});

	it('closes pubsub even when getTopics throws', async () => {
		const pubsub = stubPubSub();
		pubsub.getTopics.mockRejectedValue(new Error('boom'));
		mockBuildPubSubAuth.mockResolvedValue({ pubsub });

		const ctx = makeCtx({ authentication: 'serviceAccount' });
		await expect(searchTopics.call(ctx)).rejects.toThrow('boom');
		expect(pubsub.close).toHaveBeenCalled();
	});

	it('passes through pagination tokens', async () => {
		const pubsub = stubPubSub();
		pubsub.getTopics.mockResolvedValue([[], undefined, {}]);
		mockBuildPubSubAuth.mockResolvedValue({ pubsub });

		const ctx = makeCtx({ authentication: 'serviceAccount' });
		await searchTopics.call(ctx, '', 'NEXT');

		expect(pubsub.getTopics).toHaveBeenCalledWith({
			pageSize: 50,
			pageToken: 'NEXT',
			autoPaginate: false,
		});
	});
});

describe('searchSubscriptions', () => {
	beforeEach(() => {
		mockBuildPubSubAuth.mockReset();
	});

	it('filters subscriptions by name (case-insensitive)', async () => {
		const pubsub = stubPubSub();
		pubsub.getSubscriptions.mockResolvedValue([
			[
				{ name: 'projects/p/subscriptions/orders' },
				{ name: 'projects/p/subscriptions/ORDERS-DLQ' },
				{ name: 'projects/p/subscriptions/payments' },
			],
			undefined,
			{},
		]);
		mockBuildPubSubAuth.mockResolvedValue({ pubsub });

		const ctx = makeCtx({ authentication: 'serviceAccount' });
		const res = await searchSubscriptions.call(ctx, 'orders');
		expect(res.results.map((r) => r.value)).toEqual(['orders', 'ORDERS-DLQ']);
	});

	it('closes pubsub even when getSubscriptions throws', async () => {
		const pubsub = stubPubSub();
		pubsub.getSubscriptions.mockRejectedValue(new Error('nope'));
		mockBuildPubSubAuth.mockResolvedValue({ pubsub });

		const ctx = makeCtx({ authentication: 'serviceAccount' });
		await expect(searchSubscriptions.call(ctx)).rejects.toThrow('nope');
		expect(pubsub.close).toHaveBeenCalled();
	});
});
