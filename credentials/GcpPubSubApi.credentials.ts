import type {
	Icon,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

// eslint-disable-next-line @n8n/community-nodes/credential-test-required -- Declarative HTTP test cannot sign the JWT needed for a service-account credential; the credential is validated at run time by the nodes that use it.
export class GcpPubSubApi implements ICredentialType {
	name = 'gcpPubSubApi';

	displayName = 'Google Cloud Pub/Sub API';

	documentationUrl = 'https://github.com/experiment78-apps/n8n-node-gcp-pubsub#credentials';

	icon: Icon = 'file:gcpPubSub.svg';

	properties: INodeProperties[] = [
		{
			displayName: 'Auth Method',
			name: 'authType',
			type: 'options',
			default: 'serviceAccountKey',
			description: 'How to authenticate to Google Cloud Pub/Sub.',
			options: [
				{
					name: 'Service Account Key (Email + Private Key)',
					value: 'serviceAccountKey',
					description: 'Paste the client_email and private_key from a service-account JSON key.',
				},
				{
					name: 'Service Account JSON',
					value: 'serviceAccountJson',
					description: 'Paste the full service-account JSON key downloaded from Google Cloud.',
				},
				{
					name: 'Application Default Credentials',
					value: 'applicationDefault',
					description:
						'Use ambient credentials discovered by the Google client library (GOOGLE_APPLICATION_CREDENTIALS, gcloud, or the metadata server on GKE/Cloud Run). Not available on n8n Cloud.',
				},
			],
		},
		{
			displayName: 'Service Account Email',
			name: 'email',
			type: 'string',
			default: '',
			placeholder: 'name@project.iam.gserviceaccount.com',
			description: 'The client_email from your Google Cloud service account key.',
			displayOptions: {
				show: {
					authType: ['serviceAccountKey'],
				},
			},
		},
		{
			displayName: 'Private Key',
			name: 'privateKey',
			type: 'string',
			typeOptions: {
				password: true,
				rows: 5,
			},
			default: '',
			description:
				'The private_key from your service account key. Paste the PEM including BEGIN/END markers; escaped \\n sequences are handled automatically.',
			displayOptions: {
				show: {
					authType: ['serviceAccountKey'],
				},
			},
		},
		{
			displayName: 'Service Account JSON',
			name: 'serviceAccountJson',
			type: 'string',
			typeOptions: {
				password: true,
				rows: 12,
			},
			default: '',
			description:
				'Paste the full JSON key downloaded from Google Cloud. project_id, client_email and private_key are extracted automatically.',
			displayOptions: {
				show: {
					authType: ['serviceAccountJson'],
				},
			},
		},
		{
			displayName: 'Project ID',
			name: 'projectId',
			type: 'string',
			default: '',
			description:
				'Default Google Cloud project ID. Optional when using Service Account JSON (inferred from project_id) or Application Default Credentials (inferred from the environment). Can be overridden per node.',
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
				'Whether to target a local Pub/Sub emulator (gcloud beta emulators pubsub) instead of the real Pub/Sub service. Credentials are ignored when this is on.',
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
