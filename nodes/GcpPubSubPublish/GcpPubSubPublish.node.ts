import type { INodeTypeBaseDescription, IVersionedNodeType } from 'n8n-workflow';
import { VersionedNodeType } from 'n8n-workflow';

import { GcpPubSubPublishV1 } from './v1/GcpPubSubPublishV1.node';

export class GcpPubSubPublish extends VersionedNodeType {
	constructor() {
		const baseDescription: INodeTypeBaseDescription = {
			displayName: 'Google Cloud Pub/Sub Publish',
			name: 'gcpPubSubPublish',
			icon: 'file:gcpPubSub.svg',
			group: ['output'],
			description: 'Publishes messages to a Google Cloud Pub/Sub topic',
			defaultVersion: 1,
		};

		const nodeVersions: IVersionedNodeType['nodeVersions'] = {
			1: new GcpPubSubPublishV1(),
		};

		super(nodeVersions, baseDescription);
	}
}
