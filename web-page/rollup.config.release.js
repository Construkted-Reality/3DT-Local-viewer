import postcss from 'rollup-plugin-postcss';
import { terser } from "rollup-plugin-terser";
import html from "rollup-plugin-html";
import json from '@rollup/plugin-json';

let plugins = [
	postcss({
		extensions: [ '.css' ]
	}),
	html({ // added to import html file as template
		include: "**/*.html",
	}),
	terser(),
	json()
];

const sourceMap = false;

const globals = {
	cesium: 'Cesium',
};

export default [
	{
		input: 'src/index.js',
		treeshake: false,
		external: ['cesium'],
		output: {
			file: 'build/app.js',
			format: 'umd',
			name: 'ConstruktedJs',
			sourcemap: sourceMap,
			globals: globals
		},
		plugins: plugins
	}
]