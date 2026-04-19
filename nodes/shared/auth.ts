import { PubSub } from '@google-cloud/pubsub';
import { gaxios, GoogleAuth, OAuth2Client } from 'google-auth-library';
import type { AuthClient, CredentialBody } from 'google-auth-library';
import type { ICredentialDataDecryptedObject } from 'n8n-workflow';

const PUBSUB_SCOPES = ['https://www.googleapis.com/auth/pubsub'];
const DEFAULT_REST_API_BASE = 'https://pubsub.googleapis.com/v1';
const EMULATOR_DEFAULT_PROJECT = 'emulator-project';

export type Authentication = 'serviceAccount' | 'oAuth2';
export type ServiceAccountAuthType =
	| 'serviceAccountKey'
	| 'serviceAccountJson'
	| 'applicationDefault';

export interface PubSubAuthBundle {
	authClient: AuthClient;
	pubsub: PubSub;
	projectId: string;
	restApiBase: string;
}

export interface CredentialLoader {
	getCredentials<T extends object = ICredentialDataDecryptedObject>(
		type: string,
	): Promise<T>;
}

/**
 * Normalises a PEM private key that has been pasted with escaped newlines
 * (a common copy/paste shape from JSON service-account keys).
 */
export function formatPrivateKey(raw: string | undefined): string {
	if (!raw) return '';
	let key = raw.trim();
	if (key.includes('\\n')) {
		key = key.replace(/\\n/g, '\n');
	}
	if (!key.endsWith('\n')) {
		key = `${key}\n`;
	}
	return key;
}

function trimOrUndefined(value: unknown): string | undefined {
	if (typeof value !== 'string') return undefined;
	const trimmed = value.trim();
	return trimmed === '' ? undefined : trimmed;
}

export function parseServiceAccountJson(raw: string): CredentialBody & { project_id?: string } {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Service Account JSON is not valid JSON: ${message}`);
	}
	if (!parsed || typeof parsed !== 'object') {
		throw new Error('Service Account JSON must be a JSON object');
	}
	const obj = parsed as Record<string, unknown>;
	const clientEmail = obj.client_email;
	const privateKey = obj.private_key;
	if (typeof clientEmail !== 'string' || typeof privateKey !== 'string') {
		throw new Error(
			'Service Account JSON is missing required fields client_email and/or private_key',
		);
	}
	return {
		client_email: clientEmail,
		private_key: formatPrivateKey(privateKey),
		project_id: typeof obj.project_id === 'string' ? obj.project_id : undefined,
	};
}

async function buildServiceAccountAuth(
	credentials: ICredentialDataDecryptedObject,
	projectIdOverride: string | undefined,
): Promise<{ googleAuth: GoogleAuth; projectId: string }> {
	const authType = (credentials.authType as ServiceAccountAuthType | undefined) ?? 'serviceAccountKey';
	let googleAuth: GoogleAuth;
	let jsonProjectId: string | undefined;

	if (authType === 'serviceAccountKey') {
		const clientEmail = trimOrUndefined(credentials.email ?? credentials.client_email);
		const privateKey = formatPrivateKey(
			(credentials.privateKey ?? credentials.private_key) as string | undefined,
		);
		if (!clientEmail || !privateKey) {
			throw new Error(
				'Service account credential is missing required fields (email and/or private key)',
			);
		}
		googleAuth = new GoogleAuth({
			credentials: { client_email: clientEmail, private_key: privateKey },
			scopes: PUBSUB_SCOPES,
		});
	} else if (authType === 'serviceAccountJson') {
		const raw = trimOrUndefined(credentials.serviceAccountJson);
		if (!raw) {
			throw new Error('Service Account JSON is required');
		}
		const parsed = parseServiceAccountJson(raw);
		jsonProjectId = parsed.project_id;
		googleAuth = new GoogleAuth({
			credentials: {
				client_email: parsed.client_email,
				private_key: parsed.private_key,
			},
			scopes: PUBSUB_SCOPES,
		});
	} else if (authType === 'applicationDefault') {
		googleAuth = new GoogleAuth({ scopes: PUBSUB_SCOPES });
	} else {
		throw new Error(`Unsupported Auth Method: ${String(authType)}`);
	}

	const projectId =
		projectIdOverride ??
		trimOrUndefined(credentials.projectId) ??
		jsonProjectId ??
		(await googleAuth.getProjectId().catch(() => '')) ??
		'';

	if (!projectId) {
		throw new Error(
			'Project ID could not be determined. Set it on the node, the credential, or ensure Application Default Credentials include a project.',
		);
	}

	return { googleAuth, projectId };
}

function buildOAuth2GoogleAuth(
	credentials: ICredentialDataDecryptedObject,
	projectIdOverride: string | undefined,
): { googleAuth: GoogleAuth; projectId: string } {
	const tokenData = credentials.oauthTokenData as
		| {
				access_token?: string;
				refresh_token?: string;
				expiry_date?: number;
				token_type?: string;
				scope?: string;
			}
		| undefined;
	const accessToken = trimOrUndefined(tokenData?.access_token);
	if (!accessToken) {
		throw new Error(
			'OAuth2 credential is missing an access token. Re-authorise the credential in n8n.',
		);
	}

	const oauth2Client = new OAuth2Client();
	oauth2Client.setCredentials({
		access_token: accessToken,
		refresh_token: tokenData?.refresh_token,
		expiry_date: tokenData?.expiry_date,
		token_type: tokenData?.token_type,
		scope: tokenData?.scope,
	});

	const projectId = projectIdOverride ?? trimOrUndefined(credentials.projectId);
	if (!projectId) {
		throw new Error(
			'Project ID is required for OAuth2 credentials. Set it on the credential or override it on the node.',
		);
	}

	const googleAuth = new GoogleAuth({ authClient: oauth2Client, scopes: PUBSUB_SCOPES });
	return { googleAuth, projectId };
}

export function normaliseApiEndpoint(value: unknown): string | undefined {
	const raw = trimOrUndefined(value);
	if (!raw) return undefined;
	return raw.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
}

export function restBaseForApiEndpoint(apiEndpoint: string | undefined): string {
	if (!apiEndpoint) return DEFAULT_REST_API_BASE;
	const host = apiEndpoint.replace(/:443$/, '');
	return `https://${host}/v1`;
}

