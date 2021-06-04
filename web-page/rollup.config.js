import postcss from 'rollup-plugin-postcss';
import html from "rollup-plugin-html";
import json from '@rollup/plugin-json';

let plugins = [
	postcss({
		extensions: [ '.css' ]
	}),
	html({ // added to import html file as template
		include: "**/*.html",
	}),
	json()
];

const globals = {
	cesium: 'Cesium',
};

export default [
	{
		input: 'src/index.js',
		treeshake: false,
		external: ['cesium'],
		output: {
			file: 'app.js',
			format: 'umd',
			name: 'ConstruktedJs',
			sourcemap: true,
			globals: globals
		},
		plugins: plugins
	}
]