import { createConnection } from 'net';

import type {
	ICredentialDataDecryptedObject,
	ICredentialsDecrypted,
	ICredentialTestFunctions,
	INodeCredentialTestResult,
} from 'n8n-workflow';

import { buildPubSubAuth, type Authentication } from './auth';

const TCP_PROBE_TIMEOUT_MS = 2000;

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
 * request. In emulator mode it only verifies that the emulator host is
 * reachable, since the emulator does not validate credentials.
 */
export async function testPubSubCredential(
	this: ICredentialTestFunctions,
	credential: ICredentialsDecrypted<ICredentialDataDecryptedObject>,
): Promise<INodeCredentialTestResult> {
	const data = credential.data ?? {};
	const authentication = authenticationForCredentialType(credential.type);

	if (data.useEmulator === true) {
		const host = typeof data.emulatorHost === 'string' ? data.emulatorHost : 'localhost:8085';
		const [h, p] = host.split(':');
		try {
			await probeTcp(h, Number(p || 8085));
			return { status: 'OK', message: `Emulator reachable at ${host}` };
		} catch (err) {
			return {
				status: 'Error',
				message: `Could not reach Pub/Sub emulator at ${host}: ${humaniseError(err)}`,
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
		return { status: 'Error', message: humaniseError(err) };
	} finally {
		await pubsub.close().catch(() => undefined);
	}
}
