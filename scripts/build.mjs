// Bundles the React app with esbuild into public/dist.
import * as esbuild from "esbuild";

const watch = process.argv.includes("--watch");
const options = {
  entryPoints: { app: "web/main.tsx" },
  bundle: true,
  format: "esm",
  outdir: "public/dist",
  minify: !watch,
  sourcemap: watch ? "inline" : true,
  target: ["es2020"],
  jsx: "automatic",
  loader: { ".css": "css" },
  define: { "process.env.NODE_ENV": watch ? '"development"' : '"production"' },
  logLevel: "info",
};

// CSS is bundled as its own entry so the page can load it before JS.
const cssOptions = { entryPoints: { app: "web/styles.css" }, bundle: true, outdir: "public/dist", minify: !watch, logLevel: "info" };

if (watch) {
  const a = await esbuild.context(options);
  const b = await esbuild.context(cssOptions);
  await Promise.all([a.watch(), b.watch()]);
  console.log("watching web/ …");
} else {
  await Promise.all([esbuild.build(options), esbuild.build(cssOptions)]);
}
