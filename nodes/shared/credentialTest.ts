import { createConnection } from 'net';

import type {
	ICredentialDataDecryptedObject,
	ICredentialsDecrypted,
	ICredentialTestFunctions,
	INodeCredentialTestResult,
} from 'n8n-workflow';

import { buildPubSubAuth, parseEmulatorHost, type Authentication } from './auth';

const TCP_PROBE_TIMEOUT_MS = 2000;
const PERMISSION_DENIED_CODE = 7;

function authenticationForCredentialType(type: string): Authentication {
	return type === 'gcpPubSubOAuth2Api' ? 'oAuth2' : 'serviceAccount';
}

async function probeTcp(host: string, port: number): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const socket = createConnection({ host, port });
		const timer = setTimeout(() => {
			socket.destroy();
			reject(new Error(`Timed out connecting to ${host}:${port}`));
		}, TCP_PROBE_TIMEOUT_MS);
		socket.once('connect', () => {
			clearTimeout(timer);
			socket.end();
			resolve();
		});
		socket.once('error', (err) => {
			clearTimeout(timer);
			reject(err);
		});
	});
}

/**
 * True when Pub/Sub accepted the credential but IAM refused the list call.
 * A disabled API also reports PERMISSION_DENIED and must stay an error.
 */
function isListPermissionDenied(err: unknown): boolean {
	if (!(err instanceof Error)) return false;
	const anyErr = err as Error & { code?: number | string; reason?: string };
	if (anyErr.code !== PERMISSION_DENIED_CODE) return false;
	return (
		anyErr.reason !== 'SERVICE_DISABLED' && !/has not been used|is disabled/i.test(anyErr.message)
	);
}

function humaniseError(err: unknown): string {
	if (err instanceof Error) {
		const anyErr = err as Error & { code?: number | string; details?: string };
		const status =
			typeof anyErr.code === 'number' && (anyErr.code === 7 || anyErr.code === 16)
				? ' (check IAM permissions or re-authorise the credential)'
				: '';
		return `${anyErr.message}${status}`;
	}
	return String(err);
}

/**
 * Shared imperative credential test for both the service-account and OAuth2
 * credentials. Exercises auth end-to-end by issuing a minimal Pub/Sub list
 * request; an IAM denial of that request still counts as a working
 * credential. In emulator mode it only verifies that the emulator host is
 * reachable, since the emulator does not validate credentials.
 */
export async function testPubSubCredential(
	this: ICredentialTestFunctions,
	credential: ICredentialsDecrypted<ICredentialDataDecryptedObject>,
): Promise<INodeCredentialTestResult> {
	const data = credential.data ?? {};
	const authentication = authenticationForCredentialType(credential.type);

	if (data.useEmulator === true) {
		let address;
		try {
			address = parseEmulatorHost(data.emulatorHost);
		} catch (err) {
			return { status: 'Error', message: humaniseError(err) };
		}
		try {
			await probeTcp(address.host, address.port);
			return { status: 'OK', message: `Emulator reachable at ${address.authority}` };
		} catch (err) {
			return {
				status: 'Error',
				message: `Could not reach Pub/Sub emulator at ${address.authority}: ${humaniseError(err)}`,
			};
		}
	}

	const loader = {
		async getCredentials<T extends object = ICredentialDataDecryptedObject>(): Promise<T> {
			return data as unknown as T;
		},
	};

	let pubsub;
	try {
		({ pubsub } = await buildPubSubAuth(loader, { authentication }));
	} catch (err) {
		return { status: 'Error', message: humaniseError(err) };
	}

	try {
		await pubsub.getTopics({ pageSize: 1, autoPaginate: false });
		return { status: 'OK', message: 'Authentication and Pub/Sub access confirmed' };
	} catch (err) {
		// Least-privilege principals (e.g. roles/pubsub.subscriber) cannot list
		// topics, yet the denial itself proves the credential authenticated.
		if (isListPermissionDenied(err)) {
			return {
				status: 'OK',
				message:
					'Authentication succeeded. The principal cannot list topics (pubsub.topics.list), so the Topic and Subscription dropdowns will not load; enter names with "By Name" or grant roles/pubsub.viewer.',
			};
		}
		return { status: 'Error', message: humaniseError(err) };
	} finally {
		await pubsub.close().catch(() => undefined);
	}
}
