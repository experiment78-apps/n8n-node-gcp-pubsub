import type { PubSub } from '@google-cloud/pubsub';
import type { ILoadOptionsFunctions, INodeListSearchResult } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

import { buildPubSubAuth, type Authentication } from './auth';

const PAGE_SIZE = 50;
// A filtered search scans the project in larger pages until it has a full page
// of matches, bounded so one keystroke cannot walk an unbounded listing.
const FILTER_PAGE_SIZE = 500;
const MAX_FILTER_PAGES = 20;
const PERMISSION_DENIED_CODE = 7;

type ResourceKind = 'topics' | 'subscriptions';

interface PageOptions {
	pageSize: number;
	pageToken?: string;
	autoPaginate: false;
}

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

async function fetchPage(
	pubsub: PubSub,
	kind: ResourceKind,
	options: PageOptions,
): Promise<{ names: string[]; nextPageToken?: string }> {
	const [resources, , apiResponse] = (await (kind === 'topics'
		? pubsub.getTopics(options)
		: pubsub.getSubscriptions(options))) as [Array<{ name?: string | null }>, unknown, unknown];
	return {
		names: resources.map((r) => shortName(r.name)),
		nextPageToken: extractNextPageToken(apiResponse),
	};
}

async function searchResources(
	ctx: ILoadOptionsFunctions,
	kind: ResourceKind,
	filter?: string,
	paginationToken?: string,
): Promise<INodeListSearchResult> {
	const authentication = readAuthentication(ctx);
	const projectIdOverride = readProjectIdOverride(ctx);
	const needle = filter?.trim().toLowerCase();

	const { pubsub } = await buildPubSubAuth(ctx, { authentication, projectIdOverride });
	try {
		const results: INodeListSearchResult['results'] = [];
		let pageToken = paginationToken;
		let pages = 0;
		do {
			const page = await fetchPage(pubsub, kind, {
				pageSize: needle ? FILTER_PAGE_SIZE : PAGE_SIZE,
				pageToken,
				autoPaginate: false,
			});
			for (const name of page.names) {
				if (!needle || name.toLowerCase().includes(needle)) {
					results.push({ name, value: name });
				}
			}
			pageToken = page.nextPageToken;
			pages++;
		} while (needle && pageToken && results.length < PAGE_SIZE && pages < MAX_FILTER_PAGES);

		return { results, paginationToken: pageToken };
	} catch (error) {
		if ((error as { code?: unknown } | null)?.code === PERMISSION_DENIED_CODE) {
			throw new NodeOperationError(
				ctx.getNode(),
				`The credential is not allowed to list ${kind} (pubsub.${kind}.list). Switch the field to "By Name" and type the name, or grant roles/pubsub.viewer.`,
			);
		}
		throw error;
	} finally {
		await pubsub.close().catch(() => undefined);
	}
}

export async function searchTopics(
	this: ILoadOptionsFunctions,
	filter?: string,
	paginationToken?: string,
): Promise<INodeListSearchResult> {
	return await searchResources(this, 'topics', filter, paginationToken);
}

export async function searchSubscriptions(
	this: ILoadOptionsFunctions,
	filter?: string,
	paginationToken?: string,
): Promise<INodeListSearchResult> {
	return await searchResources(this, 'subscriptions', filter, paginationToken);
}
