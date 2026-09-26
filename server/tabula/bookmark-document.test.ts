import assert from 'node:assert/strict';
import test from 'node:test';
import {bookmarkDocument} from './bookmark-document.js';

test('scraped bookmark retains snapshot and metadata while extracting inert article text',()=>{
  const html='<html><body><nav>Navigation</nav><article><h1>Article</h1><p>Saved text</p><script>secretScript()</script><form>Secret field</form></article></body></html>';
  const result=bookmarkDocument({title:'Saved page',url:'https://example.com/page',memo:'My memo',summary:'Summary'},html);
  assert.equal(result.snapshotHtml,html);
  assert.equal(result.bookmark_url,'https://example.com/page');
  assert.equal(result.source_kind,'bookmark');
  const text=result.elements.map(element=>element.text).join('\n');
  assert.match(text,/Saved text/);
  assert.match(text,/My memo/);
  assert.match(text,/Summary/);
  assert.doesNotMatch(text,/secretScript|Secret field|Navigation/);
});

test('empty snapshots remain registerable with explicit reference to the retained original',()=>{
  const result=bookmarkDocument({title:'Image page',url:'https://example.com',memo:'',summary:null},'<html><body><img src="x"></body></html>');
  assert.match(result.elements.at(-1)!.text,/保存HTML/);
  assert.equal(result.snapshotHtml,'<html><body><img src="x"></body></html>');
});
