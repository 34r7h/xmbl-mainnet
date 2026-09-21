// .cjs, NOT .js: packages/desktop-app is "type": "module", so a CommonJS electron-builder.config.js
// throws on load and electron-builder silently falls back to a package.json `build` key that does not
// exist — appId, targets, output dir and file globs were all dead. Keep the extension.
//
// npm workspaces HOIST electron to the root node_modules, and electron-builder only looks inside the
// project's own node_modules — without this it dies with "Cannot compute electron version from
// installed node modules". Resolving the manifest through normal node resolution finds the hoisted
// copy and never drifts from what is actually installed.
const electronVersion = require('electron/package.json').version;

module.exports = {
  electronVersion,
  appId: 'com.xmbl.desktop',
  productName: 'XMBL Desktop',
  directories: {
    output: 'dist'
  },
  files: [
    'main/**/*',
    'renderer/**/*',
    'preload/**/*',
    'src/**/*',
    'node_modules/**/*',
    'package.json'
  ],
  mac: {
    category: 'public.app-category.finance',
    // BOTH arches: an arm64-only dmg leaves every Intel Mac without a build.
    target: [{ target: 'dmg', arch: ['x64', 'arm64'] }]
  },
  win: {
    target: [{ target: 'nsis', arch: ['x64', 'arm64'] }]
  },
  linux: {
    // BOTH, because package.yml uploads dist/*.AppImage AND dist/*.deb
    target: [
      { target: 'AppImage', arch: ['x64', 'arm64'] },
      { target: 'deb', arch: ['x64', 'arm64'] }
    ],
    category: 'Finance',
    maintainer: 'XMBL <noreply@xmbl.org>'
  }
};

