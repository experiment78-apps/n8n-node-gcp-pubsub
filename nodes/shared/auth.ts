import { PubSub } from '@google-cloud/pubsub';
import { gaxios, GoogleAuth, OAuth2Client } from 'google-auth-library';
import type { AuthClient, CredentialBody } from 'google-auth-library';
import type { ICredentialDataDecryptedObject } from 'n8n-workflow';

const PUBSUB_SCOPES = ['https://www.googleapis.com/auth/pubsub'];
const DEFAULT_REST_API_BASE = 'https://pubsub.googleapis.com/v1';
const EMULATOR_DEFAULT_PROJECT = 'emulator-project';
const DEFAULT_EMULATOR_HOST = 'localhost:8085';
const DEFAULT_EMULATOR_PORT = 8085;

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
	getCredentials<T extends object = ICredentialDataDecryptedObject>(type: string): Promise<T>;
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

/**
 * Extracts the project from a user-managed service-account email
 * (`name@{project}.iam.gserviceaccount.com`). Other shapes (default compute /
 * App Engine accounts, domain-scoped projects) return undefined.
 */
export function projectIdFromServiceAccountEmail(email: string | undefined): string | undefined {
	const match = /@([a-z][a-z0-9-]{4,28}[a-z0-9])\.iam\.gserviceaccount\.com$/i.exec(
		email?.trim() ?? '',
	);
	return match?.[1].toLowerCase();
}

async function buildServiceAccountAuth(
	credentials: ICredentialDataDecryptedObject,
	projectIdOverride: string | undefined,
): Promise<{ googleAuth: GoogleAuth; projectId: string }> {
	const authType =
		(credentials.authType as ServiceAccountAuthType | undefined) ?? 'serviceAccountKey';
	let googleAuth: GoogleAuth;
	let inferredProjectId: string | undefined;

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
		inferredProjectId = projectIdFromServiceAccountEmail(clientEmail);
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
		inferredProjectId =
			trimOrUndefined(parsed.project_id) ?? projectIdFromServiceAccountEmail(parsed.client_email);
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

	// Only Application Default Credentials may take the project from the host
	// environment. Pasted keys never fall back to it: the ambient project
	// (GCLOUD_PROJECT, gcloud config, metadata server) belongs to whatever runs
	// n8n, not to the pasted service account.
	const projectId =
		projectIdOverride ??
		trimOrUndefined(credentials.projectId) ??
		inferredProjectId ??
		(authType === 'applicationDefault'
			? await googleAuth.getProjectId().catch(() => undefined)
			: undefined);

	if (!projectId) {
		throw new Error(
			authType === 'applicationDefault'
				? 'Project ID could not be determined. Set it on the node, the credential, or ensure Application Default Credentials include a project.'
				: 'Project ID could not be determined from the service account. Set it on the node or the credential.',
		);
	}

	return { googleAuth, projectId };
}

interface OAuth2TokenData {
	access_token?: string;
	accessToken?: string;
	refresh_token?: string;
	refreshToken?: string;
	expiry_date?: number | string;
	n8n_expires_at?: string;
	token_type?: string;
	scope?: string;
}

function buildOAuth2GoogleAuth(
	credentials: ICredentialDataDecryptedObject,
	projectIdOverride: string | undefined,
): { googleAuth: GoogleAuth; projectId: string } {
	const tokenData = credentials.oauthTokenData as OAuth2TokenData | undefined;
	const accessToken = trimOrUndefined(tokenData?.access_token ?? tokenData?.accessToken);
	if (!accessToken) {
		throw new Error(
			'OAuth2 credential is missing an access token. Re-authorise the credential in n8n.',
		);
	}

	const refreshToken = trimOrUndefined(tokenData?.refresh_token ?? tokenData?.refreshToken);
	const clientId = trimOrUndefined(credentials.clientId);
	const clientSecret = trimOrUndefined(credentials.clientSecret);
	if (refreshToken && !clientId) {
		throw new Error(
			'OAuth2 credential is missing its Client ID. Re-authorise the credential in n8n.',
		);
	}
	const rawExpiry = tokenData?.expiry_date ?? tokenData?.n8n_expires_at;
	const numericExpiry = Number(rawExpiry);
	const parsedExpiry =
		Number.isFinite(numericExpiry) && numericExpiry > 0
			? numericExpiry
			: typeof rawExpiry === 'string'
				? Date.parse(rawExpiry)
				: NaN;
	// Older n8n credentials only store expires_in. Its original start time is
	// unknown, so refresh before opening a long-lived stream instead of treating
	// a persisted token as newly issued on each execution.
	const expiryDate = Number.isFinite(parsedExpiry) ? parsedExpiry : refreshToken ? 1 : undefined;
	const oauth2Client = new OAuth2Client({ clientId, clientSecret });
	oauth2Client.setCredentials({
		access_token: accessToken,
		refresh_token: refreshToken,
		expiry_date: expiryDate,
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

export interface EmulatorAddress {
	host: string;
	port: number;
	/** `host:port`, always with an explicit port. */
	authority: string;
}

/**
 * Parses the credential's Emulator Host into one address shared by the gRPC
 * client, the REST ack calls and the credential test. Accepts an optional
 * http(s):// prefix and trailing slash; the port defaults to 8085.
 */
export function parseEmulatorHost(value: unknown): EmulatorAddress {
	const raw = trimOrUndefined(value) ?? DEFAULT_EMULATOR_HOST;
	const stripped = raw.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
	if (stripped.includes('[') || (stripped.match(/:/g) ?? []).length > 1) {
		throw new Error(
			`Emulator Host "${raw}" looks like an IPv6 address, which the Pub/Sub client does not support. Use a hostname or IPv4 address.`,
		);
	}
	const match = /^([^\s:/?#@]+)(?::(\d{1,5}))?$/.exec(stripped);
	const port = match?.[2] ? Number(match[2]) : DEFAULT_EMULATOR_PORT;
	if (!match || port < 1 || port > 65535) {
		throw new Error(`Emulator Host "${raw}" must be in the form host:port (e.g. localhost:8085)`);
	}
	return { host: match[1], port, authority: `${match[1]}:${port}` };
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
			return gaxios.request(opts);
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
		const { host, port, authority } = parseEmulatorHost(credentials.emulatorHost);
		const projectId =
			projectIdOverride ?? trimOrUndefined(credentials.projectId) ?? EMULATOR_DEFAULT_PROJECT;
		const pubsub = new PubSub({
			projectId,
			emulatorMode: true,
			apiEndpoint: authority,
			servicePath: host,
			port,
		});
		return {
			authClient: buildEmulatorAuthClient(),
			pubsub,
			projectId,
			restApiBase: `http://${authority}/v1`,
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
