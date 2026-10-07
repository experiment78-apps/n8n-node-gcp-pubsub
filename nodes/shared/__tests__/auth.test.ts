jest.mock('@google-cloud/pubsub', () => {
	class PubSubMock {
		public options: Record<string, unknown>;
		constructor(options: Record<string, unknown>) {
			this.options = options;
		}
		async close() {
			/* noop */
		}
	}
	return { PubSub: PubSubMock };
});

jest.mock('google-auth-library', () => {
	const actual = jest.requireActual('google-auth-library');
	class GoogleAuthMock {
		constructor(public opts: Record<string, unknown>) {}
		async getClient() {
			if (this.opts.authClient) return this.opts.authClient;
			return {
				async request() {
					return { status: 200, data: {} };
				},
			};
		}
		async getProjectId() {
			return (this.opts as { projectId?: string }).projectId ?? 'adc-project';
		}
	}
	return {
		...actual,
		GoogleAuth: GoogleAuthMock,
	};
});

describe('buildPubSubAuth OAuth2 refresh', () => {
	const credentials = {
		projectId: 'oauth-project',
		clientId: 'test-client-id',
		clientSecret: 'test-client-secret',
	};

	it.each([
		{ expiry_date: 1 },
		{ n8n_expires_at: '1970-01-01T00:00:00.001Z' },
		{ n8n_expires_at: '1' },
		{ expires_in: 3600 },
	])(
		'refreshes expired or undated persisted tokens with client credentials (%j)',
		async (expiry) => {
			const bundle = await buildPubSubAuth(
				credentialLoaderFor({
					...credentials,
					oauthTokenData: { access_token: 'old-token', refresh_token: 'refresh-token', ...expiry },
				}),
				{ authentication: 'oAuth2' },
			);
			const client = bundle.authClient as import('google-auth-library').OAuth2Client;
			const request = jest.spyOn(client.transporter, 'request').mockResolvedValue({
				data: { access_token: 'new-token', expires_in: 3600 },
			} as never);

			expect((await client.getAccessToken()).token).toBe('new-token');
			const form = request.mock.calls[0][0]?.data as URLSearchParams;
			expect(form.get('client_id')).toBe(credentials.clientId);
			expect(form.get('client_secret')).toBe(credentials.clientSecret);
			expect(form.get('refresh_token')).toBe('refresh-token');
			expect(client.credentials.expiry_date).toBeGreaterThan(Date.now());
			await client.getAccessToken();
			expect(request).toHaveBeenCalledTimes(1);
		},
	);

	it('keeps a token whose absolute n8n expiry is still in the future', async () => {
		const bundle = await buildPubSubAuth(
			credentialLoaderFor({
				...credentials,
				oauthTokenData: {
					access_token: 'valid-token',
					refresh_token: 'refresh-token',
					n8n_expires_at: new Date(Date.now() + 3600000).toISOString(),
				},
			}),
			{ authentication: 'oAuth2' },
		);
		const client = bundle.authClient as import('google-auth-library').OAuth2Client;
		const request = jest.spyOn(client.transporter, 'request');
		expect((await client.getAccessToken()).token).toBe('valid-token');
		expect(request).not.toHaveBeenCalled();
	});
});

import {
	buildPubSubAuth,
	formatPrivateKey,
	normaliseApiEndpoint,
	parseEmulatorHost,
	parseServiceAccountJson,
	projectIdFromServiceAccountEmail,
	restBaseForApiEndpoint,
	type CredentialLoader,
} from '../auth';

describe('formatPrivateKey', () => {
	it('returns empty string for missing value', () => {
		expect(formatPrivateKey(undefined)).toBe('');
	});

	it('unescapes \\n sequences pasted from JSON', () => {
		const input = '-----BEGIN-----\\nabc\\ndef';
		const out = formatPrivateKey(input);
		expect(out).toContain('\n');
		expect(out.endsWith('\n')).toBe(true);
		expect(out).not.toContain('\\n');
	});

	it('trims and appends trailing newline', () => {
		expect(formatPrivateKey('   key   ')).toBe('key\n');
	});
});

