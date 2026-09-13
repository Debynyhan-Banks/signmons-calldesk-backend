// Existing local TypeScript/webpack only; no package installation or app route.
module.exports = function (source) {
  if (this.resourcePath.endsWith(".css")) {
    const classes = [...source.matchAll(/\.([a-zA-Z][a-zA-Z0-9_-]*)/g)].map(
      (match) => match[1],
    );
    return (
      "export default " +
      JSON.stringify(Object.fromEntries(classes.map((name) => [name, name])))
    );
  }
  return require("typescript").transpileModule(source, {
    compilerOptions: { jsx: 4, module: 99, target: 9 },
    fileName: this.resourcePath,
  }).outputText;
};