/**
 * Builds a stub AuthClient that forwards `.request()` to gaxios unauthenticated.
 * Used only when the credential targets the Pub/Sub emulator (which does not
 * require authentication). The Pub/Sub client library itself is put into
 * emulatorMode, which short-circuits gRPC auth.
 */
function buildEmulatorAuthClient(): AuthClient {
	return {
		async request(opts: Parameters<AuthClient['request']>[0]) {
			return gaxios.request({ validateStatus: () => true, ...opts });
		},
	} as unknown as AuthClient;
}

export async function buildPubSubAuth(
	ctx: CredentialLoader,
	opts: { authentication: Authentication; projectIdOverride?: string },
): Promise<PubSubAuthBundle> {
	const projectIdOverride = trimOrUndefined(opts.projectIdOverride);

	const credentials =
		opts.authentication === 'oAuth2'
			? await ctx.getCredentials('gcpPubSubOAuth2Api')
			: await ctx.getCredentials('gcpPubSubApi');

	const useEmulator = credentials.useEmulator === true;
	const apiEndpoint = normaliseApiEndpoint(credentials.apiEndpoint);

	if (useEmulator) {
		const emulatorHost =
			normaliseApiEndpoint(credentials.emulatorHost) ?? 'localhost:8085';
		const [host, portStr] = emulatorHost.split(':');
		const port = portStr ? Number(portStr) : 8085;
		const projectId =
			projectIdOverride ??
			trimOrUndefined(credentials.projectId) ??
			EMULATOR_DEFAULT_PROJECT;
		const pubsub = new PubSub({
			projectId,
			emulatorMode: true,
			apiEndpoint: emulatorHost,
			servicePath: host,
			port,
		});
		return {
			authClient: buildEmulatorAuthClient(),
			pubsub,
			projectId,
			restApiBase: `http://${emulatorHost}/v1`,
		};
	}

	let googleAuth: GoogleAuth;
	let projectId: string;
	if (opts.authentication === 'oAuth2') {
		({ googleAuth, projectId } = buildOAuth2GoogleAuth(credentials, projectIdOverride));
	} else {
		({ googleAuth, projectId } = await buildServiceAccountAuth(credentials, projectIdOverride));
	}

	const authClient = (await googleAuth.getClient()) as AuthClient;
	const pubsub = apiEndpoint
		? new PubSub({ projectId, auth: googleAuth, apiEndpoint })
		: new PubSub({ projectId, auth: googleAuth });
	return { authClient, pubsub, projectId, restApiBase: restBaseForApiEndpoint(apiEndpoint) };
}
