const path = require('path');
const { VueLoaderPlugin } = require('vue-loader');

module.exports = {
  mode: 'development',
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
    extensions: ['.js', '.vue']
  }
};

