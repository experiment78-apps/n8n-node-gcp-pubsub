import { readdirSync } from 'fs';
import { join, resolve } from 'path';

import packageJson from '../../../package.json';

describe('registered node and credential source paths', () => {
	it.each([...packageJson.n8n.nodes, ...packageJson.n8n.credentials])(
		'%s matches source filenames with exact casing',
		(entry) => {
			const source = entry.replace(/^dist\//, '').replace(/\.js$/, '.ts');
			let directory = resolve(__dirname, '../../..');
			for (const segment of source.split('/')) {
				expect(readdirSync(directory)).toContain(segment);
				directory = join(directory, segment);
			}
		},
	);
});
