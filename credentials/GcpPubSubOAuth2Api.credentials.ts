import type { Icon, ICredentialType, INodeProperties } from 'n8n-workflow';

export class GcpPubSubOAuth2Api implements ICredentialType {
	name = 'gcpPubSubOAuth2Api';

	displayName = 'Google Cloud Pub/Sub OAuth2 API';

	extends = ['oAuth2Api'];

	documentationUrl = 'https://github.com/experiment78-apps/n8n-node-gcp-pubsub#credentials';

	icon: Icon = 'file:gcpPubSub.svg';

	properties: INodeProperties[] = [
		{
			displayName: 'Grant Type',
			name: 'grantType',
			type: 'hidden',
			default: 'authorizationCode',
		},
		{
			displayName: 'Authorization URL',
			name: 'authUrl',
			type: 'hidden',
			default: 'https://accounts.google.com/o/oauth2/v2/auth',
		},
		{
			displayName: 'Access Token URL',
			name: 'accessTokenUrl',
			type: 'hidden',
			default: 'https://oauth2.googleapis.com/token',
		},
		{
			displayName: 'Scope',
			name: 'scope',
			type: 'hidden',
			default: 'https://www.googleapis.com/auth/pubsub',
		},
		{
			displayName: 'Auth URI Query Parameters',
			name: 'authQueryParameters',
			type: 'hidden',
			default: 'access_type=offline&prompt=consent',
		},
		{
			displayName: 'Authentication',
			name: 'authentication',
			type: 'hidden',
			default: 'body',
		},
		{
			displayName: 'Project ID',
			name: 'projectId',
			type: 'string',
			default: '',
			description:
				'Google Cloud project ID to operate against. Required unless overridden on the node. OAuth2 tokens are user-scoped and carry no project context.',
		},
		{
			displayName: 'API Endpoint (Regional)',
			name: 'apiEndpoint',
			type: 'string',
			default: '',
			placeholder: 'europe-west1-pubsub.googleapis.com:443',
			description:
				'Regional Pub/Sub endpoint to use (host:port). Leave blank for the default global endpoint. Common values: us-east1-pubsub.googleapis.com:443, europe-west1-pubsub.googleapis.com:443. Ignored when "Use Pub/Sub Emulator" is on.',
		},
		{
			displayName: 'Use Pub/Sub Emulator',
			name: 'useEmulator',
			type: 'boolean',
			default: false,
			description:
				'Whether to target a local Pub/Sub emulator (gcloud beta emulators pubsub) instead of the real Pub/Sub service. OAuth2 tokens are ignored when this is on.',
		},
		{
			displayName: 'Emulator Host',
			name: 'emulatorHost',
			type: 'string',
			default: 'localhost:8085',
			description: 'host:port the Pub/Sub emulator is listening on.',
			displayOptions: {
				show: {
					useEmulator: [true],
				},
			},
		},
	];
}
