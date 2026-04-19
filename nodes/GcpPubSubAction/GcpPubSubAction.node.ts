import type { INodeTypeBaseDescription, IVersionedNodeType } from 'n8n-workflow';
import { VersionedNodeType } from 'n8n-workflow';

import { GcpPubSubActionV1 } from './v1/GcpPubSubActionV1.node';

export class GCPPubSubAction extends VersionedNodeType {
	constructor() {
		const baseDescription: INodeTypeBaseDescription = {
			displayName: 'Google Cloud Pub/Sub Action',
			name: 'gcpPubSubAction',
			icon: 'file:gcpPubSub.svg',
			group: ['transform'],
			description: 'Acknowledge, nack or extend the ack deadline of a Pub/Sub message',
			defaultVersion: 1,
		};

		const nodeVersions: IVersionedNodeType['nodeVersions'] = {
			1: new GcpPubSubActionV1(),
		};

		super(nodeVersions, baseDescription);
	}
}
