const gulp = require('gulp');
const execSync = require('child_process').execSync;
const {watch} = gulp;
const connect = require('gulp-connect');
const browserSync = require('browser-sync').create();

// For development, it is now possible to use 'gulp webserver'
// from the command line to start the server (default port is 8080)
gulp.task('webserver', gulp.series(async function() {
	connect.server({
		port: 1237,
		https: false,
		livereload: true,
	});
}));

gulp.task("pack", async function(){
	execSync('rollup -c');
});

gulp.task('reload', async function () {
	browserSync.reload();
});

gulp.task('default', gulp.parallel("pack", "webserver", async function() {
	browserSync.init({
		injectChanges: true,
		proxy: "http://localhost:1237/"
	});

	let watchlist = [
		'./index.html',
		'src/config.json',
		'src/*.js',
		'src/*/*.js',
		'src/*.css',
	];

	watch(watchlist, gulp.series("pack", "reload"));
}));

gulp.task("build", async function(){
	execSync('rollup -c ./rollup.config.release.js');
});
