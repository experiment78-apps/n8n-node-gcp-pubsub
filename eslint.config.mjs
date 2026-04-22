import { configWithoutCloudSupport } from '@n8n/node-cli/eslint';

export default [
	...configWithoutCloudSupport,
	{
		ignores: ['**/__tests__/**', 'jest.config.cjs', 'dist/**'],
	},
];
