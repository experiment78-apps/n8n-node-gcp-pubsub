import type { AuthClient } from 'google-auth-library';

const DEFAULT_PUBSUB_API = 'https://pubsub.googleapis.com/v1';

/**
 * Normalises a subscription argument into the canonical
 * `projects/{project}/subscriptions/{sub}` resource name.
 */
export function normaliseSubscription(subscription: string, projectId: string): string {
	const value = subscription.trim();
	if (!value) {
		throw new Error('Subscription is required');
	}
	if (value.startsWith('projects/')) {
		return value;
	}
	if (!projectId) {
		throw new Error(
			'Project ID is required when subscription is passed as a short name (e.g. "my-sub")',
		);
	}
	return `projects/${projectId}/subscriptions/${value}`;
}

interface PubsubRequestResult {
	ok: boolean;
	status: number;
	code?: string;
	message?: string;
}

interface GaxiosLikeError {
	response?: { status?: number; data?: { error?: { status?: string; message?: string } } };
	message?: string;
	code?: string | number;
}

function isRetryableStatus(status: number): boolean {
	return status === 408 || status === 429 || (status >= 500 && status < 600);
}

async function postToSubscription(
	authClient: AuthClient,
	subscription: string,
	action: 'acknowledge' | 'modifyAckDeadline',
	body: Record<string, unknown>,
	apiBase: string = DEFAULT_PUBSUB_API,
): Promise<PubsubRequestResult> {
	const url = `${apiBase.replace(/\/+$/, '')}/${subscription}:${action}`;
	try {
		const res = await authClient.request<unknown>({
			method: 'POST',
			url,
			data: body,
			retry: true,
			retryConfig: {
				retry: 3,
				retryDelay: 250,
				httpMethodsToRetry: ['POST'],
				statusCodesToRetry: [
					[408, 408],
					[429, 429],
					[500, 599],
				],
				shouldRetry: (err: GaxiosLikeError): boolean => {
					const status = err.response?.status ?? 0;
					const apiStatus = err.response?.data?.error?.status;
					if (status === 400 && apiStatus === 'FAILED_PRECONDITION') {
						return false;
					}
					if (status === 0) {
						return true;
					}
					return isRetryableStatus(status);
				},
			},
		});
		const status = res.status ?? 0;
		if (status >= 200 && status < 300) {
			return { ok: true, status };
		}
		const raw = res.data as { error?: { status?: string; message?: string } } | undefined;
		return {
			ok: false,
			status,
			code: raw?.error?.status,
			message: raw?.error?.message,
		};
	} catch (err) {
		const anyErr = err as GaxiosLikeError;
		return {
			ok: false,
			status: anyErr.response?.status ?? 0,
			code: anyErr.response?.data?.error?.status,
			message: anyErr.response?.data?.error?.message ?? anyErr.message,
		};
	}
}

export interface AcknowledgeResult {
	subscription: string;
	ackIds: string[];
	ok: boolean;
	status: number;
	code?: string;
	message?: string;
}

export async function acknowledge(
	authClient: AuthClient,
	subscription: string,
	ackIds: string[],
	apiBase?: string,
): Promise<AcknowledgeResult> {
	const result = await postToSubscription(
		authClient,
		subscription,
		'acknowledge',
		{ ackIds },
		apiBase,
	);
	return { subscription, ackIds, ...result };
}

export async function modifyAckDeadline(
	authClient: AuthClient,
	subscription: string,
	ackIds: string[],
	ackDeadlineSeconds: number,
	apiBase?: string,
): Promise<AcknowledgeResult> {
	const result = await postToSubscription(
		authClient,
		subscription,
		'modifyAckDeadline',
		{ ackIds, ackDeadlineSeconds },
		apiBase,
	);
	return { subscription, ackIds, ...result };
}

export function isAckIdExpiredError(result: PubsubRequestResult): boolean {
	return (
		result.status === 400 &&
		(result.code === 'FAILED_PRECONDITION' || /ackId/i.test(result.message ?? ''))
	);
}
