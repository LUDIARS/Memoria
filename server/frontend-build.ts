import {build} from 'esbuild';
import {createHash} from 'node:crypto';
import {readFile,writeFile,rename,rm} from 'node:fs/promises';

/** Both production startup and manual builds publish the same frontend revision. */
export async function buildFrontend():Promise<void> {
  await build({entryPoints:['public/src/app.ts'],bundle:true,outfile:'public/app.js',target:'es2020',sourcemap:true,minify:true});
  const hash=createHash('sha256');
  for(const name of ['app.js','index.html','style.css','clever-search.css','sw.js']) {
    hash.update(name);hash.update(await readFile(`public/${name}`));
  }
  const temporary=`public/app-version.json.${process.pid}.tmp`;
  try {
    await writeFile(temporary,JSON.stringify({version:hash.digest('hex')}),'utf8');
    await rename(temporary,'public/app-version.json');
  } finally {await rm(temporary,{force:true});}
}
