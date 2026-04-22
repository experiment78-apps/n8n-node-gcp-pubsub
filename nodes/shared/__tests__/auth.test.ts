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

import {
	buildPubSubAuth,
	formatPrivateKey,
	normaliseApiEndpoint,
	parseServiceAccountJson,
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
		expect(() => parseServiceAccountJson('not json')).toThrow(
			/not valid JSON/i,
		);
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
