/** @type {import('jest').Config} */
module.exports = {
	preset: 'ts-jest',
	testEnvironment: 'node',
	testMatch: ['<rootDir>/**/__tests__/**/*.test.ts'],
	moduleFileExtensions: ['ts', 'js', 'json'],
	roots: ['<rootDir>/nodes', '<rootDir>/credentials'],
	clearMocks: true,
	transform: {
		'^.+\\.ts$': [
			'ts-jest',
			{
				tsconfig: {
					target: 'ES2022',
					module: 'CommonJS',
					esModuleInterop: true,
					strict: true,
					skipLibCheck: true,
				},
			},
		],
	},
};
