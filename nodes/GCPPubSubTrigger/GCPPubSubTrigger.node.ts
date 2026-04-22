import type { INodeTypeBaseDescription, IVersionedNodeType } from 'n8n-workflow';
import { VersionedNodeType } from 'n8n-workflow';

import { GcpPubSubTriggerV1 } from './v1/GcpPubSubTriggerV1.node';

export class GcpPubSubTrigger extends VersionedNodeType {
	constructor() {
		const baseDescription: INodeTypeBaseDescription = {
			displayName: 'Google Cloud Pub/Sub Trigger',
			name: 'gcpPubSubTrigger',
			icon: 'file:gcpPubSub.svg',
			group: ['trigger'],
			description:
				'Starts a workflow when a message is received on a Google Cloud Pub/Sub topic',
			defaultVersion: 1,
		};

		const nodeVersions: IVersionedNodeType['nodeVersions'] = {
			1: new GcpPubSubTriggerV1(),
		};

		super(nodeVersions, baseDescription);
	}
}