describe('parseServiceAccountJson', () => {
	it('parses valid JSON with required fields', () => {
		const raw = JSON.stringify({
			client_email: 'sa@example.iam.gserviceaccount.com',
			private_key: '-----BEGIN KEY-----\\nabc',
			project_id: 'proj-1',
		});
		const out = parseServiceAccountJson(raw);
		expect(out.client_email).toBe('sa@example.iam.gserviceaccount.com');
		expect(out.private_key).toContain('\n');
		expect(out.project_id).toBe('proj-1');
	});

	it('throws on invalid JSON', () => {
		expect(() => parseServiceAccountJson('not json')).toThrow(/not valid JSON/i);
	});

	it('throws when client_email or private_key missing', () => {
		expect(() => parseServiceAccountJson(JSON.stringify({ client_email: 'a' }))).toThrow(
			/missing required fields/i,
		);
	});

	it('throws when body is not an object', () => {
		expect(() => parseServiceAccountJson('123')).toThrow(/must be a JSON object/i);
	});
});

describe('normaliseApiEndpoint', () => {
	it('returns undefined for blank input', () => {
		expect(normaliseApiEndpoint('')).toBeUndefined();
		expect(normaliseApiEndpoint('   ')).toBeUndefined();
		expect(normaliseApiEndpoint(undefined)).toBeUndefined();
	});

	it('strips http/https protocol', () => {
		expect(normaliseApiEndpoint('https://europe-west1-pubsub.googleapis.com:443')).toBe(
			'europe-west1-pubsub.googleapis.com:443',
		);
	});

	it('trims surrounding whitespace and trailing slashes', () => {
		expect(normaliseApiEndpoint('  localhost:8085/  ')).toBe('localhost:8085');
	});
});

describe('restBaseForApiEndpoint', () => {
	it('returns the default global endpoint when blank', () => {
		expect(restBaseForApiEndpoint(undefined)).toBe('https://pubsub.googleapis.com/v1');
	});

	it('strips :443 when present and wraps with https', () => {
		expect(restBaseForApiEndpoint('europe-west1-pubsub.googleapis.com:443')).toBe(
			'https://europe-west1-pubsub.googleapis.com/v1',
		);
	});

	it('keeps non-standard ports intact', () => {
		expect(restBaseForApiEndpoint('pubsub.example.com:8443')).toBe(
			'https://pubsub.example.com:8443/v1',
		);
	});
});

function credentialLoaderFor(credentials: Record<string, unknown>): CredentialLoader {
	return {
		async getCredentials<T extends object>(): Promise<T> {
			return credentials as T;
		},
	};
}

describe('buildPubSubAuth emulator mode', () => {
	const originalEnv = process.env.PUBSUB_EMULATOR_HOST;

	afterEach(() => {
		if (originalEnv === undefined) {
			delete process.env.PUBSUB_EMULATOR_HOST;
		} else {
			process.env.PUBSUB_EMULATOR_HOST = originalEnv;
		}
	});

	it('uses emulator host and defaults project ID without touching process.env', async () => {
		delete process.env.PUBSUB_EMULATOR_HOST;
		const loader = credentialLoaderFor({
			useEmulator: true,
			emulatorHost: 'localhost:1234',
		});
		const bundle = await buildPubSubAuth(loader, { authentication: 'serviceAccount' });
		expect(bundle.projectId).toBe('emulator-project');
		expect(bundle.restApiBase).toBe('http://localhost:1234/v1');
		expect(process.env.PUBSUB_EMULATOR_HOST).toBeUndefined();
	});

	it('respects projectIdOverride in emulator mode', async () => {
		const loader = credentialLoaderFor({ useEmulator: true });
		const bundle = await buildPubSubAuth(loader, {
			authentication: 'serviceAccount',
			projectIdOverride: 'my-proj',
		});
		expect(bundle.projectId).toBe('my-proj');
	});

	it('falls back to credentials.projectId in emulator mode', async () => {
		const loader = credentialLoaderFor({ useEmulator: true, projectId: 'cred-proj' });
		const bundle = await buildPubSubAuth(loader, { authentication: 'serviceAccount' });
		expect(bundle.projectId).toBe('cred-proj');
	});
});

describe('parseEmulatorHost', () => {
	it.each([
		[undefined, 'localhost', 8085],
		['', 'localhost', 8085],
		['localhost', 'localhost', 8085],
		['emulator:9000', 'emulator', 9000],
		['http://localhost:8085/', 'localhost', 8085],
		[' 10.0.0.5:80 ', '10.0.0.5', 80],
	])('parses %j', (input, host, port) => {
		expect(parseEmulatorHost(input)).toEqual({ host, port, authority: `${host}:${port}` });
	});

	it.each(['[::1]:8085', '::1', 'host:port', 'host:0', 'host:70000', 'host:8085/path', 'a b'])(
		'rejects %j',
		(input) => {
			expect(() => parseEmulatorHost(input)).toThrow('Emulator Host');
		},
	);
});

