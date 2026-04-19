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
			validateStatus: () => true,
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
		const anyErr = err as {
			response?: { status?: number; data?: { error?: { status?: string; message?: string } } };
			message?: string;
		};
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
