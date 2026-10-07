import { createServer, type AddressInfo, type Server } from 'net';

import type { ICredentialsDecrypted, ICredentialTestFunctions } from 'n8n-workflow';

import { buildPubSubAuth, type PubSubAuthBundle } from '../auth';
import { testPubSubCredential } from '../credentialTest';

jest.mock('../auth', () => ({
	...jest.requireActual('../auth'),
	buildPubSubAuth: jest.fn(),
}));

async function runTest(data: Record<string, unknown>) {
	return await testPubSubCredential.call({} as ICredentialTestFunctions, {
		id: '1',
		name: 'cred',
		type: 'gcpPubSubApi',
		data,
	} as ICredentialsDecrypted);
}

function mockGetTopics(getTopics: jest.Mock) {
	const close = jest.fn().mockResolvedValue(undefined);
	jest.mocked(buildPubSubAuth).mockResolvedValue({
		pubsub: { getTopics, close },
	} as unknown as PubSubAuthBundle);
	return close;
}

describe('testPubSubCredential', () => {
	it('passes when the list call succeeds', async () => {
		const close = mockGetTopics(jest.fn().mockResolvedValue([[]]));
		expect(await runTest({})).toMatchObject({ status: 'OK' });
		expect(close).toHaveBeenCalled();
	});

	it('passes, with a note, when the principal authenticates but may not list topics', async () => {
		mockGetTopics(
			jest
				.fn()
				.mockRejectedValue(
					Object.assign(new Error('7 PERMISSION_DENIED: User not authorized'), { code: 7 }),
				),
		);
		const result = await runTest({});
		expect(result.status).toBe('OK');
		expect(result.message).toContain('pubsub.topics.list');
	});

	it.each([
		Object.assign(new Error('7 PERMISSION_DENIED: Cloud Pub/Sub API has not been used'), { code: 7 }),
		Object.assign(new Error('7 PERMISSION_DENIED: denied'), { code: 7, reason: 'SERVICE_DISABLED' }),
		Object.assign(new Error('16 UNAUTHENTICATED: bad key'), { code: 16 }),
		new Error('invalid_grant'),
	])('fails for %s', async (error) => {
		mockGetTopics(jest.fn().mockRejectedValue(error));
		expect((await runTest({})).status).toBe('Error');
	});
});

describe('testPubSubCredential emulator mode', () => {
	let server: Server;
	let port: number;

	beforeAll(async () => {
		server = createServer((socket) => socket.end());
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
		port = (server.address() as AddressInfo).port;
	});

	afterAll(async () => {
		await new Promise((resolve) => server.close(resolve));
	});

	it.each([
		(p: number) => `127.0.0.1:${p}`,
		(p: number) => `http://127.0.0.1:${p}/`,
	])('reaches the emulator however the host is written', async (format) => {
		const result = await runTest({ useEmulator: true, emulatorHost: format(port) });
		expect(result).toEqual({ status: 'OK', message: `Emulator reachable at 127.0.0.1:${port}` });
	});

	it('reports an unparseable host without probing', async () => {
		const result = await runTest({ useEmulator: true, emulatorHost: '[::1]:8085' });
		expect(result.status).toBe('Error');
		expect(result.message).toContain('IPv6');
	});
});