describe('buildPubSubAuth emulator address', () => {
	it('uses the same host and port for gRPC and REST when the port is omitted', async () => {
		const bundle = await buildPubSubAuth(
			credentialLoaderFor({ useEmulator: true, emulatorHost: 'emulator' }),
			{ authentication: 'serviceAccount' },
		);
		expect(bundle.restApiBase).toBe('http://emulator:8085/v1');
		expect((bundle.pubsub as unknown as { options: unknown }).options).toMatchObject({
			apiEndpoint: 'emulator:8085',
			servicePath: 'emulator',
			port: 8085,
			emulatorMode: true,
		});
	});
});

describe('projectIdFromServiceAccountEmail', () => {
	it('reads the project from a user-managed service account', () => {
		expect(projectIdFromServiceAccountEmail('n8n@my-project-1.iam.gserviceaccount.com')).toBe(
			'my-project-1',
		);
	});

	it.each([
		undefined,
		'123-compute@developer.gserviceaccount.com',
		'proj@appspot.gserviceaccount.com',
		'user@example.com',
	])('returns undefined for %j', (email) => {
		expect(projectIdFromServiceAccountEmail(email)).toBeUndefined();
	});
});

describe('buildPubSubAuth project resolution', () => {
	const key = { privateKey: '-----BEGIN KEY-----\\nabc' };

	it('infers the project from the service account email', async () => {
		const bundle = await buildPubSubAuth(
			credentialLoaderFor({
				authType: 'serviceAccountKey',
				email: 'sa@key-project.iam.gserviceaccount.com',
				...key,
			}),
			{ authentication: 'serviceAccount' },
		);
		expect(bundle.projectId).toBe('key-project');
	});

	it('prefers project_id from pasted JSON', async () => {
		const bundle = await buildPubSubAuth(
			credentialLoaderFor({
				authType: 'serviceAccountJson',
				serviceAccountJson: JSON.stringify({
					client_email: 'sa@email-project.iam.gserviceaccount.com',
					private_key: 'key',
					project_id: 'json-project',
				}),
			}),
			{ authentication: 'serviceAccount' },
		);
		expect(bundle.projectId).toBe('json-project');
	});

	it('never falls back to the ambient project for a pasted key', async () => {
		await expect(
			buildPubSubAuth(
				credentialLoaderFor({
					authType: 'serviceAccountKey',
					email: '123-compute@developer.gserviceaccount.com',
					...key,
				}),
				{ authentication: 'serviceAccount' },
			),
		).rejects.toThrow('could not be determined from the service account');
	});

	it('still uses the ambient project for Application Default Credentials', async () => {
		const bundle = await buildPubSubAuth(credentialLoaderFor({ authType: 'applicationDefault' }), {
			authentication: 'serviceAccount',
		});
		expect(bundle.projectId).toBe('adc-project');
	});
});

describe('buildPubSubAuth service account', () => {
	it('prefers projectIdOverride over credentials.projectId', async () => {
		const loader = credentialLoaderFor({
			authType: 'serviceAccountKey',
			email: 'sa@example.iam.gserviceaccount.com',
			privateKey: '-----BEGIN KEY-----\\nabc',
			projectId: 'cred-proj',
		});
		const bundle = await buildPubSubAuth(loader, {
			authentication: 'serviceAccount',
			projectIdOverride: 'override-proj',
		});
		expect(bundle.projectId).toBe('override-proj');
		expect(bundle.restApiBase).toBe('https://pubsub.googleapis.com/v1');
	});

	it('uses credentials.projectId when no override', async () => {
		const loader = credentialLoaderFor({
			authType: 'serviceAccountKey',
			email: 'sa@example.iam.gserviceaccount.com',
			privateKey: '-----BEGIN KEY-----\\nabc',
			projectId: 'cred-proj',
		});
		const bundle = await buildPubSubAuth(loader, { authentication: 'serviceAccount' });
		expect(bundle.projectId).toBe('cred-proj');
	});

	it('passes apiEndpoint through to restApiBase', async () => {
		const loader = credentialLoaderFor({
			authType: 'serviceAccountKey',
			email: 'sa@example.iam.gserviceaccount.com',
			privateKey: '-----BEGIN KEY-----\\nabc',
			projectId: 'cred-proj',
			apiEndpoint: 'europe-west1-pubsub.googleapis.com:443',
		});
		const bundle = await buildPubSubAuth(loader, { authentication: 'serviceAccount' });
		expect(bundle.restApiBase).toBe('https://europe-west1-pubsub.googleapis.com/v1');
	});
});
