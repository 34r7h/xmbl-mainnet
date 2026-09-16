module.exports = {
  testEnvironment: 'node',
  // Electron is not present outside an Electron runtime — require('electron') returns the binary's PATH in a
  // plain Node process. Map it to a recording double so the REAL main-process code can run under test.
  moduleNameMapper: { '^electron$': '<rootDir>/__mocks__/electron.cjs' },
  testMatch: ['**/__tests__/**/*.test.js'],
  collectCoverageFrom: [
    'main/**/*.js',
    'renderer/**/*.{js,vue}',
    '!**/node_modules/**'
  ],
  coverageThreshold: {
    global: {
      branches: 80,
      functions: 80,
      lines: 80,
      statements: 80
    }
  }
};



