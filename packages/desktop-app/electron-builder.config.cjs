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
  // The default deb/AppImage artifact name is ${name}_${version}_${arch}, and `name` here is the
  // SCOPED package name @xmbl/desktop-app — fpm then tries to write into dist/@xmbl/ and dies with
  // "Parent directory does not exist". Every Linux build failed on this. Name them explicitly.
  artifactName: 'xmbl-desktop-${version}-${arch}.${ext}',
  // Nothing in this app loads a native module (main.js and src/core/xmbl-core.js require only
  // electron and path), but electron-builder still rebuilt every native dependency in the hoisted
  // workspace tree for the electron ABI — and classic-level's node-gyp build fails on Windows, so
  // the .exe was never produced. Skip the rebuild rather than fix a build nothing here executes.
  npmRebuild: false,
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

