// Validates src/docs/openapi.yaml (OpenAPI 3 structure + $refs). Used by CI: `npm run docs:validate`.
const SwaggerParser = require('@apidevtools/swagger-parser');
const path = require('path');

const spec = path.resolve(__dirname, '..', 'src', 'docs', 'openapi.yaml');
SwaggerParser.validate(spec)
  .then((api) => {
    let ops = 0;
    for (const item of Object.values(api.paths)) for (const m of ['get', 'post', 'put', 'patch', 'delete']) if (item[m]) ops += 1;
    console.log(`✔ openapi.yaml is valid — ${ops} operations, ${Object.keys(api.components.schemas).length} schemas`);
  })
  .catch((err) => {
    console.error(`✖ openapi.yaml is invalid:\n${err.message}`);
    process.exit(1);
  });
