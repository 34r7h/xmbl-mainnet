const path = require('path');
const { VueLoaderPlugin } = require('vue-loader');

module.exports = {
  mode: 'development',
  // CRITICAL for MV3: the default dev devtool is 'eval', which wraps every module in eval() — and
  // extension pages run under a CSP that forbids eval(), so an eval-devtool bundle silently dies at
  // load and the popup is blank ("nothing happens when I click the icon"). A normal web page (the
  // Playwright harness) has no such CSP, which is why it never caught this. devtool:false emits plain
  // source with NO eval, while keeping development mode (no terser) so @xmbl/lng's BigInt literals
  // are left intact. WebAssembly (@xmbl/lng) is separately allowed via manifest CSP 'wasm-unsafe-eval'.
  devtool: false,
  entry: {
    background: './src/background.js',
    popup: './src/popup/main.js',
    content: './src/content.js'
  },
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: '[name].js',
    clean: true
  },
  module: {
    rules: [
      {
        test: /\.vue$/,
        loader: 'vue-loader'
      },
      // No babel-loader: the extension targets Chromium MV3 (modern JS + BigInt), Vue SFCs are
      // compiled by vue-loader, and @xmbl/lng is BigInt-heavy — running it through
      // @babel/preset-env down-levels its BigInt literals and breaks at load
      // ("Cannot convert a BigInt value to a number"). Webpack 5 parses the modern ESM natively.
      {
        test: /\.css$/,
        use: ['style-loader', 'css-loader']
      }
    ]
  },
  plugins: [
    new VueLoaderPlugin()
  ],
  resolve: {
    extensions: ['.js', '.vue'],
    alias: {
      // Runtime-only Vue: SFC templates are precompiled by vue-loader, so the template compiler
      // (which uses new Function, also CSP-forbidden on extension pages) must not ship.
      vue$: 'vue/dist/vue.runtime.esm-bundler.js'
    }
  }
};

