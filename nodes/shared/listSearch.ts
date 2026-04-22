import type { Topic, Subscription } from '@google-cloud/pubsub';
import type { ILoadOptionsFunctions, INodeListSearchResult } from 'n8n-workflow';

import { buildPubSubAuth, type Authentication } from './auth';

function shortName(fullName: string | null | undefined): string {
	if (!fullName) return '';
	return fullName.split('/').pop() ?? fullName;
}

function readAuthentication(ctx: ILoadOptionsFunctions): Authentication {
	const raw = ctx.getCurrentNodeParameter('authentication');
	return (raw === 'oAuth2' ? 'oAuth2' : 'serviceAccount') as Authentication;
}

function readProjectIdOverride(ctx: ILoadOptionsFunctions): string | undefined {
	const raw = ctx.getCurrentNodeParameter('projectId');
	if (typeof raw !== 'string') return undefined;
	const trimmed = raw.trim();
	return trimmed === '' ? undefined : trimmed;
}

function extractNextPageToken(apiResponse: unknown): string | undefined {
	if (apiResponse && typeof apiResponse === 'object' && 'nextPageToken' in apiResponse) {
		const token = (apiResponse as { nextPageToken?: string | null }).nextPageToken;
		return typeof token === 'string' && token.length > 0 ? token : undefined;
	}
	return undefined;
}

function applyFilter<T extends { name: string }>(items: T[], filter: string | undefined): T[] {
	const needle = filter?.trim().toLowerCase();
	if (!needle) return items;
	return items.filter((i) => i.name.toLowerCase().includes(needle));
}

export async function searchTopics(
	this: ILoadOptionsFunctions,
	filter?: string,
	paginationToken?: string,
): Promise<INodeListSearchResult> {
	const authentication = readAuthentication(this);
	const projectIdOverride = readProjectIdOverride(this);

	const { pubsub } = await buildPubSubAuth(this, { authentication, projectIdOverride });
	try {
		const [topics, , apiResponse] = (await pubsub.getTopics({
			pageSize: 50,
			pageToken: paginationToken,
			autoPaginate: false,
		})) as [Topic[], unknown, unknown];

		const items = topics.map((t) => {
			const short = shortName(t.name);
			return { name: short, value: short };
		});
		return {
			results: applyFilter(items, filter),
			paginationToken: extractNextPageToken(apiResponse),
		};
	} finally {
		await pubsub.close().catch(() => undefined);
	}
}

export async function searchSubscriptions(
	this: ILoadOptionsFunctions,
	filter?: string,
	paginationToken?: string,
): Promise<INodeListSearchResult> {
	const authentication = readAuthentication(this);
	const projectIdOverride = readProjectIdOverride(this);

	const { pubsub } = await buildPubSubAuth(this, { authentication, projectIdOverride });
	try {
		const [subs, , apiResponse] = (await pubsub.getSubscriptions({
			pageSize: 50,
			pageToken: paginationToken,
			autoPaginate: false,
		})) as [Subscription[], unknown, unknown];

		const items = subs.map((s) => {
			const short = shortName(s.name);
			return { name: short, value: short };
		});
		return {
			results: applyFilter(items, filter),
			paginationToken: extractNextPageToken(apiResponse),
		};
	} finally {
		await pubsub.close().catch(() => undefined);
	}
}
